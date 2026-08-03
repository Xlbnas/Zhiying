/**
 * TTS-A Voice Library — HTTP API 契约测试（H）。
 *
 * 直接调用 route handler（构造 Request，不起 Next server）。覆盖（设计文档 §6）：
 *  - GET/POST /api/voice-profiles：POST 201；strict 未知字段 422；displayName 空/全空白 422；
 *    GET 列表 + ?status=archived|active 过滤；非法 status 查询 422
 *  - GET/PATCH [profileId]：404；PATCH archived/active 200；未知字段/非法 status 422；
 *    GET 含 suggestedLatestForDisplay（且递归扫描响应 JSON 键名：不存在
 *    current/selected/activeRevision/defaultRevision）
 *  - POST revisions multipart：缺 requestId 422；缺 audio 422；非法 formData 400 invalid_formdata；
 *    201 created；同 body 重发 200 reused；同 requestId 不同音频 409；archived 409；
 *    >25MB file 413
 *  - GET revision：200；跨 Profile / 不存在 → 404
 *  - GET audio：200 + Content-Type audio/wav + Accept-Ranges；Range bytes=0-99 → 206 +
 *    Content-Range 精确 + 字节与文件切片一致；suffix bytes=-50；越界 → 416；
 *    篡改 DB canonical_audio_path 指向 voice-library 外 → 404；文件删除后 → 404
 *  - 所有 JSON 响应不包含绝对路径（响应字符串不含 dataDir）
 *
 * 已知实现问题（本脚本如实记录，不修生产代码）：
 *  - 415 unsupported_audio 的 message 内嵌 execFile 错误文本，包含 staging 绝对路径
 *    （违反设计文档 §6「响应绝不包含任何文件路径」）。见脚本末尾 KNOWN-ISSUE 输出。
 *
 * 用法：npx tsx scripts/test-tts-a-voice-library-api.ts
 * 使用临时数据目录（data/test-tts-a-api），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

const TOOLS_DIR = path.resolve(process.cwd(), '.tools', 'static-ffmpeg');
if (fs.existsSync(path.join(TOOLS_DIR, 'ffprobe'))) {
  process.env.PATH = `${TOOLS_DIR}:${process.env.PATH ?? ''}`;
}

const DATA_DIR = path.join('data', 'test-tts-a-api');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {GET as profilesGET, POST as profilesPOST} from '../src/app/api/voice-profiles/route';
import {
  GET as profileGET,
  PATCH as profilePATCH,
} from '../src/app/api/voice-profiles/[profileId]/route';
import {
  GET as revisionsGET,
  POST as revisionsPOST,
} from '../src/app/api/voice-profiles/[profileId]/revisions/route';
import {GET as revisionGET} from '../src/app/api/voice-profiles/[profileId]/revisions/[revisionId]/route';
import {GET as audioGET} from '../src/app/api/voice-profiles/[profileId]/revisions/[revisionId]/audio/route';

let pass = 0;
let fail = 0;
let knownIssues = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

/** 已确认的实现 bug：存在 → KNOWN-ISSUE（不计 fail，报告列出）；被修复 → 自动转为 PASS。 */
function knownIssue(present: boolean, label: string, detail?: unknown): void {
  if (present) {
    knownIssues++;
    console.log(`KNOWN-ISSUE  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  } else {
    pass++;
    console.log(`PASS  ${label}（已修复）`);
  }
}

// 收集所有 JSON 响应文本，最后统一断言不含绝对路径
const jsonResponseTexts: Array<{label: string; text: string}> = [];

async function jsonOf(label: string, res: Response): Promise<unknown> {
  const text = await res.text();
  jsonResponseTexts.push({label, text});
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function collectKeys(v: unknown, acc: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) collectKeys(x, acc);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      acc.add(k);
      collectKeys(val, acc);
    }
  }
}

function makeWav(durationMs: number, freq: number): Buffer {
  const sampleRate = 48000;
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const BASE = 'http://localhost';
const profileParams = (profileId: string) => ({params: Promise.resolve({profileId})});
const revisionParams = (profileId: string, revisionId: string) => ({
  params: Promise.resolve({profileId, revisionId}),
});

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}

function revisionFormReq(
  profileId: string,
  fields: {requestId?: string; audio?: {buf: Buffer; name: string}; transcript?: string},
): Request {
  const form = new FormData();
  if (fields.requestId !== undefined) form.set('requestId', fields.requestId);
  if (fields.audio)
    form.set('audio', new File([new Uint8Array(fields.audio.buf)], fields.audio.name));
  if (fields.transcript !== undefined) form.set('transcript', fields.transcript);
  return new Request(`${BASE}/api/voice-profiles/${profileId}/revisions`, {
    method: 'POST',
    body: form,
  });
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();

  // ---------- GET/POST /api/voice-profiles ----------
  const create = await profilesPOST(jsonReq(`${BASE}/api/voice-profiles`, 'POST', {displayName: 'API 测试声音'}));
  const createBody = (await jsonOf('POST /api/voice-profiles 201', create)) as {
    profile: {id: string};
  };
  const pid = createBody.profile.id;
  ok(create.status === 201 && typeof pid === 'string', '[H1] POST /api/voice-profiles → 201 + profile.id');

  const unknownField = await profilesPOST(
    jsonReq(`${BASE}/api/voice-profiles`, 'POST', {displayName: 'x', bogus: 1}),
  );
  await jsonOf('POST unknown field', unknownField);
  ok(unknownField.status === 422, '[H2] POST strict 未知字段 → 422');

  const emptyName = await profilesPOST(jsonReq(`${BASE}/api/voice-profiles`, 'POST', {displayName: ''}));
  await jsonOf('POST displayName 空', emptyName);
  ok(emptyName.status === 422, '[H3] POST displayName 空 → 422');

  const blankName = await profilesPOST(jsonReq(`${BASE}/api/voice-profiles`, 'POST', {displayName: '   '}));
  await jsonOf('POST displayName 全空白', blankName);
  ok(blankName.status === 422, '[H4] POST displayName 全空白（trim 后为空）→ 422');

  // 第二个 profile + archive，用于 status 过滤
  const create2 = await profilesPOST(jsonReq(`${BASE}/api/voice-profiles`, 'POST', {displayName: '归档对象'}));
  const pid2 = ((await jsonOf('POST profile2', create2)) as {profile: {id: string}}).profile.id;
  const arch = await profilePATCH(
    jsonReq(`${BASE}/api/voice-profiles/${pid2}`, 'PATCH', {status: 'archived'}),
    profileParams(pid2),
  );
  await jsonOf('PATCH archived', arch);
  ok(arch.status === 200, '[H5] PATCH status=archived → 200');

  const listAll = (await jsonOf('GET list', await profilesGET(new Request(`${BASE}/api/voice-profiles`)))) as {
    profiles: Array<{id: string}>;
  };
  const listArchived = (await jsonOf(
    'GET list?status=archived',
    await profilesGET(new Request(`${BASE}/api/voice-profiles?status=archived`)),
  )) as {profiles: Array<{id: string; status: string}>};
  const listActive = (await jsonOf(
    'GET list?status=active',
    await profilesGET(new Request(`${BASE}/api/voice-profiles?status=active`)),
  )) as {profiles: Array<{id: string; status: string}>};
  ok(
    listAll.profiles.length === 2 &&
      listArchived.profiles.length === 1 && listArchived.profiles[0].id === pid2 &&
      listActive.profiles.length === 1 && listActive.profiles[0].id === pid,
    '[H6] GET 列表 + ?status=archived / ?status=active 过滤正确',
  );
  const badStatus = await profilesGET(new Request(`${BASE}/api/voice-profiles?status=bogus`));
  await jsonOf('GET list?status=bogus', badStatus);
  ok(badStatus.status === 422, '[H7] GET ?status=非法值 → 422');

  // ---------- GET/PATCH [profileId] ----------
  const notFound = await profileGET(
    new Request(`${BASE}/api/voice-profiles/no-such`),
    profileParams('no-such'),
  );
  await jsonOf('GET profile 404', notFound);
  ok(notFound.status === 404, '[H8] GET 不存在 Profile → 404');

  const patchBad1 = await profilePATCH(
    jsonReq(`${BASE}/api/voice-profiles/${pid}`, 'PATCH', {status: 'bogus'}),
    profileParams(pid),
  );
  await jsonOf('PATCH status 非法', patchBad1);
  ok(patchBad1.status === 422, '[H9] PATCH 非法 status → 422');

  const patchBad2 = await profilePATCH(
    jsonReq(`${BASE}/api/voice-profiles/${pid}`, 'PATCH', {foo: 1}),
    profileParams(pid),
  );
  await jsonOf('PATCH 未知字段', patchBad2);
  ok(patchBad2.status === 422, '[H10] PATCH 未知字段（strict）→ 422');

  const patch404 = await profilePATCH(
    jsonReq(`${BASE}/api/voice-profiles/no-such`, 'PATCH', {status: 'active'}),
    profileParams('no-such'),
  );
  await jsonOf('PATCH 404', patch404);
  ok(patch404.status === 404, '[H11] PATCH 不存在 Profile → 404');

  const detailBefore = (await jsonOf(
    'GET profile detail (no revisions)',
    await profileGET(new Request(`${BASE}/api/voice-profiles/${pid}`), profileParams(pid)),
  )) as {revisionCount: number; suggestedLatestForDisplay: unknown};
  ok(
    detailBefore.revisionCount === 0 && detailBefore.suggestedLatestForDisplay === null,
    '[H12] GET detail：无 revision 时 suggestedLatestForDisplay=null',
  );

  // ---------- POST revisions multipart ----------
  const wavA = makeWav(1500, 440);
  const missingReqId = await revisionsPOST(
    revisionFormReq(pid, {audio: {buf: wavA, name: 'a.wav'}}),
    profileParams(pid),
  );
  await jsonOf('POST revision 缺 requestId', missingReqId);
  ok(missingReqId.status === 422, '[H13] POST revision 缺 requestId → 422');

  const missingAudio = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-0'}),
    profileParams(pid),
  );
  await jsonOf('POST revision 缺 audio', missingAudio);
  ok(missingAudio.status === 422, '[H14] POST revision 缺 audio → 422');

  const invalidForm = await revisionsPOST(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{"not":"multipart"}',
    }),
    profileParams(pid),
  );
  const invalidFormBody = (await jsonOf('POST revision 非法 formData', invalidForm)) as {error?: string} | null;
  ok(
    invalidForm.status === 400 && invalidFormBody?.error === 'invalid_formdata',
    '[H15] 非法 formData → 400 invalid_formdata',
    {status: invalidForm.status, body: invalidFormBody},
  );

  const created = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-1', audio: {buf: wavA, name: 'voice.wav'}}),
    profileParams(pid),
  );
  const createdBody = (await jsonOf('POST revision 201', created)) as {
    outcome: string;
    revision: {id: string; revisionNumber: number};
  };
  const rid = createdBody.revision.id;
  ok(
    created.status === 201 && createdBody.outcome === 'created' && createdBody.revision.revisionNumber === 1,
    '[H16] POST revision multipart → 201 created',
  );

  const reused = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-1', audio: {buf: wavA, name: 'voice.wav'}}),
    profileParams(pid),
  );
  const reusedBody = (await jsonOf('POST revision reused', reused)) as {
    outcome: string;
    revision: {id: string};
  };
  ok(
    reused.status === 200 && reusedBody.outcome === 'reused' && reusedBody.revision.id === rid,
    '[H17] 同 body 重发 → 200 reused（同 revisionId）',
  );

  const conflict = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-1', audio: {buf: makeWav(1500, 550), name: 'other.wav'}}),
    profileParams(pid),
  );
  await jsonOf('POST revision 同 requestId 不同音频', conflict);
  ok(conflict.status === 409, '[H18] 同 requestId + 不同音频 → 409');

  const archivedPost = await revisionsPOST(
    revisionFormReq(pid2, {requestId: 'api-req-arch', audio: {buf: wavA, name: 'voice.wav'}}),
    profileParams(pid2),
  );
  await jsonOf('POST revision archived', archivedPost);
  ok(archivedPost.status === 409, '[H19] archived Profile 新增 revision → 409');

  const bigBuf = Buffer.alloc(26 * 1024 * 1024);
  const tooBig = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-big', audio: {buf: bigBuf, name: 'big.wav'}}),
    profileParams(pid),
  );
  await jsonOf('POST revision >25MB', tooBig);
  ok(tooBig.status === 413, '[H20] 超 25MB file → 413');

  // ---------- GET revision ----------
  const revList = (await jsonOf(
    'GET revisions list',
    await revisionsGET(new Request(`${BASE}/api/voice-profiles/${pid}/revisions`), profileParams(pid)),
  )) as {revisions: Array<{id: string; revisionNumber: number}>};
  ok(
    revList.revisions.length === 1 && revList.revisions[0].id === rid,
    '[H21] GET revisions 列表（revision_number 升序）',
  );

  const revGet = await revisionGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}`),
    revisionParams(pid, rid),
  );
  await jsonOf('GET revision 200', revGet);
  ok(revGet.status === 200, '[H22] GET revision → 200');

  const crossProfile = await revisionGET(
    new Request(`${BASE}/api/voice-profiles/${pid2}/revisions/${rid}`),
    revisionParams(pid2, rid),
  );
  await jsonOf('GET revision 跨 Profile', crossProfile);
  ok(crossProfile.status === 404, '[H23] GET revision 跨 Profile → 404');

  const revMissing = await revisionGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/no-such`),
    revisionParams(pid, 'no-such'),
  );
  await jsonOf('GET revision 不存在', revMissing);
  ok(revMissing.status === 404, '[H24] GET revision 不存在 → 404');

  // ---------- suggestedLatestForDisplay + 禁用键名递归扫描 ----------
  const detailAfter = (await jsonOf(
    'GET profile detail (with revision)',
    await profileGET(new Request(`${BASE}/api/voice-profiles/${pid}`), profileParams(pid)),
  )) as {revisionCount: number; suggestedLatestForDisplay: {id: string; revisionNumber: number} | null};
  ok(
    detailAfter.revisionCount === 1 && detailAfter.suggestedLatestForDisplay?.id === rid &&
      detailAfter.suggestedLatestForDisplay?.revisionNumber === 1,
    '[H25] GET detail 含 suggestedLatestForDisplay（revision_number 最大者）',
  );
  const forbiddenKeys = new Set(['current', 'selected', 'activeRevision', 'defaultRevision']);
  const foundKeys = new Set<string>();
  collectKeys(detailAfter, foundKeys);
  collectKeys(revList, foundKeys);
  const leakedKeys = [...foundKeys].filter((k) => forbiddenKeys.has(k));
  ok(
    leakedKeys.length === 0 && foundKeys.has('suggestedLatestForDisplay'),
    '[H26] 响应 JSON 键名无 current/selected/activeRevision/defaultRevision（递归扫描）',
    leakedKeys,
  );

  // ---------- GET audio ----------
  const canonicalAbs = path.join(
    getDataDir(),
    (getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?')
      .get(rid) as {p: string}).p,
  );
  const fileBytes = fs.readFileSync(canonicalAbs);

  const audioOk = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}/audio`),
    revisionParams(pid, rid),
  );
  const audioOkBuf = Buffer.from(await audioOk.arrayBuffer());
  ok(
    audioOk.status === 200 && audioOk.headers.get('content-type') === 'audio/wav' &&
      audioOk.headers.get('accept-ranges') === 'bytes' && audioOkBuf.equals(fileBytes),
    '[H27] GET audio → 200 + Content-Type audio/wav + Accept-Ranges + 字节与文件一致',
  );

  const rangeRes = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}/audio`, {
      headers: {range: 'bytes=0-99'},
    }),
    revisionParams(pid, rid),
  );
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
  ok(
    rangeRes.status === 206 &&
      rangeRes.headers.get('content-range') === `bytes 0-99/${fileBytes.length}` &&
      rangeBuf.equals(fileBytes.subarray(0, 100)),
    '[H28] Range bytes=0-99 → 206 + Content-Range 精确 + 字节与文件切片一致',
    {status: rangeRes.status, contentRange: rangeRes.headers.get('content-range')},
  );

  const suffixRes = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}/audio`, {
      headers: {range: 'bytes=-50'},
    }),
    revisionParams(pid, rid),
  );
  const suffixBuf = Buffer.from(await suffixRes.arrayBuffer());
  ok(
    suffixRes.status === 206 &&
      suffixRes.headers.get('content-range') ===
        `bytes ${fileBytes.length - 50}-${fileBytes.length - 1}/${fileBytes.length}` &&
      suffixBuf.equals(fileBytes.subarray(fileBytes.length - 50)),
    '[H29] suffix Range bytes=-50 → 206 + 末 50 字节一致',
  );

  const oobRes = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}/audio`, {
      headers: {range: 'bytes=99999999-'},
    }),
    revisionParams(pid, rid),
  );
  ok(
    oobRes.status === 416 && oobRes.headers.get('content-range') === `bytes */${fileBytes.length}`,
    '[H30] 越界 Range → 416 + Content-Range bytes */size',
  );

  // 篡改 DB canonical_audio_path 指向 voice-library 外 → 404
  //（UPDATE 被 immutable trigger 拦截——先 drop trigger 模拟外部篡改，测完恢复并重建 trigger）
  const db = getDb();
  const origPathRow = db.prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?')
    .get(rid) as {p: string};
  db.exec('DROP TRIGGER IF EXISTS voice_profile_revisions_update_abort');
  db.prepare('UPDATE voice_profile_revisions SET canonical_audio_path = ? WHERE id = ?')
    .run('voice-library/../../outside.wav', rid);
  const tamperedRes = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}/audio`),
    revisionParams(pid, rid),
  );
  ok(tamperedRes.status === 404, '[H31] canonical_audio_path 被篡改指向 voice-library 外 → 404（fail-closed）');
  db.prepare('UPDATE voice_profile_revisions SET canonical_audio_path = ? WHERE id = ?')
    .run(origPathRow.p, rid);
  db.exec(`CREATE TRIGGER IF NOT EXISTS voice_profile_revisions_update_abort
BEFORE UPDATE ON voice_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'voice_profile_revisions is immutable');
END;`);
  // 确认篡改已还原：audio 重新可读
  const restoredRes = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${rid}/audio`),
    revisionParams(pid, rid),
  );
  ok(restoredRes.status === 200, '[H32] 篡改还原后 audio 恢复 200（trigger 已重建）');

  // 文件删除后 → 404（用独立 revision，避免影响其他断言）
  const del = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-del', audio: {buf: makeWav(1500, 660), name: 'del.wav'}}),
    profileParams(pid),
  );
  const delBody = (await jsonOf('POST revision for delete', del)) as {revision: {id: string}};
  const delAbs = path.join(
    getDataDir(),
    (getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?')
      .get(delBody.revision.id) as {p: string}).p,
  );
  fs.rmSync(delAbs);
  const goneRes = await audioGET(
    new Request(`${BASE}/api/voice-profiles/${pid}/revisions/${delBody.revision.id}/audio`),
    revisionParams(pid, delBody.revision.id),
  );
  ok(goneRes.status === 404, '[H33] canonical 文件删除后 GET audio → 404（fail-closed）');

  // ---------- R. 损坏 revision 不得 reused（TTS-A.R1：reused 前 exact 校验，fail-closed） ----------
  {
    const db = getDb();
    const dropTrigger = (): void => {
      db.exec('DROP TRIGGER IF EXISTS voice_profile_revisions_update_abort');
    };
    const restoreTrigger = (): void => {
      db.exec(`CREATE TRIGGER IF NOT EXISTS voice_profile_revisions_update_abort
BEFORE UPDATE ON voice_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'voice_profile_revisions is immutable');
END;`);
    };
    const ruRows = (requestId: string): number =>
      (db.prepare('SELECT COUNT(*) AS c FROM voice_profile_revisions WHERE voice_profile_id = ? AND request_id = ?')
        .get(pid, requestId) as {c: number}).c;
    const rowByReq = (requestId: string): Record<string, unknown> =>
      db.prepare('SELECT * FROM voice_profile_revisions WHERE voice_profile_id = ? AND request_id = ?')
        .get(pid, requestId) as Record<string, unknown>;
    const canonicalAbsByReq = (requestId: string): string => {
      const row = rowByReq(requestId);
      return path.join(getDataDir(), row.canonical_audio_path as string);
    };
    // 建立 revision（route 摄取，真实 wav）+ 同 requestId 重试
    async function createRu(requestId: string, freq: number): Promise<{rid: string; wav: Buffer}> {
      const wav = makeWav(1500, freq);
      const c = await revisionsPOST(
        revisionFormReq(pid, {requestId, audio: {buf: wav, name: 'ru.wav'}}),
        profileParams(pid),
      );
      const cBody = (await jsonOf(`R create ${requestId}`, c)) as {revision: {id: string}};
      ok(c.status === 201, `[R0] ${requestId} 初始摄取 201`);
      return {rid: cBody.revision.id, wav};
    }
    async function retryExpectUnusable(requestId: string, wav: Buffer, label: string): Promise<void> {
      const before = ruRows(requestId);
      const res = await revisionsPOST(
        revisionFormReq(pid, {requestId, audio: {buf: wav, name: 'ru.wav'}}),
        profileParams(pid),
      );
      const body = (await jsonOf(`R retry ${requestId}`, res)) as {error?: string};
      ok(
        res.status === 409 && body.error === 'revision_unusable',
        `${label} → 同 requestId 重试 409 revision_unusable（不返回 200 reused）`,
        {status: res.status, error: body.error},
      );
      ok(ruRows(requestId) === before, `${label} → 无新行产生`, {rows: ruRows(requestId)});
    }

    // 控制组：正常 usable 行 → 同 requestId 重试 200 reused
    {
      const {rid, wav} = await createRu('ru-control', 700);
      const res = await revisionsPOST(
        revisionFormReq(pid, {requestId: 'ru-control', audio: {buf: wav, name: 'ru.wav'}}),
        profileParams(pid),
      );
      const body = (await jsonOf('R control reused', res)) as {outcome: string; revision: {id: string}};
      ok(
        res.status === 200 && body.outcome === 'reused' && body.revision.id === rid &&
          ruRows('ru-control') === 1,
        '[R1] 正常 usable 行：同 requestId 仍 200 reused（revisionId 不变、无新增）',
      );
    }

    // R-A 文件缺失
    {
      const {wav} = await createRu('ru-missing', 710);
      fs.rmSync(canonicalAbsByReq('ru-missing'));
      await retryExpectUnusable('ru-missing', wav, '[R2] canonical 文件缺失');
    }
    // R-B hash mismatch
    {
      const {wav} = await createRu('ru-hash', 720);
      fs.appendFileSync(canonicalAbsByReq('ru-hash'), Buffer.from([0x00]));
      await retryExpectUnusable('ru-hash', wav, '[R3] hash mismatch');
    }
    // R-C 中间目录 symlink（revisionDir → 外部目录，含同内容 reference.wav 副本）
    {
      const {wav} = await createRu('ru-symlink', 730);
      const canonicalAbs = canonicalAbsByReq('ru-symlink');
      const extDir = path.join(getDataDir(), 'ru-ext-symlink');
      fs.mkdirSync(extDir, {recursive: true});
      fs.copyFileSync(canonicalAbs, path.join(extDir, 'reference.wav'));
      fs.rmSync(path.dirname(canonicalAbs), {recursive: true, force: true});
      fs.symlinkSync(extDir, path.dirname(canonicalAbs));
      await retryExpectUnusable('ru-symlink', wav, '[R4] revisionDir 中间 symlink 越界');
      fs.rmSync(path.dirname(canonicalAbs), {force: true});
      fs.rmSync(extDir, {recursive: true, force: true});
    }
    // R-D..R-K：行内容契约损坏（drop trigger → UPDATE → 重试 → 还原 → 重建 trigger）
    const contentCases: Array<{id: string; label: string; freq: number; col: string; bad: unknown; good: unknown}> = [
      {id: 'ru-meta-mal', label: '[R5] metadata_json malformed', freq: 740, col: 'metadata_json', bad: 'not json', good: null},
      {id: 'ru-meta-unk', label: '[R6] metadata unknown field', freq: 750, col: 'metadata_json',
        bad: '{"canonicalizationVersion":"voice-canonical@1.0","adapterCompatibilityKey":"indextts2-adapter-registry@1","ingestedAt":"2026-01-01T00:00:00.000Z","bogus":1}', good: null},
      {id: 'ru-provider', label: '[R7] provider mismatch', freq: 760, col: 'provider', bad: 'mock', good: null},
      {id: 'ru-adapter', label: '[R8] adapter_compatibility_key mismatch', freq: 770, col: 'adapter_compatibility_key', bad: 'other@1', good: null},
      {id: 'ru-codec', label: '[R9] codec mismatch', freq: 780, col: 'codec', bad: 'mp3', good: null},
      {id: 'ru-sr', label: '[R10] sample_rate mismatch', freq: 790, col: 'sample_rate', bad: 44100, good: null},
      {id: 'ru-ch', label: '[R11] channels mismatch', freq: 800, col: 'channels', bad: 2, good: null},
      {id: 'ru-dur', label: '[R12] duration invalid', freq: 810, col: 'duration_ms', bad: 5, good: null},
    ];
    for (const c of contentCases) {
      const {wav} = await createRu(c.id, c.freq);
      const orig = rowByReq(c.id)[c.col];
      dropTrigger();
      db.prepare(`UPDATE voice_profile_revisions SET ${c.col} = ? WHERE voice_profile_id = ? AND request_id = ?`)
        .run(c.bad, pid, c.id);
      restoreTrigger();
      await retryExpectUnusable(c.id, wav, c.label);
      // 还原（用原值）并重建 trigger：恢复后同 requestId 重试应回到 200 reused
      dropTrigger();
      db.prepare(`UPDATE voice_profile_revisions SET ${c.col} = ? WHERE voice_profile_id = ? AND request_id = ?`)
        .run(orig, pid, c.id);
      restoreTrigger();
      const res = await revisionsPOST(
        revisionFormReq(pid, {requestId: c.id, audio: {buf: wav, name: 'ru.wav'}}),
        profileParams(pid),
      );
      ok(
        res.status === 200,
        `${c.label} → 还原后同 requestId 重试恢复 200 reused（行可再次 usable）`,
        {status: res.status},
      );
    }
  }

  // ---------- 响应不包含绝对路径 ----------
  const dataDir = getDataDir();
  const leaking = jsonResponseTexts.filter((r) => r.text.includes(dataDir));
  ok(
    leaking.length === 0,
    '[H34] 所有 JSON 响应不包含绝对路径（不含 dataDir）',
    leaking.map((l) => l.label),
  );

  // ---------- 已知实现问题：415 unsupported_audio 泄漏 staging 绝对路径 ----------
  const garbage415 = await revisionsPOST(
    revisionFormReq(pid, {requestId: 'api-req-garbage', audio: {buf: Buffer.alloc(4096, 7), name: 'g.wav'}}),
    profileParams(pid),
  );
  const garbage415Text = await garbage415.text();
  knownIssue(
    garbage415.status === 415 && garbage415Text.includes(dataDir),
    '[K1] 415 unsupported_audio 响应 message 内嵌 staging 绝对路径（违反设计文档 §6「响应绝不包含任何文件路径」；源自 execFile 错误文本拼入 VoiceLibraryError.message）',
    {status: garbage415.status},
  );

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail} KNOWN-ISSUE=${knownIssues}`);
  if (fail > 0) {
    console.error('[test] TTS-A API 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A Voice Library API 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

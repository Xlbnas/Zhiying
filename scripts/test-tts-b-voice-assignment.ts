/**
 * TTS-B — Project Voice Assignment 测试（设计文档 §3/§4；A/B/C 覆盖）。
 *
 * A. Assignment schema：正常 parse / unknown field / 路径·音频·文本·performance·timing
 *    字段拒绝 / exact provider / exact hash / malformed profile·revision。
 * B. Assignment exact source：active Profile + usable Revision → candidate；
 *    missing Profile / missing Revision / cross Profile；archived 新建拒绝；
 *    archive 前创建后仍可读；file missing；hash mismatch；metadata/provider/adapter
 *    mismatch；新 revision 不 stale 旧 assignment；无 latest fallback。
 * C. Assignment idempotency：同 requestId 同 revision 复用；异 revision 409；
 *    并发恰好一个 artifact；跨项目拒绝；无 default/current 指针。
 *
 * 用法：npx tsx scripts/test-tts-b-voice-assignment.ts
 * 使用临时数据目录（data/test-tts-b-assignment），结束后清理。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join('data', 'test-tts-b-assignment');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {createVoiceProfile, setVoiceProfileStatus} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../src/lib/voice-library/revisions';
import {
  buildProjectVoiceAssignment,
  classifyProjectVoiceAssignment,
  AssignmentError,
  listProjectVoiceAssignmentCandidates,
} from '../src/lib/tts-b/assignment';
import {projectVoiceAssignmentArtifactV1Schema as assignmentSchema} from '../src/lib/tts-b/assignment-schema';
import {PROJECT_VOICE_ASSIGNMENT_KIND} from '../src/lib/tts-b/constants';
import {setAssignmentBeforeCommitFenceForTest} from '../src/lib/tts-b/assignment';
import {parseProjectVoiceAssignment} from '../src/lib/tts-b/assignment';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

async function expectAssignmentError(
  label: string,
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    ok(false, label, '预期抛错但未抛');
  } catch (err) {
    ok(err instanceof AssignmentError && err.code === code, label, err instanceof Error ? err.message : String(err));
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

const MOCK_DEPS: VoiceLibraryExecDeps = {
  ffprobeImpl: async () => ({
    durationMs: 2000,
    codec: 'pcm_s16le',
    sampleRate: 48000,
    channels: 1,
    hasVideo: false,
  }),
  ffmpegImpl: async (args: string[]) => {
    const inputPath = args[args.indexOf('-i') + 1];
    const outPath = args[args.length - 1];
    const h = crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
    fs.writeFileSync(outPath, Buffer.from(`FAKE-CANONICAL:${h}`));
  },
};

async function makeVoiceRevision(freq: number): Promise<{profileId: string; revisionId: string}> {
  const profile = createVoiceProfile({displayName: `voice-${freq}`});
  const result = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${freq}-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    MOCK_DEPS,
  );
  return {profileId: profile.id, revisionId: result.revision.id};
}

function assignmentCount(projectId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?')
    .get(projectId, PROJECT_VOICE_ASSIGNMENT_KIND) as {c: number}).c;
}

function envelopeCount(projectId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM voice_assignment_requests WHERE project_id = ?')
    .get(projectId) as {c: number}).c;
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const projectId = createProjectWithWorkflow({topic: 'tts-b', coreQuestion: 'q'}).project.id;
  const {profileId, revisionId} = await makeVoiceRevision(440);

  // ---------- A. Assignment schema ----------
  {
    const base = {
      schemaVersion: 'project-voice-assignment@1.0',
      compilerVersion: '1.0',
      projectId,
      source: {
        voiceProfileId: profileId,
        voiceProfileRevisionId: revisionId,
        revisionSchemaVersion: 'voice-profile-revision@1.0',
        provider: 'indextts2',
        canonicalAudioSha256: 'a'.repeat(64),
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
      },
    };
    ok(assignmentSchema.safeParse(base).success, '[A1] 合法 assignment content parse 通过');
    ok(!assignmentSchema.safeParse({...base, bogus: 1}).success, '[A2] unknown field 拒绝');
    for (const [key, val] of [
      ['canonicalAudioPath', 'voice-library/x/y/reference.wav'],
      ['absolutePath', '/app/data/voice-library'],
      ['transcript', '你好'],
      ['originalFilename', 'a.wav'],
      ['audioBytes', 'AAAA'],
      ['latest', true],
      ['current', true],
      ['pace', 'normal'],
      ['energy', 'high'],
      ['emotion', {mode: 'none'}],
      ['ttsJobId', 'job-1'],
      ['timing', {startMs: 0}],
    ] as const) {
      ok(
        !assignmentSchema.safeParse({...base, [key]: val}).success,
        `[A3] forbidden 字段 ${key} 拒绝`,
      );
    }
    ok(
      !assignmentSchema.safeParse({...base, source: {...base.source, provider: 'mock'}}).success &&
        !assignmentSchema.safeParse({...base, source: {...base.source, adapterCompatibilityKey: 'other'}}).success,
      '[A4] exact provider / adapter key 拒绝',
    );
    ok(
      !assignmentSchema.safeParse({...base, source: {...base.source, canonicalAudioSha256: 'zz'}}).success,
      '[A5] hash 格式非法拒绝',
    );
    // ID schema（TTS-B.R1 §八）：malformed → INVALID_PROFILE_ID/INVALID_REVISION_ID（400/422）；
    // well-formed UUID 但不存在 → PROFILE_NOT_FOUND/REVISION_NOT_FOUND（404）
    const missingUuid = '00000000-0000-4000-8000-000000000000';
    for (const [label, badId] of [
      ['空字符串', ''],
      ['no-such-profile', 'no-such-profile'],
      ['abc', 'abc'],
      ['路径字符串', '../etc/passwd'],
      ['含换行', 'abc\ndef'],
    ] as const) {
      await expectAssignmentError(
        `[A6-${label}] malformed profile ID → INVALID_PROFILE_ID`,
        () => buildProjectVoiceAssignment({projectId, voiceProfileId: badId, voiceProfileRevisionId: revisionId, requestId: 'req-a6-0001'}),
        'INVALID_PROFILE_ID',
      );
    }
    await expectAssignmentError(
      '[A6b] well-formed 但不存在 profile UUID → PROFILE_NOT_FOUND',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: missingUuid, voiceProfileRevisionId: revisionId, requestId: 'req-a6-0001'}),
      'PROFILE_NOT_FOUND',
    );
    await expectAssignmentError(
      '[A6c] malformed revision ID → INVALID_REVISION_ID',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: profileId, voiceProfileRevisionId: 'no-such-rev', requestId: 'req-a7-0001'}),
      'INVALID_REVISION_ID',
    );
    await expectAssignmentError(
      '[A7] well-formed 但不存在 revision UUID → REVISION_NOT_FOUND',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: profileId, voiceProfileRevisionId: missingUuid, requestId: 'req-a7-0001'}),
      'REVISION_NOT_FOUND',
    );
    await expectAssignmentError(
      '[A8] requestId 为空 → REQUEST_ID_REQUIRED',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: profileId, voiceProfileRevisionId: revisionId, requestId: ''}),
      'REQUEST_ID_REQUIRED',
    );
    await expectAssignmentError(
      '[A9] 项目不存在 → PROJECT_NOT_FOUND',
      () => buildProjectVoiceAssignment({projectId: 'no-such-project', voiceProfileId: profileId, voiceProfileRevisionId: revisionId, requestId: 'req-a9-0001'}),
      'PROJECT_NOT_FOUND',
    );
  }

  // ---------- B. Assignment exact source ----------
  {
    const b1 = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: profileId,
      voiceProfileRevisionId: revisionId,
      requestId: 'req-b1-0001',
    });
    ok(b1.kind === 'created' && assignmentCount(projectId) === 1, '[B1] active Profile + usable Revision → created candidate');
    const cand1 = (await listProjectVoiceAssignmentCandidates(projectId)).find((c) => c.artifact.id === b1.artifact.id);
    ok(cand1?.status === 'current_candidate', '[B2] 新 assignment 分类 current_candidate');

    // cross Profile：revision 属于另一个 profile → 用不同 profile 的 revision
    const other = await makeVoiceRevision(550);
    await expectAssignmentError(
      '[B3] cross Profile（revision 不属于该 profile）→ REVISION_NOT_FOUND',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: profileId, voiceProfileRevisionId: other.revisionId, requestId: 'req-b3-0001'}),
      'REVISION_NOT_FOUND',
    );

    // archived Profile 新建拒绝
    const {profileId: archPid, revisionId: archRid} = await makeVoiceRevision(660);
    const {setVoiceProfileStatus} = await import('../src/lib/voice-library/profiles');
    setVoiceProfileStatus(archPid, 'archived');
    await expectAssignmentError(
      '[B4] archived Profile 新建 assignment → PROFILE_ARCHIVED',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: archPid, voiceProfileRevisionId: archRid, requestId: 'req-b4-0001'}),
      'PROFILE_ARCHIVED',
    );
    // archive 前创建 → archive 后仍 current（historical exact read）
    setVoiceProfileStatus(archPid, 'active');
    const b5 = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: archPid,
      voiceProfileRevisionId: archRid,
      requestId: 'req-b5-0001',
    });
    setVoiceProfileStatus(archPid, 'archived');
    const candB5 = await classifyProjectVoiceAssignment(projectId, b5.artifact);
    ok(candB5.status === 'current_candidate', '[B5] archive 前创建的 assignment archive 后仍 current_candidate');
    setVoiceProfileStatus(archPid, 'active');

    // file missing → 新 build 失败；已建 assignment 分类 invalid_source
    const {profileId: fmPid, revisionId: fmRid} = await makeVoiceRevision(770);
    const fm = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: fmPid,
      voiceProfileRevisionId: fmRid,
      requestId: 'req-b6-0001',
    });
    const fmRow = getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?').get(fmRid) as {p: string};
    const fmAbs = path.join(
      process.cwd(),
      'data',
      'test-tts-b-assignment',
      'voice-library',
      fmRow.p.slice('voice-library/'.length),
    );
    fs.rmSync(fmAbs);
    await expectAssignmentError(
      '[B6] 文件缺失 → 新 build → REVISION_NOT_FOUND',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: fmPid, voiceProfileRevisionId: fmRid, requestId: 'req-b7-0001'}),
      'REVISION_NOT_FOUND',
    );
    const candB6 = await classifyProjectVoiceAssignment(projectId, fm.artifact);
    ok(candB6.status === 'invalid_source', '[B7] 文件缺失 → 已建 assignment 分类 invalid_source');

    // hash mismatch → 已建 assignment invalid_source
    const {profileId: hmPid, revisionId: hmRid} = await makeVoiceRevision(880);
    const hm = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: hmPid,
      voiceProfileRevisionId: hmRid,
      requestId: 'req-b8-0001',
    });
    const hmRow = getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?').get(hmRid) as {p: string};
    const hmAbs = path.join(process.cwd(), 'data', 'test-tts-b-assignment', 'voice-library', hmRow.p.slice('voice-library/'.length));
    fs.appendFileSync(hmAbs, Buffer.from([0x00]));
    const candHm = await classifyProjectVoiceAssignment(projectId, hm.artifact);
    ok(candHm.status === 'invalid_source' && (candHm.statusReason?.includes('hash_mismatch') ?? false), '[B8] hash 漂移 → assignment invalid_source');
    await expectAssignmentError(
      '[B9] hash 漂移 → 新 build → VOICE_UNUSABLE',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: hmPid, voiceProfileRevisionId: hmRid, requestId: 'req-b9-0001'}),
      'VOICE_UNUSABLE',
    );

    // metadata/provider/adapter mismatch（drop trigger 篡改 row → build VOICE_UNUSABLE）
    const {profileId: mmPid, revisionId: mmRid} = await makeVoiceRevision(990);
    const db = getDb();
    db.exec('DROP TRIGGER IF EXISTS voice_profile_revisions_update_abort');
    db.prepare('UPDATE voice_profile_revisions SET metadata_json = ? WHERE id = ?').run('not json', mmRid);
    db.exec(`CREATE TRIGGER IF NOT EXISTS voice_profile_revisions_update_abort
BEFORE UPDATE ON voice_profile_revisions
BEGIN SELECT RAISE(ABORT, 'voice_profile_revisions is immutable'); END;`);
    await expectAssignmentError(
      '[B10] metadata malformed → VOICE_UNUSABLE',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: mmPid, voiceProfileRevisionId: mmRid, requestId: 'req-b10-0001'}),
      'VOICE_UNUSABLE',
    );

    // 新 revision 不 stale 旧 assignment；无 latest fallback
    const {profileId: npPid, revisionId: npRid1} = await makeVoiceRevision(1010);
    const np = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: npPid,
      voiceProfileRevisionId: npRid1,
      requestId: 'req-b11-0001',
    });
    // 同 profile 上传新 revision（不同音频）
    const npRev2 = await ingestVoiceProfileRevision(
      {voiceProfileId: npPid, requestId: `rev-2-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 1110)},
      MOCK_DEPS,
    );
    const candNp = await classifyProjectVoiceAssignment(projectId, np.artifact);
    ok(
      candNp.status === 'current_candidate' && np.assignment.source.voiceProfileRevisionId === npRid1 &&
        npRev2.revision.id !== npRid1,
      '[B11] 新 revision 上传不 stale 旧 assignment（exact revisionId 固定，无 latest fallback）',
    );
  }

  // ---------- C. Assignment idempotency ----------
  {
    const {profileId: idPid, revisionId: idRid} = await makeVoiceRevision(1210);
    // 同 profile 的第二 revision（不同音频）——C2 冲突测试用
    const idRid2 = (
      await ingestVoiceProfileRevision(
        {voiceProfileId: idPid, requestId: `rev-2-c-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 1310)},
        MOCK_DEPS,
      )
    ).revision.id;
    const c1 = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: idPid,
      voiceProfileRevisionId: idRid,
      requestId: 'req-c1-0001',
    });
    const c1again = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: idPid,
      voiceProfileRevisionId: idRid,
      requestId: 'req-c1-0001',
    });
    ok(
      c1again.kind === 'reused' && c1again.artifact.id === c1.artifact.id && assignmentCount(projectId) >= 6 &&
        envelopeCount(projectId) === 6,
      '[C1] 同 requestId + 同 revision → 复用同一 artifact（200 reused）',
    );
    await expectAssignmentError(
      '[C2] 同 requestId + 不同 revision（同 profile）→ 409 REQUEST_ID_CONFLICT',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: idPid, voiceProfileRevisionId: idRid2, requestId: 'req-c1-0001'}),
      'REQUEST_ID_CONFLICT',
    );
    // 并发同 requestId → 恰好一个 artifact
    const {profileId: ccPid, revisionId: ccRid} = await makeVoiceRevision(1410);
    const conc = await Promise.all(
      Array.from({length: 5}, (_, i) =>
        buildProjectVoiceAssignment({projectId, voiceProfileId: ccPid, voiceProfileRevisionId: ccRid, requestId: 'req-c-conc-0001'}).catch((e) => e),
      ),
    );
    const created = conc.filter((r) => r && r.kind === 'created').length;
    const reused = conc.filter((r) => r && r.kind === 'reused').length;
    const artifactIds = new Set(conc.filter((r) => r && r.artifact).map((r) => (r as {artifact: {id: string}}).artifact.id));
    ok(
      created === 1 && reused === 4 && artifactIds.size === 1,
      '[C3] 并发 5× 同 requestId → 恰好 1 created + 4 reused、同一 artifact',
      {created, reused, artifactIds: [...artifactIds]},
    );
    // 跨项目：同 requestId 在另一项目可用（不同 envelope 行）；不存在的项目 404
    const projectB = createProjectWithWorkflow({topic: 'tts-b-b', coreQuestion: 'q'}).project.id;
    const cCross = await buildProjectVoiceAssignment({
      projectId: projectB,
      voiceProfileId: idPid,
      voiceProfileRevisionId: idRid,
      requestId: 'req-c1-0001',
    });
    ok(cCross.kind === 'created', '[C4] 同 requestId 跨项目 → 独立创建（per-project envelope）');
    await expectAssignmentError(
      '[C5] 跨项目引用不存在项目 → PROJECT_NOT_FOUND',
      () => buildProjectVoiceAssignment({projectId: 'no-such', voiceProfileId: idPid, voiceProfileRevisionId: idRid, requestId: 'req-c5-0001'}),
      'PROJECT_NOT_FOUND',
    );
    // 无 default/current 指针：projects 表不被修改
    const projRow = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>;
    ok(
      projRow.m7_pipeline_snapshot_id === null && projRow.pipeline_version === 'm6',
      '[C6] assignment 不更新 projects 指针（m7_pipeline_snapshot_id NULL、pipeline m6）',
    );
  }

  // ---------- C-ext：archived replay / commit fence / source 自洽 ----------
  {
    // C7：archive 后同 requestId 同 revision → 200 reused（historical replay，不 PROFILE_ARCHIVED）
    const {profileId: arPid, revisionId: arRid} = await makeVoiceRevision(1510);
    const ar = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: arPid,
      voiceProfileRevisionId: arRid,
      requestId: 'req-ar-replay-0001',
    });
    setVoiceProfileStatus(arPid, 'archived');
    const arReplay = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: arPid,
      voiceProfileRevisionId: arRid,
      requestId: 'req-ar-replay-0001',
    });
    ok(
      arReplay.kind === 'reused' && arReplay.artifact.id === ar.artifact.id,
      '[C7] archive 后同 requestId 同 revision → 200 reused（historical replay）',
    );
    // archive 后新 requestId → PROFILE_ARCHIVED
    await expectAssignmentError(
      '[C8] archive 后新 requestId → PROFILE_ARCHIVED',
      () => buildProjectVoiceAssignment({projectId, voiceProfileId: arPid, voiceProfileRevisionId: arRid, requestId: 'req-ar-new-0001'}),
      'PROFILE_ARCHIVED',
    );
    setVoiceProfileStatus(arPid, 'active');
  }

  // C9：commit fence —— initial precheck 后、事务前 archive Profile → 创建失败、0/0
  {
    const {profileId: cfPid, revisionId: cfRid} = await makeVoiceRevision(1610);
    const beforeCount = assignmentCount(projectId);
    setAssignmentBeforeCommitFenceForTest(() => setVoiceProfileStatus(cfPid, 'archived'));
    let err: unknown = null;
    try {
      await buildProjectVoiceAssignment({projectId, voiceProfileId: cfPid, voiceProfileRevisionId: cfRid, requestId: 'req-cf-0001'});
    } catch (e) {
      err = e;
    }
    setAssignmentBeforeCommitFenceForTest(null);
    ok(
      err instanceof AssignmentError && err.code === 'PROFILE_ARCHIVED' &&
        assignmentCount(projectId) === beforeCount && envelopeCount(projectId) === beforeCount,
      '[C9] commit fence：事务前 archive → 创建失败、artifact/envelope 未新增',
    );
    setVoiceProfileStatus(cfPid, 'active');
  }

  // C10：commit fence —— 事务前删除 reference 文件 → 创建失败、0/0
  {
    const {profileId: fdPid, revisionId: fdRid} = await makeVoiceRevision(1710);
    const beforeCount = assignmentCount(projectId);
    const fdRow = getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?').get(fdRid) as {p: string};
    setAssignmentBeforeCommitFenceForTest(() => {
      fs.rmSync(path.join(process.cwd(), 'data', 'test-tts-b-assignment', 'voice-library', fdRow.p.slice('voice-library/'.length)));
    });
    let err: unknown = null;
    try {
      await buildProjectVoiceAssignment({projectId, voiceProfileId: fdPid, voiceProfileRevisionId: fdRid, requestId: 'req-cf-0002'});
    } catch (e) {
      err = e;
    }
    setAssignmentBeforeCommitFenceForTest(null);
    ok(
      err instanceof AssignmentError &&
        (err.code === 'REVISION_NOT_FOUND' || err.code === 'VOICE_UNUSABLE') &&
        assignmentCount(projectId) === beforeCount && envelopeCount(projectId) === beforeCount,
      '[C10] commit fence：事务前 reference 删除 → 创建失败（final exact validator fail-closed）、artifact/envelope 0/0',
      {code: err instanceof AssignmentError ? err.code : String(err)},
    );
  }

  // C11：source 自洽（semantic fence——部分字段保持 schema 可 parse 仅值不一致 →
  // ASSIGNMENT_SOURCE_MISMATCH；zod literal 字段（provider/adapter/schema）变异 →
  // schema 拒绝，同样 fail-closed invalid_source）
  {
    const {profileId: scPid, revisionId: scRid} = await makeVoiceRevision(1810);
    // 同 profile 第二 revision（供 revisionId 变异使用——同 profile 不同 revision
    // 时 descriptor 可读，hash 不一致 → semantic ASSIGNMENT_SOURCE_MISMATCH）
    const scRev2 = (
      await ingestVoiceProfileRevision(
        {voiceProfileId: scPid, requestId: `rev-2-sc-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 1820)},
        MOCK_DEPS,
      )
    ).revision;
    const sc = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: scPid,
      voiceProfileRevisionId: scRid,
      requestId: 'req-sc-0001',
    });
    const missingUuid = '00000000-0000-4000-8000-000000000099';
    // semantic cases：schema 保持可 parse，仅字段值不一致
    const semanticCases: Array<{label: string; mutate: (c: Record<string, unknown>) => void}> = [
      {label: 'canonicalAudioSha256 改错', mutate: (c) => { (c.source as Record<string, unknown>).canonicalAudioSha256 = 'e'.repeat(64); }},
      {label: 'projectId 改错', mutate: (c) => { c.projectId = '00000000-0000-4000-8000-0000000000aa'; }},
      {label: 'voiceProfileId 改另一个有效 UUID（缺失）', mutate: (c) => { (c.source as Record<string, unknown>).voiceProfileId = missingUuid; }},
      {label: 'voiceProfileRevisionId 改同 profile 另一 revision', mutate: (c) => { (c.source as Record<string, unknown>).voiceProfileRevisionId = scRev2.id; }},
    ];
    for (const c of semanticCases) {
      const original = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(sc.artifact.id) as {content_json: string}).content_json;
      const mutated = JSON.parse(original) as Record<string, unknown>;
      c.mutate(mutated);
      const parsed = parseProjectVoiceAssignment({id: sc.artifact.id, project_id: projectId, kind: PROJECT_VOICE_ASSIGNMENT_KIND, version: 1, content_json: JSON.stringify(mutated), created_at: ''});
      if (parsed === null) {
        ok(false, `[C11-${c.label}] 前置：变异后仍可 parse（应为 semantic 而非 schema 拒绝）`);
        continue;
      }
      const candidate = await classifyProjectVoiceAssignment(projectId, {
        id: sc.artifact.id, project_id: projectId, kind: PROJECT_VOICE_ASSIGNMENT_KIND, version: 1,
        content_json: JSON.stringify(mutated), created_at: '',
      });
      ok(
        candidate.status === 'invalid_source' &&
          ((candidate.statusReason?.includes('ASSIGNMENT_SOURCE_MISMATCH') ?? false) ||
            (candidate.statusReason?.includes('不可读') ?? false)),
        `[C11-${c.label}] source 不一致 → invalid_source（ASSIGNMENT_SOURCE_MISMATCH 或 descriptor 不可读，均 fail-closed）`,
        {status: candidate.status, reason: candidate.statusReason},
      );
    }
    // schema-level cases：provider/adapter/schema 是 zod literal，变异 → schema 拒绝（fail-closed）
    for (const [label, mutate] of [
      ['provider 改 mock', (c: Record<string, unknown>) => { (c.source as Record<string, unknown>).provider = 'mock'; }],
      ['adapter key 改错', (c: Record<string, unknown>) => { (c.source as Record<string, unknown>).adapterCompatibilityKey = 'other@1'; }],
      ['revisionSchemaVersion 改错', (c: Record<string, unknown>) => { (c.source as Record<string, unknown>).revisionSchemaVersion = 'voice-profile-revision@9.9'; }],
    ] as const) {
      const original = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(sc.artifact.id) as {content_json: string}).content_json;
      const mutated = JSON.parse(original) as Record<string, unknown>;
      mutate(mutated);
      const parsed = parseProjectVoiceAssignment({id: sc.artifact.id, project_id: projectId, kind: PROJECT_VOICE_ASSIGNMENT_KIND, version: 1, content_json: JSON.stringify(mutated), created_at: ''});
      ok(parsed === null, `[C11-${label}] zod literal 变异 → schema 拒绝（同样 fail-closed）`);
    }
  }

  // C12：既有 envelope 的 artifact 损坏（source mismatch）→ 同 requestId replay → ASSIGNMENT_UNUSABLE，不重建
  {
    const {profileId: euPid, revisionId: euRid} = await makeVoiceRevision(1910);
    const eu = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: euPid,
      voiceProfileRevisionId: euRid,
      requestId: 'req-eu-0001',
    });
    const row = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(eu.artifact.id) as {content_json: string});
    const mutated = JSON.parse(row.content_json) as Record<string, unknown>;
    (mutated.source as Record<string, unknown>).canonicalAudioSha256 = 'f'.repeat(64);
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(mutated), eu.artifact.id);
    const beforeCount = assignmentCount(projectId);
    let err: unknown = null;
    try {
      await buildProjectVoiceAssignment({projectId, voiceProfileId: euPid, voiceProfileRevisionId: euRid, requestId: 'req-eu-0001'});
    } catch (e) {
      err = e;
    }
    ok(
      err instanceof AssignmentError && err.code === 'ASSIGNMENT_UNUSABLE' &&
        assignmentCount(projectId) === beforeCount,
      '[C12] 既有 envelope 的 artifact source 不一致 → replay ASSIGNMENT_UNUSABLE（不重建、不新增）',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-B voice assignment 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-B Project Voice Assignment 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

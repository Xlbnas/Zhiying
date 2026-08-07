/**
 * TTS-A Voice Library — Schema / Migration / Profile / Revision schema 测试。
 *
 * 覆盖（设计文档 docs/TTS_A_VOICE_LIBRARY_DESIGN.md §3/§4）：
 *  A. migration：全新临时 DB 建表成功；getDb 关闭后重开幂等；
 *     voice_profiles / voice_profile_revisions 两表 + 索引 + 两个 immutable trigger 存在（sqlite_master 查证）。
 *  A2. 旧 DB 升级：先用「无 TTS-A 表」的旧 schema 快照（完整当前 schema  drop 掉 TTS-A 对象）
 *     造旧库并插入 3 行全字段 tts_jobs 历史行 → getDb 迁移后 TTS-A 对象就绪，旧行逐字段不变。
 *  B. Profile：create、display_name trim、>80 拒绝、description >500 拒绝、strict 未知字段拒绝、
 *     archive/unarchive、archived 不可新增 revision（profile_archived/409）、
 *     archive 后 revision 行仍在且 exact 可读。
 *  C. Revision schema：exact lookup 命中；跨 Profile → null；不存在 → null；
 *     revision_number 从 1 连续（MAX+1）；UNIQUE(voice_profile_id, revision_number) 冲突；
 *     UNIQUE(voice_profile_id, request_id) 冲突；UPDATE/DELETE trigger abort；
 *     canonical 文件被外部删除 → exact null；hash 漂移 → usable:false + hash_mismatch；
 *     无 rollback / getLatest 业务接口（append-only，不伪装支持——见脚本末尾断言与注释）。
 *
 * 音频摄取使用注入的 ffprobeImpl/ffmpegImpl mock（真实 ffmpeg 路径由
 * test-tts-a-voice-library-ingest.ts 覆盖），本脚本聚焦 DB/schema 语义。
 *
 * 用法：npx tsx scripts/test-tts-a-voice-library-schema.ts
 * 使用临时数据目录（data/test-tts-a-schema*），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const DATA_DIR = path.join('data', 'test-tts-a-schema');
const LEGACY_DATA_DIR = path.join('data', 'test-tts-a-schema-legacy');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir, getDbPath} from '../src/lib/db';
import {
  createVoiceProfile,
  getVoiceProfile,
  listVoiceProfiles,
  setVoiceProfileStatus,
} from '../src/lib/voice-library/profiles';
import {
  getVoiceProfileRevisionExact,
  ingestVoiceProfileRevision,
  listVoiceProfileRevisions,
  type VoiceLibraryExecDeps,
} from '../src/lib/voice-library/revisions';
import {
  createVoiceProfileBodySchema,
  VoiceLibraryError,
  type VoiceProfileRevisionRow,
} from '../src/lib/voice-library/types';
import {VOICE_PROFILE_REVISION_SCHEMA_VERSION} from '../src/lib/voice-library/constants';
import * as revisionsModule from '../src/lib/voice-library/revisions';

let pass = 0;
let fail = 0;

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

async function expectError(
  label: string,
  fn: () => unknown | Promise<unknown>,
  check: (err: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    ok(false, label, '预期抛错但未抛');
  } catch (err) {
    ok(check(err), label, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

/** 注入 mock：canonical 字节由输入内容派生（同输入→同 hash，异输入→异 hash）。 */
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

async function ingestMock(profileId: string, requestId: string, content: string) {
  return ingestVoiceProfileRevision(
    {voiceProfileId: profileId, requestId, audioBuffer: Buffer.from(content)},
    MOCK_DEPS,
  );
}

/** 直接 SQL 插入最小合法 revision 行（用于 UNIQUE 冲突 / trigger 测试，绕过摄取管线）。 */
function insertRevisionRowDirect(fields: {
  id: string;
  profileId: string;
  revisionNumber: number;
  requestId: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO voice_profile_revisions
         (id, schema_version, voice_profile_id, revision_number, request_id, provider,
          adapter_compatibility_key, original_audio_sha256, canonical_audio_sha256,
          original_filename_display, canonical_audio_path, codec, sample_rate, channels,
          duration_ms, transcript, language, metadata_json, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, 'indextts2', 'indextts2-adapter-registry@1', ?, ?, NULL, ?, 'pcm_s16le', 48000, 1, 2000, NULL, NULL, '{}', ?, ?)`,
    )
    .run(
      fields.id,
      VOICE_PROFILE_REVISION_SCHEMA_VERSION,
      fields.profileId,
      fields.revisionNumber,
      fields.requestId,
      crypto.randomBytes(32).toString('hex'),
      crypto.randomBytes(32).toString('hex'),
      `voice-library/${fields.profileId}/${fields.id}/reference.wav`,
      `sha256:${crypto.randomBytes(32).toString('hex')}`,
      new Date().toISOString(),
    );
}

function sqliteMasterNames(type: string): string[] {
  return (getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = ?`)
    .all(type) as Array<{name: string}>).map((r) => r.name);
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  fs.rmSync(path.resolve(process.cwd(), LEGACY_DATA_DIR), {recursive: true, force: true});

  // ---------- A. 全新 DB migration ----------
  getDb();
  ok(fs.existsSync(getDbPath()), '[A1] 全新临时 DB migration 成功（zhiying.db 已创建）');
  const tables = sqliteMasterNames('table');
  ok(tables.includes('voice_profiles'), '[A2] voice_profiles 表存在', tables);
  ok(tables.includes('voice_profile_revisions'), '[A3] voice_profile_revisions 表存在', tables);
  ok(
    sqliteMasterNames('index').includes('idx_voice_profile_revisions_profile'),
    '[A4] idx_voice_profile_revisions_profile 索引存在',
  );
  const triggers = sqliteMasterNames('trigger');
  ok(
    triggers.includes('voice_profile_revisions_update_abort') &&
      triggers.includes('voice_profile_revisions_delete_abort'),
    '[A5] UPDATE/DELETE 两个 immutable trigger 存在',
    triggers,
  );

  closeDb();
  let reopenThrew: unknown = null;
  try {
    getDb();
  } catch (err) {
    reopenThrew = err;
  }
  ok(
    reopenThrew === null && sqliteMasterNames('table').includes('voice_profiles'),
    '[A6] getDb 关闭后重开幂等（二次 migration 无错、表仍在）',
    reopenThrew,
  );

  // ---------- A2. 旧 DB 升级（无 TTS-A 表的旧 schema 快照） ----------
  // 造旧库：完整当前 schema → drop TTS-A 对象 → 插入 1 个 project + 3 行全字段 tts_jobs。
  process.env.ZHIYING_DATA_DIR = LEGACY_DATA_DIR;
  closeDb();
  getDb();
  closeDb();
  {
    const legacy = new Database(path.join(path.resolve(process.cwd(), LEGACY_DATA_DIR), 'zhiying.db'));
    legacy.exec(`
      DROP TRIGGER IF EXISTS voice_profile_revisions_update_abort;
      DROP TRIGGER IF EXISTS voice_profile_revisions_delete_abort;
      DROP TABLE IF EXISTS voice_profile_revisions;
      DROP TABLE IF EXISTS voice_profiles;
    `);
    const now = '2025-01-01T00:00:00.000Z';
    legacy
      .prepare(
        `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id,
           current_stage, created_at, updated_at, pipeline_version, m7_pipeline_snapshot_id)
         VALUES ('legacy-p1', '历史项目', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut',
           'tts', ?, ?, 'm6', NULL)`,
      )
      .run(now, now);
    const legacyJobs = [
      ['legacy-job-1', 'plan-art-1', 3, 'N001', 'mock', 'default', '1', 'succeeded',
        '{"text":"第一句"}', 'tts/legacy-p1/N001.wav', 1234, 'aaaa'.repeat(16),
        '{"provider":"mock"}', now, now, now, 'w-1', now, now, 1, 2, 100, null, null, 0],
      ['legacy-job-2', 'plan-art-1', 3, 'N002', 'indextts2', 'default', '1', 'failed',
        '{"text":"第二句"}', null, null, null, null, now, now, now, 'w-1', now, now, 2, 2, 40,
        'PROVIDER_ERROR', 'boom', 0],
      ['legacy-job-3', 'plan-art-2', 1, 'N003', 'mock', 'default', '2', 'queued',
        '{"text":"第三句"}', null, null, null, null, now, null, null, null, null, null, 0, 2, 0,
        null, null, 1],
    ] as const;
    // C.2 后 tts_jobs 含 FK（voice_profile_revision_id/claim_id/result_artifact_id REFERENCES），
    // prepare 严格要求被引用表存在——先 getDb 重开补建 TTS-A 表，再 prepare/write legacy 行
    // （legacy 行新列全 NULL，FK 零约束；与 production 升级路径一致：voice 表先于 C.2 存在）。
    getDb();
    const insertJob = legacy.prepare(
      `INSERT INTO tts_jobs
         (id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id, provider,
          voice_profile_id, voice_profile_revision, status, payload_json, output_path,
          duration_ms, audio_sha256, result_json, queued_at, started_at, finished_at,
          claimed_by, claimed_at, heartbeat_at, attempt, max_attempts, progress,
          error_code, error_message, cancel_requested)
       VALUES (?, 'legacy-p1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of legacyJobs) insertJob.run(...row);
    legacy.close();

    // 重新走 getDb 迁移（TTS-A 对象由 CREATE TABLE/TRIGGER IF NOT EXISTS 补建——已在上一步补建）
    const tablesAfter = sqliteMasterNames('table');
    ok(
      tablesAfter.includes('voice_profiles') && tablesAfter.includes('voice_profile_revisions'),
      '[A7] 旧库升级后 TTS-A 两表就绪',
    );
    const triggerAfter = sqliteMasterNames('trigger');
    ok(
      triggerAfter.includes('voice_profile_revisions_update_abort') &&
        triggerAfter.includes('voice_profile_revisions_delete_abort'),
      '[A8] 旧库升级后两个 immutable trigger 就绪',
    );
    const rowsAfter = getDb()
      .prepare('SELECT * FROM tts_jobs WHERE project_id = ? ORDER BY id ASC')
      .all('legacy-p1') as Array<Record<string, unknown>>;
    const sortedExpected = [...legacyJobs].sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
    const cols = [
      'id', 'project_id', 'narration_plan_artifact_id', 'narration_plan_version', 'unit_id',
      'provider', 'voice_profile_id', 'voice_profile_revision', 'status', 'payload_json',
      'output_path', 'duration_ms', 'audio_sha256', 'result_json', 'queued_at', 'started_at',
      'finished_at', 'claimed_by', 'claimed_at', 'heartbeat_at', 'attempt', 'max_attempts',
      'progress', 'error_code', 'error_message', 'cancel_requested',
    ];
    // 显式逐字段比对：expected 数组顺序 = INSERT 列顺序
    let allMatch = rowsAfter.length === 3;
    const expectedRows = sortedExpected.map((r) => ({
      id: r[0], project_id: 'legacy-p1', narration_plan_artifact_id: r[1],
      narration_plan_version: r[2], unit_id: r[3], provider: r[4],
      voice_profile_id: r[5], voice_profile_revision: r[6], status: r[7],
      payload_json: r[8], output_path: r[9], duration_ms: r[10], audio_sha256: r[11],
      result_json: r[12], queued_at: r[13], started_at: r[14], finished_at: r[15],
      claimed_by: r[16], claimed_at: r[17], heartbeat_at: r[18], attempt: r[19],
      max_attempts: r[20], progress: r[21], error_code: r[22], error_message: r[23],
      cancel_requested: r[24],
    }));
    for (let i = 0; i < 3 && allMatch; i++) {
      for (const col of cols) {
        if (rowsAfter[i][col] !== expectedRows[i][col as keyof typeof expectedRows[number]]) {
          allMatch = false;
          console.log('      字段不一致:', rowsAfter[i].id, col, rowsAfter[i][col], '≠', expectedRows[i][col as keyof typeof expectedRows[number]]);
        }
      }
    }
    ok(allMatch, '[A9] 旧库升级后 3 行 tts_jobs 历史行逐字段不变');
  }
  process.env.ZHIYING_DATA_DIR = DATA_DIR;
  closeDb();
  getDb();

  // ---------- B. Profile ----------
  const p1 = createVoiceProfile({displayName: '  我的声音  ', description: 'desc'});
  ok(p1.display_name === '我的声音', '[B1] create + display_name trim 生效', p1.display_name);
  ok(
    p1.status === 'active' && p1.provider === 'indextts2' && p1.schema_version === 'voice-profile@1.0',
    '[B2] 新 Profile 默认 active / provider=indextts2 / schema_version 正确',
  );
  await expectError(
    '[B3] displayName >80 拒绝（422 invalid_request）',
    () => createVoiceProfile({displayName: 'x'.repeat(81)}),
    (err) => err instanceof VoiceLibraryError && err.code === 'invalid_request' && err.httpStatus === 422,
  );
  await expectError(
    '[B4] displayName trim 后为空拒绝（422）',
    () => createVoiceProfile({displayName: '   '}),
    (err) => err instanceof VoiceLibraryError && err.code === 'invalid_request' && err.httpStatus === 422,
  );
  await expectError(
    '[B5] description >500 拒绝（422）',
    () => createVoiceProfile({displayName: 'ok', description: 'y'.repeat(501)}),
    (err) => err instanceof VoiceLibraryError && err.code === 'invalid_request' && err.httpStatus === 422,
  );
  ok(
    !createVoiceProfileBodySchema.safeParse({displayName: 'a', bogusField: 1}).success,
    '[B6] strict schema 拒绝未知字段（API 层 422 的契约来源）',
  );
  ok(
    listVoiceProfiles().some((p) => p.id === p1.id) && getVoiceProfile('no-such-id') === null,
    '[B7] list 包含新 Profile；未知 id getVoiceProfile → null',
  );
  const archived = setVoiceProfileStatus(p1.id, 'archived');
  ok(archived?.status === 'archived', '[B8] archive → status=archived');
  const reactivated = setVoiceProfileStatus(p1.id, 'active');
  ok(reactivated?.status === 'active', '[B9] unarchive → status=active');
  ok(setVoiceProfileStatus('no-such-id', 'archived') === null, '[B10] 未知 Profile setStatus → null');

  // ---------- C. Revision schema ----------
  const r1 = await ingestMock(p1.id, 'req-1', 'audio-content-A');
  ok(
    r1.outcome === 'created' && r1.revision.revision_number === 1,
    '[C1] 首个 revision created 且 revision_number=1',
  );
  const r2 = await ingestMock(p1.id, 'req-2', 'audio-content-B');
  const r3 = await ingestMock(p1.id, 'req-3', 'audio-content-C');
  ok(
    r2.revision.revision_number === 2 && r3.revision.revision_number === 3,
    '[C2] revision_number 从 1 连续递增（1,2,3）',
    [r1.revision.revision_number, r2.revision.revision_number, r3.revision.revision_number],
  );

  const exact1 = await getVoiceProfileRevisionExact(p1.id, r1.revision.id);
  ok(
    exact1 !== null && exact1.usable === true && exact1.revisionNumber === 1 &&
      exact1.requestId === 'req-1' && exact1.unusableReason === null,
    '[C3] exact lookup 命中且 usable',
  );
  const p2 = createVoiceProfile({displayName: '另一个声音'});
  ok(
    (await getVoiceProfileRevisionExact(p2.id, r1.revision.id)) === null,
    '[C4] 跨 Profile exact lookup → null',
  );
  ok(
    (await getVoiceProfileRevisionExact(p1.id, 'no-such-revision')) === null &&
      (await getVoiceProfileRevisionExact('no-such-profile', r1.revision.id)) === null,
    '[C5] Revision / Profile 不存在 → null',
  );

  await expectError(
    '[C6] UNIQUE(voice_profile_id, revision_number) 冲突',
    () => insertRevisionRowDirect({id: crypto.randomUUID(), profileId: p1.id, revisionNumber: 1, requestId: 'req-x'}),
    (err) => String(err).includes('UNIQUE'),
  );
  await expectError(
    '[C7] UNIQUE(voice_profile_id, request_id) 冲突',
    () => insertRevisionRowDirect({id: crypto.randomUUID(), profileId: p1.id, revisionNumber: 99, requestId: 'req-1'}),
    (err) => String(err).includes('UNIQUE'),
  );

  await expectError(
    '[C8] UPDATE voice_profile_revisions → trigger abort',
    () => getDb().prepare('UPDATE voice_profile_revisions SET transcript = ? WHERE id = ?').run('x', r1.revision.id),
    (err) => String(err).includes('immutable'),
  );
  await expectError(
    '[C9] DELETE voice_profile_revisions → trigger abort',
    () => getDb().prepare('DELETE FROM voice_profile_revisions WHERE id = ?').run(r1.revision.id),
    (err) => String(err).includes('immutable'),
  );
  const stillThere = getDb()
    .prepare('SELECT COUNT(*) AS c FROM voice_profile_revisions WHERE voice_profile_id = ?')
    .get(p1.id) as {c: number};
  ok(stillThere.c === 3, '[C10] trigger abort 后 3 行 revision 仍在', stillThere.c);

  // archived 不可新增 revision
  setVoiceProfileStatus(p1.id, 'archived');
  await expectError(
    '[C11] archived Profile 新增 revision → profile_archived (409)',
    () => ingestMock(p1.id, 'req-4', 'audio-content-D'),
    (err) => err instanceof VoiceLibraryError && err.code === 'profile_archived' && err.httpStatus === 409,
  );
  // archive 后 revision 行仍在且 historical exact 可读
  const rowsArchived = listVoiceProfileRevisions(p1.id);
  const exactArchived = await getVoiceProfileRevisionExact(p1.id, r1.revision.id);
  ok(
    rowsArchived.length === 3 && exactArchived !== null && exactArchived.usable === true,
    '[C12] archive 后 revision 行仍在且 exact 可读（historical read 不受 archive 影响）',
  );
  setVoiceProfileStatus(p1.id, 'active');

  // canonical 文件被外部删除 → exact null
  const r2Abs = path.join(getDataDir(), r2.revision.canonical_audio_path);
  fs.rmSync(r2Abs);
  ok(
    (await getVoiceProfileRevisionExact(p1.id, r2.revision.id)) === null,
    '[C13] canonical 文件被外部删除 → exact → null（不当 usable）',
  );

  // hash 漂移（改写文件字节）→ usable:false + hash_mismatch
  const r3Abs = path.join(getDataDir(), r3.revision.canonical_audio_path);
  fs.appendFileSync(r3Abs, Buffer.from([0x00]));
  const drifted = await getVoiceProfileRevisionExact(p1.id, r3.revision.id);
  ok(
    drifted !== null && drifted.usable === false && drifted.unusableReason === 'hash_mismatch',
    '[C14] hash 漂移 → descriptor usable:false + unusableReason=hash_mismatch（fail-closed）',
  );

  // rollback 不伪装支持：本实现为 append-only，不提供任何 revision rollback / 删除 / getLatest
  // 业务接口。这里不需要真做 rollback——断言模块没有导出这类能力即可（设计文档 §3/§8：
  // immutable revision，UI 显示建议只能叫 suggestedLatestForDisplay）。
  const mod = revisionsModule as unknown as Record<string, unknown>;
  ok(
    typeof mod['rollbackVoiceProfileRevision'] === 'undefined' &&
      typeof mod['deleteVoiceProfileRevision'] === 'undefined' &&
      typeof mod['getLatestVoiceRevision'] === 'undefined',
    '[C15] 无 rollback/delete/getLatest 导出（append-only，不伪装支持 rollback）',
  );

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  fs.rmSync(path.resolve(process.cwd(), LEGACY_DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-A schema 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A Voice Library schema 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

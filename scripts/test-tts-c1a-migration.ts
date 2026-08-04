/**
 * TTS-C.1A Migration 测试（A）：
 * - frozen §2 片段 hash 绑定（build-tts-c1a-migration.ts 复算一致）；
 * - clean DB apply / production-like 旧 DB apply / 重跑幂等；
 * - foreign_key_check 空 / integrity_check ok；
 * - tts_jobs 351 行 fixture hash 不变；
 * - publication/activation/legacy 表存在但 0 行。
 *
 * 用法：npx tsx scripts/test-tts-c1a-migration.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {getDb, closeDb} from '../src/lib/db';
import {applyTtsC1aMigration, isTtsC1aMigrationApplied} from '../src/lib/tts-c/migration';
import {TTS_C1A_FROZEN_FRAGMENTS_SHA256, TTS_C1A_APPLIED_SQL_SHA256, TTS_C1A_TABLES} from '../src/lib/tts-c/migration.generated';
import {ok, pass, fail, summary} from './lib/tts-c1a-test-utils';

const TAG = 'test-tts-c1a-migration';
const DATA_DIR = path.join('data', TAG);
fs.rmSync(DATA_DIR, {recursive: true, force: true});
process.env.ZHIYING_DATA_DIR = DATA_DIR;
closeDb();

// 1) frozen 片段 hash 绑定：复算生成器
import {buildMigrationSql} from './build-tts-c1a-migration';
const rebuilt = buildMigrationSql('docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md');
ok(rebuilt.frozenFragmentsSha256 === TTS_C1A_FROZEN_FRAGMENTS_SHA256,
   'frozen fragments sha256 与 checked-in 基线一致', rebuilt.frozenFragmentsSha256);
ok(rebuilt.appliedSqlSha256 === TTS_C1A_APPLIED_SQL_SHA256,
   'applied sql sha256 与 checked-in 基线一致', rebuilt.appliedSqlSha256);
ok(rebuilt.tableNames.length === 6 && rebuilt.tableNames.every((t, i) => t === TTS_C1A_TABLES[i]),
   '6 张 1A 表（vmr/vmjob/vmat/lve/vrp/vrpa）', rebuilt.tableNames);

// 2) 351 行 legacy tts_jobs fixture
function seedLegacy351(db: ReturnType<typeof getDb>): string {
  db.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('P-LEGACY', 'legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO artifacts (id, project_id, kind, created_at) VALUES ('A-LEGACY', 'P-LEGACY', 'narration_plan_v2', '2026-01-01T00:00:00.000Z')").run();
  const stmt = db.prepare(
    `INSERT INTO tts_jobs
       (id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id, provider,
        voice_profile_id, voice_profile_revision, status, payload_json, queued_at)
     VALUES (?, 'P-LEGACY', 'A-LEGACY', 1, ?, 'mock', 'VP-LEGACY', '1', 'queued', '{}', ?)`,
  );
  for (let i = 0; i < 351; i++) {
    stmt.run(`legacy-job-${String(i).padStart(3, '0')}`, `N${String(i % 999).padStart(3, '0')}`, '2026-01-01T00:00:00.000Z');
  }
  const rows = db.prepare('SELECT id, project_id, unit_id, provider, voice_profile_id, status, payload_json FROM tts_jobs ORDER BY id').all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const db = getDb();
const baseHash = seedLegacy351(db);
ok((db.prepare('SELECT count(*) c FROM tts_jobs').get() as {c: number}).c === 351, 'legacy tts_jobs = 351');

// 3) clean apply（getDb 已自动应用）+ FK/integrity
const fk = db.prepare('PRAGMA foreign_key_check').all();
ok(fk.length === 0, 'foreign_key_check 空', fk);
const ic = db.prepare('PRAGMA integrity_check').all() as Array<{integrity_check: string}>;
ok(ic.length === 1 && ic[0].integrity_check === 'ok', 'integrity_check ok', ic);
ok(isTtsC1aMigrationApplied(db), '1A migration 已应用');

// 4) 重跑幂等
applyTtsC1aMigration(db);
ok(true, 'migration 重跑幂等（无异常）');
const afterHash = crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT id, project_id, unit_id, provider, voice_profile_id, status, payload_json FROM tts_jobs ORDER BY id').all())).digest('hex');
ok(afterHash === baseHash, 'legacy tts_jobs 351 行 hash 不变', afterHash);

// 5) publication/activation/legacy 表 0 行
for (const t of ['voice_registry_publications', 'voice_registry_publication_activations', 'legacy_adapter_voice_entries']) {
  const c = (db.prepare(`SELECT count(*) c FROM ${t}`).get() as {c: number}).c;
  ok(c === 0, `${t} 0 行`, c);
}
// 6) 1A 业务表 0 行
for (const t of ['voice_materialization_requests', 'voice_materialization_jobs', 'voice_materializations']) {
  const c = (db.prepare(`SELECT count(*) c FROM ${t}`).get() as {c: number}).c;
  ok(c === 0, `${t} 0 行`, c);
}
// 7) C.2 表不存在（未提前落 production schema）
for (const t of ['tts_audio_requests', 'tts_synthesis_claims', 'tts_claim_generation_dispatches', 'tts_job_execution_transitions', 'tts_generation_attempts', 'sentence_audio_artifacts']) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  ok(row === undefined, `C.2 表 ${t} 不存在`);
}
// tts_jobs 无 TTS-C 列
const tjsCols = (db.prepare('PRAGMA table_info(tts_jobs)').all() as Array<{name: string}>).map((c) => c.name);
ok(!tjsCols.includes('claim_id') && !tjsCols.includes('execution_command_seq'), 'tts_jobs 无 TTS-C 列');

closeDb();
fs.rmSync(DATA_DIR, {recursive: true, force: true});
summary('TTS-C.1A migration');

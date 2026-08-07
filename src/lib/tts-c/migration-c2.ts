/**
 * TTS-C.2 migration 应用（幂等；SQL 来源 = frozen §2 提取生成文件 migration-c2.generated.ts）。
 *
 * 顺序（生成器分段，frozen §2.0 依赖顺序说明）：
 *   1. TTS_C2_TABLES_SQL（6 新表 CREATE IF NOT EXISTS）
 *   2. tts_jobs ADD COLUMN（TTS_C2_TTS_JOBS_ALTERS——SQLite 无 ADD COLUMN IF NOT EXISTS，
 *      按 PRAGMA table_info 列存在性动态跳过；既有 legacy 行不受影响，零 rebuild）
 *   3. TTS_C2_INDEXES_SQL（引用新列，须在 ALTER 后）
 *   4. TTS_C2_TRIGGERS_SQL（引用新列，须在 ALTER 后）
 *
 * 与 1A migration 相同的并发安全：已应用短路 + BEGIN IMMEDIATE 串行化首次迁移。
 * 不 import db.ts（由调用方传入连接，避免循环依赖）。
 */
import type {Db} from '../db';
import {
  TTS_C2_TABLES_SQL,
  TTS_C2_INDEXES_SQL,
  TTS_C2_TRIGGERS_SQL,
  TTS_C2_TTS_JOBS_ALTERS,
} from './migration-c2.generated';

export const TTS_C2_TABLES: ReadonlyArray<string> = [
  'tts_audio_requests',
  'tts_synthesis_claims',
  'tts_claim_generation_dispatches',
  'tts_job_execution_transitions',
  'tts_generation_attempts',
  'sentence_audio_artifacts',
];

/** 是否已应用 C.2 migration（任意一张新表存在即视为已应用；SQL 幂等可安全重跑）。 */
export function isTtsC2MigrationApplied(db: Db): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get('tts_audio_requests') as {name: string} | undefined;
  return row !== undefined;
}

const ALTER_COLUMN_RE = /^ALTER TABLE tts_jobs ADD COLUMN ([a-z_]+)\b/;

/** 幂等应用 C.2 migration（frozen §2 提取 SQL；ALTER 按列存在性跳过；并发安全）。 */
export function applyTtsC2Migration(db: Db): void {
  if (isTtsC2MigrationApplied(db)) return; // 已迁移：零操作（并发进程不产生 DDL 竞争）
  const tx = db.transaction((): void => {
    db.exec(TTS_C2_TABLES_SQL);
    // tts_jobs ADD COLUMN（动态跳过已存在列——幂等重跑与升级路径共用）
    const cols = new Set(
      (db.prepare('PRAGMA table_info(tts_jobs)').all() as Array<{name: string}>).map((c) => c.name),
    );
    for (const alter of TTS_C2_TTS_JOBS_ALTERS) {
      const m = ALTER_COLUMN_RE.exec(alter);
      if (!m) throw new Error(`无法解析 tts_jobs ALTER: ${alter.slice(0, 80)}`);
      if (cols.has(m[1])) continue;
      db.exec(alter);
      cols.add(m[1]);
    }
    db.exec(TTS_C2_INDEXES_SQL);
    db.exec(TTS_C2_TRIGGERS_SQL);
  });
  tx.immediate(); // BEGIN IMMEDIATE：并发首次迁移串行化（DROP+CREATE 在同一写锁内原子）
}

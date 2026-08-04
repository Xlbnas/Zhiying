/**
 * TTS-C.1A migration 应用（幂等；SQL 来源 = frozen §2 提取生成文件）。
 * 表存在检查 + IF NOT EXISTS SQL 双保险；production/测试共用入口。
 * R1：已应用检查短路（并发进程零 DDL 竞争）+ BEGIN IMMEDIATE 串行化首次迁移
 * （DROP TRIGGER + CREATE TRIGGER 非原子，并发 DDL 会 already exists）。
 * 不 import db.ts（由调用方传入连接，避免循环依赖）。
 */
import type {Db} from '../db';
import {TTS_C1A_MIGRATION_SQL} from './migration.generated';

export const TTS_C1A_TABLES: ReadonlyArray<string> = [
  'voice_materialization_requests',
  'voice_materialization_jobs',
  'voice_materializations',
  'legacy_adapter_voice_entries',
  'voice_registry_publications',
  'voice_registry_publication_activations',
];

/** 是否已应用 1A migration（任意一张表存在即视为已应用；SQL 幂等可安全重跑）。 */
export function isTtsC1aMigrationApplied(db: Db): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get('voice_materialization_requests') as {name: string} | undefined;
  return row !== undefined;
}

/** 幂等应用 1A migration（frozen §2 提取 SQL，IF NOT EXISTS；R1 并发安全）。 */
export function applyTtsC1aMigration(db: Db): void {
  if (isTtsC1aMigrationApplied(db)) return; // 已迁移：零操作（并发进程不产生 DDL 竞争）
  const tx = db.transaction((): void => {
    db.exec(TTS_C1A_MIGRATION_SQL);
  });
  tx.immediate(); // BEGIN IMMEDIATE：并发首次迁移串行化（DROP+CREATE 在同一写锁内原子）
}

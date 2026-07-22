import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 知影 SQLite 连接层（CONTRACT §3）
 * - 单例 getDb()
 * - 数据目录解析顺序：ZHIYING_DATA_DIR 环境变量 → ./data
 * - 连接时执行四条 PRAGMA，并按契约建四张表（幂等）
 */

export type Db = Database.Database;

let instance: Db | null = null;

/** 数据目录（绝对路径）。worker / API 共用此解析逻辑。 */
export function getDataDir(): string {
  const fromEnv = process.env.ZHIYING_DATA_DIR;
  return path.resolve(process.cwd(), fromEnv && fromEnv.length > 0 ? fromEnv : './data');
}

/** 数据库文件绝对路径：{dataDir}/zhiying.db */
export function getDbPath(): string {
  return path.join(getDataDir(), 'zhiying.db');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rigorous',
  schema_version TEXT NOT NULL DEFAULT '1.0',
  template_version TEXT NOT NULL DEFAULT 'freud-mg-v1.0',
  composition_id TEXT NOT NULL DEFAULT 'ZhiyingFullCut',
  current_stage TEXT NOT NULL DEFAULT 'scenes',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                -- 'scenes' | 'subtitles' | 'render_output'
  version INTEGER NOT NULL DEFAULT 1,
  content_json TEXT,                 -- scenes/subtitles 等 JSON 文本
  file_path TEXT,                    -- 大文件（mp4）走路径
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'fullcut',   -- 'fullcut' | 'no-subtitles'
  status TEXT NOT NULL DEFAULT 'queued',  -- queued/running/succeeded/failed/cancelled
  progress REAL NOT NULL DEFAULT 0,       -- 0-100
  payload_json TEXT NOT NULL,             -- ZhiyingFullCutProps JSON
  output_path TEXT,
  error_code TEXT, error_message TEXT,
  queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_jobs (   -- M2 用，M1 只建表不消费
  id TEXT PRIMARY KEY, project_id TEXT, stage TEXT,
  status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT,
  queued_at TEXT, started_at TEXT, finished_at TEXT,
  claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
  attempt INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 2,
  progress REAL DEFAULT 0, error_code TEXT, error_message TEXT,
  cancel_requested INTEGER DEFAULT 0
);
`;

/**
 * 获取数据库单例。首次调用时：
 * 1. 创建数据目录（recursive，幂等）
 * 2. 打开 {dataDir}/zhiying.db
 * 3. 执行 PRAGMA：journal_mode=WAL / busy_timeout=5000 / foreign_keys=ON / synchronous=NORMAL
 * 4. 建四张表（IF NOT EXISTS，幂等）
 */
export function getDb(): Db {
  if (instance) {
    return instance;
  }
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, {recursive: true});
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  instance = db;
  return db;
}

/** 关闭单例（测试 / 优雅退出用）。 */
export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

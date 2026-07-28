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
  progress_detail TEXT,                   -- M5：步骤级进度 JSON（render/progress-detail.ts）
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
-- ============ M2-A：工作流数据地基（仅新增，不修改以上 M1 表） ============
CREATE TABLE IF NOT EXISTS project_stages (   -- 阶段状态机，每项目 10 行
  project_id TEXT NOT NULL REFERENCES projects(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_started', -- not_started/generated/edited/locked/stale
  active_version INTEGER,          -- 当前展示/编辑版本（project_versions.version）
  locked_version INTEGER,          -- 锁定版本（null=未锁）
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, stage)
);
CREATE TABLE IF NOT EXISTS project_versions ( -- 阶段产物版本快照
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  stage TEXT NOT NULL,
  version INTEGER NOT NULL,        -- 每 (project_id, stage) 递增
  content TEXT NOT NULL,           -- Markdown 文本或 JSON 字符串
  content_type TEXT NOT NULL,      -- 'markdown' | 'json'
  source TEXT NOT NULL,            -- ai_generate/manual_edit/repair/rollback
  prompt_version TEXT,             -- Prompt Registry 版本（M2-B 起写入）
  model TEXT,                      -- 生成模型（人工编辑为 null）
  job_id TEXT,                     -- 来源 llm_job（可空）
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_usage (        -- 逐请求成本快照（架构 §6.2）
  id TEXT PRIMARY KEY,
  project_id TEXT, stage TEXT, job_id TEXT, request_id TEXT,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER,
  price_cache_hit_per_m REAL,      -- 调用当时单价快照（元/百万 tokens）
  price_cache_miss_per_m REAL,
  price_output_per_m REAL,
  cost_cny REAL,                   -- 以快照单价算出，历史成本永不重算
  prompt_version TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_project
  ON llm_usage (project_id, stage);
-- ============ M2-C：项目生产参数（仅新增，不修改 M1 表结构） ============
CREATE TABLE IF NOT EXISTS project_inputs ( -- 项目生产参数（非 workflow artifact）
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT '1.0',
  config_json TEXT NOT NULL,          -- projectInputSchema JSON（写入前/读取后 zod）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- ============ M3-B：TTS 任务队列（仅新增，不修改以上表） ============
CREATE TABLE IF NOT EXISTS tts_jobs (   -- 一个 speech unit 一个 job（独立 retry/cancel）
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  narration_plan_artifact_id TEXT NOT NULL,
  narration_plan_version INTEGER NOT NULL,
  unit_id TEXT NOT NULL,              -- Narration Plan unit（N001…）
  provider TEXT NOT NULL,             -- mock | indextts2
  voice_profile_id TEXT NOT NULL,
  voice_profile_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued/running/succeeded/failed/cancelled
  payload_json TEXT NOT NULL,         -- 入队快照（source artifact/unit text/voice）
  output_path TEXT,                   -- data 目录相对路径
  duration_ms INTEGER,                -- ffprobe 实测（唯一时长真相）
  audio_sha256 TEXT,
  result_json TEXT,                   -- M3-B Hardening：Provider 返回快照 + ffprobe 元数据（ttsJobResultSchema）
  queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
  progress REAL DEFAULT 0,
  error_code TEXT, error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tts_jobs_project_unit
  ON tts_jobs (project_id, unit_id, status);
`;

// M2-A Hardening：版本号数据库级唯一约束（幂等）。
// 建索引前先查重 —— 发现重复必须停止并报告，不得静默删除。
const VERSION_DUP_CHECK_SQL = `
SELECT project_id, stage, version, COUNT(*) AS c
FROM project_versions
GROUP BY project_id, stage, version
HAVING c > 1
LIMIT 1
`;

const VERSION_UNIQUE_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_versions_project_stage_version
  ON project_versions (project_id, stage, version)
`;

// 唯一索引完全覆盖原普通索引的查询路径，删除冗余（幂等）
const DROP_REDUNDANT_INDEX_SQL = `DROP INDEX IF EXISTS idx_project_versions_stage`;

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
  // M2-A Hardening 迁移（幂等）：
  // 1. 版本号唯一索引前先查重——有重复必须停止并报告，不得静默删除
  const dup = db.prepare(VERSION_DUP_CHECK_SQL).get() as
    | {project_id: string; stage: string; version: number; c: number}
    | undefined;
  if (dup) {
    throw new Error(
      `project_versions 存在重复版本号，已停止：project=${dup.project_id} ` +
        `stage=${dup.stage} version=${dup.version} 出现 ${dup.c} 次。` +
        `请人工核查数据后再启动。`,
    );
  }
  db.exec(VERSION_UNIQUE_INDEX_SQL);
  db.exec(DROP_REDUNDANT_INDEX_SQL);
  // M3-B Hardening 迁移（幂等）：CREATE TABLE IF NOT EXISTS 不会给已有 tts_jobs 加列，
  // 需 PRAGMA table_info 检查后 ALTER TABLE（旧库升级；二次启动幂等）。
  const ttsCols = db.prepare('PRAGMA table_info(tts_jobs)').all() as Array<{name: string}>;
  if (!ttsCols.some((c) => c.name === 'result_json')) {
    db.exec('ALTER TABLE tts_jobs ADD COLUMN result_json TEXT');
  }
  // M5 迁移（幂等，同模式）：render_jobs 增加步骤级进度列。
  const renderCols = db.prepare('PRAGMA table_info(render_jobs)').all() as Array<{name: string}>;
  if (!renderCols.some((c) => c.name === 'progress_detail')) {
    db.exec('ALTER TABLE render_jobs ADD COLUMN progress_detail TEXT');
  }
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

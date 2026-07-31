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
-- M6.3.11：每个成功 Final Render 的不可变产物 manifest（job_id 一一对应）。
-- job 只有在输出校验 + SHA256 + manifest 落库后才能 succeeded（succeeded gate）；
-- 下载按 exact job 读 manifest 校验文件，fail-closed，绝不 fallback 旧视频。
CREATE TABLE IF NOT EXISTS render_artifacts (
  job_id TEXT PRIMARY KEY REFERENCES render_jobs(id),
  project_id TEXT NOT NULL,
  output_path TEXT NOT NULL,
  output_sha256 TEXT NOT NULL,
  output_size INTEGER NOT NULL,
  duration_sec REAL,
  frame_count INTEGER,
  encoder TEXT,
  payload_sha256 TEXT,
  bundle_key TEXT,
  backfilled INTEGER NOT NULL DEFAULT 0,  -- 1 = M6.3.11 前历史产物惰性回填
  audit_json TEXT,    -- M6.3.12：视觉审计（visual-gate auditFinalVisuals）
  loudness_json TEXT, -- M6.3.12：loudnorm 归一化后实测响度
  created_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  scene_id TEXT,                    -- 绑定的 scene（M6；null = 项目级素材预留）
  media_type TEXT NOT NULL,         -- image | video
  source_type TEXT NOT NULL,        -- archive | stock | generated | upload | local
  source_provider TEXT NOT NULL,    -- wikimedia | ...
  source_url TEXT,
  local_path TEXT NOT NULL,         -- public/assets/{projectId}/{id}.{ext}
  mime_type TEXT,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  license_status TEXT NOT NULL,     -- usable | review_required | blocked
  license_note TEXT,
  attribution TEXT,
  description TEXT,
  requirement_json TEXT,            -- 来源 assetRequirement 快照
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project_scene ON assets(project_id, scene_id);
-- ============ M6.3.8：显式 asset→requirement 绑定（唯一 READY 依据） ============
-- scene_id 仅为 denormalized 便利列；resolver/readiness 只认本表 active 行。
-- candidate = 无 active binding 的 asset 行；replace = deactivate 旧 + insert 新（历史保留）。
CREATE TABLE IF NOT EXISTS asset_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  scene_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,       -- 稳定需求 ID（如 S012-R01；见 scene-schema.requirementIdOf）
  asset_id TEXT NOT NULL REFERENCES assets(id),
  active INTEGER NOT NULL DEFAULT 1,  -- 1 = 当前生效；0 = 历史（replace 后保留）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_bindings_project_scene
  ON asset_bindings(project_id, scene_id);
-- 每个 (project, scene, requirement) 至多一个 active binding（DB 级强制）
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_bindings_active_requirement
  ON asset_bindings(project_id, scene_id, requirement_id) WHERE active = 1;
-- ============ M6.3.9：per-requirement 解析尝试状态（仅展示层元数据） ============
-- READY 唯一依据仍是 asset_bindings；本表只记录最近一次自动获取/生成的失败结果，
-- 供 resolver 向用户解释「发生了什么 / 为什么 / 下一步」（不驱动 readiness）。
CREATE TABLE IF NOT EXISTS asset_resolution_state (
  project_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- no_result | download_failed | generation_failed | policy_blocked
  reason TEXT,
  queries_tried TEXT,            -- JSON array
  provider TEXT,
  metadata TEXT,                 -- M7：JSON {attemptId, providerRequestId, failurePhase, model, prompt}
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scene_id, requirement_id)
);
-- M3-B：TTS 任务队列（一个 speech unit 一个 job，独立 retry/cancel）
CREATE TABLE IF NOT EXISTS tts_jobs (
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
CREATE TABLE IF NOT EXISTS project_usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                -- llm | cpu | gpu | render | tts | asset
  stage TEXT,                        -- workflow 阶段
  job_id TEXT,                       -- 来源 job（render_jobs / llm_jobs / tts_jobs id）
  provider TEXT,                     -- llm provider / tts provider
  model TEXT,                        -- llm model
  input_tokens INTEGER,              -- 仅 llm events
  output_tokens INTEGER,             -- 仅 llm events
  cache_tokens INTEGER,              -- 仅 llm events
  cost_cny REAL,                     -- 费用（元），整数 minor unit 存储
  cpu_usec INTEGER,                  -- CPU 微秒（usage_usec delta）
  gpu_sec REAL,                      -- GPU 秒（wall duration of GPU task）
  wall_ms INTEGER,                   -- 任务运行墙上毫秒
  metadata TEXT,                     -- JSON 附加信息
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_project
  ON project_usage_events (project_id, kind);
-- ============ M6.3.13：scene 级「改用 MG」视觉策略覆盖（authoritative override） ============
-- 不编辑 scenes artifact（whole-generation invariant 禁止跨代组合）：
-- override 在 props/readiness/resolver 构建时按 scene 输入应用；
-- scenes_version_id 漂移（重新生成/锁定新 scenes 版本）→ override 自动失效。
CREATE TABLE IF NOT EXISTS scene_visual_overrides (
  project_id TEXT NOT NULL REFERENCES projects(id),
  scene_id TEXT NOT NULL,
  scenes_version_id TEXT NOT NULL,      -- 创建时的 locked scenes 版本行 id（失效判定依据）
  strategy TEXT NOT NULL,               -- 'mg'
  template TEXT NOT NULL,               -- 已注册 MG 模板 id
  template_props TEXT NOT NULL,         -- 模板 schema 校验通过的 templateProps JSON
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, scene_id)
);
-- ============ M7.2.1：durable single-flight generation runs + attempt journal ============
-- UNIQUE(project_id, stage, request_id) 行在任何 provider 调用之前以
-- BEGIN IMMEDIATE 原子 claim，保证同一逻辑 run 最多一个调用方到达 provider
-- （并发双计费在 DB 层被阻断，而非仅靠进程内检查）。
CREATE TABLE IF NOT EXISTS generation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage TEXT NOT NULL,                -- 如 'm7_narrative_beats'
  request_id TEXT NOT NULL,           -- canonicalized 调用方幂等键
  source_artifact_id TEXT NOT NULL,   -- exact 输入 artifact（禁止 latest 解析）
  status TEXT NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed', 'indeterminate')),
  owner_token TEXT,                   -- claim 持有者；完成/失败转移时校验
  lease_expires_at TEXT,              -- running 租约；过期 = indeterminate（不自动重调 provider）
  result_artifact_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, stage, request_id)
);
-- append-only attempt journal：每次 provider 请求（proposal + 每次 repair）独立一行，
-- 保存安全 request 投影、response 原文/hash、validation issues 与 usage 关联，
-- 使成本与失败原因完全可审计。禁止保存 Authorization/header/secret。
CREATE TABLE IF NOT EXISTS generation_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES generation_runs(id),
  attempt_number INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_hash TEXT NOT NULL,         -- sha256 请求投影（对账/去重证据）
  request_json TEXT NOT NULL,         -- 安全字段投影（model/system/user/outputMode/…）
  provider_request_id TEXT,
  response_hash TEXT,
  response_text TEXT,
  finish_reason TEXT,
  parse_result TEXT CHECK (parse_result IN ('pass', 'fail')),
  schema_issues_json TEXT,
  semantic_issues_json TEXT,
  usage_record_id TEXT,               -- 精确关联 llm_usage.id
  status TEXT NOT NULL CHECK (status IN (
    'in_flight',
    'response_received',
    'validation_failed',
    'succeeded',
    'transport_failed',
    'indeterminate'
  )),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(run_id, attempt_number)
);
-- ============ M7.3A.2：素材生成 durable worker job ============
-- Web 不再同步等待 provider；Worker 原子 claim 后执行，同 requestId 生命周期
-- 内只产生一个 job，跨进程/重试/双击均不重复调用 provider。
-- resource_class：provider 驱动（apiyi→remote_image_api、local/comfyui→local_image_gpu）。
-- resource_group：仅 local_image_gpu 归 production_gpu；remote API 为 NULL。
-- source_scenes_version_id + requirement_json：enqueue 时冻结 exact source，
--   执行期校验 source version 仍匹配；若已 stale → SOURCE_STALE → confirmed_zero。
CREATE TABLE IF NOT EXISTS asset_generation_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  scene_id TEXT NOT NULL,
  requirement_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  resource_class TEXT NOT NULL DEFAULT 'remote_image_api',
  resource_group TEXT,
  source_scenes_version_id TEXT,
  source_requirement_hash TEXT,
  requirement_json TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled')),
  owner_token TEXT,
  lease_expires_at TEXT,
  provider_request_id TEXT,
  result_asset_id TEXT,
  error_code TEXT,
  error_message TEXT,
  failure_phase TEXT,
  billing_status TEXT
    CHECK (billing_status IN ('confirmed_zero', 'confirmed_charged', 'unknown_billing')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scene_id, requirement_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_generation_jobs_project
  ON asset_generation_jobs (project_id, scene_id, requirement_id);

-- ============ M7.3A.2：durable 跨 Worker GPU 资源租约 ============
-- production_gpu 整机互斥；claim 先于 status=running；lease heartbeat 保活；
-- 崩溃后 lease 过期可回收，但不得释放仍有有效 heartbeat 的 lease。
CREATE TABLE IF NOT EXISTS resource_group_leases (
  resource_group TEXT PRIMARY KEY,
  owner_job_type TEXT NOT NULL,
  owner_job_id TEXT NOT NULL,
  owner_worker_id TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============ Worker-side LLM dispatch（通用排队信封） ============
-- Production 安全边界：DEEPSEEK_API_KEY/LLM_PROVIDER 只注入 worker 容器，
-- Web 进程不持有 secret——POST 只做 validation + idempotency + enqueue，
-- Worker 原子 claim 后执行 build。durable single-flight 仍由 generation_runs
-- 兜底：dispatch 只是信封，重复执行不会重复调用 provider。
CREATE TABLE IF NOT EXISTS generation_dispatch_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage TEXT NOT NULL,                -- 'm7_narrative_beats' | 'm7_visual_intent'
  request_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL,   -- exact 输入 artifact（禁止 latest 解析）
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  owner_token TEXT,                   -- claim 持有者；完成/失败转移时校验
  lease_expires_at TEXT,              -- running 租约（崩溃检测；不自动重调 provider）
  generation_run_id TEXT,
  result_artifact_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, stage, request_id)
);
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
  // M7：为已存在表补齐 asset_resolution_state.metadata 列（幂等）
  try {
    db.exec(`ALTER TABLE asset_resolution_state ADD COLUMN metadata TEXT`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('duplicate column name')) {
      // 已存在，忽略
    } else {
      throw err;
    }
  }
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
  // M6.3.12 迁移（幂等，同模式）：render_artifacts 增加视觉审计/响度列。
  const artifactCols = db.prepare('PRAGMA table_info(render_artifacts)').all() as Array<{name: string}>;
  if (!artifactCols.some((c) => c.name === 'audit_json')) {
    db.exec('ALTER TABLE render_artifacts ADD COLUMN audit_json TEXT');
  }
  if (!artifactCols.some((c) => c.name === 'loudness_json')) {
    db.exec('ALTER TABLE render_artifacts ADD COLUMN loudness_json TEXT');
  }
  // M7.1 迁移（幂等，同模式）：projects 增加 pipeline 分流列。
  // 全部存量项目默认 'm6'（DDL DEFAULT 保证），绝不自动切 'm7'。
  const projectCols = db.prepare('PRAGMA table_info(projects)').all() as Array<{name: string}>;
  if (!projectCols.some((c) => c.name === 'pipeline_version')) {
    db.exec(`ALTER TABLE projects ADD COLUMN pipeline_version TEXT NOT NULL DEFAULT 'm6'`);
  }
  // M7.1.1 迁移（additive，幂等）：M7 激活唯一指针。
  // 冻结约束（由 pipeline-version.ts 事务写入 + 读取侧 validator 双重 fail-closed 保证，
  // SQLite 无法安全附加复杂 CHECK/FK）：m6 → 必须 NULL；m7 → 必须指向同项目完整
  // immutable m7_pipeline_snapshot。绝不依赖 latest 解析。
  if (!projectCols.some((c) => c.name === 'm7_pipeline_snapshot_id')) {
    db.exec('ALTER TABLE projects ADD COLUMN m7_pipeline_snapshot_id TEXT');
  }
  // M7.3A.2 additive columns for asset_generation_jobs（review hardening）
  const agCols = db.prepare('PRAGMA table_info(asset_generation_jobs)').all() as Array<{name: string}>;
  if (!agCols.some((c) => c.name === 'resource_class')) {
    db.exec("ALTER TABLE asset_generation_jobs ADD COLUMN resource_class TEXT NOT NULL DEFAULT 'remote_image_api'");
  }
  if (!agCols.some((c) => c.name === 'resource_group')) {
    db.exec('ALTER TABLE asset_generation_jobs ADD COLUMN resource_group TEXT');
  }
  if (!agCols.some((c) => c.name === 'source_scenes_version_id')) {
    db.exec('ALTER TABLE asset_generation_jobs ADD COLUMN source_scenes_version_id TEXT');
  }
  if (!agCols.some((c) => c.name === 'source_requirement_hash')) {
    db.exec('ALTER TABLE asset_generation_jobs ADD COLUMN source_requirement_hash TEXT');
  }
  if (!agCols.some((c) => c.name === 'requirement_json')) {
    db.exec('ALTER TABLE asset_generation_jobs ADD COLUMN requirement_json TEXT');
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

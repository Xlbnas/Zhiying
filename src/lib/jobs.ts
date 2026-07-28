import crypto from 'node:crypto';
import {getDb} from '@/lib/db';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';

/**
 * 渲染任务队列（CONTRACT §3）
 * - 所有时间用 ISO 字符串（new Date().toISOString()）
 * - ID 用 crypto.randomUUID()
 * - claim 使用 BEGIN IMMEDIATE 事务保证原子性（better-sqlite3 transaction().immediate()）
 */

export type RenderJobKind = 'fullcut' | 'no-subtitles';
export type RenderJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** render_jobs 表行（snake_case 与 DB 列一一对应）。 */
export interface RenderJobRow {
  id: string;
  project_id: string;
  kind: string;
  status: RenderJobStatus;
  progress: number;
  payload_json: string;
  output_path: string | null;
  error_code: string | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  max_attempts: number;
  cancel_requested: number;
}

/** CONTRACT 命名别名：claimNextJob(workerId): Job | null */
export type Job = RenderJobRow;

function now(): string {
  return new Date().toISOString();
}

function getJobById(jobId: string): RenderJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM render_jobs WHERE id = ?')
    .get(jobId) as RenderJobRow | undefined;
}

/**
 * 入队一个渲染任务。payload 为 ZhiyingFullCutProps（由 API 层组装并校验）。
 * 返回插入后的完整行。
 */
export function enqueueRenderJob(
  projectId: string,
  kind: RenderJobKind,
  payload: ZhiyingFullCutProps,
): RenderJobRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const queuedAt = now();
  db.prepare(
    `INSERT INTO render_jobs (id, project_id, kind, status, progress, payload_json, queued_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(id, projectId, kind, JSON.stringify(payload), queuedAt);
  const row = getJobById(id);
  if (!row) {
    throw new Error(`enqueueRenderJob: inserted job ${id} not found`);
  }
  return row;
}

/**
 * 原子领取下一个 queued 任务（FIFO，按 queued_at 升序）。
 * BEGIN IMMEDIATE 保证同一时刻只有一个 worker 能完成 claim。
 * claim 时：status→running、记录 claimed_by/at、heartbeat_at、attempt+1；
 * started_at 用 COALESCE 保留首次启动时间（重试不覆盖）。
 */
export function claimNextJob(workerId: string): Job | null {
  const db = getDb();
  const claimTx = db.transaction(
    (claimedBy: string, at: string): RenderJobRow | null => {
      const next = db
        .prepare(
          `SELECT id FROM render_jobs
           WHERE status = 'queued'
           ORDER BY queued_at ASC
           LIMIT 1`,
        )
        .get() as {id: string} | undefined;
      if (!next) {
        return null;
      }
      db.prepare(
        `UPDATE render_jobs
         SET status = 'running',
             claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
             started_at = COALESCE(started_at, ?),
             attempt = attempt + 1
         WHERE id = ? AND status = 'queued'`,
      ).run(claimedBy, at, at, at, next.id);
      return getJobById(next.id) ?? null;
    },
  );
  // .immediate() → BEGIN IMMEDIATE：立即获取 RESERVED 锁，杜绝并发双 claim
  return claimTx.immediate(workerId, now());
}

/**
 * 心跳 + 进度上报（progress 0-100；M5 起可附带步骤级 progress_detail JSON）。
 * 仅对 running 任务生效，避免任务已被取消/回收后又被心跳覆写。
 */
export function heartbeat(jobId: string, progress: number, progressDetail?: string): void {
  getDb()
    .prepare(
      `UPDATE render_jobs
       SET heartbeat_at = ?, progress = ?, progress_detail = COALESCE(?, progress_detail)
       WHERE id = ? AND status = 'running'`,
    )
    .run(now(), progress, progressDetail ?? null, jobId);
}

/**
 * 任务成功：status→succeeded、progress=100、记录 output_path。
 * 同时写入一条 kind='render_output' 的 artifact（version 按项目递增），
 * 供项目详情 / 下载使用。整个操作在一个事务内完成。
 */
export function completeJob(jobId: string, outputPath: string): void {
  const db = getDb();
  const completeTx = db.transaction((id: string, out: string, at: string) => {
    const job = getJobById(id);
    if (!job) {
      throw new Error(`completeJob: job ${id} not found`);
    }
    db.prepare(
      `UPDATE render_jobs
       SET status = 'succeeded', progress = 100, output_path = ?, finished_at = ?
       WHERE id = ?`,
    ).run(out, at, id);
    const nextVersion =
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(version), 0) + 1 AS v
             FROM artifacts WHERE project_id = ? AND kind = 'render_output'`,
          )
          .get(job.project_id) as {v: number}
      ).v;
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, file_path, created_at)
       VALUES (?, ?, 'render_output', ?, ?, ?)`,
    ).run(crypto.randomUUID(), job.project_id, nextVersion, out, at);
  });
  completeTx(jobId, outputPath, now());
}

/**
 * 任务失败：记录 error_code / error_message。
 * 未超 max_attempts → 回 queued（清空 claim 字段，等待重试）；
 * 已达上限 → status→failed 并记录 finished_at。
 */
export function failJob(jobId: string, code: string, msg: string): void {
  const db = getDb();
  const job = getJobById(jobId);
  if (!job) {
    throw new Error(`failJob: job ${jobId} not found`);
  }
  const at = now();
  if (job.attempt < job.max_attempts) {
    db.prepare(
      `UPDATE render_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           cancel_requested = 0,
           error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(code, msg, jobId);
  } else {
    db.prepare(
      `UPDATE render_jobs
       SET status = 'failed', finished_at = ?,
           error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(at, code, msg, jobId);
  }
}

/**
 * 启动 / 巡检时回收僵尸任务：
 * status='running' 且 heartbeat_at 早于 now - timeoutMs → 回 queued。
 * 返回回收的任务数。
 */
export function recoverStaleJobs(timeoutMs: number): number {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const result = getDb()
    .prepare(
      `UPDATE render_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           cancel_requested = 0
       WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

/** 请求取消（queued / running 均可标记；worker 在运行中轮询检查）。 */
export function requestCancel(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE render_jobs
       SET cancel_requested = 1
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(jobId);
}

/** 是否已被请求取消。 */
export function isCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare('SELECT cancel_requested FROM render_jobs WHERE id = ?')
    .get(jobId) as {cancel_requested: number} | undefined;
  return row !== undefined && row.cancel_requested === 1;
}

/**
 * 【契约外补充】将 running 任务标记为 cancelled。
 * worker 响应 isCancelRequested 中止渲染后调用；契约 §4 要求“取消则中止并标记 cancelled”，
 * 故在此提供该原子操作，避免 worker 直接写 SQL。
 */
export function markCancelled(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE render_jobs
       SET status = 'cancelled', finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(now(), jobId);
}

/**
 * 【契约外补充】将当前 running 任务原样回 queued（不记错误、attempt 保留）。
 * 用于 worker 收到 SIGTERM/SIGINT 优雅退出时（契约 §4：当前任务标记回 queued 后退出）。
 */
export function requeueJob(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE render_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           cancel_requested = 0
       WHERE id = ? AND status = 'running'`,
    )
    .run(jobId);
}

import crypto from 'node:crypto';
import {z} from 'zod';
import {getDb} from './db';
import {projectInputSchema} from './project-inputs';
import {generateVersionTx} from './workflow/operations';
import {
  workflowStageSchema,
  type ContentType,
  type ProjectVersionRow,
  type VersionSource,
  type WorkflowStage,
} from './workflow/types';

/**
 * LLM 任务队列数据层（M2-C，语义与 M1 render_jobs 对齐：jobs.ts）。
 * - 状态机：queued / running / succeeded / failed / cancelled
 * - 同一 (project_id, stage) 任意时刻最多一个 queued|running（enqueue 去重）
 * - payload_json 是生成输入快照（Worker 不重读 UI state）
 * - claim 原子性由 scheduler.ts 的 claimNextAnyJob（单 BEGIN IMMEDIATE）保证
 */

export type LlmJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface LlmJobRow {
  id: string;
  project_id: string;
  stage: string;
  status: LlmJobStatus;
  payload_json: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  max_attempts: number;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  cancel_requested: number;
}

/** run-stage 入队快照（M2-C：project_definition 无 upstream；M2-D 再扩 upstreamVersions）。 */
export const llmJobPayloadSchema = z.object({
  schemaVersion: z.literal('1.0'),
  stage: workflowStageSchema,
  promptInput: projectInputSchema,
});

export type LlmJobPayload = z.infer<typeof llmJobPayloadSchema>;

export class LlmJobError extends Error {
  constructor(
    public readonly code: 'JOB_ALREADY_ACTIVE' | 'JOB_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'LlmJobError';
  }
}

function now(): string {
  return new Date().toISOString();
}

export function getLlmJob(jobId: string): LlmJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM llm_jobs WHERE id = ?')
    .get(jobId) as LlmJobRow | undefined;
}

/** 同阶段活跃任务（queued|running），用于 enqueue 去重与编辑冲突检测。 */
export function getActiveLlmJob(projectId: string, stage: string): LlmJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM llm_jobs
       WHERE project_id = ? AND stage = ? AND status IN ('queued', 'running')
       ORDER BY queued_at ASC LIMIT 1`,
    )
    .get(projectId, stage) as LlmJobRow | undefined;
}

/** 最近一次任务（UI 推导 failed 状态用）。 */
export function getLatestLlmJob(projectId: string, stage: string): LlmJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM llm_jobs
       WHERE project_id = ? AND stage = ?
       ORDER BY queued_at DESC LIMIT 1`,
    )
    .get(projectId, stage) as LlmJobRow | undefined;
}

/**
 * 入队（BEGIN IMMEDIATE）：同 (project_id, stage) 存在 queued/running
 * 即抛 JOB_ALREADY_ACTIVE——不依赖前端 disabled 保证。
 */
export function enqueueLlmJob(projectId: string, payload: LlmJobPayload): LlmJobRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const tx = db.transaction((): LlmJobRow => {
    const active = getActiveLlmJob(projectId, payload.stage);
    if (active) {
      throw new LlmJobError(
        'JOB_ALREADY_ACTIVE',
        `${payload.stage} 已有进行中的任务（${active.id}，${active.status}）`,
      );
    }
    db.prepare(
      `INSERT INTO llm_jobs (id, project_id, stage, status, payload_json, queued_at, attempt, max_attempts)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, 2)`,
    ).run(id, projectId, payload.stage, JSON.stringify(payload), now());
    const row = getLlmJob(id);
    if (!row) {
      throw new Error(`enqueueLlmJob: inserted job ${id} not found`);
    }
    return row;
  });
  return tx.immediate();
}

/** 心跳（仅 running 生效，避免覆写已终结任务）。 */
export function heartbeatLlmJob(jobId: string): void {
  getDb()
    .prepare(`UPDATE llm_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`)
    .run(now(), jobId);
}

/**
 * 任务成功（Hardening §三）：仅允许 running → succeeded，
 * 防止 cancelled/failed 被迟到的 complete 覆盖。返回是否真正生效。
 */
export function completeLlmJob(jobId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE llm_jobs
       SET status = 'succeeded', progress = 100, finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(now(), jobId);
  return result.changes > 0;
}

/**
 * 任务失败：
 * - retryable 且 attempt < max_attempts → 回 queued（等下一轮 claim，attempt 保留）
 * - 否则 → failed。VALIDATION_FAILED / CONFIG_ERROR / OUTPUT_TRUNCATED / CANCELLED
 *   一律 non-retryable（避免反复烧 token）。
 */
export function failLlmJob(
  jobId: string,
  code: string,
  msg: string,
  opts: {retryable: boolean},
): void {
  const db = getDb();
  const job = getLlmJob(jobId);
  if (!job) {
    throw new LlmJobError('JOB_NOT_FOUND', `failLlmJob: job ${jobId} not found`);
  }
  const at = now();
  if (opts.retryable && job.attempt < job.max_attempts) {
    db.prepare(
      `UPDATE llm_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           cancel_requested = 0,
           error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(code, msg, jobId);
  } else {
    db.prepare(
      `UPDATE llm_jobs
       SET status = 'failed', finished_at = ?, error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(at, code, msg, jobId);
  }
}

/** 回收僵尸 running（heartbeat 超时）→ queued。返回回收数。 */
export function recoverStaleLlmJobs(timeoutMs: number): number {
  const cutoff = new Date(Date.now() - timeoutMs).toISOString();
  const result = getDb()
    .prepare(
      `UPDATE llm_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           cancel_requested = 0
       WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}

/** 请求取消（queued/running 均可标记）。 */
export function requestCancelLlmJob(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE llm_jobs SET cancel_requested = 1
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(jobId);
}

export function isLlmCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare('SELECT cancel_requested FROM llm_jobs WHERE id = ?')
    .get(jobId) as {cancel_requested: number} | undefined;
  return row !== undefined && row.cancel_requested === 1;
}

/** running 任务标记 cancelled（worker 响应取消后调用）。 */
export function markLlmCancelled(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE llm_jobs SET status = 'cancelled', finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(now(), jobId);
}

/** queued 任务直接终结为 cancelled（取消 API：未 claim 前生效）。 */
export function cancelQueuedLlmJob(jobId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE llm_jobs SET status = 'cancelled', finished_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .run(now(), jobId);
  return result.changes > 0;
}

/** running 任务原样回 queued（worker 优雅退出用；不记错误、attempt 保留）。 */
export function requeueLlmJob(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE llm_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
           cancel_requested = 0
       WHERE id = ? AND status = 'running'`,
    )
    .run(jobId);
}

/**
 * Crash idempotency 只读 helper（M2-C §十二）：
 * 若 project_versions 已存在 job_id=当前 job 的版本行，说明上次业务结果已落库、
 * 只是 job completion 未提交——不得重新调用 LLM，直接 complete。
 */
export function getVersionByJobId(jobId: string): ProjectVersionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM project_versions WHERE job_id = ?')
    .get(jobId) as ProjectVersionRow | undefined;
}

// ---------- 原子结果提交（Commit Atomicity Hardening） ----------

export type CommitLlmJobResultCode =
  | 'COMMITTED'
  | 'CANCEL_REQUESTED'
  | 'JOB_NOT_RUNNING'
  | 'JOB_NOT_FOUND'
  | 'JOB_MISMATCH';

export type CommitLlmJobResult =
  | {code: 'COMMITTED'; version: ProjectVersionRow}
  | {code: Exclude<CommitLlmJobResultCode, 'COMMITTED'>};

export interface CommitLlmJobResultInput {
  jobId: string;
  projectId: string;
  stage: WorkflowStage;
  content: string;
  contentType: ContentType;
  source: VersionSource;
  promptVersion?: string | null;
  model?: string | null;
}

/**
 * 「版本落库 + job 终态」原子提交：单个 BEGIN IMMEDIATE 内完成——
 *   1. job 前置条件（存在 / project+stage 匹配 / status=running / cancel_requested=0）
 *   2. generateVersionTx（M2-A 事务内 helper：版本 + active_version + generated + stale 传播）
 *   3. job → succeeded（WHERE status='running' AND cancel_requested=0，changes 必须为 1）
 * 任一步失败整体 rollback：不存在「version 已建但 job 未 succeeded」的部分提交窗口，
 * 也不存在 cancel fence 与 generateVersion 之间的跨进程竞态窗口。
 *
 * 竞争语义：
 * - Cancel API 先提交 cancel_requested=1 → 本事务读到 → CANCEL_REQUESTED（不建版本）
 * - 本事务先提交（running→succeeded 原子完成）→ Cancel API 的 UPDATE 匹配 0 行（JOB_NOT_ACTIVE）
 */
export function commitLlmJobResult(input: CommitLlmJobResultInput): CommitLlmJobResult {
  const db = getDb();
  const tx = db.transaction((): CommitLlmJobResult => {
    const job = getLlmJob(input.jobId);
    if (!job) {
      return {code: 'JOB_NOT_FOUND'};
    }
    if (job.project_id !== input.projectId || job.stage !== input.stage) {
      return {code: 'JOB_MISMATCH'};
    }
    if (job.status !== 'running') {
      return {code: 'JOB_NOT_RUNNING'};
    }
    if (job.cancel_requested === 1) {
      return {code: 'CANCEL_REQUESTED'};
    }
    const version = generateVersionTx({
      projectId: input.projectId,
      stage: input.stage,
      content: input.content,
      contentType: input.contentType,
      source: input.source,
      promptVersion: input.promptVersion ?? null,
      model: input.model ?? null,
      jobId: input.jobId,
    });
    const result = db
      .prepare(
        `UPDATE llm_jobs
         SET status = 'succeeded', progress = 100, finished_at = ?
         WHERE id = ? AND status = 'running' AND cancel_requested = 0`,
      )
      .run(new Date().toISOString(), input.jobId);
    if (result.changes !== 1) {
      // 单事务内理论上不可达；防线存在即验证——失败则整体回滚
      throw new Error(`commitLlmJobResult: job ${input.jobId} success 更新丢失竞态（changes=${result.changes}）`);
    }
    return {code: 'COMMITTED', version};
  });
  return tx.immediate();
}

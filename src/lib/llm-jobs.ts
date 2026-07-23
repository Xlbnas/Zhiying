import crypto from 'node:crypto';
import {z} from 'zod';
import {getDb} from './db';
import {getProjectInput, projectInputSchema} from './project-inputs';
import {
  captureLockedUpstreamVersionsTx,
  checkDependencySnapshotTx,
  type DependencyIssue,
  type UpstreamVersionSnapshot,
} from './workflow/dependencies';
import {generateVersionTx} from './workflow/operations';
import {assertRerunAllowed, requireStage} from './workflow/stages';
import {
  workflowStageSchema,
  type ContentType,
  type ProjectVersionRow,
  type VersionSource,
  type WorkflowStage,
} from './workflow/types';

/**
 * LLM 任务队列数据层（M2-C 建，M2-D 扩展 Payload V2）。
 * - 状态机：queued / running / succeeded / failed / cancelled
 * - 同一 (project_id, stage) 任意时刻最多一个 queued|running（enqueue 去重）
 * - payload_json 是生成输入快照（Worker 不重读 UI state）：
 *   V1（1.0，M2-C legacy，仅为旧 queued/history job 保留解析）；
 *   V2（2.0，M2-D 起所有新任务：promptInput + upstreamVersions 不可变上游锁定版本快照）。
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

/** V1（M2-C legacy）：只为兼容旧 queued/history job 的解析，新任务不得使用。 */
export const llmJobPayloadV1Schema = z.object({
  schemaVersion: z.literal('1.0'),
  stage: workflowStageSchema,
  promptInput: projectInputSchema,
});

/** V2（M2-D 起所有新入队任务）：含不可变上游 locked_version 快照。 */
export const llmJobPayloadV2Schema = z.object({
  schemaVersion: z.literal('2.0'),
  stage: workflowStageSchema,
  promptInput: projectInputSchema,
  upstreamVersions: z.record(z.string(), z.number().int().positive()),
});

export const llmJobPayloadSchema = z.discriminatedUnion('schemaVersion', [
  llmJobPayloadV1Schema,
  llmJobPayloadV2Schema,
]);

export type LlmJobPayloadV1 = z.infer<typeof llmJobPayloadV1Schema>;
export type LlmJobPayloadV2 = z.infer<typeof llmJobPayloadV2Schema>;
export type LlmJobPayload = LlmJobPayloadV1 | LlmJobPayloadV2;

/** 统一取上游快照：V1 视为空快照（M2-C project_definition 无上游）。 */
export function payloadUpstreamVersions(payload: LlmJobPayload): Record<string, number> {
  return payload.schemaVersion === '2.0' ? payload.upstreamVersions : {};
}

export class LlmJobError extends Error {
  constructor(
    public readonly code: 'JOB_ALREADY_ACTIVE' | 'JOB_NOT_FOUND' | 'PROJECT_INPUT_MISSING',
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

/**
 * 活跃任务保护（M2-D §二十一）：同 stage 有 queued/running 即抛
 * JOB_ALREADY_ACTIVE——edit/lock/rollback 等人工操作的服务端统一检查，
 * 不依赖前端 disabled。
 */
export function assertNoActiveLlmJob(projectId: string, stage: string): void {
  const active = getActiveLlmJob(projectId, stage);
  if (active) {
    throw new LlmJobError(
      'JOB_ALREADY_ACTIVE',
      `${stage} 已有进行中的生成任务（${active.id}），请等待完成或先取消`,
    );
  }
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
 * 【事务内 helper】去重 + INSERT（调用方负责事务/原子性）：
 * 同 (project_id, stage) 存在 queued/running 即抛 JOB_ALREADY_ACTIVE。
 * 供 enqueueLlmJob 与 dependencies.enqueueWorkflowStageJob 复用（SQL 唯一份）。
 */
export function enqueueLlmJobTx(projectId: string, payload: LlmJobPayload): LlmJobRow {
  const db = getDb();
  const active = getActiveLlmJob(projectId, payload.stage);
  if (active) {
    throw new LlmJobError(
      'JOB_ALREADY_ACTIVE',
      `${payload.stage} 已有进行中的任务（${active.id}，${active.status}）`,
    );
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO llm_jobs (id, project_id, stage, status, payload_json, queued_at, attempt, max_attempts)
     VALUES (?, ?, ?, 'queued', ?, ?, 0, 2)`,
  ).run(id, projectId, payload.stage, JSON.stringify(payload), now());
  const row = getLlmJob(id);
  if (!row) {
    throw new Error(`enqueueLlmJobTx: inserted job ${id} not found`);
  }
  return row;
}

/** 入队（BEGIN IMMEDIATE 独立事务）。高层原子入队请用 enqueueWorkflowStageJob。 */
export function enqueueLlmJob(projectId: string, payload: LlmJobPayload): LlmJobRow {
  const db = getDb();
  const tx = db.transaction((): LlmJobRow => enqueueLlmJobTx(projectId, payload));
  return tx.immediate();
}

/**
 * 高层原子入队（M2-D §七）：单个 BEGIN IMMEDIATE 内完成——
 *   1. target stage 存在
 *   2. assertRerunAllowed（上游锁门控 + locked 阶段 confirmStale）
 *   3. 捕获全部上游 locked_version 快照
 *   4. 读取 project_inputs（缺失即失败）
 *   5. 同 stage 无 queued/running（enqueueLlmJobTx 去重）
 *   6. INSERT llm_job（payload V2）
 * Route 不得自行拆分这些步骤（快照与入队之间不得有可插入修改的窗口）。
 */
export function enqueueWorkflowStageJob(
  projectId: string,
  stage: WorkflowStage,
  opts: {confirmStale?: boolean} = {},
): LlmJobRow {
  const db = getDb();
  const tx = db.transaction((): LlmJobRow => {
    requireStage(projectId, stage);
    assertRerunAllowed(projectId, stage, {confirmStale: opts.confirmStale ?? false});
    const upstreamVersions = captureLockedUpstreamVersionsTx(projectId, stage);
    const promptInput = getProjectInput(projectId);
    if (!promptInput) {
      throw new LlmJobError(
        'PROJECT_INPUT_MISSING',
        '项目缺少生产参数（project_inputs），无法生成（Legacy M1 项目？）',
      );
    }
    return enqueueLlmJobTx(projectId, {
      schemaVersion: '2.0',
      stage,
      promptInput,
      upstreamVersions,
    });
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

export type FinalizeLlmJobFailureCode =
  | 'REQUEUED'
  | 'FAILED'
  | 'CANCELLED'
  | 'JOB_NOT_RUNNING'
  | 'JOB_NOT_FOUND';

/**
 * 失败终局原子裁决（Cancellation Durability §四）：单个 BEGIN IMMEDIATE 内——
 *   - job 不存在 → JOB_NOT_FOUND；不在 running → JOB_NOT_RUNNING
 *   - cancel_requested=1 → cancelled（保留取消意图，绝不回 queued 清零）
 *   - retryable 且 attempt < max_attempts → 回 queued（清 claim/heartbeat）
 *   - 否则 → failed
 * 不存在「cancel_requested=1 → fail → queued + cancel=0」的路径。
 */
export function failLlmJob(
  jobId: string,
  code: string,
  msg: string,
  opts: {retryable: boolean},
): FinalizeLlmJobFailureCode {
  const db = getDb();
  const tx = db.transaction((): FinalizeLlmJobFailureCode => {
    const job = getLlmJob(jobId);
    if (!job) {
      return 'JOB_NOT_FOUND';
    }
    if (job.status !== 'running') {
      return 'JOB_NOT_RUNNING';
    }
    const at = now();
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE llm_jobs
         SET status = 'cancelled', finished_at = ?, error_code = ?, error_message = ?
         WHERE id = ? AND status = 'running' AND cancel_requested = 1`,
      ).run(at, code, msg, jobId);
      return 'CANCELLED';
    }
    if (opts.retryable && job.attempt < job.max_attempts) {
      db.prepare(
        `UPDATE llm_jobs
         SET status = 'queued',
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
             error_code = ?, error_message = ?
         WHERE id = ?`,
      ).run(code, msg, jobId);
      return 'REQUEUED';
    }
    db.prepare(
      `UPDATE llm_jobs
       SET status = 'failed', finished_at = ?, error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(at, code, msg, jobId);
    return 'FAILED';
  });
  return tx.immediate();
}

/**
 * 回收僵尸 running（Cancellation Durability §五）：单个事务内区分两类——
 *   A. stale + cancel_requested=1 → cancelled（保留取消意图，不复活）
 *   B. stale + cancel_requested=0 → queued（原有语义）
 */
export function recoverStaleLlmJobs(timeoutMs: number): {
  requeued: number;
  cancelled: number;
} {
  const db = getDb();
  const tx = db.transaction(() => {
    const at = now();
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const cancelled = db
      .prepare(
        `UPDATE llm_jobs
         SET status = 'cancelled', finished_at = ?,
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
           AND cancel_requested = 1`,
      )
      .run(at, cutoff).changes;
    const requeued = db
      .prepare(
        `UPDATE llm_jobs
         SET status = 'queued',
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
           AND cancel_requested = 0`,
      )
      .run(cutoff).changes;
    return {requeued, cancelled};
  });
  return tx.immediate();
}

/**
 * 请求取消（running）：返回是否真正写入（changes>0）。
 * 写入失败说明任务已不在 running（可能已被 Worker 原子提交 succeeded），
 * 调用方应重新读取并按 JOB_NOT_ACTIVE 处理。
 */
export function requestCancelLlmJob(jobId: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE llm_jobs SET cancel_requested = 1
         WHERE id = ? AND status = 'running'`,
      )
      .run(jobId).changes > 0
  );
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

/**
 * shutdown requeue（Cancellation Durability §六）：原子事务内裁决——
 *   running + cancel_requested=1 → cancelled（用户取消优先于 shutdown requeue）
 *   running + cancel_requested=0 → queued（原有语义，意图不被清除）
 *   非 running → JOB_NOT_RUNNING（调用方按日志处理）
 */
export function requeueLlmJob(jobId: string): 'REQUEUED' | 'CANCELLED' | 'JOB_NOT_RUNNING' {
  const db = getDb();
  const tx = db.transaction((): 'REQUEUED' | 'CANCELLED' | 'JOB_NOT_RUNNING' => {
    const job = getLlmJob(jobId);
    if (!job || job.status !== 'running') {
      return 'JOB_NOT_RUNNING';
    }
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE llm_jobs
         SET status = 'cancelled', finished_at = ?,
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE id = ? AND status = 'running' AND cancel_requested = 1`,
      ).run(now(), jobId);
      return 'CANCELLED';
    }
    db.prepare(
      `UPDATE llm_jobs
       SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ? AND status = 'running'`,
    ).run(jobId);
    return 'REQUEUED';
  });
  return tx.immediate();
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
  | 'CANCELLED'
  | 'DEPENDENCY_STALE'
  | 'JOB_NOT_RUNNING'
  | 'JOB_NOT_FOUND'
  | 'JOB_MISMATCH';

export type CommitLlmJobResult =
  | {code: 'COMMITTED'; version: ProjectVersionRow}
  | {code: 'DEPENDENCY_STALE'; issues: DependencyIssue[]}
  | {code: Exclude<CommitLlmJobResultCode, 'COMMITTED' | 'DEPENDENCY_STALE'>};

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
 *   1. job 前置条件（存在 / project+stage 匹配 / status=running / cancel_requested）
 *   2a. cancel_requested=1 → 同事务原子终结为 cancelled（CANCELLED），不建版本——
 *       消除「commit decision → mark cancelled」之间的 crash window
 *   2b. 否则 generateVersionTx（M2-A 事务内 helper）→ job → succeeded
 *      （WHERE status='running' AND cancel_requested=0，changes 必须为 1）
 * 任一步失败整体 rollback：不存在「version 已建但 job 未 succeeded」的部分提交窗口，
 * 也不存在 cancel fence 与 generateVersion 之间的跨进程竞态窗口。
 *
 * 竞争语义：
 * - Cancel API 先提交 cancel_requested=1 → 本事务原子终结 cancelled（不建版本）
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
      // Cancel once accepted → never resurrect：同事务直接收敛到 cancelled 终态
      const finalized = db
        .prepare(
          `UPDATE llm_jobs
           SET status = 'cancelled', finished_at = ?
           WHERE id = ? AND status = 'running' AND cancel_requested = 1`,
        )
        .run(new Date().toISOString(), input.jobId);
      if (finalized.changes !== 1) {
        throw new Error(
          `commitLlmJobResult: job ${input.jobId} cancel 终结丢失竞态（changes=${finalized.changes}）`,
        );
      }
      return {code: 'CANCELLED'};
    }

    // Dependency Commit Fence（M2-D §十一）：同事务内从 job.payload_json 读取
    // upstreamVersions，逐个核对当前上游仍 locked 且 locked_version 等于快照值；
    // 任何依赖变化 → 同事务直接 failed（DEPENDENCY_STALE，non-retryable），不建版本。
    // 顺序在 cancel 检查之后：用户 Cancel 优先于 DEPENDENCY_STALE。
    let snapshot: UpstreamVersionSnapshot;
    try {
      snapshot = payloadUpstreamVersions(llmJobPayloadSchema.parse(JSON.parse(job.payload_json)));
    } catch {
      return {code: 'JOB_MISMATCH'};
    }
    const issues = checkDependencySnapshotTx(input.projectId, snapshot);
    if (issues.length > 0) {
      const first = issues[0]!;
      const finalized = db
        .prepare(
          `UPDATE llm_jobs
           SET status = 'failed', finished_at = ?,
               error_code = 'DEPENDENCY_STALE', error_message = ?
           WHERE id = ? AND status = 'running' AND cancel_requested = 0`,
        )
        .run(
          new Date().toISOString(),
          `上游依赖已变化：stage=${first.stage} expectedVersion=${first.expectedVersion} ` +
            `currentStatus=${first.currentStatus} currentLockedVersion=${first.currentLockedVersion}`,
          input.jobId,
        );
      if (finalized.changes !== 1) {
        throw new Error(
          `commitLlmJobResult: job ${input.jobId} DEPENDENCY_STALE 终结丢失竞态（changes=${finalized.changes}）`,
        );
      }
      return {code: 'DEPENDENCY_STALE', issues};
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

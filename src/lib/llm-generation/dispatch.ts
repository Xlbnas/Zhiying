/**
 * 通用 Worker-side LLM Dispatch（generation_dispatch_jobs）。
 *
 * Production 安全边界：DEEPSEEK_API_KEY/LLM_PROVIDER 只注入 worker 容器，
 * Web 进程不持有 secret——Web route 只做 validation + exact source precheck +
 * 幂等复用查询 + enqueue + 状态查询；Worker 原子 claim 后执行 build。
 *
 * 冻结语义：
 * - dispatch 只是排队信封；真正的 durable single-flight 在 generation_runs
 *   （build 内部的 BEGIN IMMEDIATE claim）。Worker 重复执行同一 dispatch
 *   绝不重复调用 provider。
 * - UNIQUE(project_id, stage, request_id)：同 requestId 生命周期内双击/
 *   重试 POST 只产生一个 dispatch（INSERT 冲突 → 重读返回现有状态）。
 * - 崩溃恢复（recoverStaleDispatchJobs）：不自动重试可能已计费的 provider
 *   请求——generation_runs 的 indeterminate 语义兜底。
 */

import crypto from 'node:crypto';
import type {Db} from '../db';
import {findGenerationRun, RequestIdConflictError} from './runs';

/** dispatch 信封租约（执行期间 worker 周期性刷新；过期 = 持有者可能已崩溃）。 */
export const DISPATCH_LEASE_MS = 10 * 60 * 1000;
/** 崩溃判定：running dispatch 的租约过期超过该时长才回收。 */
export const DISPATCH_STALE_MS = 2 * 60 * 1000;

export interface DispatchJobRow {
  id: string;
  project_id: string;
  stage: string;
  request_id: string;
  source_artifact_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  owner_token: string | null;
  lease_expires_at: string | null;
  generation_run_id: string | null;
  result_artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

function getByKey(
  db: Db,
  projectId: string,
  stage: string,
  requestId: string,
): DispatchJobRow | undefined {
  return db
    .prepare(
      `SELECT * FROM generation_dispatch_jobs
       WHERE project_id = ? AND stage = ? AND request_id = ?`,
    )
    .get(projectId, stage, requestId) as DispatchJobRow | undefined;
}

// ── enqueue（Web route 调用；单 BEGIN IMMEDIATE） ──

export type EnqueueDispatchResult =
  | {kind: 'queued'; dispatchId: string; dispatchStatus: 'queued' | 'running'}
  | {kind: 'reused'; runId: string; resultArtifactId: string | null}
  | {kind: 'running'; runId: string; dispatchId: string | null}
  | {
      kind: 'terminal';
      runId: string | null;
      status: 'failed' | 'indeterminate';
      errorCode: string;
      errorMessage: string;
    };

/**
 * source 双持久状态冲突（M7.3B.R2）：继承 RequestIdConflictError 保持
 * route 层 instanceof 映射（409 REQUEST_ID_CONFLICT）不变，但 message
 * 明确列出 persisted run source / persisted dispatch source 与 fail-closed
 * 语义（只含 artifact ID/source key，无 prompt/content）。
 */
export class SourceInvariantConflictError extends RequestIdConflictError {
  constructor(requestId: string, boundSourceArtifactId: string, message: string) {
    super(requestId, boundSourceArtifactId);
    this.message = message;
    this.name = 'RequestIdConflictError';
  }
}

/**
 * 入队 dispatch（单 BEGIN IMMEDIATE）：
 * 1. 统一读取 generation_run 与 generation_dispatch_jobs 两份持久状态；
 * 2. **source 双持久状态 fail-closed（M7.3B.R2）**：在任何 status 返回之前，
 *    input vs run、input vs dispatch、run vs dispatch（两者同时存在时）
 *    三组 source 必须完全一致；任一组不一致 → RequestIdConflictError
 *    （message 明确 requestId、persisted run source、persisted dispatch source；
 *    只含 artifact ID/source key，无 prompt/content）。不修改/不删除/不覆盖
 *    任一持久 source，不重新生成，不调用 provider。
 * 3. 按状态短路（同 source 正常行为保持）：
 *    - run succeeded → reused；run failed/indeterminate → terminal；
 *    - run running 且租约有效 → running（附已有 dispatchId）；
 *      run running 但租约过期 → 落入入队（worker 经 build 的 durable claim
 *      将 run 转 indeterminate 后映射为 dispatch 终态）；
 *    - dispatch succeeded → reused；dispatch failed/cancelled → terminal；
 *    - dispatch queued/running（含 dispatch-only running：scheduler 已 claim、
 *      generation_run 尚未创建）→ queued variant（dispatchStatus 原样返回，
 *      由 route 直接透出，不再一律 queued）；
 *    - 两者都不存在 → INSERT 新 dispatch → queued。
 * 已有 artifact 内容含该 requestId 的 legacy 复用由调用方先行处理，不在此层。
 */
export function enqueueGenerationDispatch(
  db: Db,
  input: {projectId: string; stage: string; requestId: string; sourceArtifactId: string},
): EnqueueDispatchResult {
  const tx = db.transaction((): EnqueueDispatchResult => {
    const now = new Date();
    const run = findGenerationRun(db, input.projectId, input.stage, input.requestId);
    const dispatch = getByKey(db, input.projectId, input.stage, input.requestId);

    // ── source 双持久状态 fail-closed（任何 status 返回之前） ──
    if (run && run.source_artifact_id !== input.sourceArtifactId) {
      throw new SourceInvariantConflictError(
        input.requestId,
        run.source_artifact_id,
        `requestId=${input.requestId}：persisted generation_run source=${run.source_artifact_id} 与 input source=${input.sourceArtifactId} 不一致（fail-closed，不选择任一继续）`,
      );
    }
    if (dispatch && dispatch.source_artifact_id !== input.sourceArtifactId) {
      throw new SourceInvariantConflictError(
        input.requestId,
        dispatch.source_artifact_id,
        `requestId=${input.requestId}：persisted dispatch source=${dispatch.source_artifact_id} 与 input source=${input.sourceArtifactId} 不一致（fail-closed，不选择任一继续）`,
      );
    }
    if (run && dispatch && run.source_artifact_id !== dispatch.source_artifact_id) {
      throw new SourceInvariantConflictError(
        input.requestId,
        run.source_artifact_id,
        `requestId=${input.requestId}：persisted generation_run source=${run.source_artifact_id} 与 persisted dispatch source=${dispatch.source_artifact_id} 互相矛盾（fail-closed，即使 input 恰好匹配其中之一也不继续）`,
      );
    }

    // ── 状态短路（同 source 正常行为） ──
    if (run) {
      if (run.status === 'succeeded') {
        return {kind: 'reused', runId: run.id, resultArtifactId: run.result_artifact_id};
      }
      if (run.status === 'failed' || run.status === 'indeterminate') {
        return {
          kind: 'terminal',
          runId: run.id,
          status: run.status,
          errorCode: run.error_code ?? 'UNKNOWN',
          errorMessage: run.error_message ?? '',
        };
      }
      // running：租约有效 → in_progress；租约过期 → 落入入队（worker 经 claim 兜底）
      const leaseExpiresAt = run.lease_expires_at ? Date.parse(run.lease_expires_at) : 0;
      if (leaseExpiresAt > now.getTime()) {
        return {kind: 'running', runId: run.id, dispatchId: dispatch?.id ?? null};
      }
    }
    if (dispatch) {
      if (dispatch.status === 'succeeded') {
        return {
          kind: 'reused',
          runId: dispatch.generation_run_id ?? '',
          resultArtifactId: dispatch.result_artifact_id,
        };
      }
      if (dispatch.status === 'failed' || dispatch.status === 'cancelled') {
        return {
          kind: 'terminal',
          runId: dispatch.generation_run_id,
          status: 'failed',
          errorCode: dispatch.error_code ?? 'UNKNOWN',
          errorMessage: dispatch.error_message ?? '',
        };
      }
      // queued / running（含 dispatch-only running）→ 原样透出信封状态。
      return {kind: 'queued', dispatchId: dispatch.id, dispatchStatus: dispatch.status};
    }

    const id = crypto.randomUUID();
    const iso = now.toISOString();
    db.prepare(
      `INSERT INTO generation_dispatch_jobs (
         id, project_id, stage, request_id, source_artifact_id,
         status, owner_token, lease_expires_at,
         generation_run_id, result_artifact_id, error_code, error_message,
         created_at, started_at, finished_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)
       ON CONFLICT(project_id, stage, request_id) DO NOTHING`,
    ).run(id, input.projectId, input.stage, input.requestId, input.sourceArtifactId, iso, iso);
    const row = getByKey(db, input.projectId, input.stage, input.requestId);
    if (!row) {
      throw new Error(`enqueueGenerationDispatch: dispatch 写入后不可读（内部错误）`);
    }
    // 刚插入的行必然与 input source 一致；防御性再查一次（幂等重读路径）。
    if (row.source_artifact_id !== input.sourceArtifactId) {
      throw new SourceInvariantConflictError(
        input.requestId,
        row.source_artifact_id,
        `requestId=${input.requestId}：persisted dispatch source=${row.source_artifact_id} 与 input source=${input.sourceArtifactId} 不一致（fail-closed）`,
      );
    }
    if (row.status === 'queued' || row.status === 'running') {
      return {kind: 'queued', dispatchId: row.id, dispatchStatus: row.status};
    }
    if (row.status === 'succeeded') {
      return {
        kind: 'reused',
        runId: row.generation_run_id ?? '',
        resultArtifactId: row.result_artifact_id,
      };
    }
    // failed / cancelled：信封终态稳定返回（不自动重试；显式 regenerate 用新 requestId）
    return {
      kind: 'terminal',
      runId: row.generation_run_id,
      status: 'failed',
      errorCode: row.error_code ?? 'UNKNOWN',
      errorMessage: row.error_message ?? '',
    };
  });
  return tx.immediate();
}

// ── 状态查询（API/UI 状态面） ──

export interface DispatchJobSummary {
  dispatchId: string;
  stage: string;
  requestId: string;
  sourceArtifactId: string;
  status: DispatchJobRow['status'];
  generationRunId: string | null;
  resultArtifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function toSummary(row: DispatchJobRow): DispatchJobSummary {
  return {
    dispatchId: row.id,
    stage: row.stage,
    requestId: row.request_id,
    sourceArtifactId: row.source_artifact_id,
    status: row.status,
    generationRunId: row.generation_run_id,
    resultArtifactId: row.result_artifact_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function getDispatchJob(db: Db, id: string): DispatchJobRow | null {
  const row = db
    .prepare(`SELECT * FROM generation_dispatch_jobs WHERE id = ?`)
    .get(id) as DispatchJobRow | undefined;
  return row ?? null;
}

export function listDispatchJobs(db: Db, projectId: string, stage?: string): DispatchJobSummary[] {
  const rows = (
    stage
      ? db
          .prepare(
            `SELECT * FROM generation_dispatch_jobs
             WHERE project_id = ? AND stage = ? ORDER BY created_at DESC`,
          )
          .all(projectId, stage)
      : db
          .prepare(
            `SELECT * FROM generation_dispatch_jobs
             WHERE project_id = ? ORDER BY created_at DESC`,
          )
          .all(projectId)
  ) as DispatchJobRow[];
  return rows.map(toSummary);
}

// ── worker 执行面 ──

/** 执行期间周期性刷新租约（校验 owner；非 running/owner 失配 → false，调用方忽略）。 */
export function heartbeatDispatchLease(
  db: Db,
  dispatchId: string,
  ownerToken: string,
  leaseMs: number = DISPATCH_LEASE_MS,
): boolean {
  const now = new Date();
  return (
    db
      .prepare(
        `UPDATE generation_dispatch_jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        dispatchId,
        ownerToken,
      ).changes === 1
  );
}

/** 成功终态（校验 owner）：关联 generation_run + result artifact。 */
export function completeDispatchSucceeded(
  db: Db,
  input: {dispatchId: string; ownerToken: string; runId: string | null; resultArtifactId: string},
): void {
  const now = new Date().toISOString();
  const changed = db
    .prepare(
      `UPDATE generation_dispatch_jobs
       SET status = 'succeeded', owner_token = NULL, lease_expires_at = NULL,
           generation_run_id = ?, result_artifact_id = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(input.runId, input.resultArtifactId, now, now, input.dispatchId, input.ownerToken).changes;
  if (changed !== 1) {
    throw new Error(`completeDispatchSucceeded: dispatch ${input.dispatchId} 状态非法（owner 不匹配或已终态）`);
  }
}

/** 失败终态（校验 owner）：generation run 终态 / precheck 失败 / WORKER_CRASH。 */
export function completeDispatchFailed(
  db: Db,
  input: {
    dispatchId: string;
    ownerToken: string;
    runId: string | null;
    errorCode: string;
    errorMessage: string;
  },
): void {
  const now = new Date().toISOString();
  const changed = db
    .prepare(
      `UPDATE generation_dispatch_jobs
       SET status = 'failed', owner_token = NULL, lease_expires_at = NULL,
           generation_run_id = ?, error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(
      input.runId,
      input.errorCode,
      input.errorMessage.slice(0, 2000),
      now,
      now,
      input.dispatchId,
      input.ownerToken,
    ).changes;
  if (changed !== 1) {
    throw new Error(`completeDispatchFailed: dispatch ${input.dispatchId} 状态非法（owner 不匹配或已终态）`);
  }
}

/**
 * 信封回 queued（校验 owner）：run 仍 in_progress（他人持有 claim）或 worker
 * 优雅退出时——durable single-flight 保证重执行零重复 provider 调用。
 */
export function requeueDispatch(db: Db, dispatchId: string, ownerToken: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE generation_dispatch_jobs
     SET status = 'queued', owner_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND owner_token = ? AND status = 'running'`,
  ).run(now, dispatchId, ownerToken);
}

/**
 * Worker 启动回收（单 BEGIN IMMEDIATE）。规则：
 * - generation_run 存在且 running（租约未过期）→ dispatch 回 queued 等待
 *   （run 可能仍在被其他持有者执行；重执行经 durable claim 短路，零重复计费）；
 * - run 不存在或已 terminal → dispatch 标 failed('WORKER_CRASH')，不自动重试
 *   可能已计费的 provider 请求——generation_runs 的 indeterminate 语义兜底。
 */
export function recoverStaleDispatchJobs(
  db: Db,
  staleMs: number = DISPATCH_STALE_MS,
): {requeued: number; failed: number} {
  const tx = db.transaction((): {requeued: number; failed: number} => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - staleMs).toISOString();
    const stale = db
      .prepare(
        `SELECT * FROM generation_dispatch_jobs
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(cutoff) as DispatchJobRow[];
    let requeued = 0;
    let failed = 0;
    const iso = now.toISOString();
    for (const row of stale) {
      const run = findGenerationRun(db, row.project_id, row.stage, row.request_id);
      const runLeaseValid =
        run !== null &&
        run.status === 'running' &&
        run.lease_expires_at !== null &&
        Date.parse(run.lease_expires_at) > now.getTime();
      if (runLeaseValid) {
        db.prepare(
          `UPDATE generation_dispatch_jobs
           SET status = 'queued', owner_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(iso, row.id);
        requeued++;
      } else {
        db.prepare(
          `UPDATE generation_dispatch_jobs
           SET status = 'failed', owner_token = NULL, lease_expires_at = NULL,
               generation_run_id = ?, error_code = 'WORKER_CRASH',
               error_message = 'running dispatch 租约过期（worker 可能崩溃）且无有效 running generation run——不自动重试可能已计费的 provider 请求，需新 requestId 重新生成',
               finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(run?.id ?? null, iso, iso, row.id);
        failed++;
      }
    }
    return {requeued, failed};
  });
  return tx.immediate();
}

/**
 * Durable single-flight generation runs + attempt journal（M7.2.1 通用化）。
 *
 * 通用 LLM generation 控制面：stage 参数化（m7_narrative_beats /
 * m7_visual_intent / …），全部 M7 candidate 生成共用同一套
 * generation_runs / generation_attempts 表——不得复制第二套。
 *
 * 冻结语义：
 * - (project_id, stage, request_id) 唯一行在任何 provider 调用之前以
 *   BEGIN IMMEDIATE 原子 claim：同一逻辑 run 最多一个调用方到达 provider，
 *   并发双计费在 DB 层被阻断（不依赖进程内 Map）。
 * - requestId 终态语义：succeeded → 永远复用同一 artifact；running（租约有效）
 *   → in_progress，绝不二次调用 provider；failed / indeterminate → 返回同一
 *   终态，绝不自动重试。显式 regenerate 必须使用新 requestId。
 * - 租约过期 ≠ 自动重试：provider 无服务端幂等键，进程崩溃后无法证明请求
 *   是否已计费，保守标记 indeterminate，要求新 requestId。
 * - attempt journal append-only：每次 provider 请求（proposal + repair）一行，
 *   保存安全 request 投影/response 原文与 hash/validation issues/usage 关联。
 *   禁止写入 Authorization/header/secret。
 */

import crypto from 'node:crypto';
import {z} from 'zod';
import type {Db} from '../db';

export const GENERATION_RUN_LEASE_MS = 15 * 60 * 1000;
export const GENERATION_IN_PROGRESS_RETRY_AFTER_MS = 5000;

const requestIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * canonicalize 调用方幂等键：trim + 有界安全字符集。
 * 非法（空/过短/超长/换行/控制字符/空白）→ 返回 null（调用方映射 422）。
 * `' abc '` 与 `'abc'` canonicalize 后为同一键。
 */
export function canonicalizeRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = requestIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface GenerationRunRow {
  id: string;
  project_id: string;
  stage: string;
  request_id: string;
  source_artifact_id: string;
  status: 'running' | 'succeeded' | 'failed' | 'indeterminate';
  owner_token: string | null;
  lease_expires_at: string | null;
  result_artifact_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export type ClaimResult =
  | {kind: 'claimed'; run: GenerationRunRow}
  | {kind: 'succeeded'; run: GenerationRunRow}
  | {kind: 'in_progress'; run: GenerationRunRow; retryAfterMs: number}
  | {kind: 'terminal'; run: GenerationRunRow};

export class RequestIdConflictError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly boundSourceArtifactId: string,
  ) {
    super(
      `requestId ${requestId} 已绑定 source artifact ${boundSourceArtifactId}，不得复用于其他 source`,
    );
    this.name = 'RequestIdConflictError';
  }
}

function getRun(db: Db, projectId: string, stage: string, requestId: string): GenerationRunRow | undefined {
  return db
    .prepare(`SELECT * FROM generation_runs WHERE project_id = ? AND stage = ? AND request_id = ?`)
    .get(projectId, stage, requestId) as GenerationRunRow | undefined;
}

/** 只读查找（不做状态转移）：legacy 复用路径补充 run 关联用。 */
export function findGenerationRun(
  db: Db,
  projectId: string,
  stage: string,
  requestId: string,
): GenerationRunRow | null {
  return getRun(db, projectId, stage, requestId) ?? null;
}

/**
 * 原子 claim（单 BEGIN IMMEDIATE）：
 * 1. 已存在同 (project, stage, requestId)：
 *    - source 不同 → RequestIdConflictError；
 *    - succeeded → 复用；failed/indeterminate → 同一终态；
 *    - running 且租约有效 → in_progress（绝不调用 provider）；
 *    - running 且租约过期 → 同事务转 indeterminate（崩溃保守语义，
 *      孤儿 in_flight attempt 一并转 indeterminate），返回 terminal。
 * 2. 不存在 → INSERT running + owner_token + lease，当前调用方取得 claim。
 * 不持有任何跨 provider 网络调用的写事务。
 */
export function claimGenerationRun(
  db: Db,
  input: {projectId: string; stage: string; requestId: string; sourceArtifactId: string},
): ClaimResult {
  const tx = db.transaction((): ClaimResult => {
    const existing = getRun(db, input.projectId, input.stage, input.requestId);
    const now = new Date();
    if (existing) {
      if (existing.source_artifact_id !== input.sourceArtifactId) {
        throw new RequestIdConflictError(input.requestId, existing.source_artifact_id);
      }
      if (existing.status === 'succeeded') return {kind: 'succeeded', run: existing};
      if (existing.status === 'failed' || existing.status === 'indeterminate') {
        return {kind: 'terminal', run: existing};
      }
      // running
      const leaseExpiresAt = existing.lease_expires_at ? Date.parse(existing.lease_expires_at) : 0;
      if (leaseExpiresAt > now.getTime()) {
        return {kind: 'in_progress', run: existing, retryAfterMs: GENERATION_IN_PROGRESS_RETRY_AFTER_MS};
      }
      // 租约过期：不自动重调 provider（无法证明崩溃前是否已计费）→ indeterminate
      const finished = now.toISOString();
      db.prepare(
        `UPDATE generation_runs
         SET status = 'indeterminate', owner_token = NULL, lease_expires_at = NULL,
             error_code = 'LEASE_EXPIRED',
             error_message = 'running 租约过期（进程可能崩溃）；provider 无服务端幂等键，保守标记 indeterminate，需新 requestId 重新生成',
             finished_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(finished, finished, existing.id);
      db.prepare(
        `UPDATE generation_attempts SET status = 'indeterminate', finished_at = ?
         WHERE run_id = ? AND status = 'in_flight'`,
      ).run(finished, existing.id);
      const run = db.prepare(`SELECT * FROM generation_runs WHERE id = ?`).get(existing.id) as GenerationRunRow;
      return {kind: 'terminal', run};
    }

    const id = crypto.randomUUID();
    const iso = now.toISOString();
    db.prepare(
      `INSERT INTO generation_runs (
         id, project_id, stage, request_id, source_artifact_id,
         status, owner_token, lease_expires_at,
         result_artifact_id, error_code, error_message,
         created_at, started_at, finished_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    ).run(
      id,
      input.projectId,
      input.stage,
      input.requestId,
      input.sourceArtifactId,
      crypto.randomUUID(),
      new Date(now.getTime() + GENERATION_RUN_LEASE_MS).toISOString(),
      iso,
      iso,
      iso,
    );
    const run = db.prepare(`SELECT * FROM generation_runs WHERE id = ?`).get(id) as GenerationRunRow;
    return {kind: 'claimed', run};
  });
  return tx.immediate();
}

/** 每个 attempt 开始前刷新租约（校验 owner，防误转移）。 */
export function refreshRunLease(db: Db, runId: string, ownerToken: string): void {
  const now = new Date();
  const changed = db
    .prepare(
      `UPDATE generation_runs
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(new Date(now.getTime() + GENERATION_RUN_LEASE_MS).toISOString(), now.toISOString(), runId, ownerToken)
    .changes;
  if (changed !== 1) {
    throw new Error(`refreshRunLease: run ${runId} 不属于当前 owner 或已非 running`);
  }
}

/** 成功终态：running → succeeded + result artifact（校验 owner）。 */
export function completeGenerationRunSuccess(
  db: Db,
  input: {runId: string; ownerToken: string; resultArtifactId: string},
): void {
  const now = new Date().toISOString();
  const changed = db
    .prepare(
      `UPDATE generation_runs
       SET status = 'succeeded', owner_token = NULL, lease_expires_at = NULL,
           result_artifact_id = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(input.resultArtifactId, now, now, input.runId, input.ownerToken).changes;
  if (changed !== 1) {
    throw new Error(`completeGenerationRunSuccess: run ${input.runId} 状态非法（owner 不匹配或已终态）`);
  }
}

/** 失败终态：running → failed + error（校验 owner）。 */
export function completeGenerationRunFailure(
  db: Db,
  input: {runId: string; ownerToken: string; errorCode: string; errorMessage: string},
): void {
  const now = new Date().toISOString();
  const changed = db
    .prepare(
      `UPDATE generation_runs
       SET status = 'failed', owner_token = NULL, lease_expires_at = NULL,
           error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(input.errorCode, input.errorMessage.slice(0, 2000), now, now, input.runId, input.ownerToken).changes;
  if (changed !== 1) {
    throw new Error(`completeGenerationRunFailure: run ${input.runId} 状态非法（owner 不匹配或已终态）`);
  }
}

// ── attempt journal ──

export interface GenerationAttemptRow {
  id: string;
  run_id: string;
  attempt_number: number;
  provider: string;
  model: string;
  request_hash: string;
  request_json: string;
  provider_request_id: string | null;
  response_hash: string | null;
  response_text: string | null;
  finish_reason: string | null;
  parse_result: 'pass' | 'fail' | null;
  schema_issues_json: string | null;
  semantic_issues_json: string | null;
  usage_record_id: string | null;
  status:
    | 'in_flight'
    | 'response_received'
    | 'validation_failed'
    | 'succeeded'
    | 'transport_failed'
    | 'indeterminate';
  created_at: string;
  finished_at: string | null;
}

export function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** provider 调用前写入 in_flight attempt（安全 request 投影，绝无 header/secret）。 */
export function insertAttemptInFlight(
  db: Db,
  input: {
    runId: string;
    attemptNumber: number;
    provider: string;
    model: string;
    requestHash: string;
    requestJson: string;
  },
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO generation_attempts (
       id, run_id, attempt_number, provider, model,
       request_hash, request_json,
       provider_request_id, response_hash, response_text, finish_reason,
       parse_result, schema_issues_json, semantic_issues_json, usage_record_id,
       status, created_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'in_flight', ?, NULL)`,
  ).run(
    id,
    input.runId,
    input.attemptNumber,
    input.provider,
    input.model,
    input.requestHash,
    input.requestJson,
    new Date().toISOString(),
  );
  return id;
}

export function updateAttempt(
  db: Db,
  attemptId: string,
  patch: {
    providerRequestId?: string | null;
    responseHash?: string | null;
    responseText?: string | null;
    finishReason?: string | null;
    parseResult?: 'pass' | 'fail' | null;
    schemaIssuesJson?: string | null;
    semanticIssuesJson?: string | null;
    usageRecordId?: string | null;
    status: GenerationAttemptRow['status'];
  },
): void {
  db.prepare(
    `UPDATE generation_attempts
     SET provider_request_id = COALESCE(?, provider_request_id),
         response_hash = COALESCE(?, response_hash),
         response_text = COALESCE(?, response_text),
         finish_reason = COALESCE(?, finish_reason),
         parse_result = COALESCE(?, parse_result),
         schema_issues_json = COALESCE(?, schema_issues_json),
         semantic_issues_json = COALESCE(?, semantic_issues_json),
         usage_record_id = COALESCE(?, usage_record_id),
         status = ?, finished_at = ?
     WHERE id = ?`,
  ).run(
    patch.providerRequestId ?? null,
    patch.responseHash ?? null,
    patch.responseText ?? null,
    patch.finishReason ?? null,
    patch.parseResult ?? null,
    patch.schemaIssuesJson ?? null,
    patch.semanticIssuesJson ?? null,
    patch.usageRecordId ?? null,
    patch.status,
    new Date().toISOString(),
    attemptId,
  );
}

export function listRunAttempts(db: Db, runId: string): GenerationAttemptRow[] {
  return db
    .prepare(`SELECT * FROM generation_attempts WHERE run_id = ? ORDER BY attempt_number ASC`)
    .all(runId) as GenerationAttemptRow[];
}

// ── run 查询（API/UI 状态面） ──

export interface GenerationRunSummary {
  runId: string;
  requestId: string;
  stage: string;
  status: GenerationRunRow['status'];
  sourceArtifactId: string;
  resultArtifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  usageCount: number;
  costCny: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function listGenerationRunSummaries(db: Db, projectId: string, stage: string): GenerationRunSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM generation_runs WHERE project_id = ? AND stage = ? ORDER BY created_at DESC`,
    )
    .all(projectId, stage) as GenerationRunRow[];
  return rows.map((run) => {
    const attemptCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM generation_attempts WHERE run_id = ?`).get(run.id) as {c: number}
    ).c;
    const usage = db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(cost_cny), 0) AS cost
         FROM llm_usage WHERE project_id = ? AND stage = ? AND job_id = ?`,
      )
      .get(projectId, stage, run.request_id) as {c: number; cost: number};
    return {
      runId: run.id,
      requestId: run.request_id,
      stage: run.stage,
      status: run.status,
      sourceArtifactId: run.source_artifact_id,
      resultArtifactId: run.result_artifact_id,
      errorCode: run.error_code,
      errorMessage: run.error_message,
      attemptCount,
      usageCount: usage.c,
      costCny: usage.cost,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
    };
  });
}

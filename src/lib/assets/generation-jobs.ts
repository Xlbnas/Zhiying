/**
 * Durable Asset Generation Job 队列（M7.3A.2）。
 *
 * Web 侧只做 validation + 幂等 enqueue + 状态查询；
 * Worker 侧原子 claim 后调用图像 provider，持久化 candidate 与 usage。
 * 同 (project_id, scene_id, requirement_id, request_id) 生命周期内只产生一个 job，
 * 跨进程/页面重试/双击均不重复调用 provider。
 */

import crypto from 'node:crypto';
import {getDb} from '../db';
import {
  buildRequirementSnapshot,
  computeRequirementSnapshotHash,
  findRequirementInPlans,
  loadLatestScenesPlans,
  type AssetRequirementSnapshot,
} from './requirements';
import {isSceneVisuallyOverridden} from '../scenes/visual-overrides';

export type {AssetRequirementSnapshot} from './requirements';
export {buildRequirementSnapshot, computeRequirementSnapshotHash} from './requirements';

export type AssetGenerationJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'indeterminate'
  | 'cancelled';

export type AssetGenerationBillingStatus =
  | 'confirmed_zero'
  | 'confirmed_charged'
  | 'unknown_billing';

export interface AssetGenerationJobRow {
  id: string;
  project_id: string;
  scene_id: string;
  requirement_id: string;
  request_id: string;
  prompt: string;
  provider: string;
  model: string;
  resource_class: string;
  resource_group: string | null;
  source_scenes_version_id: string | null;
  source_requirement_hash: string | null;
  requirement_json: string | null;
  request_fingerprint: string | null;
  status: AssetGenerationJobStatus;
  result_relevance: 'current' | 'stale' | null;
  owner_token: string | null;
  lease_expires_at: string | null;
  provider_request_id: string | null;
  result_asset_id: string | null;
  error_code: string | null;
  error_message: string | null;
  failure_phase: string | null;
  billing_status: AssetGenerationBillingStatus | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface EnqueueAssetGenerationInput {
  projectId: string;
  sceneId: string;
  requirementId: string;
  requestId: string;
  prompt: string;
  provider: string;
  model: string;
  resourceClass: string;
  resourceGroup: string | null;
  sourceScenesVersionId: string;
  requirementSnapshot: AssetRequirementSnapshot;
}

export interface EnqueueAssetGenerationResult {
  jobId: string;
  requestId: string;
  status: AssetGenerationJobStatus;
  reused: boolean;
}

export interface ClaimAssetGenerationResult {
  kind: 'claimed' | 'not_found' | 'not_queued' | 'lease_failed';
  job?: AssetGenerationJobRow;
  ownerToken?: string;
}

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

/**
 * M7.3A.3：prompt 规范化（仅做字符级规范化，不做语义改写）：
 * trim 首尾空白；CRLF/CR → LF；去除每行行尾空白。
 */
export function normalizeGenerationPrompt(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** requirement snapshot 的确定性 hash（enqueue 与 executor/fence 共用同一算法）。 */
// computeRequirementSnapshotHash / buildRequirementSnapshot 定义于 ./requirements
// （避免 requirements ↔ generation-jobs 循环依赖），顶部统一 re-export。

/**
 * M7.3A.3：strict request fingerprint —— 相同 requestId 只代表完全相同的逻辑请求。
 * 覆盖 projectId/sceneId/requirementId/normalizedPrompt/provider/model/resourceClass/
 * sourceScenesVersionId/sourceRequirementHash；任一字段不同 → fingerprint 不同。
 */
export function computeRequestFingerprint(input: {
  projectId: string;
  sceneId: string;
  requirementId: string;
  prompt: string;
  provider: string;
  model: string;
  resourceClass: string;
  sourceScenesVersionId: string;
  sourceRequirementHash: string;
}): string {
  const payload = JSON.stringify({
    projectId: input.projectId,
    sceneId: input.sceneId,
    requirementId: input.requirementId,
    normalizedPrompt: normalizeGenerationPrompt(input.prompt),
    provider: input.provider,
    model: input.model,
    resourceClass: input.resourceClass,
    sourceScenesVersionId: input.sourceScenesVersionId,
    sourceRequirementHash: input.sourceRequirementHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function getById(id: string): AssetGenerationJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM asset_generation_jobs WHERE id = ?')
    .get(id) as AssetGenerationJobRow | undefined;
}

export function getAssetGenerationJobByRequestId(
  projectId: string,
  sceneId: string,
  requirementId: string,
  requestId: string,
): AssetGenerationJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM asset_generation_jobs
       WHERE project_id = ? AND scene_id = ? AND requirement_id = ? AND request_id = ?`,
    )
    .get(projectId, sceneId, requirementId, requestId) as AssetGenerationJobRow | undefined;
}

export function listAssetGenerationJobs(
  projectId: string,
  sceneId?: string,
  requirementId?: string,
): AssetGenerationJobRow[] {
  if (sceneId && requirementId) {
    return getDb()
      .prepare(
        `SELECT * FROM asset_generation_jobs
         WHERE project_id = ? AND scene_id = ? AND requirement_id = ?
         ORDER BY created_at DESC`,
      )
      .all(projectId, sceneId, requirementId) as AssetGenerationJobRow[];
  }
  return getDb()
    .prepare('SELECT * FROM asset_generation_jobs WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as AssetGenerationJobRow[];
}

/**
 * 每个 (scene_id, requirement_id) 的最新 job（用于 resolver/reconciliation）。
 * DESC 遍历，每个复合 key 只保留第一个（即最新的）。
 * key = `${scene_id}:${requirement_id}`——不依赖 requirementId 含 sceneId 前缀的偶然格式。
 */
export function listLatestAssetGenerationJobsByRequirement(
  projectId: string,
): Map<string, AssetGenerationJobRow> {
  const jobs = getDb()
    .prepare(
      `SELECT * FROM asset_generation_jobs
       WHERE project_id = ?
       ORDER BY created_at DESC`,
    )
    .all(projectId) as AssetGenerationJobRow[];
  const byReq = new Map<string, AssetGenerationJobRow>();
  for (const job of jobs) {
    const key = `${job.scene_id}:${job.requirement_id}`;
    if (!byReq.has(key)) {
      byReq.set(key, job);
    }
  }
  return byReq;
}

/**
 * Web 入队入口：在单个 BEGIN IMMEDIATE 内完成 exact requirement 校验 +
 * 幂等 INSERT（UNIQUE 冲突 → 重读现有行，按 fingerprint 判定 reused 或 409）。
 * enqueue 时冻结 exact source scenes version + requirement snapshot + request fingerprint。
 * 相同 requestId + 相同 fingerprint → reused；相同 requestId + 不同 fingerprint →
 * REQUEST_ID_CONFLICT（零 provider call、不修改旧 job）。
 */
export function enqueueAssetGenerationJob(
  input: EnqueueAssetGenerationInput,
): EnqueueAssetGenerationResult {
  const db = getDb();
  const tx = db.transaction((): EnqueueAssetGenerationResult => {
    // exact requirement 校验
    const plans = loadLatestScenesPlans(input.projectId);
    if (!plans) {
      throw new AssetGenerationJobError('SCENES_NOT_FOUND', '项目缺少 scenes artifact');
    }
    const found = findRequirementInPlans(plans, input.sceneId, input.requirementId);
    if (!found) {
      throw new AssetGenerationJobError(
        'REQUIREMENT_NOT_FOUND',
        `需求 ${input.requirementId} 不存在于场景 ${input.sceneId}`,
      );
    }
    if (isSceneVisuallyOverridden(input.projectId, input.sceneId)) {
      throw new AssetGenerationJobError(
        'SCENE_OVERRIDDEN',
        `场景 ${input.sceneId} 已改用 MG 模板，无需生成素材`,
      );
    }

    // 计算 source requirement hash（用于执行期校验 source version 匹配）
    const requirementJson = JSON.stringify(input.requirementSnapshot);
    const sourceHash = computeRequirementSnapshotHash(requirementJson);

    // M7.3A.3：strict request fingerprint
    const normalizedPrompt = normalizeGenerationPrompt(input.prompt);
    const fingerprint = computeRequestFingerprint({
      projectId: input.projectId,
      sceneId: input.sceneId,
      requirementId: input.requirementId,
      prompt: normalizedPrompt,
      provider: input.provider,
      model: input.model,
      resourceClass: input.resourceClass,
      sourceScenesVersionId: input.sourceScenesVersionId,
      sourceRequirementHash: sourceHash,
    });

    const id = crypto.randomUUID();
    const at = now();
    db.prepare(
      `INSERT INTO asset_generation_jobs (
         id, project_id, scene_id, requirement_id, request_id,
         prompt, provider, model,
         resource_class, resource_group,
         source_scenes_version_id, source_requirement_hash, requirement_json,
         request_fingerprint,
         status,
         owner_token, lease_expires_at,
         provider_request_id, result_asset_id,
         error_code, error_message, failure_phase, billing_status,
         created_at, started_at, finished_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued',
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         ?, NULL, NULL, ?)
       ON CONFLICT(project_id, scene_id, requirement_id, request_id) DO NOTHING`,
    ).run(
      id,
      input.projectId,
      input.sceneId,
      input.requirementId,
      input.requestId,
      normalizedPrompt,
      input.provider,
      input.model,
      input.resourceClass,
      input.resourceGroup,
      input.sourceScenesVersionId,
      sourceHash,
      requirementJson,
      fingerprint,
      at,
      at,
    );

    const row = getAssetGenerationJobByRequestId(
      input.projectId,
      input.sceneId,
      input.requirementId,
      input.requestId,
    );
    if (!row) {
      throw new AssetGenerationJobError('INTERNAL_ERROR', 'asset_generation_jobs 写入后不可读');
    }

    if (row.id !== id) {
      // UNIQUE 冲突：已存在同 requestId 的 job —— 校验 fingerprint 严格一致
      const existingFingerprint = row.request_fingerprint ?? computeRequestFingerprint({
        projectId: row.project_id,
        sceneId: row.scene_id,
        requirementId: row.requirement_id,
        prompt: normalizeGenerationPrompt(row.prompt),
        provider: row.provider,
        model: row.model,
        resourceClass: row.resource_class,
        sourceScenesVersionId: row.source_scenes_version_id ?? '',
        sourceRequirementHash: row.source_requirement_hash ?? '',
      });
      if (existingFingerprint === fingerprint) {
        // fingerprint 一致 → reused；旧行缺失 fingerprint 时确定性回填（幂等）
        if (!row.request_fingerprint) {
          db.prepare('UPDATE asset_generation_jobs SET request_fingerprint = ? WHERE id = ?')
            .run(fingerprint, row.id);
        }
        return {
          jobId: row.id,
          requestId: row.request_id,
          status: row.status,
          reused: true,
        };
      }
      // fingerprint 不一致：同一 requestId 不能代表不同逻辑请求
      const diffs = describeRequestDiff(row, {
        prompt: normalizedPrompt,
        provider: input.provider,
        model: input.model,
        resourceClass: input.resourceClass,
        sourceScenesVersionId: input.sourceScenesVersionId,
        sourceRequirementHash: sourceHash,
      });
      throw new AssetGenerationJobError(
        'REQUEST_ID_CONFLICT',
        `requestId ${input.requestId} 已被不同逻辑请求占用（字段差异：${diffs.join(', ')}）。请使用新 requestId 发起新请求。`,
      );
    }
    return {
      jobId: row.id,
      requestId: row.request_id,
      status: row.status,
      reused: row.id !== id,
    };
  });
  return tx.immediate();
}

/** 计算已存在 job 与本次输入之间的字段差异（只列字段名，不含值，不泄露 secret）。 */
function describeRequestDiff(
  existing: AssetGenerationJobRow,
  input: {
    prompt: string;
    provider: string;
    model: string;
    resourceClass: string;
    sourceScenesVersionId: string;
    sourceRequirementHash: string;
  },
): string[] {
  const diffs: string[] = [];
  if (normalizeGenerationPrompt(existing.prompt) !== input.prompt) diffs.push('prompt');
  if (existing.provider !== input.provider) diffs.push('provider');
  if (existing.model !== input.model) diffs.push('model');
  if (existing.resource_class !== input.resourceClass) diffs.push('resourceClass');
  if ((existing.source_scenes_version_id ?? '') !== input.sourceScenesVersionId) diffs.push('sourceScenesVersionId');
  if ((existing.source_requirement_hash ?? '') !== input.sourceRequirementHash) diffs.push('sourceRequirementHash');
  return diffs;
}

/**
 * Worker 原子 claim：status=queued → running，并分配 owner_token + lease。
 */
export function claimAssetGenerationJob(
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): ClaimAssetGenerationResult {
  const db = getDb();
  const tx = db.transaction((): ClaimAssetGenerationResult => {
    const at = now();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const ownerToken = `${workerId}:asset_generation:${crypto.randomUUID()}`;

    const candidate = db
      .prepare(
        `SELECT * FROM asset_generation_jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get() as AssetGenerationJobRow | undefined;
    if (!candidate) {
      return {kind: 'not_found'};
    }

    const changed = db
      .prepare(
        `UPDATE asset_generation_jobs
         SET status = 'running', owner_token = ?, lease_expires_at = ?,
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(ownerToken, expiresAt, at, at, candidate.id).changes;

    if (changed === 0) {
      return {kind: 'not_queued'};
    }

    const job = getById(candidate.id);
    if (!job) {
      return {kind: 'not_found'};
    }
    return {kind: 'claimed', job, ownerToken};
  });
  return tx.immediate();
}

/**
 * Worker 执行期间周期性 heartbeat（lease + job 状态）。
 */
export function heartbeatAssetGenerationJob(
  jobId: string,
  ownerToken: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): boolean {
  const db = getDb();
  const at = now();
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();
  return (
    db
      .prepare(
        `UPDATE asset_generation_jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(expiresAt, at, jobId, ownerToken).changes === 1
  );
}

/**
 * 成功终态：关联 result asset，billing=confirmed_charged。
 * resultRelevance：'current'（来源仍匹配，可作为 resolver candidate）或
 * 'stale'（来源已漂移 / lease lost——结果保留为历史，不冒充当前成功）。
 */
export function completeAssetGenerationSucceeded(
  jobId: string,
  ownerToken: string,
  resultAssetId: string,
  providerRequestId?: string,
  resultRelevance: 'current' | 'stale' = 'current',
): void {
  const db = getDb();
  const at = now();
  const changed = db
    .prepare(
      `UPDATE asset_generation_jobs
       SET status = 'succeeded', owner_token = NULL, lease_expires_at = NULL,
           result_asset_id = ?, provider_request_id = COALESCE(?, provider_request_id),
           result_relevance = ?,
           billing_status = 'confirmed_charged', finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(resultAssetId, providerRequestId ?? null, resultRelevance, at, at, jobId, ownerToken).changes;
  if (changed !== 1) {
    throw new Error(`completeAssetGenerationSucceeded: job ${jobId} 状态非法或 owner 不匹配`);
  }
}

/**
 * 失败终态：记录 error_code / failure_phase / billing_status。
 */
export function completeAssetGenerationFailed(
  jobId: string,
  ownerToken: string,
  input: {
    errorCode: string;
    errorMessage: string;
    failurePhase?: string;
    billingStatus?: AssetGenerationBillingStatus;
    providerRequestId?: string;
  },
): void {
  const db = getDb();
  const at = now();
  const billingStatus: AssetGenerationBillingStatus = input.billingStatus ?? 'unknown_billing';
  const changed = db
    .prepare(
      `UPDATE asset_generation_jobs
       SET status = 'failed', owner_token = NULL, lease_expires_at = NULL,
           error_code = ?, error_message = ?, failure_phase = ?,
           provider_request_id = COALESCE(?, provider_request_id),
           billing_status = ?, finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(
      input.errorCode,
      input.errorMessage.slice(0, 2000),
      input.failurePhase ?? null,
      input.providerRequestId ?? null,
      billingStatus,
      at,
      at,
      jobId,
      ownerToken,
    ).changes;
  if (changed !== 1) {
    throw new Error(`completeAssetGenerationFailed: job ${jobId} 状态非法或 owner 不匹配`);
  }
}

/**
 * indeterminate 终态：请求已发出但结果未知；billing=unknown_billing。
 * 同 requestId 不会自动重试，必须用户显式新 requestId。
 */
export function completeAssetGenerationIndeterminate(
  jobId: string,
  ownerToken: string,
  input: {
    errorCode: string;
    errorMessage: string;
    failurePhase?: string;
    providerRequestId?: string;
  },
): void {
  const db = getDb();
  const at = now();
  const changed = db
    .prepare(
      `UPDATE asset_generation_jobs
       SET status = 'indeterminate', owner_token = NULL, lease_expires_at = NULL,
           error_code = ?, error_message = ?, failure_phase = ?,
           provider_request_id = COALESCE(?, provider_request_id),
           billing_status = 'unknown_billing', finished_at = ?, updated_at = ?
       WHERE id = ? AND owner_token = ? AND status = 'running'`,
    )
    .run(
      input.errorCode,
      input.errorMessage.slice(0, 2000),
      input.failurePhase ?? null,
      input.providerRequestId ?? null,
      at,
      at,
      jobId,
      ownerToken,
    ).changes;
  if (changed !== 1) {
    throw new Error(`completeAssetGenerationIndeterminate: job ${jobId} 状态非法或 owner 不匹配`);
  }
}

/**
 * 优雅退出 / 租约续约失败时回 queued：不丢任务、不重复计费。
 */
export function requeueAssetGenerationJob(jobId: string, ownerToken: string): boolean {
  const db = getDb();
  const at = now();
  return (
    db
      .prepare(
        `UPDATE asset_generation_jobs
         SET status = 'queued', owner_token = NULL, lease_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(at, jobId, ownerToken).changes === 1
  );
}

/**
 * Worker 启动回收：running 且 lease 过期 → 转 indeterminate（不自动重调 provider）。
 */
export function recoverStaleAssetGenerationJobs(staleMs: number): {indeterminate: number} {
  const db = getDb();
  const tx = db.transaction((): {indeterminate: number} => {
    const at = now();
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const indeterminate = db
      .prepare(
        `UPDATE asset_generation_jobs
         SET status = 'indeterminate', owner_token = NULL, lease_expires_at = NULL,
             error_code = 'WORKER_CRASH', error_message = ?,
             failure_phase = 'PROVIDER_RESULT_INDETERMINATE',
             billing_status = 'unknown_billing', finished_at = ?, updated_at = ?
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(
        'running asset generation job 租约过期（worker 可能崩溃）——不自动重试可能已计费的 provider 请求，需新 requestId 重新生成',
        at,
        at,
        cutoff,
      ).changes;
    return {indeterminate};
  });
  return tx.immediate();
}

export class AssetGenerationJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssetGenerationJobError';
  }
}

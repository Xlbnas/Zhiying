/**
 * Asset Generation Job Executor（M7.3A.2 + M7.3A.3）。
 *
 * Worker 通过 scheduler 原子 claim asset_generation_job → 获取 resource lease →
 * Fence A（provider 前校验 source）→ 调用图像 provider → Fence B（provider 返回后
 * 再次校验 source + lease）→ 持久化 candidate（含 requirement provenance）→
 * 记录 usage → 终态。任何终态或 shutdown 均由 job-runner finally 释放 lease。
 *
 * M7.3A.3 语义：
 * - Fence A：active/selected scenes version + exact requirement hash 与 job 冻结
 *   快照不一致 → SOURCE_STALE（confirmed_zero，provider calls=0）。
 * - Fence B：生成期间 source 漂移或 production_gpu lease 丢失 → 结果仍 append-only
 *   保存为 historical asset（relevance=stale，含完整 provenance），不冒充当前成功；
 *   不清除当前 requirement 的失败/readiness 状态；不自动重试；不自动重新计费调用。
 * - Executor 不执行 normal lease release（scheduler 唯一 claim，job-runner finally
 *   唯一 normal release）；只接收 lease-lost 信号并 fail-closed。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  completeAssetGenerationFailed,
  completeAssetGenerationIndeterminate,
  completeAssetGenerationSucceeded,
  heartbeatAssetGenerationJob,
  requeueAssetGenerationJob,
  type AssetGenerationJobRow,
} from '@/lib/assets/generation-jobs';
import {insertAsset, type AssetProvenance} from '@/lib/assets/model';
import {
  getGeneratedImageProvider,
  ImageGenerationError,
  type GeneratedImageCandidate,
} from '@/lib/assets/providers/generated';
import {clearResolutionState, upsertResolutionState} from '@/lib/assets/model';
import {
  buildRequirementSnapshot,
  computeRequirementSnapshotHash,
  findRequirementInPlans,
  loadLatestScenesPlans,
} from '@/lib/assets/requirements';
import {createResourceLeaseHeartbeat, type ResourceLeaseHeartbeatHandle} from '@/lib/resources/lease-heartbeat';
import {getResourceLeaseMs} from '@/lib/resources/leases';
import {finalizeImageGenerationUsage, recordImageGenerationUsage} from '@/lib/usage-events';
import type {JobRunnerContext} from './job-runner';
import {getDb} from '@/lib/db';

const HEARTBEAT_INTERVAL_MS = getAssetHeartbeatMs();

/** 生成期间 lease/job 心跳间隔（默认 2s；ZHIYING_ASSET_HEARTBEAT_MS 可覆盖，测试用短间隔+短 TTL）。 */
function getAssetHeartbeatMs(): number {
  const raw = process.env.ZHIYING_ASSET_HEARTBEAT_MS;
  if (raw === undefined) return 2000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 50 ? n : 2000;
}

export interface AssetGenerationJobLease {
  group: 'production_gpu';
  ownerToken: string;
}

/** 当前 scenes artifact 中该 requirement 的冻结快照 hash（无 artifact/requirement 返回 null）。 */
function currentSourceFingerprint(
  job: AssetGenerationJobRow,
): {versionId: string | null; requirementHash: string | null} {
  const plans = loadLatestScenesPlans(job.project_id);
  if (!plans) return {versionId: null, requirementHash: null};
  const found = findRequirementInPlans(plans, job.scene_id, job.requirement_id);
  if (!found) return {versionId: null, requirementHash: null};
  const hash = computeRequirementSnapshotHash(JSON.stringify(buildRequirementSnapshot(found.requirement)));
  const versionId = getDb().prepare(
    `SELECT version FROM project_versions
     WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(job.project_id) as {version: number} | undefined;
  return {
    versionId: versionId ? String(versionId.version) : null,
    requirementHash: hash,
  };
}

export async function runAssetGenerationJob(
  job: AssetGenerationJobRow,
  ctx: JobRunnerContext,
  resourceLease?: AssetGenerationJobLease,
): Promise<void> {
  const {log, isShuttingDown} = ctx;

  // 统一 lease heartbeat：lease 丢失 → 标记 lost（Fence B 拒绝 current commit）。
  // job 级 heartbeat 单独维护（asset_generation_jobs 的 owner_token 租约）。
  let leaseHeartbeat: ResourceLeaseHeartbeatHandle | null = null;
  if (resourceLease?.group === 'production_gpu') {
    leaseHeartbeat = createResourceLeaseHeartbeat({
      group: 'production_gpu',
      ownerToken: resourceLease.ownerToken,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      leaseMs: getResourceLeaseMs(),
    });
  }
  const leaseLost = (): boolean => leaseHeartbeat?.isLost() ?? false;

  const jobHeartbeatTimer = setInterval(() => {
    if (job.owner_token) {
      heartbeatAssetGenerationJob(job.id, job.owner_token, getResourceLeaseMs());
    }
  }, HEARTBEAT_INTERVAL_MS);
  const startAtMs = Date.now();
  const provider = getGeneratedImageProvider();

  const cleanup = (): void => {
    leaseHeartbeat?.dispose();
    clearInterval(jobHeartbeatTimer);
  };

  // Fence A：provider 调用前 —— scenes version + exact requirement hash 必须与
  // enqueue 冻结快照一致；不一致 → SOURCE_STALE（confirmed_zero，零 provider call）。
  const fenceA = (): {ok: boolean; reason?: string} => {
    if (job.source_scenes_version_id) {
      const current = getDb().prepare(
        `SELECT s.active_version AS latest_version
         FROM projects p
         JOIN project_stages s ON s.project_id = p.id AND s.stage = 'scenes'
         WHERE p.id = ?`,
      ).get(job.project_id) as {latest_version: number | null} | undefined;
      if (current?.latest_version != null) {
        const expectedVersion = Number.parseInt(job.source_scenes_version_id, 10);
        if (!Number.isNaN(expectedVersion) && current.latest_version !== expectedVersion) {
          return {ok: false, reason: `scenes version 变为 ${current.latest_version}，预期 ${expectedVersion}`};
        }
      }
    }
    if (job.source_requirement_hash) {
      const {requirementHash} = currentSourceFingerprint(job);
      if (requirementHash !== null && requirementHash !== job.source_requirement_hash) {
        return {ok: false, reason: 'exact requirement hash 已变化'};
      }
    }
    return {ok: true};
  };

  // Fence B：provider 返回后 —— source 漂移或 lease lost → relevance=stale。
  const fenceB = (): {relevance: 'current' | 'stale'; reason: string | null} => {
    if (leaseLost()) {
      return {relevance: 'stale', reason: 'lease_lost'};
    }
    const {versionId, requirementHash} = currentSourceFingerprint(job);
    if (job.source_scenes_version_id && versionId !== null && versionId !== job.source_scenes_version_id) {
      return {relevance: 'stale', reason: 'source_drift'};
    }
    if (job.source_requirement_hash && requirementHash !== null && requirementHash !== job.source_requirement_hash) {
      return {relevance: 'stale', reason: 'source_drift'};
    }
    return {relevance: 'current', reason: null};
  };

  const finishStale = (reason: string): void => {
    // 结果有效但来源已漂移/lease lost：job 保持 succeeded + result_relevance=stale；
    // 不写 failure state（不是失败），不清除当前 requirement 的失败/readiness 状态。
    log(`asset job ${job.id}: 结果保留为历史（${reason}），不作为当前 candidate`);
  };

  try {
    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      log(`asset job ${job.id}: shutdown 前回 queued`);
      cleanup();
      return;
    }

    const providerUnavailable = !provider.configured || !provider.health.available;
    if (providerUnavailable) {
      completeAssetGenerationFailed(job.id, job.owner_token!, {
        errorCode: 'provider_unavailable',
        errorMessage: '图像生成服务未配置或不可用',
        billingStatus: 'confirmed_zero',
      });
      upsertResolutionState({
        projectId: job.project_id,
        sceneId: job.scene_id,
        requirementId: job.requirement_id,
        status: 'generation_failed',
        reason: '图像生成服务未配置或不可用',
        provider: provider.name,
      });
      cleanup();
      return;
    }

    // Fence A（provider 前）
    const before = fenceA();
    if (!before.ok) {
      completeAssetGenerationFailed(job.id, job.owner_token!, {
        errorCode: 'SOURCE_STALE',
        errorMessage: before.reason ?? 'source stale，不调用 provider',
        failurePhase: 'SOURCE_STALE',
        billingStatus: 'confirmed_zero',
      });
      upsertResolutionState({
        projectId: job.project_id,
        sceneId: job.scene_id,
        requirementId: job.requirement_id,
        status: 'generation_failed',
        reason: 'SOURCE_STALE',
        provider: job.provider,
        metadata: {requestId: job.request_id, failurePhase: 'SOURCE_STALE'},
      });
      log(`asset job ${job.id}: Fence A ${before.reason}，零 provider call`);
      cleanup();
      return;
    }

    // 记录 in-flight usage event（幂等键 = job.request_id）
    recordImageGenerationUsageInFlight(job);

    // 生成期间周期性心跳（lease + job），防止执行超过 lease TTL 时被其他 worker 抢占
    let candidates: GeneratedImageCandidate[];
    try {
      candidates = await provider.generate({prompt: job.prompt, model: job.model});
    } catch (err) {
      cleanup();
      throw err;
    }

    if (!candidates.length) {
      const reason = '未生成有效图片';
      completeAssetGenerationFailed(job.id, job.owner_token!, {
        errorCode: 'generation_failed',
        errorMessage: reason,
        failurePhase: 'IMAGE_DECODE_FAILED',
        billingStatus: 'unknown_billing',
      });
      recordImageGenerationUsageFinal(job, 0, 'unknown_billing', 'IMAGE_DECODE_FAILED');
      upsertResolutionState({
        projectId: job.project_id,
        sceneId: job.scene_id,
        requirementId: job.requirement_id,
        status: 'generation_failed',
        reason,
        provider: provider.name,
        metadata: {requestId: job.request_id, failurePhase: 'IMAGE_DECODE_FAILED', prompt: job.prompt},
      });
      return;
    }

    const first = candidates[0]!;
    const firstMeta = (first.metadata ?? {}) as Record<string, unknown>;
    const providerRequestId = typeof firstMeta.providerRequestId === 'string' ? firstMeta.providerRequestId : undefined;
    const elapsedMs = Date.now() - startAtMs;

    // 费用已真实发生：先 finalize usage event，再持久化 candidate
    recordImageGenerationUsageFinal(job, candidates.length, 'confirmed_charged', undefined, providerRequestId);

    // Fence B（provider 返回后、写 current candidate 前）
    const after = fenceB();

    const assetId = crypto.randomUUID();
    const ext = first.mimeType === 'image/png' ? 'png' : first.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const relPath = path.posix.join('assets', job.project_id, `${assetId}.${ext}`);
    const publicDir = path.join(process.cwd(), 'public');
    const absPath = path.join(publicDir, relPath);

    fs.mkdirSync(path.dirname(absPath), {recursive: true});
    const tmpPath = absPath + '.tmp';
    fs.writeFileSync(tmpPath, first.data);
    fs.renameSync(tmpPath, absPath);

    const requirement = job.requirement_json
      ? (JSON.parse(job.requirement_json) as Record<string, unknown>) as Parameters<typeof insertAsset>[0]['requirement']
      : undefined;
    const provenance: AssetProvenance = {
      sourceScenesVersionId: job.source_scenes_version_id,
      sourceRequirementHash: job.source_requirement_hash,
      assetGenerationJobId: job.id,
      requestId: job.request_id,
      relevance: after.relevance,
      staleReason: after.reason,
    };

    const row = insertAsset({
      projectId: job.project_id,
      sceneId: job.scene_id,
      mediaType: 'image',
      sourceType: 'generated',
      sourceProvider: first.provider,
      sourceUrl: null,
      localPath: relPath,
      mimeType: first.mimeType,
      width: first.width ?? null,
      height: first.height ?? null,
      licenseStatus: 'generated',
      licenseNote: `AI 生成 · ${first.model} (待确认)`,
      attribution: `API易 / ${first.model}`,
      description: first.prompt.slice(0, 200),
      requirement,
      provenance,
    });

    if (after.relevance === 'current') {
      clearResolutionState(job.project_id, job.scene_id, job.requirement_id);
    } else {
      finishStale(after.reason ?? 'stale');
    }

    completeAssetGenerationSucceeded(job.id, job.owner_token!, row.id, providerRequestId, after.relevance);
    log(`asset job ${job.id} succeeded（relevance=${after.relevance}）→ asset ${row.id}`);
  } catch (err) {
    const elapsedMs = Date.now() - startAtMs;
    const msg = err instanceof Error ? err.message : '图像生成失败';

    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      log(`asset job ${job.id}: 执行中 shutdown，回 queued`);
      return;
    }

    let failurePhase = 'PROVIDER_TERMINAL_FAILURE';
    let providerRequestId: string | undefined;
    let billingStatus: 'confirmed_zero' | 'confirmed_charged' | 'unknown_billing' = 'unknown_billing';

    if (err instanceof ImageGenerationError) {
      failurePhase = err.code;
      providerRequestId = err.context?.providerRequestId;
      billingStatus = errorCodeToBillingStatus(err.code);
    }

    // 请求已发出但结果未知 → indeterminate；否则 failed
    if (failurePhase === 'PROVIDER_RESPONSE_TIMEOUT') {
      completeAssetGenerationIndeterminate(job.id, job.owner_token!, {
        errorCode: 'response_timeout',
        errorMessage: msg,
        failurePhase,
        providerRequestId,
      });
    } else {
      completeAssetGenerationFailed(job.id, job.owner_token!, {
        errorCode: 'generation_failed',
        errorMessage: msg,
        failurePhase,
        billingStatus,
        providerRequestId,
      });
    }

    recordImageGenerationUsageFinal(job, 0, billingStatus, failurePhase, providerRequestId, elapsedMs);

    upsertResolutionState({
      projectId: job.project_id,
      sceneId: job.scene_id,
      requirementId: job.requirement_id,
      status: 'generation_failed',
      reason: msg,
      provider: provider.name,
      metadata: {
        requestId: job.request_id,
        providerRequestId,
        failurePhase,
        model: job.model,
        prompt: job.prompt,
        elapsedMs,
      },
    });

    log(`asset job ${job.id} terminal: ${failurePhase} (${billingStatus})`);
  } finally {
    cleanup();
  }
}

function errorCodeToBillingStatus(
  code: ImageGenerationError['code'],
): 'confirmed_zero' | 'confirmed_charged' | 'unknown_billing' {
  if (code === 'auth_failed' || code === 'not_configured') return 'confirmed_zero';
  return 'unknown_billing';
}

function recordImageGenerationUsageInFlight(job: AssetGenerationJobRow): void {
  recordImageGenerationUsage({
    attemptId: job.request_id,
    projectId: job.project_id,
    sceneId: job.scene_id,
    requirementId: job.requirement_id,
    provider: job.provider,
    model: job.model,
    requestedSize: process.env.APIYI_IMAGE_SIZE || '1K',
    aspectRatio: process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9',
    imageCount: 0,
    status: 'in_flight',
  });
}

function recordImageGenerationUsageFinal(
  job: AssetGenerationJobRow,
  imageCount: number,
  status: 'confirmed_zero' | 'confirmed_charged' | 'unknown_billing',
  failurePhase?: string,
  providerRequestId?: string,
  elapsedMs?: number,
): void {
  finalizeImageGenerationUsage({
    attemptId: job.request_id,
    projectId: job.project_id,
    sceneId: job.scene_id,
    requirementId: job.requirement_id,
    provider: job.provider,
    model: job.model,
    requestedSize: process.env.APIYI_IMAGE_SIZE || '1K',
    aspectRatio: process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9',
    imageCount,
    status,
    providerRequestId,
    failurePhase,
    prompt: job.prompt,
    elapsedMs,
  });
}

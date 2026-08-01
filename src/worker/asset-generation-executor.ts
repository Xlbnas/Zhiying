/**
 * Asset Generation Job Executor（M7.3A.2 + M7.3A.3 + M7.3A.3.1）。
 *
 * Worker 通过 scheduler 原子 claim asset_generation_job → 获取 resource lease →
 * Fence A（provider 前校验 active source）→ 调用 provider（job 冻结快照参数，
 * provider.name 必须匹配）→ 写临时文件 + rename append-only → 原子 commit
 * （commitGeneratedAssetResultTx：Fence B 判定 + asset 落库 + job 终态同一事务）→
 * 记录 usage → 终态。任何终态或 shutdown 均由 job-runner finally 释放 lease。
 *
 * M7.3A.3.1 语义：
 * - Fence A 与 Fence B 使用 loadActiveScenesSource（exact active_version，fail-closed，
 *   禁止 latest fallback）。
 * - Fence B 判定在 commit 事务内完成（无 TOCTOU 窗口）；事务失败 → 删除本轮新文件，
 *   不删除任何已落库历史 asset。
 * - Worker 执行时从 job 快照读取 imageSize/aspectRatio（禁止从 env 重新推导）；
 *   provider.name !== job.provider → CONFIG_ERROR（零 provider call）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  completeAssetGenerationFailed,
  completeAssetGenerationIndeterminate,
  CURRENT_PROVIDER_CONFIG_VERSION,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_SIZE,
  heartbeatAssetGenerationJob,
  requeueAssetGenerationJob,
  type AssetGenerationJobRow,
} from '@/lib/assets/generation-jobs';
import {commitGeneratedAssetResultTx, CommitGeneratedAssetError} from '@/lib/assets/commit';
import {
  getGeneratedImageProvider,
  ImageGenerationError,
  type GeneratedImageCandidate,
} from '@/lib/assets/providers/generated';
import {upsertResolutionState} from '@/lib/assets/model';
import {
  buildRequirementSnapshot,
  computeRequirementSnapshotHash,
  findRequirementInPlans,
  loadActiveScenesSource,
} from '@/lib/assets/requirements';
import {createResourceLeaseHeartbeat, type ResourceLeaseHeartbeatHandle} from '@/lib/resources/lease-heartbeat';
import {getResourceLeaseMs} from '@/lib/resources/leases';
import {finalizeImageGenerationUsage, recordImageGenerationUsage} from '@/lib/usage-events';
import type {JobRunnerContext} from './job-runner';

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

export async function runAssetGenerationJob(
  job: AssetGenerationJobRow,
  ctx: JobRunnerContext,
  resourceLease?: AssetGenerationJobLease,
): Promise<void> {
  const {log, isShuttingDown} = ctx;

  // 统一 lease heartbeat：lease 丢失 → 标记 lost（commit 判定 stale(lease_lost)）。
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
  // M7.3A.3.2/3.3：provider 调用结果证据（函数级 hoist，catch 使用真实值，
  // 禁止重声明同名空变量）。
  let providerOutcome: 'not_called' | 'unknown' | 'confirmed_zero' | 'confirmed_charged' = 'not_called';
  let returnedImageCount = 0;
  let providerRequestId: string | undefined;
  let actualModel: string | undefined;
  let actualProvider: string | undefined;

  const cleanup = (): void => {
    leaseHeartbeat?.dispose();
    clearInterval(jobHeartbeatTimer);
  };

  // Fence A：provider 调用前 —— active scenes version + exact requirement hash 必须
  // 与 enqueue 冻结快照一致（loadActiveScenesSource，fail-closed）。
  const fenceA = (): {ok: boolean; reason?: string} => {
    const source = loadActiveScenesSource(job.project_id);
    if (!source) {
      return {ok: false, reason: 'active scenes source 不可用'};
    }
    if (job.source_scenes_version_id && String(source.activeVersion) !== job.source_scenes_version_id) {
      return {ok: false, reason: `scenes version 变为 ${source.activeVersion}，预期 ${job.source_scenes_version_id}`};
    }
    const found = findRequirementInPlans(source.plans, job.scene_id, job.requirement_id);
    if (!found) {
      return {ok: false, reason: `requirement ${job.requirement_id} 不在当前 scenes`};
    }
    if (job.source_requirement_hash) {
      const hash = computeRequirementSnapshotHash(JSON.stringify(buildRequirementSnapshot(found.requirement)));
      if (hash !== job.source_requirement_hash) {
        return {ok: false, reason: 'exact requirement hash 已变化'};
      }
    }
    return {ok: true};
  };

  let committedFile: string | null = null;

  try {
    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      log(`asset job ${job.id}: shutdown 前回 queued`);
      cleanup();
      return;
    }

    const providerUnavailable = !provider.configured || !provider.health.available;
    if (providerUnavailable) {
      providerOutcome = 'confirmed_zero';
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

    // M7.3A.3.1：provider 身份必须与 job 冻结快照一致（不允许 queued remote job
    // 被 local provider 执行而绕过 GPU lease）；不匹配 → CONFIG_ERROR，零调用。
    if (provider.name !== job.provider) {
      providerOutcome = 'confirmed_zero';
      completeAssetGenerationFailed(job.id, job.owner_token!, {
        errorCode: 'CONFIG_ERROR',
        errorMessage: `job.provider=${job.provider} 与当前 provider=${provider.name} 不匹配，拒绝执行`,
        failurePhase: 'CONFIG_ERROR',
        billingStatus: 'confirmed_zero',
      });
      upsertResolutionState({
        projectId: job.project_id,
        sceneId: job.scene_id,
        requirementId: job.requirement_id,
        status: 'generation_failed',
        reason: `provider 不匹配（job=${job.provider}，当前=${provider.name}）`,
        provider: provider.name,
        metadata: {requestId: job.request_id, failurePhase: 'CONFIG_ERROR'},
      });
      log(`asset job ${job.id}: provider 不匹配，零 provider call`);
      cleanup();
      return;
    }

    // Fence A（provider 前）
    const before = fenceA();
    if (!before.ok) {
      providerOutcome = 'confirmed_zero';
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

    // 记录 in-flight usage event（幂等键 = job.request_id；参数取 job 快照）
    recordImageGenerationUsageInFlight(job);

    // 调用 provider：参数全部来自 job 冻结快照（禁止从 env 重新推导）
    let candidates: GeneratedImageCandidate[];
    try {
      candidates = await provider.generate({
        prompt: job.prompt,
        model: job.model,
        size: job.image_size ?? DEFAULT_IMAGE_SIZE,
        aspectRatio: job.aspect_ratio ?? DEFAULT_ASPECT_RATIO,
      });
    } catch (err) {
      providerOutcome = 'unknown';
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
    // M7.3A.3.3：provider 返回非空 candidate → 立即锁定 charged 证据
    // （在 result contract validation 之前）。即使后续校验失败，billing 保持 charged。
    providerOutcome = 'confirmed_charged';
    returnedImageCount = candidates.length;
    actualModel = first.model;
    actualProvider = first.provider;
    providerRequestId = typeof firstMeta.providerRequestId === 'string' ? firstMeta.providerRequestId : undefined;
    recordImageGenerationUsageFinal(job, returnedImageCount, 'confirmed_charged', undefined, providerRequestId, undefined, actualModel);
    const elapsedMs = Date.now() - startAtMs;

    // M7.3A.3.2：provider result snapshot 校验 —— candidate.provider 必须与
    // job.provider 精确一致（不允许 provider 返回异源结果）；校验失败时 billing
    // 已锁定 charged（provider 已返回有效图片结果），job 按 PROVIDER_INVALID_RESPONSE
    // 终态（不保存 current asset、不自动重试）。
    if (first.provider !== job.provider) {
      throw new ImageGenerationError(
        'PROVIDER_INVALID_RESPONSE',
        `provider 返回 candidate.provider=${first.provider}，job.provider=${job.provider}，拒绝提交`,
        undefined,
        {model: job.model, size: job.image_size ?? DEFAULT_IMAGE_SIZE, aspectRatio: job.aspect_ratio ?? DEFAULT_ASPECT_RATIO},
      );
    }

    // 写临时文件 → rename 到 append-only 最终路径（文件写入在事务外；
    // 事务失败时由本函数删除本轮新文件，不删除任何历史 asset）
    const assetId = crypto.randomUUID();
    const ext = first.mimeType === 'image/png' ? 'png' : first.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const relPath = path.posix.join('assets', job.project_id, `${assetId}.${ext}`);
    const publicDir = path.join(process.cwd(), 'public');
    const absPath = path.join(publicDir, relPath);
    fs.mkdirSync(path.dirname(absPath), {recursive: true});
    const tmpPath = absPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, first.data);
      fs.renameSync(tmpPath, absPath);
    } catch (err) {
      fs.rmSync(tmpPath, {force: true});
      throw err;
    }
    committedFile = absPath;

    // Fence B + current commit：单事务（无 TOCTOU 窗口）
    const result = commitGeneratedAssetResultTx({
      projectId: job.project_id,
      sceneId: job.scene_id,
      requirementId: job.requirement_id,
      jobId: job.id,
      ownerToken: job.owner_token!,
      assetId,
      localPath: relPath,
      providerRequestId,
      provider: first.provider,
      model: first.model,
      mimeType: first.mimeType,
      width: first.width ?? null,
      height: first.height ?? null,
      licenseNote: `AI 生成 · ${first.model} (待确认)`,
      attribution: `API易 / ${first.model}`,
      description: first.prompt.slice(0, 200),
      requirementJson: job.requirement_json,
      sourceScenesVersionId: job.source_scenes_version_id,
      sourceRequirementHash: job.source_requirement_hash,
      requestId: job.request_id,
      leaseLost: leaseLost(),
    });
    committedFile = null; // 已落库，文件归资产所有

    // M7.3A.3.2：成功 commit 后补充 usage assetId 关联（单调保护保留 charged/cost，
    // 追加 assetId 使 requestId/jobId/assetId 可互相追溯）
    recordImageGenerationUsageFinal(job, candidates.length, 'confirmed_charged', undefined, providerRequestId, undefined, first.model, result.assetId);

    if (result.relevance === 'current') {
      log(`asset job ${job.id} succeeded（relevance=current）→ asset ${result.assetId}`);
    } else {
      log(`asset job ${job.id} succeeded（relevance=stale: ${result.staleReason}）→ 历史 asset ${result.assetId}`);
    }
  } catch (err) {
    // 本轮新文件尚未落库（commit 失败/中断）→ 删除；已落库历史 asset 绝不动
    if (committedFile) {
      fs.rmSync(committedFile, {force: true});
      committedFile = null;
    }
    const elapsedMs = Date.now() - startAtMs;
    const msg = err instanceof Error ? err.message : '图像生成失败';

    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      log(`asset job ${job.id}: 执行中 shutdown，回 queued`);
      return;
    }

    let failurePhase = 'PROVIDER_TERMINAL_FAILURE';
    let billingStatus: 'confirmed_zero' | 'confirmed_charged' | 'unknown_billing' = 'unknown_billing';

    if (err instanceof ImageGenerationError) {
      failurePhase = err.code;
      providerRequestId = err.context?.providerRequestId;
      billingStatus = errorCodeToBillingStatus(err.code);
    }

    // M7.3A.3.2：provider 已确认收费后，本地持久化失败不得把收费结论降级；
    // 使用明确错误 RESULT_PERSIST_FAILED 而非 PROVIDER_TERMINAL_FAILURE。
    if (providerOutcome === 'confirmed_charged') {
      billingStatus = 'confirmed_charged';
      if (!(err instanceof ImageGenerationError)) {
        failurePhase = 'RESULT_PERSIST_FAILED';
      }
    }

    // M7.3A.3.2：commit 时 job 已被并发 requeue/recover（JOB_STATE_INVALID）→
    // 不覆盖原 job 终态；usage 保持 confirmed_charged；worker 主循环不崩溃。
    if (err instanceof CommitGeneratedAssetError && err.code === 'JOB_STATE_INVALID') {
      recordImageGenerationUsageFinal(job, returnedImageCount, 'confirmed_charged', 'RESULT_PERSIST_FAILED', providerRequestId, elapsedMs, actualModel);
      log(`asset job ${job.id}: commit 时 job 状态已变（RESULT_PERSIST_FAILED，不覆盖 job 终态）`);
      return;
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

    recordImageGenerationUsageFinal(job, returnedImageCount, billingStatus, failurePhase, providerRequestId, elapsedMs, actualModel);

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
    requestedSize: job.image_size ?? DEFAULT_IMAGE_SIZE,
    aspectRatio: job.aspect_ratio ?? DEFAULT_ASPECT_RATIO,
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
  actualModel?: string,
  assetId?: string,
): void {
  finalizeImageGenerationUsage({
    attemptId: job.request_id,
    projectId: job.project_id,
    sceneId: job.scene_id,
    requirementId: job.requirement_id,
    provider: job.provider,
    model: job.model,
    requestedSize: job.image_size ?? DEFAULT_IMAGE_SIZE,
    aspectRatio: job.aspect_ratio ?? DEFAULT_ASPECT_RATIO,
    imageCount,
    status,
    providerRequestId,
    failurePhase,
    prompt: job.prompt,
    elapsedMs,
    actualModel,
    providerConfigVersion: job.provider_config_version ?? CURRENT_PROVIDER_CONFIG_VERSION,
    assetId,
  });
}

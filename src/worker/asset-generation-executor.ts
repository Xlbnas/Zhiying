/**
 * Asset Generation Job Executor（M7.3A.2）。
 *
 * Worker 原子 claim asset_generation_job → claim production_gpu lease →
 * 调用图像 provider → 持久化 candidate → 记录 usage → 释放 lease。
 * 任何终态或 shutdown 均释放 lease；请求已发出但结果未知 → indeterminate。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AssetGenerationJobRow,
  completeAssetGenerationFailed,
  completeAssetGenerationIndeterminate,
  completeAssetGenerationSucceeded,
  heartbeatAssetGenerationJob,
  requeueAssetGenerationJob,
} from '@/lib/assets/generation-jobs';
import {insertAsset} from '@/lib/assets/model';
import {getGeneratedImageProvider, ImageGenerationError} from '@/lib/assets/providers/generated';
import {clearResolutionState, upsertResolutionState} from '@/lib/assets/model';
import {
  claimResourceLease,
  DEFAULT_LEASE_MS,
  heartbeatResourceLease,
  releaseResourceLease,
} from '@/lib/resources/leases';
import {finalizeImageGenerationUsage, recordImageGenerationUsage} from '@/lib/usage-events';
import type {JobRunnerContext} from './job-runner';

const HEARTBEAT_INTERVAL_MS = 2000;

export async function runAssetGenerationJob(
  job: AssetGenerationJobRow,
  ctx: JobRunnerContext,
): Promise<void> {
  const {log, isShuttingDown} = ctx;
  const workerId = job.owner_token?.split(':')[0] ?? 'unknown-worker';

  // 1. 先原子取得 production_gpu lease，再真正调用 provider
  const lease = claimResourceLease('production_gpu', 'asset_generation', job.id, workerId);
  if (!lease.ok || !lease.ownerToken) {
    log(`asset job ${job.id}: production_gpu lease 不可得，跳过`);
    return;
  }
  const leaseToken = lease.ownerToken;

  const releaseLease = (): void => {
    try {
      releaseResourceLease('production_gpu', leaseToken);
    } catch {
      // 释放失败不阻断终态
    }
  };

  let lastHeartbeat = 0;
  const heartbeatBoth = (): void => {
    const nowMs = Date.now();
    if (nowMs - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = nowMs;
    heartbeatResourceLease('production_gpu', leaseToken, DEFAULT_LEASE_MS);
    heartbeatAssetGenerationJob(job.id, job.owner_token!, DEFAULT_LEASE_MS);
  };

  const provider = getGeneratedImageProvider();
  const startAt = Date.now();

  try {
    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      releaseLease();
      log(`asset job ${job.id}: shutdown 前回 queued`);
      return;
    }

    if (!provider.configured || !provider.health.available) {
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
      releaseLease();
      return;
    }

    // 记录 in-flight usage event（幂等键 = job.request_id）
    recordImageGenerationUsageInFlight(job);

    const candidates = await provider.generate({prompt: job.prompt, model: job.model});
    heartbeatBoth();

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
      releaseLease();
      return;
    }

    const first = candidates[0]!;
    const firstMeta = (first.metadata ?? {}) as Record<string, unknown>;
    const providerRequestId = typeof firstMeta.providerRequestId === 'string' ? firstMeta.providerRequestId : undefined;
    const elapsedMs = Date.now() - startAt;

    // 费用已真实发生：先 finalize usage event，再持久化 candidate
    recordImageGenerationUsageFinal(job, candidates.length, 'confirmed_charged', undefined, providerRequestId);

    const assetId = crypto.randomUUID();
    const ext = first.mimeType === 'image/png' ? 'png' : first.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const relPath = path.posix.join('assets', job.project_id, `${assetId}.${ext}`);
    const publicDir = path.join(process.cwd(), 'public');
    const absPath = path.join(publicDir, relPath);

    fs.mkdirSync(path.dirname(absPath), {recursive: true});
    const tmpPath = absPath + '.tmp';
    fs.writeFileSync(tmpPath, first.data);
    fs.renameSync(tmpPath, absPath);

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
      requirement: undefined, // candidate 不自动绑定；保留 requirement_json 为空
    });

    clearResolutionState(job.project_id, job.scene_id, job.requirement_id);

    completeAssetGenerationSucceeded(job.id, job.owner_token!, row.id, providerRequestId);
    releaseLease();
    log(`asset job ${job.id} succeeded → asset ${row.id}`);
  } catch (err) {
    const elapsedMs = Date.now() - startAt;
    const msg = err instanceof Error ? err.message : '图像生成失败';

    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      releaseLease();
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

    releaseLease();
    log(`asset job ${job.id} terminal: ${failurePhase} (${billingStatus})`);
  }
}

function errorCodeToBillingStatus(
  code: ImageGenerationError['code'],
): 'confirmed_zero' | 'confirmed_charged' | 'unknown_billing' {
  if (code === 'auth_failed' || code === 'not_configured') return 'confirmed_zero';
  if (code === 'rate_limited' || code === 'PROVIDER_CONNECT_TIMEOUT' || code === 'PROVIDER_RESPONSE_TIMEOUT') {
    return 'unknown_billing';
  }
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

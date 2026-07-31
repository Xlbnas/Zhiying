/**
 * Asset Generation Job Executor（M7.3A.2）。
 *
 * Worker 通过 scheduler 原子 claim asset_generation_job → 获取 resource lease →
 * 校验 source 版本 → 调用图像 provider → 持久化 candidate（含 requirement provenance）→
 * 记录 usage → 释放 lease。
 * 任何终态或 shutdown 均释放 lease；请求已发出但结果未知 → indeterminate。
 *
 * Executor 不自行 claim production_gpu；lease token 由 scheduler 提供并通过
 * job-runner 传入。仅 scheduler 持有唯一 lease ownerToken。
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
import {insertAsset} from '@/lib/assets/model';
import {
  getGeneratedImageProvider,
  ImageGenerationError,
  type GeneratedImageCandidate,
} from '@/lib/assets/providers/generated';
import {clearResolutionState, upsertResolutionState} from '@/lib/assets/model';
import {
  getResourceLeaseMs,
  heartbeatResourceLease,
  releaseResourceLease,
} from '@/lib/resources/leases';
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

export async function runAssetGenerationJob(
  job: AssetGenerationJobRow,
  ctx: JobRunnerContext,
  resourceLease?: AssetGenerationJobLease,
): Promise<void> {
  const {log, isShuttingDown} = ctx;

  const releaseProductionGpuLease = (): void => {
    if (resourceLease?.group === 'production_gpu') {
      try {
        releaseResourceLease('production_gpu', resourceLease.ownerToken);
      } catch {
        // 释放失败不阻断终态
      }
    }
  };

  let lastHeartbeat = 0;
  const heartbeatAll = (): void => {
    const nowMs = Date.now();
    if (nowMs - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = nowMs;
    if (resourceLease?.group === 'production_gpu') {
      heartbeatResourceLease('production_gpu', resourceLease.ownerToken, getResourceLeaseMs());
    }
    if (job.owner_token) {
      heartbeatAssetGenerationJob(job.id, job.owner_token, getResourceLeaseMs());
    }
  };

  // 校验 source scenes version 是否仍为预期版本
  if (job.source_scenes_version_id) {
    const db = getDb();
    const current = db.prepare(
      `SELECT s.active_version AS latest_version
       FROM projects p
       JOIN project_stages s ON s.project_id = p.id AND s.stage = 'scenes'
       WHERE p.id = ?`,
    ).get(job.project_id) as {latest_version: number | null} | undefined;
    if (current?.latest_version != null) {
      const expectedVersion = Number.parseInt(job.source_scenes_version_id, 10);
      if (!Number.isNaN(expectedVersion) && current.latest_version !== expectedVersion) {
        completeAssetGenerationFailed(job.id, job.owner_token!, {
          errorCode: 'SOURCE_STALE',
          errorMessage: `scenes version 变为 ${current.latest_version}，预期 ${expectedVersion}，不调用 provider`,
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
        releaseProductionGpuLease();
        log(`asset job ${job.id}: source scenes stale (${expectedVersion}→${current.latest_version})，零 provider call`);
        return;
      }
    }
  }

  const provider = getGeneratedImageProvider();
  const startAt = Date.now();

  try {
    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      releaseProductionGpuLease();
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
      releaseProductionGpuLease();
      return;
    }

    // 记录 in-flight usage event（幂等键 = job.request_id）
    recordImageGenerationUsageInFlight(job);

    // M7.3A.2：生成期间周期性 heartbeat（lease + job），
    // 防止执行超过 lease TTL 时 lease 过期被其他 worker 抢占 GPU。
    const heartbeatTimer = setInterval(heartbeatAll, HEARTBEAT_INTERVAL_MS);
    let candidates: GeneratedImageCandidate[];
    try {
      candidates = await provider.generate({prompt: job.prompt, model: job.model});
    } finally {
      clearInterval(heartbeatTimer);
      heartbeatAll();
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
      releaseProductionGpuLease();
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
      requirement: job.requirement_json ? (JSON.parse(job.requirement_json) as Record<string, unknown>) as Parameters<typeof insertAsset>[0]['requirement'] : undefined,
    });

    clearResolutionState(job.project_id, job.scene_id, job.requirement_id);

    completeAssetGenerationSucceeded(job.id, job.owner_token!, row.id, providerRequestId);
    releaseProductionGpuLease();
    log(`asset job ${job.id} succeeded → asset ${row.id}`);
  } catch (err) {
    const elapsedMs = Date.now() - startAt;
    const msg = err instanceof Error ? err.message : '图像生成失败';

    if (isShuttingDown()) {
      requeueAssetGenerationJob(job.id, job.owner_token!);
      releaseProductionGpuLease();
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

    releaseProductionGpuLease();
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

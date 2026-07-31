import crypto from 'node:crypto';
import {getDb} from './db';
import type {RenderJobRow} from './jobs';
import type {LlmJobRow} from './llm-jobs';
import type {TtsJobRow} from './tts-jobs';
import {DISPATCH_LEASE_MS, type DispatchJobRow} from './llm-generation/dispatch';
import {
  claimResourceLease,
  getResourceLeaseMs,
  releaseResourceLease,
} from './resources/leases';
import {
  getResourceLimits,
  GPU_EXCLUSIVE_GROUP,
  JOB_TYPE_RESOURCE_CLASS,
  isGpuExclusive,
  type ResourceClass,
} from './workflow/resource-classes';
import type {AssetGenerationJobRow} from './assets/generation-jobs';

/**
 * 单调度器多队列领取（M2-C 双队列 → M3-B 三队列 → M7 四队列 → M7 资源感知并行
 * → M7.3A.2 五队列含 asset_generation）。
 * render_jobs + llm_jobs + tts_jobs + generation_dispatch_jobs + asset_generation_jobs
 * 在同一 BEGIN IMMEDIATE 内按排队时间全局 FIFO；
 * 时间相同时以 job type + id 稳定 tie-break。
 *
 * M7 并行化：Worker 主循环可同时运行多个资源兼容的任务。
 * M7.3A.2：GPU 任务（render/tts/local_image_gpu）在 claim 前必须先原子取得
 * production_gpu lease；lease 不可得则跳过该候选，绝不在发现冲突前改 running。
 * remote_image_api 等不申请 production_gpu；可与 GPU 任务同时 running。
 */

export interface ResourceLeaseMeta {
  group: 'production_gpu';
  ownerToken: string;
}

export type ClaimedJob =
  | {type: 'render'; job: RenderJobRow; resourceClass: ResourceClass; resourceLease?: ResourceLeaseMeta}
  | {type: 'llm'; job: LlmJobRow; resourceClass: ResourceClass}
  | {type: 'tts'; job: TtsJobRow; resourceClass: ResourceClass; resourceLease?: ResourceLeaseMeta}
  | {type: 'dispatch'; job: DispatchJobRow; resourceClass: ResourceClass}
  | {type: 'asset_generation'; job: AssetGenerationJobRow; resourceClass: ResourceClass; resourceLease?: ResourceLeaseMeta};

/** 资源感知 claim 选项（M7）。 */
export interface ClaimOptions {
  /** 不可 claim 的资源类别（如 GPU 互斥组已有任务在跑）。 */
  excludeResourceClasses?: ResourceClass[];
  /** 各资源类别当前运行计数（达到上限的类别跳过）。 */
  runningCounts?: Partial<Record<ResourceClass, number>>;
}

function getRenderJobById(id: string): RenderJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM render_jobs WHERE id = ?')
    .get(id) as RenderJobRow | undefined;
}

function getLlmJobById(id: string): LlmJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM llm_jobs WHERE id = ?')
    .get(id) as LlmJobRow | undefined;
}

function getTtsJobById(id: string): TtsJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM tts_jobs WHERE id = ?')
    .get(id) as TtsJobRow | undefined;
}

function getDispatchJobById(id: string): DispatchJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM generation_dispatch_jobs WHERE id = ?')
    .get(id) as DispatchJobRow | undefined;
}

function getAssetGenerationJobById(id: string): AssetGenerationJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM asset_generation_jobs WHERE id = ?')
    .get(id) as AssetGenerationJobRow | undefined;
}

const CLAIM_UPDATE_SQL: Record<'render' | 'llm' | 'tts' | 'dispatch', string> = {
  render: `UPDATE render_jobs
     SET status = 'running',
         claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
         started_at = COALESCE(started_at, ?),
         attempt = attempt + 1
     WHERE id = ? AND status = 'queued'`,
  llm: `UPDATE llm_jobs
     SET status = 'running',
         claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
         started_at = COALESCE(started_at, ?),
         attempt = attempt + 1
     WHERE id = ? AND status = 'queued'`,
  tts: `UPDATE tts_jobs
     SET status = 'running',
         claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
         started_at = COALESCE(started_at, ?),
         attempt = attempt + 1
     WHERE id = ? AND status = 'queued'`,
  dispatch: `UPDATE generation_dispatch_jobs
     SET status = 'running',
         owner_token = ?, lease_expires_at = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?
     WHERE id = ? AND status = 'queued'`,
};

const GPU_JOB_TYPES = new Set<string>(['render', 'tts', 'asset_generation']);

/**
 * 原子领取全局下一个 queued 任务。无事可做返回 null。
 * claim：status→running、claimed_by/at（dispatch 为 owner_token + lease）、
 * heartbeat、started_at（COALESCE）、attempt+1（render/llm/tts）。
 *
 * M7 资源感知：候选按全局 FIFO 取出后，跳过资源类别被排除或已达
 * 并发上限者；条件 UPDATE（WHERE status='queued'）未命中说明被并发
 * 拿走，继续尝试下一个候选。
 *
 * M7.3A.2：GPU 任务 claim 前必须先取得 production_gpu DB lease；
 * 取得 lease 后才改 running；lease 失败则跳过本候选。
 */
export function claimNextAnyJob(workerId: string, opts?: ClaimOptions): ClaimedJob | null {
  const db = getDb();
  const limits = getResourceLimits();
  const tx = db.transaction(
    (claimedBy: string, at: string): ClaimedJob | null => {
      const candidates = db
        .prepare(
          `SELECT 'render' AS type, id, queued_at FROM render_jobs WHERE status = 'queued'
           UNION ALL
           SELECT 'llm' AS type, id, queued_at FROM llm_jobs WHERE status = 'queued'
           UNION ALL
           SELECT 'tts' AS type, id, queued_at FROM tts_jobs WHERE status = 'queued'
           UNION ALL
           SELECT 'dispatch' AS type, id, created_at AS queued_at FROM generation_dispatch_jobs WHERE status = 'queued'
           UNION ALL
           SELECT 'asset_generation' AS type, id, created_at AS queued_at FROM asset_generation_jobs WHERE status = 'queued'
           ORDER BY queued_at ASC, type ASC, id ASC
           LIMIT 50`,
        )
        .all() as Array<{
          type: 'render' | 'llm' | 'tts' | 'dispatch' | 'asset_generation';
          id: string;
          queued_at: string;
        }>;
      for (const next of candidates) {
        let resourceClass: ResourceClass;
        if (next.type === 'asset_generation') {
          // 从 job 行读取 resource_class（由 enqueue 时 provider 决定）
          const agJob = db.prepare(
            'SELECT resource_class FROM asset_generation_jobs WHERE id = ?',
          ).get(next.id) as {resource_class: string} | undefined;
          resourceClass = (agJob?.resource_class ?? 'remote_image_api') as ResourceClass;
        } else {
          resourceClass = JOB_TYPE_RESOURCE_CLASS[next.type];
        }
        if (opts?.excludeResourceClasses?.includes(resourceClass)) {
          continue;
        }
        const runningCount = opts?.runningCounts?.[resourceClass] ?? 0;
        if (runningCount >= limits[resourceClass]) {
          continue;
        }

        // GPU 任务：先原子 claim production_gpu lease（仅 GPU_EXCLUSIVE_GROUP 成员）
        let gpuLeaseToken: string | null = null;
        if (isGpuExclusive(resourceClass)) {
          const lease = claimResourceLease('production_gpu', next.type as 'render' | 'tts' | 'asset_generation', next.id, claimedBy, getResourceLeaseMs());
          if (!lease.ok || !lease.ownerToken) {
            // 本候选跳过，继续尝试下一个（资源不可得，不是全局无任务）
            continue;
          }
          gpuLeaseToken = lease.ownerToken;
        }
        const resourceLease: ResourceLeaseMeta | undefined =
          gpuLeaseToken ? {group: 'production_gpu', ownerToken: gpuLeaseToken} : undefined;

        if (next.type === 'dispatch') {
          const ownerToken = `${claimedBy}:${crypto.randomUUID()}`;
          const leaseExpiresAt = new Date(Date.parse(at) + DISPATCH_LEASE_MS).toISOString();
          const res = db
            .prepare(CLAIM_UPDATE_SQL.dispatch)
            .run(ownerToken, leaseExpiresAt, at, at, next.id);
          if (res.changes === 0) {
            if (gpuLeaseToken) releaseResourceLease('production_gpu', gpuLeaseToken);
            continue;
          }
          const job = getDispatchJobById(next.id);
          return job ? {type: 'dispatch', job, resourceClass} : null;
        }

        if (next.type === 'asset_generation') {
          const ownerToken = `${claimedBy}:${crypto.randomUUID()}`;
          const leaseExpiresAt = new Date(Date.parse(at) + getResourceLeaseMs()).toISOString();
          const res = db
            .prepare(
              `UPDATE asset_generation_jobs
               SET status = 'running', owner_token = ?, lease_expires_at = ?,
                   started_at = COALESCE(started_at, ?), updated_at = ?
               WHERE id = ? AND status = 'queued'`,
            )
            .run(ownerToken, leaseExpiresAt, at, at, next.id);
          if (res.changes === 0) {
            if (gpuLeaseToken) releaseResourceLease('production_gpu', gpuLeaseToken);
            continue;
          }
          const job = getAssetGenerationJobById(next.id);
          return job ? {type: 'asset_generation', job, resourceClass, resourceLease} : null;
        }

        const res = db
          .prepare(CLAIM_UPDATE_SQL[next.type])
          .run(claimedBy, at, at, at, next.id);
        if (res.changes === 0) {
          if (gpuLeaseToken) releaseResourceLease('production_gpu', gpuLeaseToken);
          continue;
        }
        if (next.type === 'render') {
          const job = getRenderJobById(next.id);
          return job ? {type: 'render', job, resourceClass, resourceLease} : null;
        }
        if (next.type === 'llm') {
          const job = getLlmJobById(next.id);
          return job ? {type: 'llm', job, resourceClass} : null;
        }
        const job = getTtsJobById(next.id);
        return job ? {type: 'tts', job, resourceClass, resourceLease} : null;
      }
      return null;
    },
  );
  return tx.immediate(workerId, new Date().toISOString());
}

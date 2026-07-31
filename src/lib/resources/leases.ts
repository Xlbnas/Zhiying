/**
 * Durable 跨 Worker 资源租约（M7.3A.2）。
 *
 * 设计：
 * - 每个物理资源组（如 production_gpu）在 DB 中只有一行；claim 是原子
 *   INSERT/UPDATE，失败说明已被其他 Worker 占用。
 * - GPU 任务（tts/render/local_image）在标记 running 之前必须先 claim
 *   production_gpu lease；claim 不到则跳过该候选。
 * - 任务执行期间周期性 heartbeat lease。
 * - 任何终态（succeeded/failed/cancelled/requeued）或 shutdown 均释放 lease。
 * - Worker crash：lease 过期后可回收；回收时必须结合原 job 状态处理，
 *   不得释放仍有有效 heartbeat 的 lease。
 */

import crypto from 'node:crypto';
import {getDb} from '../db';

export type ResourceGroup = 'production_gpu';
export type JobType = 'render' | 'tts' | 'asset_generation';

export const RESOURCE_GROUPS = ['production_gpu'] as const;

/** 默认租约时长：10 分钟；heartbeat 周期由调用方决定（建议 2s）。 */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
/** 崩溃判定宽限：lease 过期超过该时长才强制回收。 */
export const LEASE_STALE_MS = 2 * 60 * 1000;

/**
 * 当前生效的租约时长：ZHIYING_RESOURCE_LEASE_MS env 可覆盖（测试用短 TTL 验证
 * 长时间任务的心跳续约）；非法/非正数回退默认值。scheduler claim 与各 executor
 * heartbeat 统一走此入口，避免测试与生产语义分叉。
 */
export function getResourceLeaseMs(): number {
  const raw = process.env.ZHIYING_RESOURCE_LEASE_MS;
  if (raw === undefined) return DEFAULT_LEASE_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEASE_MS;
}

export interface ResourceLeaseRow {
  resource_group: ResourceGroup;
  owner_job_type: JobType;
  owner_job_id: string;
  owner_worker_id: string;
  owner_token: string;
  lease_expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface ClaimLeaseResult {
  ok: boolean;
  ownerToken: string | null;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * 原子取得资源组租约。
 * - 若该资源组当前无有效租约 → INSERT 成功，返回 {ok:true, ownerToken}。
 * - 若已有未过期租约 → INSERT 因主键冲突失败；随后 UPDATE 校验 owner 也失败，
 *   返回 {ok:false, ownerToken:null}。
 * - 调用方在得到 ok=true 后才能把 job 改为 running。
 */
export function claimResourceLease(
  resourceGroup: ResourceGroup,
  jobType: JobType,
  jobId: string,
  workerId: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): ClaimLeaseResult {
  const db = getDb();
  const ownerToken = `${workerId}:${jobType}:${jobId}:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();
  const at = now();

  // 原子 UPSERT：只有（1）该资源组当前无有效 lease（过期可覆盖），或
  //（2）同一 worker+job 重入时，才写入/更新；否则 changes=0 表示被占用。
  const changed = db
    .prepare(
      `INSERT INTO resource_group_leases (
         resource_group, owner_job_type, owner_job_id, owner_worker_id,
         owner_token, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource_group) DO UPDATE SET
         owner_job_type = excluded.owner_job_type,
         owner_job_id = excluded.owner_job_id,
         owner_worker_id = excluded.owner_worker_id,
         owner_token = excluded.owner_token,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at
       WHERE resource_group_leases.lease_expires_at < excluded.created_at
          OR (resource_group_leases.owner_worker_id = excluded.owner_worker_id
              AND resource_group_leases.owner_job_id = excluded.owner_job_id)`,
    )
    .run(resourceGroup, jobType, jobId, workerId, ownerToken, expiresAt, at, at);

  if (changed.changes === 1) {
    return {ok: true, ownerToken};
  }
  return {ok: false, ownerToken: null};
}

/**
 * 刷新租约。仅当 owner_token 匹配且资源组仍被占时生效。
 */
export function heartbeatResourceLease(
  resourceGroup: ResourceGroup,
  ownerToken: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): boolean {
  const db = getDb();
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();
  const at = now();
  return (
    db
      .prepare(
        `UPDATE resource_group_leases
         SET lease_expires_at = ?, updated_at = ?
         WHERE resource_group = ? AND owner_token = ?`,
      )
      .run(expiresAt, at, resourceGroup, ownerToken).changes === 1
  );
}

/**
 * 释放租约。按 owner_token 精确匹配；非持有者释放返回 false。
 */
export function releaseResourceLease(
  resourceGroup: ResourceGroup,
  ownerToken: string,
): boolean {
  const db = getDb();
  return (
    db
      .prepare('DELETE FROM resource_group_leases WHERE resource_group = ? AND owner_token = ?')
      .run(resourceGroup, ownerToken).changes === 1
  );
}

/**
 * 强制释放任何过期的 lease（用于 recovery）。
 * 调用方必须先处理关联 job 的终态/requeue，不要单独调用此函数。
 */
export function releaseExpiredLeases(staleMs: number = LEASE_STALE_MS): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  return db
    .prepare('DELETE FROM resource_group_leases WHERE lease_expires_at < ?')
    .run(cutoff).changes;
}

/**
 * 按 job 释放其持有的 production_gpu lease（用于 worker 主循环 finally）。
 * 与按 owner_token 释放相比，本函数在 executor 内部已释放或 lease 已过期时
 * 静默返回，不抛错。
 */
export function releaseResourceLeaseForJob(
  resourceGroup: ResourceGroup,
  jobType: JobType,
  jobId: string,
): boolean {
  const db = getDb();
  return (
    db
      .prepare(
        'DELETE FROM resource_group_leases WHERE resource_group = ? AND owner_job_type = ? AND owner_job_id = ?',
      )
      .run(resourceGroup, jobType, jobId).changes >= 1
  );
}

/**
 * 当前是否已被占用（lease 未过期）。
 */
export function isResourceLeased(resourceGroup: ResourceGroup): boolean {
  const db = getDb();
  const at = now();
  const row = db
    .prepare('SELECT 1 FROM resource_group_leases WHERE resource_group = ? AND lease_expires_at >= ?')
    .get(resourceGroup, at) as {1: number} | undefined;
  return row !== undefined;
}

/**
 * 获取当前有效 lease（若无则 null）。
 */
export function getActiveLease(resourceGroup: ResourceGroup): ResourceLeaseRow | null {
  const db = getDb();
  const at = now();
  const row = db
    .prepare('SELECT * FROM resource_group_leases WHERE resource_group = ? AND lease_expires_at >= ?')
    .get(resourceGroup, at) as ResourceLeaseRow | undefined;
  return row ?? null;
}

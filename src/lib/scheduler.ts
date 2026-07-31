import crypto from 'node:crypto';
import {getDb} from './db';
import type {RenderJobRow} from './jobs';
import type {LlmJobRow} from './llm-jobs';
import type {TtsJobRow} from './tts-jobs';
import {DISPATCH_LEASE_MS, type DispatchJobRow} from './llm-generation/dispatch';
import {
  getResourceLimits,
  JOB_TYPE_RESOURCE_CLASS,
  type ResourceClass,
} from './workflow/resource-classes';

/**
 * 单调度器多队列领取（M2-C 双队列 → M3-B 三队列 → M7 四队列 → M7 资源感知并行）。
 * render_jobs + llm_jobs + tts_jobs + generation_dispatch_jobs 在同一
 * BEGIN IMMEDIATE 内按排队时间全局 FIFO（dispatch 以 created_at 入列）；
 * 时间相同时以 job type + id 稳定 tie-break。
 *
 * M7 并行化：Worker 主循环可同时运行多个资源兼容的任务（见
 * workflow/resource-classes.ts）。调用方通过 opts 声明「哪些资源类别
 * 不可再 claim（如 GPU 互斥组被占）」与「各类当前运行计数」，
 * 本函数按 JOB_TYPE_RESOURCE_CLASS 跳过被排除/超限类型的候选，
 * 返回的 claimed job 附带 resourceClass。
 */

export type ClaimedJob =
  | {type: 'render'; job: RenderJobRow; resourceClass: ResourceClass}
  | {type: 'llm'; job: LlmJobRow; resourceClass: ResourceClass}
  | {type: 'tts'; job: TtsJobRow; resourceClass: ResourceClass}
  | {type: 'dispatch'; job: DispatchJobRow; resourceClass: ResourceClass};

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

/**
 * 原子领取全局下一个 queued 任务。无事可做返回 null。
 * claim：status→running、claimed_by/at（dispatch 为 owner_token + lease）、
 * heartbeat、started_at（COALESCE）、attempt+1（render/llm/tts）。
 *
 * M7 资源感知：候选按全局 FIFO 取出后，跳过资源类别被排除或已达
 * 并发上限者；条件 UPDATE（WHERE status='queued'）未命中说明被并发
 * 拿走，继续尝试下一个候选。
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
           ORDER BY queued_at ASC, type ASC, id ASC
           LIMIT 50`,
        )
        .all() as Array<{type: 'render' | 'llm' | 'tts' | 'dispatch'; id: string; queued_at: string}>;
      for (const next of candidates) {
        const resourceClass = JOB_TYPE_RESOURCE_CLASS[next.type];
        if (opts?.excludeResourceClasses?.includes(resourceClass)) {
          continue;
        }
        const runningCount = opts?.runningCounts?.[resourceClass] ?? 0;
        if (runningCount >= limits[resourceClass]) {
          continue;
        }
        if (next.type === 'dispatch') {
          // dispatch 信封：owner_token（workerId + 随机后缀）+ lease，风格与其他队列一致
          const ownerToken = `${claimedBy}:${crypto.randomUUID()}`;
          const leaseExpiresAt = new Date(Date.parse(at) + DISPATCH_LEASE_MS).toISOString();
          const res = db
            .prepare(CLAIM_UPDATE_SQL.dispatch)
            .run(ownerToken, leaseExpiresAt, at, at, next.id);
          if (res.changes === 0) {
            continue;
          }
          const job = getDispatchJobById(next.id);
          return job ? {type: 'dispatch', job, resourceClass} : null;
        }
        const res = db
          .prepare(CLAIM_UPDATE_SQL[next.type])
          .run(claimedBy, at, at, at, next.id);
        if (res.changes === 0) {
          continue;
        }
        if (next.type === 'render') {
          const job = getRenderJobById(next.id);
          return job ? {type: 'render', job, resourceClass} : null;
        }
        if (next.type === 'llm') {
          const job = getLlmJobById(next.id);
          return job ? {type: 'llm', job, resourceClass} : null;
        }
        const job = getTtsJobById(next.id);
        return job ? {type: 'tts', job, resourceClass} : null;
      }
      return null;
    },
  );
  return tx.immediate(workerId, new Date().toISOString());
}

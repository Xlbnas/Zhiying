import crypto from 'node:crypto';
import {getDb} from './db';
import type {RenderJobRow} from './jobs';
import type {LlmJobRow} from './llm-jobs';
import type {TtsJobRow} from './tts-jobs';
import {DISPATCH_LEASE_MS, type DispatchJobRow} from './llm-generation/dispatch';

/**
 * 单调度器多队列领取（M2-C 双队列 → M3-B 三队列 → M7 四队列）。
 * 一个 Worker、一个主循环、任意时刻只执行一个 Job：
 * render_jobs + llm_jobs + tts_jobs + generation_dispatch_jobs 在同一
 * BEGIN IMMEDIATE 内按排队时间全局 FIFO（dispatch 以 created_at 入列）；
 * 时间相同时以 job type + id 稳定 tie-break。
 */

export type ClaimedJob =
  | {type: 'render'; job: RenderJobRow}
  | {type: 'llm'; job: LlmJobRow}
  | {type: 'tts'; job: TtsJobRow}
  | {type: 'dispatch'; job: DispatchJobRow};

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
 */
export function claimNextAnyJob(workerId: string): ClaimedJob | null {
  const db = getDb();
  const tx = db.transaction((claimedBy: string, at: string): ClaimedJob | null => {
    const next = db
      .prepare(
        `SELECT 'render' AS type, id, queued_at FROM render_jobs WHERE status = 'queued'
         UNION ALL
         SELECT 'llm' AS type, id, queued_at FROM llm_jobs WHERE status = 'queued'
         UNION ALL
         SELECT 'tts' AS type, id, queued_at FROM tts_jobs WHERE status = 'queued'
         UNION ALL
         SELECT 'dispatch' AS type, id, created_at AS queued_at FROM generation_dispatch_jobs WHERE status = 'queued'
         ORDER BY queued_at ASC, type ASC, id ASC
         LIMIT 1`,
      )
      .get() as {type: 'render' | 'llm' | 'tts' | 'dispatch'; id: string; queued_at: string} | undefined;
    if (!next) {
      return null;
    }
    if (next.type === 'dispatch') {
      // dispatch 信封：owner_token（workerId + 随机后缀）+ lease，风格与其他队列一致
      const ownerToken = `${claimedBy}:${crypto.randomUUID()}`;
      const leaseExpiresAt = new Date(Date.parse(at) + DISPATCH_LEASE_MS).toISOString();
      db.prepare(CLAIM_UPDATE_SQL.dispatch).run(ownerToken, leaseExpiresAt, at, at, next.id);
      const job = getDispatchJobById(next.id);
      return job ? {type: 'dispatch', job} : null;
    }
    db.prepare(CLAIM_UPDATE_SQL[next.type]).run(claimedBy, at, at, at, next.id);
    if (next.type === 'render') {
      const job = getRenderJobById(next.id);
      return job ? {type: 'render', job} : null;
    }
    if (next.type === 'llm') {
      const job = getLlmJobById(next.id);
      return job ? {type: 'llm', job} : null;
    }
    const job = getTtsJobById(next.id);
    return job ? {type: 'tts', job} : null;
  });
  return tx.immediate(workerId, new Date().toISOString());
}

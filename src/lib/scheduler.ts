import {getDb} from './db';
import type {RenderJobRow} from './jobs';
import type {LlmJobRow} from './llm-jobs';

/**
 * 单调度器双队列领取（M2-C §九）。
 * 一个 Worker、一个主循环、任意时刻只执行一个 Job：
 * render_jobs + llm_jobs 在同一 BEGIN IMMEDIATE 内按 queued_at 全局 FIFO；
 * queued_at 相同时以 job type + id 稳定 tie-break（结果不随机）。
 */

export type ClaimedJob =
  | {type: 'render'; job: RenderJobRow}
  | {type: 'llm'; job: LlmJobRow};

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

/**
 * 原子领取全局下一个 queued 任务。无事可做返回 null。
 * claim：status→running、claimed_by/at、heartbeat_at、started_at（COALESCE）、attempt+1。
 */
export function claimNextAnyJob(workerId: string): ClaimedJob | null {
  const db = getDb();
  const tx = db.transaction((claimedBy: string, at: string): ClaimedJob | null => {
    const next = db
      .prepare(
        `SELECT 'render' AS type, id, queued_at FROM render_jobs WHERE status = 'queued'
         UNION ALL
         SELECT 'llm' AS type, id, queued_at FROM llm_jobs WHERE status = 'queued'
         ORDER BY queued_at ASC, type ASC, id ASC
         LIMIT 1`,
      )
      .get() as {type: 'render' | 'llm'; id: string; queued_at: string} | undefined;
    if (!next) {
      return null;
    }
    if (next.type === 'render') {
      db.prepare(
        `UPDATE render_jobs
         SET status = 'running',
             claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
             started_at = COALESCE(started_at, ?),
             attempt = attempt + 1
         WHERE id = ? AND status = 'queued'`,
      ).run(claimedBy, at, at, at, next.id);
      const job = getRenderJobById(next.id);
      return job ? {type: 'render', job} : null;
    }
    db.prepare(
      `UPDATE llm_jobs
       SET status = 'running',
           claimed_by = ?, claimed_at = ?, heartbeat_at = ?,
           started_at = COALESCE(started_at, ?),
           attempt = attempt + 1
       WHERE id = ? AND status = 'queued'`,
    ).run(claimedBy, at, at, at, next.id);
    const job = getLlmJobById(next.id);
    return job ? {type: 'llm', job} : null;
  });
  return tx.immediate(workerId, new Date().toISOString());
}

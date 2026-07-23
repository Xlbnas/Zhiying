import {getDb} from './db';

/**
 * llm_job 活跃状态的最低层只读 helper（M2-D Final Concurrency Hardening §四）。
 *
 * 只依赖 db + 基础类型，不依赖 workflow / llm-jobs——
 * workflow mutation 层（operations/stages）与 llm-jobs.ts 都从这里复用，
 * 避免 llm-jobs.ts ↔ workflow 循环 import。
 *
 * 【事务内语义】在调用方的 BEGIN IMMEDIATE 中执行：作为
 * edit / lock / rollback 的 authoritative active-job fence 读取点。
 */

export interface ActiveLlmJobState {
  id: string;
  status: string;
}

/** 同 (project_id, stage) 的活跃任务（queued|running），无则 undefined。 */
export function getActiveLlmJobTx(
  projectId: string,
  stage: string,
): ActiveLlmJobState | undefined {
  return getDb()
    .prepare(
      `SELECT id, status FROM llm_jobs
       WHERE project_id = ? AND stage = ? AND status IN ('queued', 'running')
       ORDER BY queued_at ASC LIMIT 1`,
    )
    .get(projectId, stage) as ActiveLlmJobState | undefined;
}

/** 是否存在活跃任务。 */
export function hasActiveLlmJobTx(projectId: string, stage: string): boolean {
  return getActiveLlmJobTx(projectId, stage) !== undefined;
}

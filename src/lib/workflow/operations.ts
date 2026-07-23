import {getDb} from '@/lib/db';
import {
  applyDownstreamStaleTx,
  assertConfirmedForStage,
  requireStage,
  setStatusTx,
  WorkflowError,
} from './stages';
import {
  copyVersionRowsTx,
  insertVersionTx,
  type CreateVersionInput,
} from './versions';
import type {ProjectVersionRow, WorkflowStage} from './types';

/**
 * 工作流高层原子业务操作（M2-A Hardening）。
 *
 * 正式调用路径（M2-B/C 的 Worker / Route Handler）只使用这里的三个操作，
 * 每个操作在**单个 BEGIN IMMEDIATE 事务**内完成：
 * 版本创建/复制 + active_version + status 推进 + downstream stale 传播。
 * 不存在「版本已建但状态未推进」的部分提交窗口；
 * 版本号分配全程处于写锁保护下（Web / Worker 双进程安全）。
 *
 * 校验（阶段存在 / confirmStale / 目标版本存在）全部在事务内、
 * 任何写入之前完成 —— 校验失败即整体回滚，不产生任何副作用。
 */

export interface AtomicOpOptions {
  /** 目标阶段为 locked 时必须显式 true（UI 已提示影响范围）。 */
  confirmStale?: boolean;
}

/**
 * 【事务内 helper】AI 生成完成的 workflow 变更部分：
 * 创建 version + active_version + status→generated + 必要 downstream stale。
 * 不开事务——供调用方在更大的原子事务内组合（如 llm-jobs.commitLlmJobResult
 * 把「版本落库 + job 终态」放进同一 BEGIN IMMEDIATE）。
 * 需要独立事务的高层调用请用 generateVersion()。
 */
export function generateVersionTx(input: CreateVersionInput): ProjectVersionRow {
  const row = requireStage(input.projectId, input.stage);
  const wasLockedOrStale =
    row.status === 'locked' || row.status === 'stale';
  const created = insertVersionTx(input);
  if (wasLockedOrStale) {
    applyDownstreamStaleTx(input.projectId, input.stage);
  }
  setStatusTx(input.projectId, input.stage, 'generated');
  return created;
}

/**
 * AI 生成完成（llm_job 成功时由 worker 调用）：
 * 创建 version + active_version + status→generated + 必要 downstream stale。
 */
export function generateVersion(input: CreateVersionInput): ProjectVersionRow {
  const db = getDb();
  const tx = db.transaction((): ProjectVersionRow => generateVersionTx(input));
  return tx.immediate();
}

/**
 * 人工编辑：
 * 创建 version + active_version + status→edited + 必要 downstream stale。
 * locked 阶段需 confirmStale；not_started 拒绝（NO_ACTIVE_VERSION）。
 */
export function editVersion(
  input: CreateVersionInput,
  opts: AtomicOpOptions = {},
): ProjectVersionRow {
  const db = getDb();
  const tx = db.transaction((): ProjectVersionRow => {
    const row = requireStage(input.projectId, input.stage);
    if (row.status === 'not_started') {
      throw new WorkflowError(
        'NO_ACTIVE_VERSION',
        `${input.stage} 尚未生成，不能编辑`,
      );
    }
    assertConfirmedForStage(
      row,
      input.projectId,
      opts.confirmStale ?? false,
    );
    const wasLockedOrStale =
      row.status === 'locked' || row.status === 'stale';
    const created = insertVersionTx(input);
    if (wasLockedOrStale) {
      applyDownstreamStaleTx(input.projectId, input.stage);
    }
    setStatusTx(input.projectId, input.stage, 'edited');
    return created;
  });
  return tx.immediate();
}

/**
 * 回滚到历史版本：
 * 复制目标 version 为新 version（历史不移动）+ active_version +
 * status→edited + 必要 downstream stale。locked 阶段需 confirmStale。
 */
export function rollbackToVersion(
  projectId: string,
  stage: WorkflowStage,
  targetVersion: number,
  opts: AtomicOpOptions = {},
): ProjectVersionRow {
  const db = getDb();
  const tx = db.transaction((): ProjectVersionRow => {
    const row = requireStage(projectId, stage);
    assertConfirmedForStage(row, projectId, opts.confirmStale ?? false);
    // copyVersionRowsTx 目标不存在则抛错，发生在任何写入之前
    const created = copyVersionRowsTx(projectId, stage, targetVersion);
    const wasLockedOrStale =
      row.status === 'locked' || row.status === 'stale';
    if (wasLockedOrStale) {
      applyDownstreamStaleTx(projectId, stage);
    }
    setStatusTx(projectId, stage, 'edited');
    return created;
  });
  return tx.immediate();
}

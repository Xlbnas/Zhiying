import {getDb} from '@/lib/db';
import {getActiveLlmJobTx} from '../llm-job-state';
import {
  WORKFLOW_STAGES,
  downstreamStages,
  upstreamStages,
  type ProjectStageRow,
  type StageStatus,
  type WorkflowStage,
} from './types';

/**
 * 工作流阶段状态机（M2-A，M2 实施计划 §1.3）。
 *
 * 规则：
 * - not_started → generated（生成成功）→ edited（人工编辑）→ locked（锁定）
 * - run 门控：所有上游必须 locked；对 locked/stale 阶段 re-run 需 confirmStale
 * - 编辑 locked 阶段需 confirmStale；确认后全部下游（已有进度的）置 stale
 * - stale 阶段不能直接 lock，必须 re-run 出新版本
 * - stale 传播不触碰 not_started 的下游（未开始谈不上失效）
 * - locked_version 在 stale 后保留可查；重新 lock 时更新
 */

function now(): string {
  return new Date().toISOString();
}

export class WorkflowError extends Error {
  constructor(
    public readonly code:
      | 'STAGE_NOT_FOUND'
      | 'UPSTREAM_NOT_LOCKED'
      | 'CONFIRM_STALE_REQUIRED'
      | 'STALE_MUST_RERUN'
      | 'NO_ACTIVE_VERSION'
      | 'INVALID_TRANSITION'
      | 'JOB_ALREADY_ACTIVE',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}

// ---------- 初始化与查询 ----------

/** 为新项目初始化 10 个阶段行（幂等：已存在则跳过）。 */
export function initProjectStages(projectId: string): void {
  const db = getDb();
  const at = now();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO project_stages
       (project_id, stage, status, active_version, locked_version, updated_at)
     VALUES (?, ?, 'not_started', NULL, NULL, ?)`,
  );
  const tx = db.transaction(() => {
    for (const stage of WORKFLOW_STAGES) {
      insert.run(projectId, stage, at);
    }
  });
  tx();
}

export function getStage(
  projectId: string,
  stage: WorkflowStage,
): ProjectStageRow | undefined {
  return getDb()
    .prepare('SELECT * FROM project_stages WHERE project_id = ? AND stage = ?')
    .get(projectId, stage) as ProjectStageRow | undefined;
}

export function listStages(projectId: string): ProjectStageRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM project_stages WHERE project_id = ?')
    .all(projectId) as ProjectStageRow[];
  const order = new Map(WORKFLOW_STAGES.map((s, i) => [s, i]));
  return rows.sort(
    (a, b) => (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99),
  );
}

export function requireStage(
  projectId: string,
  stage: WorkflowStage,
): ProjectStageRow {
  const row = getStage(projectId, stage);
  if (!row) {
    throw new WorkflowError(
      'STAGE_NOT_FOUND',
      `阶段不存在（项目未初始化工作流？）: ${projectId}/${stage}`,
    );
  }
  return row;
}

// ---------- 门控 ----------

/**
 * run-stage 门控：所有上游必须 locked（且 locked_version ≠ null，
 * 与 captureLockedUpstreamVersionsTx 语义一致——Final Concurrency §九）。
 * 通过时返回 void；否则抛 UPSTREAM_NOT_LOCKED（带首个未锁上游）。
 */
export function assertRunnable(
  projectId: string,
  stage: WorkflowStage,
): void {
  for (const up of upstreamStages(stage)) {
    const row = getStage(projectId, up);
    if (!row || row.status !== 'locked' || row.locked_version === null) {
      throw new WorkflowError(
        'UPSTREAM_NOT_LOCKED',
        `上游阶段未锁定，禁止执行 ${stage}`,
        {firstUnlockedUpstream: up, upstreamStatus: row?.status ?? 'missing'},
      );
    }
  }
}

/**
 * re-run / 编辑前的影响确认检查：
 * 目标阶段为 locked 或 stale 时，新版本会使下游基于旧版的内容失效，
 * 调用方必须显式 confirmStale（UI 已提示影响范围）。
 * 返回受影响（将变 stale 的）下游阶段列表，供 UI 预览。
 */
export function affectedDownstream(
  projectId: string,
  stage: WorkflowStage,
): WorkflowStage[] {
  return downstreamStages(stage).filter((down) => {
    const row = getStage(projectId, down);
    return row !== undefined && row.status !== 'not_started';
  });
}

export function assertConfirmedForStage(
  row: ProjectStageRow,
  projectId: string,
  confirmStale: boolean,
): void {
  // 仅 locked 阶段需要确认：stale 阶段的下游已经失效，re-run/edit/rollback
  // 属恢复动作，不产生新的影响面
  if (row.status === 'locked' && !confirmStale) {
    throw new WorkflowError(
      'CONFIRM_STALE_REQUIRED',
      `${row.stage} 已锁定，产生新版本将使下游失效，需 confirmStale 确认`,
      {affectedDownstream: affectedDownstream(projectId, row.stage)},
    );
  }
}

// ---------- 状态推进 ----------

/** 把全部已有进度的下游置 stale（同事务内调用）。 */
export function applyDownstreamStaleTx(
  projectId: string,
  stage: WorkflowStage,
): void {
  const db = getDb();
  const at = now();
  const mark = db.prepare(
    `UPDATE project_stages SET status = 'stale', updated_at = ?
     WHERE project_id = ? AND stage = ? AND status != 'not_started'`,
  );
  for (const down of downstreamStages(stage)) {
    mark.run(at, projectId, down);
  }
}

export function setStatusTx(
  projectId: string,
  stage: WorkflowStage,
  status: StageStatus,
  lockedVersion?: number | null,
): void {
  const db = getDb();
  if (lockedVersion === undefined) {
    db.prepare(
      `UPDATE project_stages SET status = ?, updated_at = ?
       WHERE project_id = ? AND stage = ?`,
    ).run(status, now(), projectId, stage);
  } else {
    db.prepare(
      `UPDATE project_stages SET status = ?, locked_version = ?, updated_at = ?
       WHERE project_id = ? AND stage = ?`,
    ).run(status, lockedVersion, now(), projectId, stage);
  }
}

/**
 * 生成成功（llm_job 完成时由 worker 调用，M2-B/C 接入）：
 * status → generated；locked_version 保留旧值直至重新 lock；
 * 若此前为 locked/stale（re-run），下游传播 stale。
 * 版本行与 active_version 由 versions.createVersion 保证。
 */
export function markGenerated(
  projectId: string,
  stage: WorkflowStage,
): void {
  const row = requireStage(projectId, stage);
  const tx = getDb().transaction(() => {
    if (row.status === 'locked' || row.status === 'stale') {
      applyDownstreamStaleTx(projectId, stage);
    }
    setStatusTx(projectId, stage, 'generated');
  });
  tx();
}

/**
 * 人工编辑成功：status → edited。
 * locked 阶段编辑需先经 assertConfirmedForStage（confirmStale）。
 */
export function markEdited(
  projectId: string,
  stage: WorkflowStage,
  opts: {confirmStale?: boolean} = {},
): void {
  const row = requireStage(projectId, stage);
  if (row.status === 'not_started') {
    throw new WorkflowError(
      'NO_ACTIVE_VERSION',
      `${stage} 尚未生成，不能编辑`,
    );
  }
  assertConfirmedForStage(row, projectId, opts.confirmStale ?? false);
  const tx = getDb().transaction(() => {
    if (row.status === 'locked' || row.status === 'stale') {
      applyDownstreamStaleTx(projectId, stage);
    }
    setStatusTx(projectId, stage, 'edited');
  });
  tx();
}

/**
 * 锁定当前 active_version（Final Concurrency Hardening：真正的高层原子 mutation）。
 *
 * 单个 BEGIN IMMEDIATE 内完成（顺序保持旧错误码语义）：
 *   1. active-job fence（JOB_ALREADY_ACTIVE，authoritative——Route 预检只是 UX）
 *   2. NO_ACTIVE_VERSION（not_started / 无 active）
 *   3. STALE_MUST_RERUN（stale 必须先重跑）
 *   4. assertRunnable 上游门控（UPSTREAM_NOT_LOCKED，含 locked_version ≠ null）
 *   5. setStatusTx → locked + locked_version
 *
 * 修复旧 TOCTOU：此前 assertRunnable（读）与 setStatusTx（写）之间无写锁，
 * 上游可在窗口内被 edit，产生「research edited + evidence locked」非法状态。
 */
export function lockStage(projectId: string, stage: WorkflowStage): void {
  const db = getDb();
  const tx = db.transaction((): void => {
    const activeJob = getActiveLlmJobTx(projectId, stage);
    if (activeJob) {
      throw new WorkflowError(
        'JOB_ALREADY_ACTIVE',
        `${stage} 已有进行中的生成任务（${activeJob.id}），请等待完成或先取消`,
      );
    }
    const row = requireStage(projectId, stage);
    if (row.status === 'not_started' || row.active_version === null) {
      throw new WorkflowError(
        'NO_ACTIVE_VERSION',
        `${stage} 尚未生成，不能锁定`,
      );
    }
    if (row.status === 'stale') {
      throw new WorkflowError(
        'STALE_MUST_RERUN',
        `${stage} 已失效，必须重新生成后才能锁定`,
      );
    }
    // 上游门控（在 stale/NO_ACTIVE 检查之后，保证旧错误码语义不变）
    assertRunnable(projectId, stage);
    setStatusTx(projectId, stage, 'locked', row.active_version);
  });
  tx.immediate();
}

/**
 * 回滚完成后的状态推进（配合 versions.copyVersionAsNew）：
 * 回滚视为一种编辑 → status = edited；locked/stale 阶段回滚需 confirmStale，
 * 确认后下游传播 stale。
 */
export function markRolledBack(
  projectId: string,
  stage: WorkflowStage,
  opts: {confirmStale?: boolean} = {},
): void {
  const row = requireStage(projectId, stage);
  assertConfirmedForStage(row, projectId, opts.confirmStale ?? false);
  const tx = getDb().transaction(() => {
    if (row.status === 'locked' || row.status === 'stale') {
      applyDownstreamStaleTx(projectId, stage);
    }
    setStatusTx(projectId, stage, 'edited');
  });
  tx();
}

/** re-run 前检查：门控 + confirmStale（仅 locked 阶段需要；stale 属恢复动作）。 */
export function assertRerunAllowed(
  projectId: string,
  stage: WorkflowStage,
  opts: {confirmStale?: boolean} = {},
): void {
  assertRunnable(projectId, stage);
  const row = requireStage(projectId, stage);
  assertConfirmedForStage(row, projectId, opts.confirmStale ?? false);
}

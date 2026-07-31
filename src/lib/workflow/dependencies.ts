import {getDb} from '../db';
import {requireStage, WorkflowError} from './stages';
import {directStageDependencies} from './dag-shared';
import type {WorkflowStage} from './types';

/**
 * 上游依赖快照（M2-D §五/六）。
 * 依赖数据逻辑的唯一出口——route / worker / prompt 不得各自实现：
 * - captureLockedUpstreamVersionsTx：入队时刻全部上游 locked_version 快照
 * - resolveUpstreamVersionContents：Worker 按快照精确读取历史版本内容
 * - checkDependencySnapshotTx：preflight / commit fence 的一致性检查
 * 高层原子入队见 llm-jobs.ts 的 enqueueWorkflowStageJob。
 */

/** 快照：stage → locked_version（不可变版本号，不复制大段内容）。 */
export type UpstreamVersionSnapshot = Record<string, number>;

export interface DependencyIssue {
  stage: WorkflowStage;
  expectedVersion: number;
  currentStatus: string;
  currentLockedVersion: number | null;
}

/**
 * 【事务内】捕获全部上游的 locked_version。
 * 每个上游必须 status=locked 且 locked_version != null，否则 UPSTREAM_NOT_LOCKED。
 */
export function captureLockedUpstreamVersionsTx(
  projectId: string,
  stage: WorkflowStage,
): UpstreamVersionSnapshot {
  const snapshot: UpstreamVersionSnapshot = {};
  for (const up of directStageDependencies(stage)) {
    const row = requireStage(projectId, up);
    if (row.status !== 'locked' || row.locked_version === null) {
      throw new WorkflowError(
        'UPSTREAM_NOT_LOCKED',
        `上游阶段未锁定，禁止执行 ${stage}`,
        {firstUnlockedUpstream: up, upstreamStatus: row.status},
      );
    }
    snapshot[up] = row.locked_version;
  }
  return snapshot;
}

/** Worker 执行时按快照精确读取版本内容（历史行不可修改，完全可复现）。 */
export function resolveUpstreamVersionContents(
  projectId: string,
  snapshot: UpstreamVersionSnapshot,
): Partial<Record<WorkflowStage, string>> {
  const upstream: Partial<Record<WorkflowStage, string>> = {};
  for (const [stage, version] of Object.entries(snapshot)) {
    const row = getDb()
      .prepare(
        `SELECT content FROM project_versions
         WHERE project_id = ? AND stage = ? AND version = ?`,
      )
      .get(projectId, stage, version) as {content: string} | undefined;
    if (row) {
      upstream[stage as WorkflowStage] = row.content;
    }
  }
  return upstream;
}

/**
 * 【事务内/只读】快照一致性检查：当前上游是否仍 locked 且 locked_version 等于快照值。
 * 返回不一致列表（空 = 全部一致）。
 */
export function checkDependencySnapshotTx(
  projectId: string,
  snapshot: UpstreamVersionSnapshot,
): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  for (const [stage, expectedVersion] of Object.entries(snapshot)) {
    const row = getDb()
      .prepare('SELECT * FROM project_stages WHERE project_id = ? AND stage = ?')
      .get(projectId, stage) as
      | {status: string; locked_version: number | null}
      | undefined;
    if (!row || row.status !== 'locked' || row.locked_version !== expectedVersion) {
      issues.push({
        stage: stage as WorkflowStage,
        expectedVersion,
        currentStatus: row?.status ?? 'missing',
        currentLockedVersion: row?.locked_version ?? null,
      });
    }
  }
  return issues;
}

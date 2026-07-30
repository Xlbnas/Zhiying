import {getDb} from './db';
import {
  getM7PipelineSnapshotArtifact,
  getSnapshotValidator,
  type M7PipelineSnapshotV1,
} from './m7-pipeline-snapshot';
import {listNarrationPlanV2Candidates} from './narration/plan-v2';

/**
 * Project pipelineVersion + M7 activation（M7.1.1，REVIEW P0-2/P0-3 冻结）。
 *
 * 语义：
 * - candidate artifact ≠ selected artifact ≠ active pipeline artifact。
 *   唯一激活路径：activateM7Pipeline(projectId, snapshotArtifactId)
 *   显式传入完整 immutable m7_pipeline_snapshot；没有任何函数可以仅凭
 *   narration-plan v2（或 latest candidate）完成 m7 切换。
 * - 冻结约束：m6 → m7_pipeline_snapshot_id 必须 NULL；
 *   m7 → 必须指向同项目、完整、合法的 immutable snapshot。
 * - consistency 不再使用随未来版本增长的全局 required-chain 数组追溯
 *   已激活项目；改为读取精确 snapshot，按其声明的 rulesetVersion 用
 *   冻结 validator 验证当时声明的完整链（见 m7-pipeline-snapshot.ts）。
 */

export type PipelineVersion = 'm6' | 'm7';

export class PipelineVersionError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'ALREADY_M7'
      | 'INVALID_TRANSITION'
      | 'M7_ACTIVATION_SNAPSHOT_REQUIRED'
      | 'SNAPSHOT_NOT_FOUND'
      | 'SNAPSHOT_INVALID'
      | 'SNAPSHOT_PROJECT_MISMATCH'
      | 'SNAPSHOT_CHAIN_INCOMPLETE'
      | 'UNSUPPORTED_RULESET'
      | 'INCONSISTENT_POINTER',
    message: string,
  ) {
    super(message);
    this.name = 'PipelineVersionError';
  }
}

interface ProjectPipelineRow {
  pipeline_version: string;
  m7_pipeline_snapshot_id: string | null;
}

function getProjectPipelineRow(projectId: string): ProjectPipelineRow {
  const row = getDb()
    .prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects WHERE id = ?')
    .get(projectId) as ProjectPipelineRow | undefined;
  if (!row) {
    throw new PipelineVersionError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
  }
  return row;
}

export function getPipelineVersion(projectId: string): PipelineVersion {
  return getProjectPipelineRow(projectId).pipeline_version === 'm7' ? 'm7' : 'm6';
}

/** 项目的 active snapshot 指针（m6 恒为 null）。 */
export function getM7PipelineSnapshotId(projectId: string): string | null {
  return getProjectPipelineRow(projectId).m7_pipeline_snapshot_id;
}

/** 读取已激活项目的精确 snapshot（m6/无指针/非法 → null）。 */
export function getActiveM7PipelineSnapshot(projectId: string): M7PipelineSnapshotV1 | null {
  const row = getProjectPipelineRow(projectId);
  if (row.pipeline_version !== 'm7' || row.m7_pipeline_snapshot_id === null) return null;
  const ref = getM7PipelineSnapshotArtifact(projectId, row.m7_pipeline_snapshot_id);
  return ref?.snapshot ?? null;
}

/**
 * 用 snapshot 自身声明的 rulesetVersion 做冻结验证（不做版本增长追溯）。
 * 返回全部违规原因；空数组 = 通过。
 */
function validateSnapshotForProject(projectId: string, snapshotArtifactId: string): string[] {
  const ref = getM7PipelineSnapshotArtifact(projectId, snapshotArtifactId);
  if (!ref) {
    return ['snapshot artifact 不存在 / 非 m7_pipeline_snapshot / 跨项目 / 契约非法'];
  }
  const {snapshot} = ref;
  if (snapshot.projectId !== projectId) {
    return [`snapshot.projectId(${snapshot.projectId}) 与项目(${projectId})不一致`];
  }
  const validator = getSnapshotValidator(snapshot.rulesetVersion);
  if (!validator) {
    return [`不支持的 rulesetVersion=${snapshot.rulesetVersion}（拒绝猜测验证）`];
  }
  return validator(projectId, snapshot);
}

/**
 * 原子激活 m6 → m7（单 BEGIN IMMEDIATE）：
 * 项目存在且为 m6 → snapshot 存在/kind/schema 合法 → projectId 一致 →
 * 冻结 ruleset 验证完整链（全部 artifact 存在、同项目、approvals 精确引用、
 * Editorial Gate=pass、final source provenance 一致）→
 * UPDATE pipeline_version + m7_pipeline_snapshot_id → commit。
 * 任一步失败整体回滚，绝不产生部分写入。
 */
export function activateM7Pipeline(projectId: string, pipelineSnapshotArtifactId: string): void {
  if (typeof pipelineSnapshotArtifactId !== 'string' || pipelineSnapshotArtifactId.length === 0) {
    throw new PipelineVersionError(
      'M7_ACTIVATION_SNAPSHOT_REQUIRED',
      'M7 激活必须显式提供完整 m7_pipeline_snapshot artifact ID（禁止 latest/猜测）',
    );
  }
  const db = getDb();
  const tx = db.transaction((): void => {
    const row = getProjectPipelineRow(projectId);
    if (row.pipeline_version === 'm7') {
      throw new PipelineVersionError('ALREADY_M7', `项目已是 pipelineVersion=m7: ${projectId}`);
    }
    if (row.pipeline_version !== 'm6') {
      throw new PipelineVersionError(
        'INVALID_TRANSITION',
        `未知 pipeline_version="${row.pipeline_version}"，拒绝切换`,
      );
    }
    const violations = validateSnapshotForProject(projectId, pipelineSnapshotArtifactId);
    if (violations.length > 0) {
      throw new PipelineVersionError(
        'SNAPSHOT_CHAIN_INCOMPLETE',
        `M7 snapshot 验证失败，禁止激活：\n- ${violations.join('\n- ')}`,
      );
    }
    db.prepare(
      `UPDATE projects SET pipeline_version = 'm7', m7_pipeline_snapshot_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(pipelineSnapshotArtifactId, new Date().toISOString(), projectId);
  });
  tx.immediate();
}

/**
 * @deprecated M7.1.1 起禁止无 snapshot 的切换。恒定抛出
 * M7_ACTIVATION_SNAPSHOT_REQUIRED——不得内部猜测 latest candidate。
 * 使用 activateM7Pipeline(projectId, snapshotArtifactId)。
 */
export function switchPipelineToM7(_projectId: string): never {
  throw new PipelineVersionError(
    'M7_ACTIVATION_SNAPSHOT_REQUIRED',
    'switchPipelineToM7 已废弃：M7 激活必须显式提供完整 m7_pipeline_snapshot artifact ID',
  );
}

/**
 * 读取侧一致性复查（fail-closed，不追溯新需求）：
 * - m6：snapshot 指针必须 NULL；
 * - m7：指针必须非 NULL，精确 snapshot 按其声明的 rulesetVersion 用
 *   冻结 validator 验证；引用 artifact 丢失/损坏/跨项目仍 fail。
 */
export function assertPipelineConsistency(projectId: string): void {
  const row = getProjectPipelineRow(projectId);
  if (row.pipeline_version === 'm6') {
    if (row.m7_pipeline_snapshot_id !== null) {
      throw new PipelineVersionError(
        'INCONSISTENT_POINTER',
        '项目 pipeline_version=m6 但 m7_pipeline_snapshot_id 非 NULL（指针污染）',
      );
    }
    return;
  }
  if (row.pipeline_version !== 'm7') {
    throw new PipelineVersionError(
      'INVALID_TRANSITION',
      `未知 pipeline_version="${row.pipeline_version}"`,
    );
  }
  if (row.m7_pipeline_snapshot_id === null) {
    throw new PipelineVersionError(
      'INCONSISTENT_POINTER',
      '项目 pipeline_version=m7 但 m7_pipeline_snapshot_id 为 NULL',
    );
  }
  const violations = validateSnapshotForProject(projectId, row.m7_pipeline_snapshot_id);
  if (violations.length > 0) {
    throw new PipelineVersionError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      `已激活项目的 snapshot 不再满足其声明的 ruleset：\n- ${violations.join('\n- ')}`,
    );
  }
}

/** 项目级 M7 激活状态（与 artifact candidate 状态严格分离）。 */
export type M7PipelineActivationStatus =
  | 'not_started'
  | 'building'
  | 'snapshot_ready'
  | 'active'
  | 'inconsistent';

/** 项目级 activation 状态（纯读）。 */
export function getM7PipelineActivationStatus(projectId: string): M7PipelineActivationStatus {
  const row = getProjectPipelineRow(projectId);
  if (row.pipeline_version === 'm7') {
    try {
      assertPipelineConsistency(projectId);
      return 'active';
    } catch {
      return 'inconsistent';
    }
  }
  if (row.m7_pipeline_snapshot_id !== null) return 'inconsistent';
  const snapshotCount = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'm7_pipeline_snapshot'`)
    .get(projectId) as {c: number};
  if (snapshotCount.c > 0) return 'snapshot_ready';
  if (listNarrationPlanV2Candidates(projectId).length > 0) return 'building';
  return 'not_started';
}

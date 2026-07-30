import {getDb} from './db';
import {getCurrentNarrationPlanV2} from './narration/plan-v2';

/**
 * Project pipelineVersion（M7.1）：'m6' | 'm7' 原子分流。
 *
 * 语义（冻结）：
 * - migration 后全部存量项目默认 'm6'（DDL DEFAULT，见 db.ts）
 * - 构建 M7 candidate artifacts 不改变 pipelineVersion
 * - 只有完整 M7 required artifact chain 全部 eligible current，
 *   才允许在单事务内原子切换 'm6' → 'm7'
 * - 禁止项目处于 'm7' 但缺少 required M7 artifacts（切换时校验 +
 *   读取侧 assertPipelineConsistency 可复查）
 *
 * required chain 随里程碑扩展（M7.2 beats / M7.3 sequences / …），
 * 每个环节是 (kind, 校验函数) 对；新增环节后旧 'm7' 项目不自动失效——
 * chain 校验只在「切换动作」时执行（append-only 语义，不回溯降级）。
 */

export type PipelineVersion = 'm6' | 'm7';

export interface PipelineChainRequirement {
  /** 人类可读环节名（错误信息用）。 */
  name: string;
  /** 返回 null = 通过；否则返回缺失原因。 */
  check: (projectId: string) => string | null;
}

/** M7 required artifact chain（M7.1：typed narration eligible current）。 */
export const M7_REQUIRED_CHAIN: PipelineChainRequirement[] = [
  {
    name: 'narration_plan_v2(eligible current)',
    check: (projectId) =>
      getCurrentNarrationPlanV2(projectId)
        ? null
        : 'Narration Plan V2 缺失或非 eligible（needsReview 未清空 / source stale）',
  },
];

export class PipelineVersionError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'CHAIN_INCOMPLETE'
      | 'ALREADY_M7'
      | 'INVALID_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'PipelineVersionError';
  }
}

export function getPipelineVersion(projectId: string): PipelineVersion {
  const row = getDb()
    .prepare('SELECT pipeline_version FROM projects WHERE id = ?')
    .get(projectId) as {pipeline_version: string} | undefined;
  if (!row) {
    throw new PipelineVersionError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
  }
  return row.pipeline_version === 'm7' ? 'm7' : 'm6';
}

/** 读取侧一致性复查：'m7' 项目必须仍满足 required chain（检测手动改库/漂移）。 */
export function assertPipelineConsistency(projectId: string): void {
  const version = getPipelineVersion(projectId);
  if (version !== 'm7') return;
  for (const requirement of M7_REQUIRED_CHAIN) {
    const missing = requirement.check(projectId);
    if (missing !== null) {
      throw new PipelineVersionError(
        'CHAIN_INCOMPLETE',
        `项目处于 pipelineVersion=m7 但缺少 required artifact：${requirement.name}——${missing}`,
      );
    }
  }
}

/**
 * 原子切换 'm6' → 'm7'（单 BEGIN IMMEDIATE）：
 * 项目存在 → 当前为 m6 → required chain 全部通过 → UPDATE → commit。
 * 任一环节缺失即整体拒绝（CHAIN_INCOMPLETE 列出全部缺失项）。
 * 反向切换（m7 → m6）不提供：append-only 纪律，纠错走新 artifact 而非降级。
 */
export function switchPipelineToM7(projectId: string): void {
  const db = getDb();
  const tx = db.transaction((): void => {
    const row = db
      .prepare('SELECT pipeline_version FROM projects WHERE id = ?')
      .get(projectId) as {pipeline_version: string} | undefined;
    if (!row) {
      throw new PipelineVersionError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (row.pipeline_version === 'm7') {
      throw new PipelineVersionError('ALREADY_M7', `项目已是 pipelineVersion=m7: ${projectId}`);
    }
    if (row.pipeline_version !== 'm6') {
      throw new PipelineVersionError(
        'INVALID_TRANSITION',
        `未知 pipeline_version="${row.pipeline_version}"，拒绝切换`,
      );
    }
    const missing: string[] = [];
    for (const requirement of M7_REQUIRED_CHAIN) {
      const reason = requirement.check(projectId);
      if (reason !== null) missing.push(`${requirement.name}：${reason}`);
    }
    if (missing.length > 0) {
      throw new PipelineVersionError(
        'CHAIN_INCOMPLETE',
        `M7 required artifact chain 不完整，禁止切换：\n- ${missing.join('\n- ')}`,
      );
    }
    db.prepare(
      `UPDATE projects SET pipeline_version = 'm7', updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), projectId);
  });
  tx.immediate();
}

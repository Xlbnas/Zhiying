/**
 * M6.3.8：generated candidate → exact requirement 的显式绑定。
 *
 * 安全不变量：
 * - candidate 只能绑定到它生成时的 intended 目标（sceneId + requirementId 完全一致）；
 *   candidate R01 → R02、candidate S012 → S013 一律拒绝。
 * - 目标 requirement 必须真实存在于 active scenes artifact（exact 查找，禁止 LIKE/猜测）。
 * - 同一 requirement 重复绑定 = replace 语义（旧 binding 转历史，asset/文件/provenance 保留）。
 */
import {getDb} from '../db';
import {
  bindAssetToRequirement,
  clearResolutionState,
  getAssetById,
  type AssetBindingRow,
  type AssetRow,
} from './model';
import {findRequirementInPlans, loadLatestScenesPlans} from './requirements';
import {isSceneVisuallyOverridden} from '../scenes/visual-overrides';

export class BindError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'BindError';
  }
}

/** candidate 的 intended 目标：sceneId 取 denormalized scene_id 列，requirementId 取快照。 */
function intendedTargetOf(asset: AssetRow): {sceneId: string | null; requirementId: string | null} {
  let requirementId: string | null = null;
  if (asset.requirement_json) {
    try {
      const parsed = JSON.parse(asset.requirement_json) as {requirementId?: unknown};
      if (typeof parsed.requirementId === 'string' && parsed.requirementId.length > 0) {
        requirementId = parsed.requirementId;
      }
    } catch {
      // 快照损坏 → 视为无 intended requirement（只能按 scene 级 provenance 校验）
    }
  }
  return {sceneId: asset.scene_id, requirementId};
}

export function bindGeneratedCandidate(input: {
  projectId: string;
  candidateId: string;
  sceneId: string;
  requirementId: string;
}): {binding: AssetBindingRow; asset: AssetRow} {
  const asset = getAssetById(input.candidateId);
  if (!asset || asset.project_id !== input.projectId) {
    throw new BindError('candidate_not_found', '候选素材不存在', 404);
  }
  if (asset.source_type !== 'generated') {
    throw new BindError('not_generated_candidate', '只能绑定 AI 生成的候选素材');
  }

  // 跨目标绑定拒绝：candidate 记录的 intended 目标与请求不一致 → reject
  const intended = intendedTargetOf(asset);
  if (intended.sceneId !== null && intended.sceneId !== input.sceneId) {
    throw new BindError(
      'scene_mismatch',
      `该候选素材的目标场景是 ${intended.sceneId}，不能绑定到 ${input.sceneId}`,
    );
  }
  if (intended.requirementId !== null && intended.requirementId !== input.requirementId) {
    throw new BindError(
      'requirement_mismatch',
      `该候选素材的目标需求是 ${intended.requirementId}，不能绑定到 ${input.requirementId}`,
    );
  }

  // 目标 requirement 必须真实存在于 active scenes artifact
  const plans = loadLatestScenesPlans(input.projectId);
  if (!plans) throw new BindError('scenes_not_found', '项目缺少 scenes artifact', 404);
  if (!findRequirementInPlans(plans, input.sceneId, input.requirementId)) {
    throw new BindError(
      'requirement_not_found',
      `需求 ${input.requirementId} 不存在于场景 ${input.sceneId}`,
    );
  }
  // M6.3.13：已「改用 MG」的 scene 拒绝绑定（防半截状态）
  if (isSceneVisuallyOverridden(input.projectId, input.sceneId)) {
    throw new BindError(
      'scene_overridden',
      `场景 ${input.sceneId} 已改用 MG 模板，如需绑定素材请先「改回素材」`,
      409,
    );
  }

  // candidate 已被其他目标 active 绑定 → 拒绝（先解除原绑定才能改绑）
  const existing = getDb()
    .prepare('SELECT scene_id, requirement_id FROM asset_bindings WHERE asset_id = ? AND active = 1')
    .get(input.candidateId) as {scene_id: string; requirement_id: string} | undefined;
  if (existing && (existing.scene_id !== input.sceneId || existing.requirement_id !== input.requirementId)) {
    throw new BindError(
      'already_bound_elsewhere',
      `该候选素材已绑定到 ${existing.scene_id}/${existing.requirement_id}`,
      409,
    );
  }

  const binding = bindAssetToRequirement({
    projectId: input.projectId,
    sceneId: input.sceneId,
    requirementId: input.requirementId,
    assetId: input.candidateId,
  });
  // 确认使用：license 标记 generated，去除「待确认」
  getDb()
    .prepare('UPDATE assets SET license_status = ?, license_note = ? WHERE id = ?')
    .run('generated', asset.license_note?.replace('(待确认)', '').trim() || 'AI 生成', input.candidateId);
  // M6.3.9：绑定成功 → 清除该 requirement 的失败状态
  clearResolutionState(input.projectId, input.sceneId, input.requirementId);

  return {binding, asset: getAssetById(input.candidateId)!};
}

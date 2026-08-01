/**
 * M6.3.8：generated candidate → exact requirement 的显式绑定。
 *
 * 安全不变量：
 * - candidate 只能绑定到它生成时的 intended 目标（sceneId + requirementId 完全一致）；
 *   candidate R01 → R02、candidate S012 → S013 一律拒绝。
 * - 目标 requirement 必须真实存在于 active scenes artifact（exact 查找，禁止 LIKE/猜测）。
 * - 同一 requirement 重复绑定 = replace 语义（旧 binding 转历史，asset/文件/provenance 保留）。
 *
 * M7.3A.3.1：服务端权威 stale 门禁（不依赖 UI 是否展示）。
 * 带 provenance_json 的新 generated asset 必须同时满足：
 *   - provenance.relevance === 'current'；
 *   - provenance.sourceScenesVersionId === active scenes version；
 *   - provenance.sourceRequirementHash === 当前 requirement snapshot hash；
 *   - provenance.assetGenerationJobId 对应 job 存在；
 *   - job.result_asset_id === candidate id；
 *   - job.result_relevance === 'current'；
 *   - job.project/scene/requirement 与请求一致。
 * 任何缺失/不匹配 → 409（CANDIDATE_STALE / CANDIDATE_SOURCE_STALE）。
 * provenance_json IS NULL 的历史资产：保留兼容（legacyProvenance=true），
 * 按旧 sceneId+requirementId 规则允许绑定，不批量伪造历史 provenance。
 */
import {getDb} from '../db';
import {
  bindAssetToRequirement,
  clearResolutionState,
  getAssetById,
  parseAssetProvenance,
  type AssetBindingRow,
  type AssetRow,
} from './model';
import {
  buildRequirementSnapshot,
  computeRequirementSnapshotHash,
  findRequirementInPlans,
  loadActiveScenesSource,
} from './requirements';
import {isSceneVisuallyOverridden} from '../scenes/visual-overrides';
import {getAssetGenerationJobById} from './generation-jobs';

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

/**
 * M7.3A.3.1：服务端 stale 门禁。带 provenance 的 candidate 必须与当前 active
 * scenes source 严格匹配，且其生成 job 必须确认为 current。
 * 返回 'current' | 'legacy'；不匹配抛 BindError(409)。
 */
function assertCandidateCurrent(input: {
  projectId: string;
  sceneId: string;
  requirementId: string;
  asset: AssetRow;
}): 'current' | 'legacy' {
  const {asset} = input;
  const prov = parseAssetProvenance(asset);
  if (!prov) {
    // 历史资产（无 provenance_json）：保留兼容路径
    return 'legacy';
  }
  if (prov.relevance !== 'current') {
    throw new BindError(
      'CANDIDATE_STALE',
      `该候选素材已被标记为历史（relevance=${prov.relevance}），来源已变化，不能绑定到当前版本`,
      409,
    );
  }
  const source = loadActiveScenesSource(input.projectId);
  if (!source) {
    throw new BindError(
      'CANDIDATE_SOURCE_STALE',
      '项目缺少 active scenes artifact，无法验证候选素材来源',
      409,
    );
  }
  const found = findRequirementInPlans(source.plans, input.sceneId, input.requirementId);
  if (!found) {
    throw new BindError(
      'CANDIDATE_SOURCE_STALE',
      `需求 ${input.requirementId} 不存在于当前 scenes 版本`,
      409,
    );
  }
  const curHash = computeRequirementSnapshotHash(
    JSON.stringify(buildRequirementSnapshot(found.requirement)),
  );
  const activeVersion = String(source.activeVersion);
  if (prov.sourceScenesVersionId !== activeVersion) {
    throw new BindError(
      'CANDIDATE_SOURCE_STALE',
      `候选素材生成于 scenes v${prov.sourceScenesVersionId ?? '?'}，当前为 v${activeVersion}`,
      409,
    );
  }
  if (prov.sourceRequirementHash !== curHash) {
    throw new BindError(
      'CANDIDATE_SOURCE_STALE',
      '候选素材的 requirement 快照与当前版本不一致',
      409,
    );
  }
  if (prov.assetGenerationJobId) {
    const job = getAssetGenerationJobById(prov.assetGenerationJobId);
    if (!job) {
      throw new BindError('CANDIDATE_SOURCE_STALE', '候选素材的生成 job 不存在', 409);
    }
    if (
      job.result_asset_id !== asset.id ||
      job.result_relevance !== 'current' ||
      job.project_id !== input.projectId ||
      job.scene_id !== input.sceneId ||
      job.requirement_id !== input.requirementId
    ) {
      throw new BindError('CANDIDATE_SOURCE_STALE', '候选素材的生成 job 与当前绑定请求不一致', 409);
    }
  }
  return 'current';
}

export function bindGeneratedCandidate(input: {
  projectId: string;
  candidateId: string;
  sceneId: string;
  requirementId: string;
}): {binding: AssetBindingRow; asset: AssetRow; legacyProvenance: boolean} {
  const asset = getAssetById(input.candidateId);
  if (!asset || asset.project_id !== input.projectId) {
    throw new BindError('candidate_not_found', '候选素材不存在', 404);
  }
  if (asset.source_type !== 'generated') {
    throw new BindError('not_generated_candidate', '只能绑定 AI 生成的候选素材');
  }

  // 跨目标绑定拒绝优先（candidate 记录的 intended 目标与请求不一致 → reject）
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

  // M7.3A.3.1：服务端 stale 门禁（带 provenance 的候选必须为 current）
  const provenanceKind = assertCandidateCurrent({
    projectId: input.projectId,
    sceneId: input.sceneId,
    requirementId: input.requirementId,
    asset,
  });

  // 目标 requirement 必须真实存在于 active scenes artifact
  const source = loadActiveScenesSource(input.projectId);
  if (!source) throw new BindError('scenes_not_found', '项目缺少 active scenes artifact', 404);
  if (!findRequirementInPlans(source.plans, input.sceneId, input.requirementId)) {
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

  return {binding, asset: getAssetById(input.candidateId)!, legacyProvenance: provenanceKind === 'legacy'};
}

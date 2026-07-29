/**
 * M6.3 Asset Resolver — 每个 scene 的素材解析状态与可用动作。
 *
 * 纯函数：输入 scenes + assets + active bindings → 输出 SceneAssetResolution[]。
 * 不修改 DB，不触发 provider。
 *
 * M6.3.8：READY 的唯一依据是 exact active binding
 * （projectId + sceneId + requirementId → assetId）。
 * 禁止 scene_id + 数组顺序猜测、禁止 asset 计数匹配、禁止依赖 DB 返回顺序。
 */
import type {AssetRequirement, IdentifiedRequirement, Scene} from '../scene-schema';
import {listActiveBindingsForProject, listAssetsForProject, type AssetBindingRow, type AssetRow} from './model';
import {buildSceneAssetPlan} from './requirements';
import type {
  AssetSearchCandidate,
  GeneratedCandidateInfo,
  RequirementResolution,
  ResolverAction,
  ResolutionStatus,
  SceneAssetResolution,
} from './resolver-types';

function statusForAsset(asset: AssetRow | null): ResolutionStatus {
  if (!asset) return 'pending';
  if (asset.license_status === 'usable' || asset.license_status === 'generated' || asset.license_status === 'user_provided') return 'ready';
  if (asset.license_status === 'review_required') return 'manual_required';
  return 'policy_blocked';
}

function friendlyStatus(status: ResolutionStatus, policy: string): string {
  switch (status) {
    case 'ready': return '已准备';
    case 'searching': return '搜索中…';
    case 'generating': return '生成中…';
    case 'pending': return '素材待准备';
    case 'no_result': return '未找到合适素材';
    case 'download_failed': return '素材下载失败，可以重试';
    case 'policy_blocked':
      return policy === 'generated' ? '该镜头适合使用 AI 生成素材' : '暂不可自动获取';
    case 'generation_failed': return 'AI 生成失败，可以重试';
    case 'manual_required': return '请上传或选择其他素材';
  }
}

function actionsFor(
  status: ResolutionStatus,
  policy: string,
  hasBoundAssets: boolean,
  hasCandidates: boolean,
): ResolverAction[] {
  const actions: ResolverAction[] = [];
  switch (status) {
    case 'ready':
      actions.push('replace');
      break;
    case 'pending':
    case 'no_result':
      if (policy === 'public_domain') actions.push('search');
      if (policy === 'generated') actions.push('generate');
      actions.push('upload');
      actions.push('switch_to_mg');
      break;
    case 'download_failed':
    case 'generation_failed':
      if (policy === 'public_domain') { actions.push('retry_download'); actions.push('search'); }
      if (policy === 'generated') actions.push('generate');
      actions.push('upload');
      actions.push('switch_to_mg');
      break;
    case 'policy_blocked':
      if (policy === 'generated') actions.push('generate');
      actions.push('upload');
      actions.push('switch_to_mg');
      break;
    case 'manual_required':
      actions.push('upload');
      actions.push('switch_to_mg');
      break;
  }
  if (hasCandidates) {
    actions.unshift('select_candidate');
  }
  return actions;
}

/** 读取 asset 快照中记录的 intended requirementId（generated candidate 的目标需求）。 */
function intendedRequirementId(asset: AssetRow): string | null {
  if (!asset.requirement_json) return null;
  try {
    const parsed = JSON.parse(asset.requirement_json) as {requirementId?: unknown};
    return typeof parsed.requirementId === 'string' && parsed.requirementId.length > 0
      ? parsed.requirementId
      : null;
  } catch {
    return null;
  }
}

function buildRequirementResolution(
  req: IdentifiedRequirement,
  index: number,
  boundAsset: AssetRow | null,
  generatedCandidates: GeneratedCandidateInfo[],
): RequirementResolution {
  const status = statusForAsset(boundAsset);
  return {
    requirementId: req.requirementId,
    index,
    requirement: req,
    status,
    boundAssetId: boundAsset?.id ?? null,
    boundAsset,
    queriesTried: req.query ? [req.query] : [],
    queryUsed: boundAsset ? req.query : null,
    candidates: [],
    generatedCandidates,
    availableActions: actionsFor(status, req.policy, boundAsset !== null, generatedCandidates.length > 0),
    friendlyStatus: friendlyStatus(status, req.policy),
  };
}

export function resolveSceneAssets(
  projectId: string,
  scene: Scene,
  assetRows: AssetRow[],
  activeBindings: AssetBindingRow[],
): SceneAssetResolution {
  const plan = buildSceneAssetPlan(scene);
  const bindingByReq = new Map(
    activeBindings.filter((b) => b.scene_id === scene.id).map((b) => [b.requirement_id, b]),
  );
  const assetById = new Map(assetRows.map((a) => [a.id, a]));
  const activelyBoundAssetIds = new Set(activeBindings.map((b) => b.asset_id));

  const requirements = plan.requirements.map((req, i) => {
    // exact binding：唯一 READY 依据
    const binding = bindingByReq.get(req.requirementId);
    const boundAsset = binding ? (assetById.get(binding.asset_id) ?? null) : null;
    // 未绑定 generated 候选：目标为本 requirement 且当前无 active binding
    const generatedCandidates: GeneratedCandidateInfo[] = assetRows
      .filter(
        (a) =>
          a.source_type === 'generated' &&
          !activelyBoundAssetIds.has(a.id) &&
          a.scene_id === scene.id &&
          intendedRequirementId(a) === req.requirementId,
      )
      .map((a) => ({
        assetId: a.id,
        publicPath: a.local_path,
        provider: a.source_provider,
        prompt: a.description ?? '',
        createdAt: a.created_at,
      }));
    return buildRequirementResolution(req, i, boundAsset, generatedCandidates);
  });

  const ready = requirements.filter((r) => r.status === 'ready').length;
  const overall: ResolutionStatus = ready === requirements.length ? 'ready'
    : requirements.some((r) => r.status === 'download_failed') ? 'download_failed'
    : requirements.some((r) => r.status === 'policy_blocked') ? 'policy_blocked'
    : requirements.some((r) => r.status === 'no_result') ? 'no_result'
    : 'pending';

  return {
    sceneId: scene.id,
    category: scene.category,
    totalRequired: requirements.length,
    ready,
    overallStatus: overall,
    requirements,
  };
}

/** 为整个项目计算所有 scenes 的解析状态 */
export function buildProjectResolution(projectId: string, scenes: Scene[]): SceneAssetResolution[] {
  const all = listAssetsForProject(projectId);
  const bindings = listActiveBindingsForProject(projectId);
  return scenes.map((s) => resolveSceneAssets(projectId, s, all, bindings));
}

/**
 * M6.3 Asset Resolver — 每个 scene 的素材解析状态与可用动作。
 *
 * 纯函数：输入 scenes + assets → 输出 SceneAssetResolution[]。
 * 不修改 DB，不触发 provider。
 */
import type {AssetRequirement, Scene} from '../scene-schema';
import {listAssetsForProject, type AssetRow} from './model';
import type {
  AssetSearchCandidate,
  RequirementResolution,
  ResolverAction,
  ResolutionStatus,
  SceneAssetResolution,
} from './resolver-types';

/** 分类：不属于 acquire 责任的 policy */
const HARD_BLOCKED_POLICIES = new Set(['generated', 'stock']);

function statusForAsset(asset: AssetRow | null): ResolutionStatus {
  if (!asset) return 'pending';
  if (asset.license_status === 'usable') return 'ready';
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

function buildRequirementResolution(
  req: AssetRequirement,
  index: number,
  boundAsset: AssetRow | null,
): RequirementResolution {
  const status = statusForAsset(boundAsset);
  const hasCandidates = false; // M6.3: candidates computed by acquire flow
  return {
    index,
    requirement: req,
    status,
    boundAssetId: boundAsset?.id ?? null,
    boundAsset,
    queriesTried: req.query ? [req.query] : [],
    queryUsed: boundAsset ? req.query : null,
    candidates: [],
    availableActions: actionsFor(status, req.policy, boundAsset !== null, hasCandidates),
    friendlyStatus: friendlyStatus(status, req.policy),
  };
}

export function resolveSceneAssets(
  projectId: string,
  scene: Scene,
  assetRows: AssetRow[],
): SceneAssetResolution {
  const all = assetRows.filter((a) => a.scene_id === scene.id && a.license_status === 'usable');
  const reqs: AssetRequirement[] = Array.isArray(scene.assetRequirements)
    ? scene.assetRequirements
    : [];
  const boundMap = new Map<string, AssetRow>();
  for (const a of all) {
    try {
      const reqJson = a.requirement_json ? (JSON.parse(a.requirement_json) as AssetRequirement) : null;
      if (reqJson) {
        const key = JSON.stringify(reqJson);
        if (!boundMap.has(key)) boundMap.set(key, a);
      }
    } catch { /* skip */ }
  }

  const requirements = reqs.map((req, i) => {
    const key = JSON.stringify(req);
    const bound = boundMap.get(key) ?? null;
    return buildRequirementResolution(req, i, bound);
  });

  const ready = requirements.filter((r) => r.status === 'ready').length;
  const overall: ResolutionStatus = ready === reqs.length ? 'ready'
    : requirements.some((r) => r.status === 'download_failed') ? 'download_failed'
    : requirements.some((r) => r.status === 'policy_blocked') ? 'policy_blocked'
    : requirements.some((r) => r.status === 'no_result') ? 'no_result'
    : 'pending';

  return {
    sceneId: scene.id,
    category: scene.category,
    totalRequired: reqs.length,
    ready,
    overallStatus: overall,
    requirements,
  };
}

/** 为整个项目计算所有 scenes 的解析状态 */
export function buildProjectResolution(projectId: string, scenes: Scene[]): SceneAssetResolution[] {
  const all = listAssetsForProject(projectId);
  return scenes.map((s) => resolveSceneAssets(projectId, s, all));
}

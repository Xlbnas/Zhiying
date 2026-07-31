/**
 * M6.3 Asset Resolver — 每个 scene 的素材解析状态与可用动作。
 *
 * 纯函数：输入 scenes + assets + active bindings + resolution states → 输出 SceneAssetResolution[]。
 * 不修改 DB，不触发 provider。
 *
 * M6.3.8：READY 的唯一依据是 exact active binding
 * （projectId + sceneId + requirementId → assetId）。
 * 禁止 scene_id + 数组顺序猜测、禁止 asset 计数匹配、禁止依赖 DB 返回顺序。
 *
 * M6.3.9：policy（来源/版权策略）与 authenticity（真实性要求）正交。
 * public_domain 只表示「优先搜索公共素材」，不再等于「禁止 AI 生成」；
 * AI fallback 由 authenticity（语义闸门）+ provider health（能力闸门）共同决定。
 */
import type {IdentifiedRequirement, RequirementAuthenticity, Scene} from '../scene-schema';
import {
  listActiveBindingsForProject,
  listAssetsForProject,
  listResolutionStatesForProject,
  type AssetBindingRow,
  type AssetResolutionStateRow,
  type AssetRow,
} from './model';
import {getLatestImageUsageForRequirement} from '@/lib/usage-events';
import {listAssetGenerationJobs} from './generation-jobs';
import {authenticityOf, buildSceneAssetPlan} from './requirements';
import {
  applyVisualOverrides,
  canSwitchToMg,
  currentScenesVersionId,
  listVisualOverrides,
  type MgSwitchEligibility,
} from '../scenes/visual-overrides';
import type {
  AssetSearchCandidate,
  GeneratedCandidateInfo,
  RequirementResolution,
  ResolverAction,
  ResolutionStatus,
  SceneAssetResolution,
} from './resolver-types';
import type {AssetGenerationJobRow} from './generation-jobs';

export interface GenerateEligibility {
  /** 语义上允许 AI 生成（authenticity 闸门，不含 provider health）。 */
  eligible: boolean;
  /** authentic_preferred：允许但应标注「AI生成替代」。 */
  secondary: boolean;
  /** 不可用时的解释（eligible=true 时为 null）。 */
  reason: string | null;
}

/**
 * M6.3.9：AI fallback 语义闸门（Phase 3）。
 * synthetic_allowed → 允许；authentic_preferred → 允许但为次级 fallback；
 * authentic_required → 默认禁止 AI 替代真实史料。
 */
export function canGenerateFallback(authenticity: RequirementAuthenticity): GenerateEligibility {
  switch (authenticity) {
    case 'synthetic_allowed':
      return {eligible: true, secondary: false, reason: null};
    case 'authentic_preferred':
      return {eligible: true, secondary: true, reason: null};
    case 'authentic_required':
      return {eligible: false, secondary: false, reason: '该镜头需要真实历史素材，不能用 AI 生成替代'};
  }
}

function statusForAsset(asset: AssetRow | null): ResolutionStatus | null {
  if (!asset) return null;
  if (asset.license_status === 'usable' || asset.license_status === 'generated' || asset.license_status === 'user_provided') return 'ready';
  if (asset.license_status === 'review_required') return 'manual_required';
  return 'policy_blocked';
}

/** M6.3.9：用户态状态文案（presentation mapping；内部状态保持技术 enum）。 */
function friendlyStatus(status: ResolutionStatus, policy: string): string {
  switch (status) {
    case 'ready': return '素材已准备';
    case 'searching': return '正在搜索…';
    case 'generating': return '正在生成…';
    case 'pending': return '等待准备';
    case 'no_result': return '自动搜索未找到合适素材';
    case 'download_failed': return '素材下载失败';
    case 'policy_blocked':
      return policy === 'generated' ? '建议使用 AI 生成' : '暂不可自动获取';
    case 'generation_failed': return 'AI 生成失败';
    case 'candidate_waiting': return 'AI 图片已生成，等待确认';
    case 'manual_required': return '请上传或选择其他素材';
  }
}

/**
 * M6.3.9：用户态说明 —— WHAT happened / WHY / WHAT next（一句话）。
 * 由 status × authenticity × policy 映射生成，不按 scene 硬编码。
 */
function statusHintFor(
  status: ResolutionStatus,
  policy: string,
  authenticity: RequirementAuthenticity,
  generateAvailable: boolean,
): string {
  switch (status) {
    case 'ready':
      return '';
    case 'candidate_waiting':
      return 'AI 图片已生成（尚未绑定，不影响就绪状态）。确认效果后点击「使用这张」。';
    case 'pending':
      return policy === 'generated'
        ? '这个镜头适合使用 AI 生成素材。'
        : '尚未开始准备。建议先自动搜索公共素材库，也可以直接上传图片。';
    case 'no_result':
      if (authenticity === 'authentic_required') {
        return '已尝试从公共素材库搜索，暂时没有找到符合要求的图片。该镜头需要真实历史素材，建议换关键词重新搜索或手动上传。';
      }
      if (authenticity === 'authentic_preferred') {
        return '已尝试从公共素材库搜索，暂时没有找到符合要求的图片。建议换关键词重新搜索或上传；也可以用 AI 生成替代。';
      }
      return generateAvailable
        ? '已尝试从公共素材库搜索，暂时没有找到符合要求的图片。这个镜头是构造型场景，可以直接使用 AI 生成。'
        : '已尝试从公共素材库搜索，暂时没有找到符合要求的图片。可以重新搜索或上传图片。';
    case 'download_failed':
      return '已找到候选图片，但下载没有成功。建议重新下载，或换关键词重新搜索。';
    case 'generation_failed':
      return 'AI 生成没有成功。可以调整画面描述后重试，或改用搜索 / 上传。';
    case 'policy_blocked':
      return policy === 'generated'
        ? '这个镜头适合使用 AI 生成素材。'
        : '当前没有可用的自动获取渠道，请上传图片。';
    case 'manual_required':
      return '候选素材的许可需要人工确认，请上传图片或选择其他素材。';
    case 'searching':
    case 'generating':
      return '';
  }
}

interface ActionDecision {
  actions: ResolverAction[];
  recommended: ResolverAction | null;
  generateDisabledReason: string | null;
}

/**
 * M6.3.9：动作决策 —— recommendedAction + availableActions（recommended 排首位）。
 * generate 出现的条件 = 语义 eligible（authenticity 闸门）AND provider 可用（能力闸门）。
 */
function decideActions(
  status: ResolutionStatus,
  policy: string,
  eligibility: GenerateEligibility,
  generateProviderAvailable: boolean,
  hasCandidates: boolean,
  mgSwitch: MgSwitchEligibility,
): ActionDecision {
  const generateAllowed = eligibility.eligible && generateProviderAvailable;
  // generate 不可用的原因：语义禁止优先，其次 provider 不可用（仅未就绪状态需要展示）
  const generateDisabledReason = eligibility.eligible
    ? (generateProviderAvailable ? null : 'AI 图像生成服务暂不可用')
    : eligibility.reason;

  const search: ResolverAction[] = policy === 'public_domain' ? ['search'] : [];
  const gen: ResolverAction[] = generateAllowed ? ['generate'] : [];
  const retry: ResolverAction[] = policy === 'public_domain' ? ['retry_download'] : [];

  let actions: ResolverAction[];
  let recommended: ResolverAction | null;
  switch (status) {
    case 'ready':
      actions = ['replace'];
      recommended = null;
      break;
    case 'pending':
      actions = [...search, ...gen, 'upload', 'switch_to_mg'];
      recommended = policy === 'generated'
        ? (generateAllowed ? 'generate' : 'upload')
        : (search.length > 0 ? 'search' : (generateAllowed ? 'generate' : 'upload'));
      break;
    case 'no_result':
      actions = [...search, ...gen, 'upload', 'switch_to_mg'];
      // 搜索失败 → 构造型场景 AI 成为合法 fallback 且优先推荐；
      // 真实优先/必需场景保持搜索优先（AI 缺位或仅作标注的次级 fallback）
      recommended = (eligibility.eligible && !eligibility.secondary && generateAllowed)
        ? 'generate'
        : (search.length > 0 ? 'search' : (generateAllowed ? 'generate' : 'upload'));
      break;
    case 'download_failed':
      actions = [...retry, ...search, ...gen, 'upload', 'switch_to_mg'];
      recommended = retry.length > 0 ? 'retry_download' : (generateAllowed ? 'generate' : 'upload');
      break;
    case 'generation_failed':
      actions = [...gen, ...search, 'upload', 'switch_to_mg'];
      recommended = generateAllowed ? 'generate' : (search.length > 0 ? 'search' : 'upload');
      break;
    case 'policy_blocked':
      actions = [...gen, ...search, 'upload', 'switch_to_mg'];
      recommended = (eligibility.eligible && !eligibility.secondary && generateAllowed)
        ? 'generate'
        : (search.length > 0 ? 'search' : (generateAllowed ? 'generate' : 'upload'));
      break;
    case 'candidate_waiting':
      actions = ['select_candidate', ...search, ...gen, 'upload', 'switch_to_mg'];
      recommended = 'select_candidate';
      break;
    case 'manual_required':
      actions = ['upload', 'switch_to_mg'];
      recommended = 'upload';
      break;
    case 'searching':
    case 'generating':
      actions = [];
      recommended = null;
      break;
  }
  // 未绑定候选始终提供「使用这张」（含 ready 后替换场景）；保证首位去重
  if (hasCandidates && !actions.includes('select_candidate')) {
    actions.unshift('select_candidate');
  }
  // M6.3.13：authentic_required（需要真实历史素材）→ 不暴露 switch_to_mg
  // （沿用 canGenerateFallback 模式：语义禁止的动作不出现在 availableActions）
  if (!mgSwitch.ok) {
    actions = actions.filter((a) => a !== 'switch_to_mg');
  }
  if (recommended && actions.includes(recommended)) {
    actions = [recommended, ...actions.filter((a) => a !== recommended)];
  }
  return {actions, recommended, generateDisabledReason};
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
  projectId: string,
  sceneId: string,
  category: string,
  req: IdentifiedRequirement,
  index: number,
  boundAsset: AssetRow | null,
  generatedCandidates: GeneratedCandidateInfo[],
  persisted: AssetResolutionStateRow | null,
  generateProviderAvailable: boolean,
  mgSwitch: MgSwitchEligibility,
  assetGenJob: AssetGenerationJobRow | null,
): RequirementResolution {
  // 状态合并优先级：exact binding → 未绑定 AI 候选 → running asset_generation_job →
  // 持久化失败状态 → pending
  const boundStatus = statusForAsset(boundAsset);
  const status: ResolutionStatus = boundStatus
    ?? (generatedCandidates.length > 0 ? 'candidate_waiting' : null)
    ?? (assetGenJob && (assetGenJob.status === 'queued' || assetGenJob.status === 'running') ? 'generating' : null)
    ?? persisted?.status
    ?? 'pending';
  const authenticity = authenticityOf(category, req);
  const eligibility = canGenerateFallback(authenticity);
  const decision = decideActions(status, req.policy, eligibility, generateProviderAvailable, generatedCandidates.length > 0, mgSwitch);
  let queriesTried: string[] = [];
  if (!boundStatus && persisted) {
    try { queriesTried = JSON.parse(persisted.queries_tried ?? '[]') as string[]; } catch { queriesTried = []; }
  }
  if (queriesTried.length === 0 && req.query) queriesTried = [req.query];
  const generateAvailable = eligibility.eligible && generateProviderAvailable;

  // M7：解析持久化失败元数据；缺失时从 usage event 兜底回填
  let failurePhase: string | null = null;
  let attemptId: string | null = null;
  let providerRequestId: string | null = null;
  let promptUsed: string | null = null;
  let providerName: string | null = null;
  let modelName: string | null = null;
  let elapsedMs: number | null = null;
  if (!boundStatus && persisted) {
    try {
      const meta = JSON.parse(persisted.metadata ?? '{}') as Record<string, unknown>;
      failurePhase = typeof meta.failurePhase === 'string' ? meta.failurePhase : null;
      attemptId = typeof meta.attemptId === 'string' ? meta.attemptId : null;
      providerRequestId = typeof meta.providerRequestId === 'string' ? meta.providerRequestId : null;
      promptUsed = typeof meta.prompt === 'string' ? meta.prompt : null;
      providerName = typeof meta.provider === 'string' ? meta.provider : null;
      modelName = typeof meta.model === 'string' ? meta.model : null;
      elapsedMs = typeof meta.elapsedMs === 'number' ? meta.elapsedMs : null;
    } catch {
      // 元数据损坏则忽略
    }
  }
  if (status === 'generation_failed' && (!attemptId || !failurePhase)) {
    const usage = getLatestImageUsageForRequirement(projectId, sceneId, req.requirementId);
    if (usage) {
      attemptId = attemptId ?? usage.id;
      providerName = providerName ?? usage.provider;
      modelName = modelName ?? usage.model;
      providerRequestId = providerRequestId ?? (typeof usage.metadata.providerRequestId === 'string' ? usage.metadata.providerRequestId : null);
      promptUsed = promptUsed ?? (typeof usage.metadata.prompt === 'string' ? usage.metadata.prompt : null);
      failurePhase = failurePhase ?? (typeof usage.metadata.failurePhase === 'string' ? usage.metadata.failurePhase : null);
    }
  }

  return {
    requirementId: req.requirementId,
    index,
    requirement: req,
    status,
    boundAssetId: boundAsset?.id ?? null,
    boundAsset,
    queriesTried,
    queryUsed: boundAsset ? req.query : null,
    candidates: [],
    generatedCandidates,
    availableActions: decision.actions,
    friendlyStatus: friendlyStatus(status, req.policy),
    authenticity,
    recommendedAction: decision.recommended,
    generateEligible: eligibility.eligible,
    generateSecondary: eligibility.secondary,
    generateDisabledReason: status === 'ready' ? null : decision.generateDisabledReason,
    failureReason: !boundStatus && persisted ? persisted.reason : null,
    failurePhase,
    attemptId,
    providerRequestId,
    promptUsed,
    provider: providerName,
    model: modelName,
    elapsedMs,
    statusHint: statusHintFor(status, req.policy, authenticity, generateAvailable),
    switchToMgEligible: mgSwitch.ok,
    switchToMgDisabledReason: mgSwitch.ok ? null : mgSwitch.reason,
  };
}

export interface ResolveSceneOptions {
  /** M6.3.9：持久化的解析尝试状态（展示层元数据）。 */
  resolutionStates?: AssetResolutionStateRow[];
  /** M6.3.9：AI 图像 provider 当前可用性（能力闸门；缺省 true 便于纯函数测试）。 */
  generateProviderAvailable?: boolean;
  /** M6.3.13：该 scene 生效中的「改用 MG」override（UI 徽标/改回入口用）。 */
  mgOverride?: {template: string} | null;
  /** M7.3A.2：该 scene 的 asset generation jobs（按 requirement 最新）。 */
  assetGenerationJobs?: AssetGenerationJobRow[];
}

export function resolveSceneAssets(
  projectId: string,
  scene: Scene,
  assetRows: AssetRow[],
  activeBindings: AssetBindingRow[],
  opts?: ResolveSceneOptions,
): SceneAssetResolution {
  const plan = buildSceneAssetPlan(scene);
  // M6.3.13：改用 MG 的语义闸门（authenticity）；MG override 后的 scene
  // requirements 为空，闸门对 requirement 行无影响
  const mgSwitch = canSwitchToMg(plan);
  const bindingByReq = new Map(
    activeBindings.filter((b) => b.scene_id === scene.id).map((b) => [b.requirement_id, b]),
  );
  const assetById = new Map(assetRows.map((a) => [a.id, a]));
  const activelyBoundAssetIds = new Set(activeBindings.map((b) => b.asset_id));
  const stateByReq = new Map(
    (opts?.resolutionStates ?? []).filter((s) => s.scene_id === scene.id).map((s) => [s.requirement_id, s]),
  );
  const jobByReq = new Map(
    (opts?.assetGenerationJobs ?? [])
      .filter((j) => j.scene_id === scene.id)
      .map((j) => [j.requirement_id, j]),
  );
  const generateProviderAvailable = opts?.generateProviderAvailable ?? true;

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
    return buildRequirementResolution(
      projectId,
      scene.id,
      plan.category,
      req,
      i,
      boundAsset,
      generatedCandidates,
      stateByReq.get(req.requirementId) ?? null,
      generateProviderAvailable,
      mgSwitch,
      jobByReq.get(req.requirementId) ?? null,
    );
  });

  const ready = requirements.filter((r) => r.status === 'ready').length;
  const overall: ResolutionStatus = ready === requirements.length ? 'ready'
    : requirements.some((r) => r.status === 'download_failed') ? 'download_failed'
    : requirements.some((r) => r.status === 'generation_failed') ? 'generation_failed'
    : requirements.some((r) => r.status === 'policy_blocked') ? 'policy_blocked'
    : requirements.some((r) => r.status === 'no_result') ? 'no_result'
    : requirements.some((r) => r.status === 'candidate_waiting') ? 'candidate_waiting'
    : 'pending';

  return {
    sceneId: scene.id,
    category: scene.category,
    totalRequired: requirements.length,
    ready,
    overallStatus: overall,
    requirements,
    mgOverride: opts?.mgOverride ?? null,
  };
}

/** 为整个项目计算所有 scenes 的解析状态 */
export function buildProjectResolution(
  projectId: string,
  scenes: Scene[],
  opts?: {generateProviderAvailable?: boolean; scenesVersionId?: string},
): SceneAssetResolution[] {
  const all = listAssetsForProject(projectId);
  const bindings = listActiveBindingsForProject(projectId);
  const states = listResolutionStatesForProject(projectId);
  const assetGenJobs = listAssetGenerationJobs(projectId);
  // M6.3.13：scene 级「改用 MG」override 在 scene 输入处生效；
  // version 漂移（重新生成/锁定新 scenes 版本）→ override 失效跳过
  const overrides = listVisualOverrides(projectId);
  const versionId = opts?.scenesVersionId ?? currentScenesVersionId(projectId);
  const effectiveScenes = applyVisualOverrides(scenes, overrides, versionId);
  const mgOverrideByScene = new Map(
    overrides
      .filter((o) => o.scenesVersionId === versionId)
      .map((o) => [o.sceneId, {template: o.template}]),
  );
  return effectiveScenes.map((s) =>
    resolveSceneAssets(projectId, s, all, bindings, {
      resolutionStates: states,
      generateProviderAvailable: opts?.generateProviderAvailable,
      mgOverride: mgOverrideByScene.get(s.id) ?? null,
      assetGenerationJobs: assetGenJobs,
    }),
  );
}

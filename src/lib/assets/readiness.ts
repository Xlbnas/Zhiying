/**
 * M6 Visual Readiness Gate（production Final Render fail-closed 的唯一判定来源）。
 *
 * 判定粒度：
 * - typography（Minimal / 无模板 Editorial Graphic）：narrationSummary 非空即可
 * - mg（MG / 带模板 Editorial Graphic）：template 已注册 + templateProps 合法
 * - asset（Archive / B-roll）：按 requirement 粒度判定（M6.3.8）——
 *   每个 requirement 必须有 exact active binding + asset license 可用 + 文件真实存在。
 *   禁止"scene 内有任意素材即 READY"或计数/顺序匹配。
 *
 * 同时构建 bridge 注入用的 assetMap（sceneId → ResolvedAsset[]，按 requirement 顺序）。
 *
 * M6.3.13：scene 级「改用 MG」override（scene_visual_overrides）在本模块入口
 * 统一应用——命中且未失效（scenes_version_id 匹配）的 scene 按 MG 判定，
 * 其 requirements 退出 readiness 分母。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {ResolvedAsset, Scene} from '../scene-schema';
import {MG_TEMPLATES, validateTemplateProps} from '../scenes/mg-templates';
import {
  listActiveBindingsForProject,
  listAssetsForProject,
  type AssetRow,
} from './model';
import {buildSceneAssetPlan, type SceneAssetPlan} from './requirements';
import {
  applyVisualOverrides,
  currentScenesVersionId,
  listVisualOverrides,
} from '../scenes/visual-overrides';

export interface SceneReadiness {
  sceneId: string;
  strategy: SceneAssetPlan['strategy'];
  ready: boolean;
  reason: string | null;
}

export interface VisualReadinessSummary {
  ready: boolean;
  /** 总场景数。 */
  total: number;
  /** 无需外部素材的场景数（Minimal / MG / Editorial Graphic）。 */
  noAssetNeeded: number;
  /** M6.3.8 requirement 粒度：需要外部素材的需求总数（≠ 场景数）。 */
  needAssets: number;
  /** 已通过 readiness 的总场景数。 */
  readyScenes: number;
  /** 需要外部素材且全部需求已就绪的场景数。 */
  readyAssetScenes: number;
  /** 已就绪素材需求数（exact binding + license + 文件存在）。 */
  readyRequirements: number;
  /** 未就绪素材需求数（needAssets - readyRequirements）。 */
  pendingAssets: number;
  missing: Array<{sceneId: string; requirementId: string | null; reason: string}>;
  scenes: SceneReadiness[];
}

const USABLE_LICENSES = new Set(['usable', 'user_provided', 'generated']);

function assetToResolved(asset: AssetRow): ResolvedAsset {
  return {
    assetId: asset.id,
    publicPath: asset.local_path,
    mediaType: asset.media_type,
    width: asset.width,
    height: asset.height,
    description: asset.description ?? '',
    attribution: asset.attribution ?? '',
    sourceUrl: asset.source_url ?? '',
  };
}

function assetFileExists(asset: AssetRow): boolean {
  return fs.existsSync(path.join(process.cwd(), 'public', asset.local_path));
}

function checkScene(
  projectId: string,
  scene: Scene,
  boundByReqKey: Map<string, AssetRow>,
): {readiness: SceneReadiness; failures: Array<{requirementId: string | null; reason: string}>; total: number; readyReqs: number} {
  const plan = buildSceneAssetPlan(scene);
  if (plan.strategy === 'typography') {
    const ok = scene.narrationSummary.trim().length > 0;
    return {
      readiness: {sceneId: scene.id, strategy: 'typography', ready: ok, reason: ok ? null : '缺少画面文字内容'},
      failures: ok ? [] : [{requirementId: null, reason: '缺少画面文字内容'}],
      total: 0,
      readyReqs: 0,
    };
  }
  if (plan.strategy === 'mg') {
    let reason: string | null = null;
    if (!scene.template) reason = '缺少模板';
    else if (!MG_TEMPLATES[scene.template]) reason = `模板未注册：${scene.template}`;
    else {
      const check = validateTemplateProps(scene.template, scene.templateProps);
      if (!check.ok) reason = check.message;
    }
    return {
      readiness: {sceneId: scene.id, strategy: 'mg', ready: reason === null, reason},
      failures: reason === null ? [] : [{requirementId: null, reason}],
      total: 0,
      readyReqs: 0,
    };
  }
  // asset strategy —— M6.3.8：per-requirement exact binding 判定
  const failures: Array<{requirementId: string | null; reason: string}> = [];
  let readyReqs = 0;
  for (const req of plan.requirements) {
    const bound = boundByReqKey.get(`${scene.id}:${req.requirementId}`);
    if (!bound) {
      failures.push({requirementId: req.requirementId, reason: '素材待准备'});
      continue;
    }
    if (!assetFileExists(bound)) {
      failures.push({requirementId: req.requirementId, reason: '素材文件缺失'});
      continue;
    }
    readyReqs += 1;
  }
  const ready = failures.length === 0;
  return {
    readiness: {
      sceneId: scene.id,
      strategy: 'asset',
      ready,
      reason: ready ? null : (failures[0]?.reason ?? '素材待准备'),
    },
    failures,
    total: plan.requirements.length,
    readyReqs,
  };
}

export interface VisualReadinessOptions {
  /**
   * M6.3.13：scenes 版本行 id（override 失效判定基准）。
   * 缺省时按 locked 优先/最新 fallback 推导（见 currentScenesVersionId）。
   */
  scenesVersionId?: string;
}

/** M6.3.13：scene 输入处应用生效中的「改用 MG」override（两个 gate 无需改）。 */
function withVisualOverrides(projectId: string, scenes: Scene[], opts?: VisualReadinessOptions): Scene[] {
  const overrides = listVisualOverrides(projectId);
  if (overrides.length === 0) return scenes;
  return applyVisualOverrides(scenes, overrides, opts?.scenesVersionId ?? currentScenesVersionId(projectId));
}

export function evaluateVisualReadiness(
  projectId: string,
  scenes: Scene[],
  opts?: VisualReadinessOptions,
): VisualReadinessSummary {
  scenes = withVisualOverrides(projectId, scenes, opts);
  const assetsById = new Map(listAssetsForProject(projectId).map((a) => [a.id, a]));
  // exact active binding 索引：`${sceneId}:${requirementId}` → asset（license 必须可用）
  const boundByReqKey = new Map<string, AssetRow>();
  for (const binding of listActiveBindingsForProject(projectId)) {
    const asset = assetsById.get(binding.asset_id);
    if (!asset || !USABLE_LICENSES.has(asset.license_status)) continue;
    boundByReqKey.set(`${binding.scene_id}:${binding.requirement_id}`, asset);
  }

  const checks = scenes.map((s) => checkScene(projectId, s, boundByReqKey));
  const plans = scenes.map(buildSceneAssetPlan);
  const needAssets = plans.reduce((sum, p) => sum + (p.needsAssets ? p.requirements.length : 0), 0);
  const readyRequirements = checks.reduce((sum, c) => sum + c.readyReqs, 0);
  const missing = checks.flatMap((c) =>
    c.failures.map((f) => ({sceneId: c.readiness.sceneId, requirementId: f.requirementId, reason: f.reason})),
  );
  return {
    ready: missing.length === 0,
    total: scenes.length,
    noAssetNeeded: plans.filter((p) => !p.needsAssets).length,
    needAssets,
    readyScenes: checks.filter((c) => c.readiness.ready).length,
    readyAssetScenes: checks.filter((c) => c.readiness.ready && c.readiness.strategy === 'asset').length,
    readyRequirements,
    pendingAssets: needAssets - readyRequirements,
    missing,
    scenes: checks.map((c) => c.readiness),
  };
}

/**
 * bridge 注入用：sceneId → ResolvedAsset[]。
 * 仅含 exact active binding + license 可用 + 文件存在的素材，
 * 按 requirement 在 scene 中的顺序排列（renderer 取 assets[0] = 首个需求）。
 */
export function buildAssetMap(
  projectId: string,
  scenes: Scene[],
  opts?: VisualReadinessOptions,
): Record<string, ResolvedAsset[]> {
  scenes = withVisualOverrides(projectId, scenes, opts);
  const assetsById = new Map(listAssetsForProject(projectId).map((a) => [a.id, a]));
  const orderByReqKey = new Map<string, number>();
  for (const scene of scenes) {
    const plan = buildSceneAssetPlan(scene);
    plan.requirements.forEach((req, i) => {
      orderByReqKey.set(`${plan.sceneId}:${req.requirementId}`, i);
    });
  }
  const entries: Array<{sceneId: string; order: number; asset: AssetRow}> = [];
  for (const binding of listActiveBindingsForProject(projectId)) {
    const asset = assetsById.get(binding.asset_id);
    if (!asset || !USABLE_LICENSES.has(asset.license_status)) continue;
    if (!assetFileExists(asset)) continue;
    const order = orderByReqKey.get(`${binding.scene_id}:${binding.requirement_id}`) ?? Number.MAX_SAFE_INTEGER;
    entries.push({sceneId: binding.scene_id, order, asset});
  }
  entries.sort((a, b) => a.order - b.order);
  const map: Record<string, ResolvedAsset[]> = {};
  for (const entry of entries) {
    (map[entry.sceneId] ??= []).push(assetToResolved(entry.asset));
  }
  return map;
}

/** M6 renderer 静态黑名单（production 渲染输出禁止出现的 M1 demo 文案）。 */
export const DEMO_STRING_BLACKLIST = [
  '我们谈谈吧',
  '未回复',
  '2 天前',
  '意图：我要做',
  'EVERYDAY CONTEXT',
  'CURRENT THOUGHT',
  'ARCHIVAL RECONSTRUCTION',
  'SOURCE-BOUND',
  'INTERPRETATION',
  '[MG PLACEHOLDER]',
  '[ARCHIVE PLACEHOLDER]',
  '[B-ROLL / TEXT PLACEHOLDER]',
] as const;

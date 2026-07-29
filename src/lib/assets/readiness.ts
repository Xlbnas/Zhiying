/**
 * M6 Visual Readiness Gate（production Final Render fail-closed 的唯一判定来源）。
 *
 * 判定粒度到 scene：
 * - typography（Minimal / 无模板 Editorial Graphic）：narrationSummary 非空即可
 * - mg（MG / 带模板 Editorial Graphic）：template 已注册 + templateProps 合法
 * - asset（Archive / B-roll）：绑定 usable asset + 文件真实存在 + 许可可用
 *
 * 同时构建 bridge 注入用的 assetMap（sceneId → ResolvedAsset[]）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {ResolvedAsset, Scene} from '../scene-schema';
import {MG_TEMPLATES, validateTemplateProps} from '../scenes/mg-templates';
import {listAssetsForProject, listUsableAssetsForScene, type AssetRow} from './model';
import {buildSceneAssetPlan, type SceneAssetPlan} from './requirements';

export interface SceneReadiness {
  sceneId: string;
  strategy: SceneAssetPlan['strategy'];
  ready: boolean;
  reason: string | null;
}

export interface VisualReadinessSummary {
  ready: boolean;
  total: number;
  /** 无需外部素材的场景数（Minimal / MG / Editorial Graphic）。 */
  noAssetNeeded: number;
  /** 需要外部素材的场景数（Archive / B-roll）。 */
  needAssets: number;
  /** 已通过 readiness 的总场景数。 */
  readyScenes: number;
  /** 需要外部素材且已准备好（已绑定 usable asset + 文件存在）的场景数。 */
  readyAssetScenes: number;
  /** 需要外部素材但尚未准备的场景数（needAssets - readyAssetScenes）。 */
  pendingAssets: number;
  missing: Array<{sceneId: string; reason: string}>;
  scenes: SceneReadiness[];
}

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

function checkScene(
  projectId: string,
  scene: Scene,
  usableByScene: Map<string, AssetRow[]>,
): SceneReadiness {
  const plan = buildSceneAssetPlan(scene);
  if (plan.strategy === 'typography') {
    return scene.narrationSummary.trim().length > 0
      ? {sceneId: scene.id, strategy: 'typography', ready: true, reason: null}
      : {sceneId: scene.id, strategy: 'typography', ready: false, reason: '缺少画面文字内容'};
  }
  if (plan.strategy === 'mg') {
    if (!scene.template) {
      return {sceneId: scene.id, strategy: 'mg', ready: false, reason: '缺少模板'};
    }
    if (!MG_TEMPLATES[scene.template]) {
      return {sceneId: scene.id, strategy: 'mg', ready: false, reason: `模板未注册：${scene.template}`};
    }
    const check = validateTemplateProps(scene.template, scene.templateProps);
    return check.ok
      ? {sceneId: scene.id, strategy: 'mg', ready: true, reason: null}
      : {sceneId: scene.id, strategy: 'mg', ready: false, reason: check.message};
  }
  // asset strategy
  const bound = usableByScene.get(scene.id) ?? [];
  if (bound.length === 0) {
    return {sceneId: scene.id, strategy: 'asset', ready: false, reason: '素材待准备'};
  }
  const missing = bound.find((a) => !fs.existsSync(path.join(process.cwd(), 'public', a.local_path)));
  if (missing) {
    return {sceneId: scene.id, strategy: 'asset', ready: false, reason: '素材文件缺失'};
  }
  return {sceneId: scene.id, strategy: 'asset', ready: true, reason: null};
}

export function evaluateVisualReadiness(projectId: string, scenes: Scene[]): VisualReadinessSummary {
  const all = listAssetsForProject(projectId);
  const usableByScene = new Map<string, AssetRow[]>();
  for (const asset of all) {
    if (asset.license_status !== 'usable' || !asset.scene_id) continue;
    const list = usableByScene.get(asset.scene_id) ?? [];
    list.push(asset);
    usableByScene.set(asset.scene_id, list);
  }
  const scenes_ = scenes.map((s) => checkScene(projectId, s, usableByScene));
  const plans = scenes.map(buildSceneAssetPlan);
  const needAssets = plans.filter((p) => p.needsAssets).length;
  const readyAssetScenes = scenes_.filter((s) => s.ready && s.strategy === 'asset').length;
  const missing = scenes_.filter((s) => !s.ready).map((s) => ({sceneId: s.sceneId, reason: s.reason ?? '未知原因'}));
  return {
    ready: missing.length === 0,
    total: scenes.length,
    noAssetNeeded: scenes.length - needAssets,
    needAssets,
    readyScenes: scenes_.filter((s) => s.ready).length,
    readyAssetScenes,
    pendingAssets: needAssets - readyAssetScenes,
    missing,
    scenes: scenes_,
  };
}

/** bridge 注入用：sceneId → ResolvedAsset[]（仅 usable + 文件存在的绑定）。 */
export function buildAssetMap(projectId: string): Record<string, ResolvedAsset[]> {
  const map: Record<string, ResolvedAsset[]> = {};
  for (const asset of listAssetsForProject(projectId)) {
    if (asset.license_status !== 'usable' || !asset.scene_id) continue;
    if (!fs.existsSync(path.join(process.cwd(), 'public', asset.local_path))) continue;
    const list = map[asset.scene_id] ?? [];
    list.push(assetToResolved(asset));
    map[asset.scene_id] = list;
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

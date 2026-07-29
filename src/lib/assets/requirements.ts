/**
 * M6 Asset Requirement Compiler。
 *
 * 输入：locked scenes artifact（含 M6 assetRequirements 字段）。
 * 原则：scene 归属由程序保证（不从 LLM 猜）；LLM 只提供 query/subject 语义。
 * - category = Archive / B-roll：必须有素材需求（LLM 给出；缺失时程序用
 *   description 合成保底 query，policy 默认 public_domain）
 * - category = Minimal / MG / Editorial Graphic：无需外部素材
 */

import {scenesAiOutputSchema} from '../prompts/scenes';
import type {AssetRequirement, Scene} from '../scene-schema';

export interface SceneAssetPlan {
  sceneId: string;
  category: string;
  needsAssets: boolean;
  requirements: AssetRequirement[];
  /** MG 场景：渲染所需 template（用于 readiness 的 templateProps 检查）。 */
  mgTemplate: string | null;
  strategy: 'typography' | 'mg' | 'asset';
}

const ASSET_CATEGORIES = new Set(['Archive', 'B-roll']);

/** deterministic 保底 query：LLM 未给 assetRequirements 时用 description 合成。 */
function synthesizeRequirement(scene: Scene): AssetRequirement {
  const subject = scene.description.trim().replace(/\s+/g, ' ').slice(0, 60) || scene.chapterTitle;
  return {
    kind: 'image',
    subject,
    query: subject,
    usage: 'primary',
    policy: 'public_domain',
  };
}

export function buildSceneAssetPlan(scene: Scene): SceneAssetPlan {
  if (scene.category === 'MG') {
    return {
      sceneId: scene.id,
      category: scene.category,
      needsAssets: false,
      requirements: [],
      mgTemplate: scene.template,
      strategy: 'mg',
    };
  }
  if (scene.category === 'Editorial Graphic') {
    // M6：Editorial Graphic 优先走模板（template+templateProps），无模板时用排版卡
    return {
      sceneId: scene.id,
      category: scene.category,
      needsAssets: false,
      requirements: [],
      mgTemplate: scene.template,
      strategy: scene.template ? 'mg' : 'typography',
    };
  }
  if (scene.category === 'Minimal') {
    return {
      sceneId: scene.id,
      category: scene.category,
      needsAssets: false,
      requirements: [],
      mgTemplate: null,
      strategy: 'typography',
    };
  }
  if (ASSET_CATEGORIES.has(scene.category)) {
    const assetReqs = Array.isArray(scene.assetRequirements) ? scene.assetRequirements : [];
    const requirements = assetReqs.length > 0
      ? assetReqs
      : [synthesizeRequirement(scene)];
    return {
      sceneId: scene.id,
      category: scene.category,
      needsAssets: true,
      requirements,
      mgTemplate: null,
      strategy: 'asset',
    };
  }
  // 未知 category 不应发生（语义校验已拦截），保守按 typography 处理
  return {
    sceneId: scene.id,
    category: scene.category,
    needsAssets: false,
    requirements: [],
    mgTemplate: null,
    strategy: 'typography',
  };
}

/** 解析 locked scenes artifact 内容为全部场景的素材计划。 */
export function compileAssetPlans(scenesJson: string): SceneAssetPlan[] {
  const parsed = scenesAiOutputSchema.parse(JSON.parse(scenesJson));
  return parsed.scenes.map(buildSceneAssetPlan);
}

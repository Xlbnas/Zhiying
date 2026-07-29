/**
 * M6 Asset Requirement Compiler。
 *
 * 输入：locked scenes artifact（含 M6 assetRequirements 字段）。
 * 原则：scene 归属由程序保证（不从 LLM 猜）；LLM 只提供 query/subject 语义。
 * - category = Archive / B-roll：必须有素材需求（LLM 给出；缺失时程序用
 *   description 合成保底 query，policy 默认 public_domain）
 * - category = Minimal / MG / Editorial Graphic：无需外部素材
 *
 * M6.3.8：plan 中的每个 requirement 都携带稳定 requirementId
 * （显式值优先，缺失时按 sceneId + 数组序号 deterministic 推导），
 * 后续 acquire / resolver / readiness / binding 一律以此 id 为身份。
 */

import {getDb} from '../db';
import {scenesAiOutputSchema} from '../prompts/scenes';
import {
  requirementIdOf,
  type AssetRequirement,
  type IdentifiedRequirement,
  type Scene,
} from '../scene-schema';

export interface SceneAssetPlan {
  sceneId: string;
  category: string;
  needsAssets: boolean;
  requirements: IdentifiedRequirement[];
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

/** 为 scene 的 requirement 挂上稳定 id（显式优先，缺失 deterministic 推导）。 */
function identify(sceneId: string, req: AssetRequirement, index: number): IdentifiedRequirement {
  return {...req, requirementId: requirementIdOf(sceneId, req, index)};
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
      ? assetReqs.map((r, i) => identify(scene.id, r, i))
      : [identify(scene.id, synthesizeRequirement(scene), 0)];
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

/** 加载项目最新 scenes artifact 并编译素材计划；无 artifact 返回 null。 */
export function loadLatestScenesPlans(projectId: string): SceneAssetPlan[] | null {
  const row = getDb()
    .prepare(
      `SELECT content FROM project_versions
       WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
    )
    .get(projectId) as {content: string} | undefined;
  if (!row?.content) return null;
  return compileAssetPlans(row.content);
}

/**
 * 在 scenes artifact 中精确定位一个 requirement（exact sceneId + requirementId）。
 * 找不到返回 null —— 调用方必须拒绝（禁止回退到位置/猜测匹配）。
 */
export function findRequirementInPlans(
  plans: SceneAssetPlan[],
  sceneId: string,
  requirementId: string,
): {plan: SceneAssetPlan; requirement: IdentifiedRequirement} | null {
  const plan = plans.find((p) => p.sceneId === sceneId);
  if (!plan) return null;
  const requirement = plan.requirements.find((r) => r.requirementId === requirementId);
  return requirement ? {plan, requirement} : null;
}

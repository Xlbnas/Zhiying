/**
 * M6.3.8：legacy asset → exact requirement binding 迁移。
 *
 * 规则（correctness 优先，允许 READY 数下降）：
 * - `requirement_json` 与 scene 某 requirement 的 5 个语义字段深度相等
 *   → bind_exact（ Wikimedia 等真实获取路径的快照是可靠证据）；
 * - scene 仅有 1 个 requirement
 *   → bind_single（用户当时操作语境唯一，无 sibling 可混淆）；
 * - 其余（多 requirement 且无精确快照证据）
 *   → ambiguous_unbound：保持 pending，禁止 sequential_guess 永久迁移。
 *
 * 幂等：已存在 binding（含历史 inactive）引用该 asset 时跳过。
 */
import type {AssetRequirement} from '../scene-schema';
import {
  bindAssetToRequirement,
  listBindingsForProject,
  type AssetRow,
} from './model';
import {compileAssetPlans, type SceneAssetPlan} from './requirements';

export type MigrationAction =
  | 'bind_exact'
  | 'bind_single'
  | 'ambiguous_unbound'
  | 'skip_already_bound'
  | 'skip_no_scene'
  | 'skip_unbound_candidate';

export interface MigrationDecision {
  assetId: string;
  sceneId: string | null;
  action: MigrationAction;
  requirementId: string | null;
  reason: string;
}

const SNAPSHOT_KEYS = ['kind', 'subject', 'query', 'usage', 'policy'] as const;

function parseSnapshot(json: string | null): Partial<AssetRequirement> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<AssetRequirement>)
      : null;
  } catch {
    return null;
  }
}

/** 快照与 requirement 的语义内容相等（忽略 requirementId）。 */
function snapshotEqualsRequirement(
  snapshot: Partial<AssetRequirement>,
  req: AssetRequirement,
): boolean {
  return SNAPSHOT_KEYS.every((k) => snapshot[k] === req[k]);
}

/**
 * 计算一个项目所有 legacy asset 的迁移决策（纯函数，不写 DB）。
 * plans 由调用方从 active scenes artifact 编译（保证版本权威）。
 */
export function planBindingMigration(
  projectId: string,
  plans: SceneAssetPlan[],
  assets: AssetRow[],
  existingBindings: Array<{asset_id: string}>,
): MigrationDecision[] {
  const boundAssetIds = new Set(existingBindings.map((b) => b.asset_id));
  const planByScene = new Map(plans.map((p) => [p.sceneId, p]));
  const decisions: MigrationDecision[] = [];

  for (const asset of assets) {
    if (boundAssetIds.has(asset.id)) {
      decisions.push({
        assetId: asset.id, sceneId: asset.scene_id,
        action: 'skip_already_bound', requirementId: null,
        reason: '已存在 binding（幂等跳过）',
      });
      continue;
    }
    if (!asset.scene_id) {
      decisions.push({
        assetId: asset.id, sceneId: null,
        action: 'skip_unbound_candidate', requirementId: null,
        reason: '无 scene 归属的候选素材（candidate-first 契约下保持未绑定）',
      });
      continue;
    }
    const plan = planByScene.get(asset.scene_id);
    if (!plan) {
      decisions.push({
        assetId: asset.id, sceneId: asset.scene_id,
        action: 'skip_no_scene', requirementId: null,
        reason: `场景 ${asset.scene_id} 不在 active scenes artifact 中`,
      });
      continue;
    }
    const reqs = plan.requirements;
    const snapshot = parseSnapshot(asset.requirement_json);
    const exactMatches = snapshot
      ? reqs.filter((r) => snapshotEqualsRequirement(snapshot, r))
      : [];
    if (exactMatches.length === 1) {
      decisions.push({
        assetId: asset.id, sceneId: asset.scene_id,
        action: 'bind_exact', requirementId: exactMatches[0]!.requirementId,
        reason: 'requirement_json 快照与需求语义精确一致',
      });
      continue;
    }
    if (exactMatches.length > 1) {
      decisions.push({
        assetId: asset.id, sceneId: asset.scene_id,
        action: 'ambiguous_unbound', requirementId: null,
        reason: `快照同时匹配 ${exactMatches.length} 个内容相同的需求，无法唯一确定`,
      });
      continue;
    }
    if (reqs.length === 1) {
      decisions.push({
        assetId: asset.id, sceneId: asset.scene_id,
        action: 'bind_single', requirementId: reqs[0]!.requirementId,
        reason: '场景仅有 1 个需求，用户操作语境唯一',
      });
      continue;
    }
    decisions.push({
      assetId: asset.id, sceneId: asset.scene_id,
      action: 'ambiguous_unbound', requirementId: null,
      reason: `场景有 ${reqs.length} 个需求且无精确快照证据，禁止顺序猜测`,
    });
  }
  return decisions;
}

/** 应用迁移决策（bind_exact / bind_single 写入 active binding）。返回实际写入数。 */
export function applyBindingMigration(projectId: string, decisions: MigrationDecision[]): number {
  let applied = 0;
  for (const d of decisions) {
    if ((d.action === 'bind_exact' || d.action === 'bind_single') && d.sceneId && d.requirementId) {
      bindAssetToRequirement({
        projectId,
        sceneId: d.sceneId,
        requirementId: d.requirementId,
        assetId: d.assetId,
      });
      applied += 1;
    }
  }
  return applied;
}

/** 便于脚本/测试：从 scenes artifact JSON 直接编译 plans。 */
export function plansFromScenesJson(scenesJson: string): SceneAssetPlan[] {
  return compileAssetPlans(scenesJson);
}

/** 项目全部已有 binding（含 inactive），供幂等判断。 */
export function existingBindingsFor(projectId: string): Array<{asset_id: string}> {
  return listBindingsForProject(projectId);
}

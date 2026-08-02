/**
 * M7 candidate 链 DAG（M7.3B §九）——纯图部分，零 DB 依赖。
 *
 * 节点与边（规格精确）：
 *   narrative_beats ─┐
 *                     ├─ visual_sequences
 *   visual_intent ────┘
 *
 *   visual_sequences ─┐
 *   narrative_beats ──┤
 *   visual_intent ────┼─ shots
 *   narration_plan_v2 ┘
 *
 * 约束（本模块结构保证 + readiness 层验证）：
 * - 无反向边（shots 不在任何节点的依赖里；Beats 不依赖 Sequence；
 *   Visual Intent 不依赖 Sequence；Shots 不得成为 Visual Sequence source）；
 * - 无环（detectM7DagCycles 断言）。
 *
 * 与 M6 WORKFLOW_NODES（src/lib/workflow/dag-shared.ts）完全无关：
 * M7 candidate 链是旁路 DAG，不进入 M6 状态机，不读写 project_stages。
 */

export type M7DagNodeId =
  | 'narration_plan_v2'
  | 'narrative_beats'
  | 'visual_intent_plan'
  | 'visual_sequences'
  | 'shots';

export interface M7DagNodeDef {
  id: M7DagNodeId;
  /** 中文 label（UI/日志直显）。 */
  label: string;
  dependencies: M7DagNodeId[];
}

export const M7_DAG_NODES: readonly M7DagNodeDef[] = [
  {id: 'narration_plan_v2', label: '旁白计划 V2', dependencies: []},
  {id: 'narrative_beats', label: '叙事节拍', dependencies: []},
  {id: 'visual_intent_plan', label: '视觉意图', dependencies: []},
  {
    id: 'visual_sequences',
    label: '视觉序列',
    dependencies: ['narrative_beats', 'visual_intent_plan'],
  },
  {
    id: 'shots',
    label: '镜头',
    dependencies: ['visual_sequences', 'narrative_beats', 'visual_intent_plan', 'narration_plan_v2'],
  },
];

const NODE_BY_ID = new Map(M7_DAG_NODES.map((node) => [node.id, node]));

export function getM7DagNodeDef(nodeId: string): M7DagNodeDef | undefined {
  return NODE_BY_ID.get(nodeId as M7DagNodeId);
}

/** 拓扑顺序（依赖先于依赖者；readiness 计算按此序）。 */
export const M7_DAG_TOPOLOGICAL_ORDER: readonly M7DagNodeId[] = [
  'narration_plan_v2',
  'narrative_beats',
  'visual_intent_plan',
  'visual_sequences',
  'shots',
];

/**
 * 环检测（deterministic DFS）：返回第一个发现的环（节点序列），无环返回 null。
 * 任何节点都不应出现在自己的传递依赖集合中。
 */
export function detectM7DagCycles(): M7DagNodeId[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<M7DagNodeId, number>();
  const stack: M7DagNodeId[] = [];

  const visit = (id: M7DagNodeId): M7DagNodeId[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    const def = NODE_BY_ID.get(id);
    for (const dep of def?.dependencies ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const cycleStart = stack.indexOf(dep);
        return [...stack.slice(cycleStart), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const node of M7_DAG_TOPOLOGICAL_ORDER) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

/** 反向边检查：下游不得被上游引用（shots 不得出现在任何依赖中；visual_sequences 只允许被 shots 依赖）。 */
export function detectM7DagReverseEdges(): {from: M7DagNodeId; to: M7DagNodeId}[] {
  const violations: {from: M7DagNodeId; to: M7DagNodeId}[] = [];
  for (const node of M7_DAG_NODES) {
    for (const dep of node.dependencies) {
      if (dep === 'shots' || (dep === 'visual_sequences' && node.id !== 'shots')) {
        violations.push({from: node.id, to: dep});
      }
    }
  }
  return violations;
}

/** 下游节点集合（BFS，按拓扑序）。 */
export function m7DownstreamOf(nodeId: M7DagNodeId): M7DagNodeId[] {
  const seen = new Set<M7DagNodeId>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const node of M7_DAG_NODES) {
      if (node.dependencies.includes(cur) && !seen.has(node.id)) {
        seen.add(node.id);
        queue.push(node.id);
      }
    }
  }
  return M7_DAG_TOPOLOGICAL_ORDER.filter((id) => seen.has(id));
}

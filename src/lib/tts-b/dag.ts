/**
 * TTS-B DAG node states（设计文档 §8；TTS-B.R1：narration_plan_v2 双依赖）。
 *
 * TTS-B graph（独立于 M7.3B frozen `m7-dag/dag.ts`）：
 *
 *   narration_plan_v2 ──────────┐
 *                              ├→ narration_performance_plan
 *   project_voice_assignment ──┘
 *
 * 节点：narration_plan_v2、project_voice_assignment、narration_performance_plan。
 * 状态：not_generated | generation_running | generation_failed | ready |
 *       needs_review | blocked | stale_source | invalid_source。
 *
 * Performance 依赖 usable 规则：
 * - Narration Plan：eligible_candidate → usable；needs_review/stale/invalid/
 *   missing/script_not_locked → unusable；
 * - Assignment：current_candidate → usable；stale/invalid/missing → unusable。
 *
 * 兼容边界（M7.3B §7.6）：TTS-B 变化**不** stale Narrative Beats / Visual Intent /
 * Sequence / Shot；本模块只读，不写任何指针，不形成反向边、不形成 cycle。
 */
import {getDb} from '../db';
import {listNarrationPlanV2Candidates} from '../narration/plan-v2';
import {PERFORMANCE_USAGE_STAGE} from './constants';
import {listProjectVoiceAssignmentCandidates} from './assignment';
import {listNarrationPerformancePlanCandidates} from './performance';

export type TtsBDagNodeId =
  | 'narration_plan_v2'
  | 'project_voice_assignment'
  | 'narration_performance_plan';

export interface TtsBDagNodeDef {
  id: TtsBDagNodeId;
  label: string;
  dependencies: TtsBDagNodeId[];
}

/** TTS-B graph 定义（narration + assignment 双依赖，无反向边）。 */
// ── TTS-B graph 定义（单一真相源：nodes.dependencies） ──
// edges / topological order 由 nodes.dependencies 派生，禁止维护三份互不验证的手写真相源。

export const TTS_B_DAG_NODES: readonly TtsBDagNodeDef[] = [
  {id: 'narration_plan_v2', label: '旁白计划 V2', dependencies: []},
  {id: 'project_voice_assignment', label: '项目声音指定', dependencies: []},
  {
    id: 'narration_performance_plan',
    label: '旁白表演计划',
    dependencies: ['narration_plan_v2', 'project_voice_assignment'],
  },
];

export interface TtsBDagEdge {
  from: TtsBDagNodeId;
  to: TtsBDagNodeId;
}

/** 从 nodes.dependencies 派生 edges（单一真相源）。 */
export function deriveTtsBDagEdges(nodes: readonly TtsBDagNodeDef[]): TtsBDagEdge[] {
  const edges: TtsBDagEdge[] = [];
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      edges.push({from: dep, to: n.id});
    }
  }
  return edges;
}

export const TTS_B_DAG_EDGES: readonly TtsBDagEdge[] = deriveTtsBDagEdges(TTS_B_DAG_NODES);

/**
 * 从 nodes.dependencies 派生 topological order（Kahn 算法；含环 → null）。
 * 派生结果必须与 edges 语义一致，不再手写第三份真相源。
 */
export function deriveTtsBDagTopologicalOrder(
  nodes: readonly TtsBDagNodeDef[],
): TtsBDagNodeId[] | null {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    indegree.set(n.id, 0);
    dependents.set(n.id, []);
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!ids.has(dep)) continue; // endpoint validation 另行报告
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), n.id]);
    }
  }
  const queue: string[] = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: TtsBDagNodeId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id as TtsBDagNodeId);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length !== nodes.length) return null; // 有环
  return order as TtsBDagNodeId[];
}

export const TTS_B_DAG_TOPOLOGICAL_ORDER: readonly TtsBDagNodeId[] = (() => {
  const order = deriveTtsBDagTopologicalOrder(TTS_B_DAG_NODES);
  if (!order) throw new Error('TTS-B graph 含环——canonical graph 必须无环');
  return order;
})();

/** 结构校验：node ID 唯一、每条 dependency 端点必须存在、edge 不重复。返回 issue 列表（空 = 合法）。 */
export function validateTtsBDag(nodes: readonly TtsBDagNodeDef[]): string[] {
  const issues: string[] = [];
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  if (new Set(ids).size !== ids.length) issues.push('node id 重复');
  const edgeSet = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!idSet.has(dep)) {
        issues.push(`未知端点 ${dep} → ${n.id}（dependency 端点不存在）`);
      }
      const key = `${dep}|${n.id}`;
      if (edgeSet.has(key)) issues.push(`重复 edge ${key}`);
      edgeSet.add(key);
    }
  }
  return issues;
}

/** DFS 三色环检测（参数化 graph，便于故障注入；无环 → null）。 */
export function detectTtsBDagCycles(
  nodes: readonly TtsBDagNodeDef[] = TTS_B_DAG_NODES,
): TtsBDagNodeId[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    color.set(n.id, WHITE);
    adj.set(n.id, n.dependencies);
  }
  const stack: string[] = [];
  const dfs = (node: string): TtsBDagNodeId[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of adj.get(node) ?? []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        return [...stack.slice(start), dep] as TtsBDagNodeId[];
      }
      if (c === WHITE) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };
  for (const n of nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) {
      const cycle = dfs(n.id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * 反向边检测（参数化 graph + topological order，便于故障注入）：
 * 根据规定的 topological order，edge (from → to) 若 from 排在 to 之后
 * （即下游依赖上游），即为反向边。合法双依赖 graph 无反向边。
 */
export function detectTtsBDagReverseEdges(
  nodes: readonly TtsBDagNodeDef[] = TTS_B_DAG_NODES,
  order: readonly TtsBDagNodeId[] = TTS_B_DAG_TOPOLOGICAL_ORDER,
): TtsBDagEdge[] {
  const index = new Map<string, number>();
  order.forEach((id, i) => index.set(id, i));
  const out: TtsBDagEdge[] = [];
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      const fromIdx = index.get(dep);
      const toIdx = index.get(n.id);
      if (fromIdx === undefined || toIdx === undefined) continue; // 端点校验另行报告
      if (toIdx < fromIdx) {
        out.push({from: dep, to: n.id});
      }
    }
  }
  return out;
}

export type TtsBDagNodeStatus =
  | 'not_generated'
  | 'generation_running'
  | 'generation_failed'
  | 'ready'
  | 'needs_review'
  | 'blocked'
  | 'stale_source'
  | 'invalid_source';

export interface TtsBDagNodeState {
  node: TtsBDagNodeId;
  status: TtsBDagNodeStatus;
  detail: string | null;
  candidateCount: number;
  currentCandidateCount: number;
}

function activityOf(projectId: string): {running: boolean; failed: boolean} {
  const db = getDb();
  const now = Date.now();
  const runs = db
    .prepare(
      `SELECT status, lease_expires_at FROM generation_runs
       WHERE project_id = ? AND stage = ? ORDER BY created_at DESC`,
    )
    .all(projectId, PERFORMANCE_USAGE_STAGE) as Array<{status: string; lease_expires_at: string | null}>;
  let running = false;
  let failed = false;
  for (const run of runs) {
    if (run.status === 'running' && run.lease_expires_at !== null && Date.parse(run.lease_expires_at) > now) {
      running = true;
    }
    if (run.status === 'failed' || run.status === 'indeterminate') {
      failed = true;
    }
  }
  const dispatch = db
    .prepare(
      `SELECT status FROM generation_dispatch_jobs
       WHERE project_id = ? AND stage = ? AND status IN ('queued', 'running', 'failed')`,
    )
    .all(projectId, PERFORMANCE_USAGE_STAGE) as Array<{status: string}>;
  for (const job of dispatch) {
    if (job.status === 'queued' || job.status === 'running') running = true;
    if (job.status === 'failed') failed = true;
  }
  return {running, failed};
}

/** Narration Plan usable：仅 eligible_candidate（needs_review/stale/invalid/missing 均不可用）。 */
export function isNarrationPlanUsableForPerformance(projectId: string): boolean {
  const candidates = listNarrationPlanV2Candidates(projectId);
  return candidates.some((c) => c.status === 'eligible_candidate');
}

export function isNarrationPlanInNeedsReview(projectId: string): boolean {
  return listNarrationPlanV2Candidates(projectId).some((c) => c.status === 'needs_review');
}

export function isNarrationPlanStale(projectId: string): boolean {
  return listNarrationPlanV2Candidates(projectId).some((c) => c.status === 'stale');
}

export function isNarrationPlanInvalid(projectId: string): boolean {
  return listNarrationPlanV2Candidates(projectId).some((c) => c.status === 'invalid');
}

/**
 * 计算 TTS-B 三节点状态（纯读，不写 DB）。assignment 无 generation 机制
 * （deterministic 同步 build），activity 恒为 false。
 */
export async function computeTtsBDagNodeStates(projectId: string): Promise<Record<TtsBDagNodeId, TtsBDagNodeState>> {
  // narration_plan_v2 节点
  const planCandidates = listNarrationPlanV2Candidates(projectId);
  const planEligible = planCandidates.filter((c) => c.status === 'eligible_candidate');
  const planNeedsReview = planCandidates.filter((c) => c.status === 'needs_review');
  const planStale = planCandidates.filter((c) => c.status === 'stale');
  const planInvalid = planCandidates.filter((c) => c.status === 'invalid');

  let narrationState: TtsBDagNodeState;
  if (planEligible.length > 0) {
    narrationState = {
      node: 'narration_plan_v2',
      status: 'ready',
      detail: null,
      candidateCount: planCandidates.length,
      currentCandidateCount: planEligible.length,
    };
  } else if (planNeedsReview.length > 0) {
    narrationState = {
      node: 'narration_plan_v2',
      status: 'needs_review',
      detail: `narration plan 存在 needsReview：${planNeedsReview[0]!.statusReason ?? ''}`,
      candidateCount: planCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (planInvalid.length > 0) {
    narrationState = {
      node: 'narration_plan_v2',
      status: 'invalid_source',
      detail: `narration plan 已 invalid：${planInvalid[0]!.statusReason ?? ''}`,
      candidateCount: planCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (planStale.length > 0) {
    narrationState = {
      node: 'narration_plan_v2',
      status: 'stale_source',
      detail: `narration plan 已 stale（locked Script V2 漂移）：${planStale[0]!.statusReason ?? ''}`,
      candidateCount: planCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (planCandidates.length > 0) {
    narrationState = {
      node: 'narration_plan_v2',
      status: 'blocked',
      detail: 'narration plan candidate 存在但分类异常',
      candidateCount: planCandidates.length,
      currentCandidateCount: 0,
    };
  } else {
    narrationState = {
      node: 'narration_plan_v2',
      status: 'not_generated',
      detail: null,
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  }

  // project_voice_assignment 节点
  const assignmentCandidates = await listProjectVoiceAssignmentCandidates(projectId);
  const assignmentCurrent = assignmentCandidates.filter((c) => c.status === 'current_candidate');
  const assignmentStale = assignmentCandidates.filter((c) => c.status === 'stale_source');
  const assignmentInvalid = assignmentCandidates.filter((c) => c.status === 'invalid_source');

  let assignmentState: TtsBDagNodeState;
  if (assignmentCurrent.length > 0) {
    assignmentState = {
      node: 'project_voice_assignment',
      status: 'ready',
      detail: null,
      candidateCount: assignmentCandidates.length,
      currentCandidateCount: assignmentCurrent.length,
    };
  } else if (assignmentInvalid.length > 0) {
    assignmentState = {
      node: 'project_voice_assignment',
      status: 'invalid_source',
      detail: `全部 assignment 为 invalid（exact voice 不可用/source 不一致）：${assignmentInvalid[0]!.statusReason ?? ''}`,
      candidateCount: assignmentCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (assignmentStale.length > 0) {
    assignmentState = {
      node: 'project_voice_assignment',
      status: 'stale_source',
      detail: `全部 assignment 为 stale：${assignmentStale[0]!.statusReason ?? ''}`,
      candidateCount: assignmentCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (assignmentCandidates.length > 0) {
    assignmentState = {
      node: 'project_voice_assignment',
      status: 'blocked',
      detail: 'assignment candidate 存在但分类异常',
      candidateCount: assignmentCandidates.length,
      currentCandidateCount: 0,
    };
  } else {
    assignmentState = {
      node: 'project_voice_assignment',
      status: 'not_generated',
      detail: null,
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  }

  // narration_performance_plan 节点（双依赖）
  const activity = activityOf(projectId);
  const performanceCandidates = await listNarrationPerformancePlanCandidates(projectId);
  const perfCurrent = performanceCandidates.filter((c) => c.status === 'current_candidate');
  const perfInvalid = performanceCandidates.filter((c) => c.status === 'invalid_source');
  const perfStale = performanceCandidates.filter((c) => c.status === 'stale_source');

  // 依赖可用性（精确列出缺失依赖，blocked detail 不写笼统文案）
  const planUsable = narrationState.status === 'ready';
  const assignUsable = assignmentState.status === 'ready';
  const missingDeps: TtsBDagNodeId[] = [];
  if (!planUsable) missingDeps.push('narration_plan_v2');
  if (!assignUsable) missingDeps.push('project_voice_assignment');

  let performanceState: TtsBDagNodeState;
  if (activity.running) {
    // generation activity：若 exact source 已失效，detail 标明 dependency invalid
    const depNote = missingDeps.length > 0 ? `（dependency invalid: ${missingDeps.join(', ')}）` : '';
    performanceState = {
      node: 'narration_performance_plan',
      status: 'generation_running',
      detail: `generation run/dispatch 进行中${depNote}`,
      candidateCount: performanceCandidates.length,
      currentCandidateCount: perfCurrent.length,
    };
  } else if (perfCurrent.length > 0) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'ready',
      detail: null,
      candidateCount: performanceCandidates.length,
      currentCandidateCount: perfCurrent.length,
    };
  } else if (perfInvalid.length > 0) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'invalid_source',
      detail: `全部 performance 为 invalid（voice 不可用/语义不通过/source 不一致）：${perfInvalid[0]!.statusReason ?? ''}`,
      candidateCount: performanceCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (perfStale.length > 0) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'stale_source',
      detail: `全部 performance 为 stale（narration/assignment source 漂移）：${perfStale[0]!.statusReason ?? ''}`,
      candidateCount: performanceCandidates.length,
      currentCandidateCount: 0,
    };
  } else if (missingDeps.length > 0) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'blocked',
      detail: `依赖缺失/不可用：${missingDeps.join(', ')}`,
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  } else if (activity.failed) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'generation_failed',
      detail: 'generation run 终态 failed/indeterminate 或 dispatch failed',
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  } else {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'not_generated',
      detail: null,
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  }

  return {
    narration_plan_v2: narrationState,
    project_voice_assignment: assignmentState,
    narration_performance_plan: performanceState,
  };
}

/** 供测试/UI 读取单个节点状态。 */
export async function computeTtsBDagNodeState(projectId: string, node: TtsBDagNodeId): Promise<TtsBDagNodeState> {
  return (await computeTtsBDagNodeStates(projectId))[node]!;
}

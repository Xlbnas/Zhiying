/**
 * M7 candidate 链 DAG readiness（M7.3B §九）——DB 计算，纯读不写。
 *
 * 节点状态（deterministic，不解析 latest/current，不写任何指针）：
 * - generation_running：该 stage 有 running run（租约有效）或 queued/running dispatch；
 * - ready：≥1 candidate 分类为 current_candidate（beats/intent 的
 *   eligible_candidate 语义映射为 current_candidate；不表示 project current）；
 * - needs_review：≥1 candidate 为 needs_review 且无 current_candidate；
 * - generation_failed：存在 terminal failed/indeterminate run 或 failed dispatch，
 *   且无有效 candidate；
 * - blocked：存在 candidate 但全部 stale/invalid；或依赖节点缺源
 *   （依赖为 blocked / not_generated——"source artifact 缺失即 blocked；
 *   source invalid/stale 即 blocked"）；
 * - not_generated：无 candidate、无 run、无 dispatch。
 *
 * 优先级：running > ready > needs_review > generation_failed > blocked > not_generated。
 *
 * TTS/其他 stage 的 run/dispatch/llm job 不影响本 DAG（并行性）；
 * Voice/Performance 概念源本轮不存在 → 无可 stale 路径。
 */

import {getDb} from '../db';
import {BEATS_USAGE_STAGE} from '../narrative-beats/generate';
import {listNarrativeBeatsCandidates} from '../narrative-beats/plan';
import {listNarrationPlanV2Candidates} from '../narration/plan-v2';
import {SHOTS_USAGE_STAGE} from '../shots/generate';
import {listShotsCandidates} from '../shots/classify';
import {VISUAL_INTENT_USAGE_STAGE} from '../visual-intent/generate';
import {listVisualIntentCandidates} from '../visual-intent/plan';
import {SEQUENCES_USAGE_STAGE} from '../visual-sequences/generate';
import {listVisualSequencesCandidates} from '../visual-sequences/classify';
import {M7_DAG_NODES, M7_DAG_TOPOLOGICAL_ORDER, m7DownstreamOf, type M7DagNodeId} from './dag';

export type M7DagNodeStatus =
  | 'not_generated'
  | 'generation_running'
  | 'generation_failed'
  | 'ready'
  | 'needs_review'
  | 'blocked';

export interface M7DagNodeState {
  node: M7DagNodeId;
  status: M7DagNodeStatus;
  /** 状态说明（如 blocked 的依赖缺失项、failed 的 errorCode）。 */
  detail: string | null;
  candidateCount: number;
  currentCandidateCount: number;
}

/** 各节点对应的 generation stage（narration_plan_v2 无 generation_runs 机制）。 */
const STAGE_BY_NODE: Partial<Record<M7DagNodeId, string>> = {
  narrative_beats: BEATS_USAGE_STAGE,
  visual_intent_plan: VISUAL_INTENT_USAGE_STAGE,
  visual_sequences: SEQUENCES_USAGE_STAGE,
  shots: SHOTS_USAGE_STAGE,
};

/** 各节点的 candidate 分类集合（deterministic，纯读）。 */
function candidatesOf(
  projectId: string,
  node: M7DagNodeId,
): Array<{status: string; reason: string | null}> {
  switch (node) {
    case 'narration_plan_v2':
      return listNarrationPlanV2Candidates(projectId).map((c) => ({status: c.status, reason: c.statusReason}));
    case 'narrative_beats':
      return listNarrativeBeatsCandidates(projectId).map((c) => ({status: c.status, reason: c.statusReason}));
    case 'visual_intent_plan':
      return listVisualIntentCandidates(projectId).map((c) => ({status: c.status, reason: c.statusReason}));
    case 'visual_sequences':
      return listVisualSequencesCandidates(projectId).map((c) => ({status: c.status, reason: c.statusReason}));
    case 'shots':
      return listShotsCandidates(projectId).map((c) => ({status: c.status, reason: c.statusReason}));
  }
}

/** 映射旧状态名 → M7.3B 语义：eligible_candidate 即 current_candidate。 */
function normalizeStatus(status: string): 'current' | 'needs_review' | 'stale_or_invalid' {
  if (status === 'eligible_candidate' || status === 'current_candidate') return 'current';
  if (status === 'needs_review') return 'needs_review';
  return 'stale_or_invalid';
}

/**
 * usable 纯判定（M7.3B.R2 导出，供测试 truth table 精确锁定；语义与 R1 一致）：
 * - 先检查下游相关性：downstreamNode 必须位于 sourceNode 的真实下游
 *   （DAG 边 reachability）；不相关 → false；
 * - eligible_candidate/current_candidate → usable；
 * - needs_review：visual_intent_plan 可用于 visual_sequences 与 shots
 *   （VISUAL_UNRESOLVED 在 Sequence/Shot 层均为非阻断 NEEDS_REVIEW）；
 *   visual_sequences 可用于 shots；narration_plan_v2 needs_review 不可用；
 * - stale/invalid → 不可用。
 */
export function isCandidateUsableForDownstream(
  sourceNode: M7DagNodeId,
  candidateStatus: string,
  downstreamNode: M7DagNodeId,
): boolean {
  if (!m7DownstreamOf(sourceNode).includes(downstreamNode)) return false;
  const s = normalizeStatus(candidateStatus);
  if (s === 'current') return true;
  if (s === 'needs_review') {
    if (sourceNode === 'visual_intent_plan' && (downstreamNode === 'visual_sequences' || downstreamNode === 'shots')) {
      return true;
    }
    if (sourceNode === 'visual_sequences' && downstreamNode === 'shots') return true;
    return false;
  }
  return false;
}

/**
 * 某节点对指定下游的「可用 candidate 数」（M7.3B.R1 P1 usable-candidate 语义）。
 * 下游 dependency 缺失判定必须基于该计数（≠0 即可用），
 * 而非 dependency 节点自身的 status 字符串——上游 regenerate running/failed
 * 且同时存在旧合法 candidate 时，下游不得被误判 blocked。
 */
function usableCandidateCount(projectId: string, node: M7DagNodeId, downstream: M7DagNodeId): number {
  const candidates = candidatesOf(projectId, node);
  return candidates.filter((c) => isCandidateUsableForDownstream(node, c.status, downstream)).length;
}

/** generation 活动：running（租约有效）/ failed 终态；只查本 stage，不影响其他 stage。 */
function activityOf(projectId: string, node: M7DagNodeId): {running: boolean; failed: boolean} {
  const stage = STAGE_BY_NODE[node];
  if (!stage) return {running: false, failed: false};
  const db = getDb();
  const now = Date.now();
  const runs = db
    .prepare(
      `SELECT status, lease_expires_at FROM generation_runs
       WHERE project_id = ? AND stage = ? ORDER BY created_at DESC`,
    )
    .all(projectId, stage) as Array<{status: string; lease_expires_at: string | null}>;
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
    .all(projectId, stage) as Array<{status: string}>;
  for (const job of dispatch) {
    if (job.status === 'queued' || job.status === 'running') running = true;
    if (job.status === 'failed') failed = true;
  }
  return {running, failed};
}

/**
 * 计算项目全部 M7 DAG 节点状态（纯读，不写 DB、不设 current、不建 snapshot）。
 * 按拓扑序计算（依赖状态先于依赖者）。
 */
export function computeM7DagNodeStates(projectId: string): Record<M7DagNodeId, M7DagNodeState> {
  const states = {} as Record<M7DagNodeId, M7DagNodeState>;

  for (const node of M7_DAG_TOPOLOGICAL_ORDER) {
    const def = M7_DAG_NODES.find((n) => n.id === node)!;
    const candidates = candidatesOf(projectId, node);
    const activity = activityOf(projectId, node);
    const current = candidates.filter((c) => normalizeStatus(c.status) === 'current');
    const review = candidates.filter((c) => normalizeStatus(c.status) === 'needs_review');

    const make = (
      status: M7DagNodeStatus,
      detail: string | null,
    ): M7DagNodeState => ({
      node,
      status,
      detail,
      candidateCount: candidates.length,
      currentCandidateCount: current.length,
    });

    let state: M7DagNodeState;
    if (activity.running) {
      state = make('generation_running', 'generation run/dispatch 进行中');
    } else if (current.length > 0) {
      state = make('ready', null);
    } else if (review.length > 0) {
      state = make('needs_review', `存在 needs_review candidate（VISUAL_UNRESOLVED 需人工处理）`);
    } else if (activity.failed) {
      state = make('generation_failed', 'generation run 终态 failed/indeterminate 或 dispatch failed');
    } else {
      // 依赖缺源 → blocked。判定基于 usable candidate 数（对当前下游），
      // 而非 dependency 节点状态字符串：generation_running/generation_failed
      // 且无可用 candidate 同样视为缺失（spec：source artifact 缺失即 blocked；
      // source invalid/stale 即 blocked；needs_review 按 usable 语义处理）。
      const missingDeps = def.dependencies.filter((dep) => usableCandidateCount(projectId, dep, node) === 0);
      if (missingDeps.length > 0) {
        state = make('blocked', `依赖缺失/不可用（无可用于本节点的 candidate）：${missingDeps.join(', ')}`);
      } else if (candidates.length > 0) {
        state = make(
          'blocked',
          `全部 candidate 为 stale/invalid（首个：${candidates[0]!.reason ?? '未知'}）`,
        );
      } else {
        state = make('not_generated', null);
      }
    }
    states[node] = state;
  }
  return states;
}

/** 供测试/UI 读取单个节点状态。 */
export function computeM7DagNodeState(projectId: string, node: M7DagNodeId): M7DagNodeState {
  return computeM7DagNodeStates(projectId)[node]!;
}

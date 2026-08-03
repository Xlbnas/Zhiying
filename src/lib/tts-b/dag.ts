/**
 * TTS-B DAG node states（设计文档 §8）——独立于 M7.3B frozen `m7-dag/dag.ts`。
 *
 * 节点：project_voice_assignment、narration_performance_plan。
 * 状态：not_generated | generation_running | generation_failed | ready |
 *       needs_review | blocked | stale_source | invalid_source。
 *
 * 兼容边界（M7.3B §7.6）：Voice Assignment / Performance Plan 变化**不** stale
 * Narrative Beats / Visual Intent / Sequence / Shot；本模块只读，不写任何指针，
 * 不形成反向边、不形成 cycle。
 */
import {getDb} from '../db';
import {
  PERFORMANCE_USAGE_STAGE,
} from './constants';
import {
  classifyProjectVoiceAssignment,
  listProjectVoiceAssignmentCandidates,
} from './assignment';
import {
  classifyNarrationPerformancePlan,
  listNarrationPerformancePlanCandidates,
} from './performance';

export type TtsBDagNodeId = 'project_voice_assignment' | 'narration_performance_plan';

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

function normalizeStatus(status: string): 'current' | 'stale' | 'invalid' {
  if (status === 'current_candidate') return 'current';
  if (status === 'invalid_source') return 'invalid';
  return 'stale';
}

/**
 * 计算 TTS-B 两节点状态（纯读，不写 DB）。assignment 无 generation 机制
 * （deterministic 同步 build），因此其 activity 恒为 false。
 */
export async function computeTtsBDagNodeStates(projectId: string): Promise<Record<TtsBDagNodeId, TtsBDagNodeState>> {
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
      detail: `全部 assignment 为 invalid（exact voice 不可用）：${assignmentInvalid[0]!.statusReason ?? ''}`,
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
      detail: 'assignment candidate 存在但分类异常（无 current/stale/invalid）',
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

  // performance 节点：依赖 = 有 current assignment（无 usable exact revision →
  // assignment invalid → performance blocked/invalid）。优先级：
  // running > ready > invalid > stale > generation_failed > not_generated > blocked。
  const activity = activityOf(projectId);
  const performanceCandidates = await listNarrationPerformancePlanCandidates(projectId);
  const perfCurrent = performanceCandidates.filter((c) => c.status === 'current_candidate');
  const perfInvalid = performanceCandidates.filter((c) => c.status === 'invalid_source');
  const perfStale = performanceCandidates.filter((c) => c.status === 'stale_source');

  let performanceState: TtsBDagNodeState;
  if (activity.running) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'generation_running',
      detail: 'generation run/dispatch 进行中',
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
      detail: `全部 performance 为 invalid（voice 不可用/语义不通过）：${perfInvalid[0]!.statusReason ?? ''}`,
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
  } else if (activity.failed) {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'generation_failed',
      detail: 'generation run 终态 failed/indeterminate 或 dispatch failed',
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  } else if (assignmentState.status === 'ready') {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'not_generated',
      detail: null,
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  } else {
    performanceState = {
      node: 'narration_performance_plan',
      status: 'blocked',
      detail: `依赖 voice assignment 状态=${assignmentState.status}（无可用 exact voice candidate）`,
      candidateCount: 0,
      currentCandidateCount: 0,
    };
  }

  return {project_voice_assignment: assignmentState, narration_performance_plan: performanceState};
}

/** 供测试/UI 读取单个节点状态。 */
export async function computeTtsBDagNodeState(projectId: string, node: TtsBDagNodeId): Promise<TtsBDagNodeState> {
  return (await computeTtsBDagNodeStates(projectId))[node]!;
}

export {classifyProjectVoiceAssignment, classifyNarrationPerformancePlan, normalizeStatus};

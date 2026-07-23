/**
 * Workflow 组件共享类型与常量（M2-C）。
 * 与 /api/projects/[id]/stages 响应结构对齐。
 */

import type {StageStatus, WorkflowStage} from '@/lib/workflow/types';
import {WORKFLOW_STAGES} from '@/lib/workflow/types';

export interface StageJobSummary {
  id: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempt: number;
  queued_at: string;
  finished_at: string | null;
}

export interface WorkflowStageState {
  project_id: string;
  stage: WorkflowStage;
  status: StageStatus;
  active_version: number | null;
  locked_version: number | null;
  updated_at: string;
  latestJob: StageJobSummary | null;
  activeJob: {id: string; status: string} | null;
}

export interface StagesResponse {
  project: {id: string; title: string; current_stage: string; created_at: string};
  stages: WorkflowStageState[];
  inputs: {topic: string; coreQuestion: string} | null;
  legacy: boolean;
  hasScenesArtifact: boolean;
}

export const STAGE_NAMES: Record<WorkflowStage, string> = {
  project_definition: '选题定义',
  research: '研究',
  evidence: '证据',
  argument_tree: '论证树',
  script_v1: '脚本 V1',
  script_v2: '脚本 V2',
  narration_beat_map: '旁白节拍',
  visual_breakdown: '视觉拆解',
  shot_list: '镜头清单',
  scenes: '场景数据',
};

export const STAGE_STATE_LABELS: Record<StageStatus, string> = {
  not_started: '未开始',
  generated: '已生成',
  edited: '已编辑',
  locked: '已锁定',
  stale: '已失效',
};

export const LLM_JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 当前阶段：拓扑序中第一个未锁定的阶段（派生态，不入库）。 */
export function deriveCurrentStage(stages: WorkflowStageState[]): WorkflowStage {
  for (const name of WORKFLOW_STAGES) {
    const row = stages.find((s) => s.stage === name);
    if (!row || row.status !== 'locked') {
      return name;
    }
  }
  return WORKFLOW_STAGES[WORKFLOW_STAGES.length - 1]!;
}

/** 阶段是否带 failed 派生态（最近任务失败，不写 project_stages.status）。 */
export function isStageFailed(stage: WorkflowStageState): boolean {
  return stage.activeJob === null && stage.latestJob?.status === 'failed';
}

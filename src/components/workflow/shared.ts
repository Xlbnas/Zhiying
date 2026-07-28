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

/** 锁定成功后的下一个阶段；最后阶段（场景数据）返回 null。 */
export function nextStageAfter(stage: WorkflowStage): WorkflowStage | null {
  const idx = WORKFLOW_STAGES.indexOf(stage);
  if (idx < 0 || idx >= WORKFLOW_STAGES.length - 1) return null;
  return WORKFLOW_STAGES[idx + 1]!;
}

/**
 * 「只接受最新一次请求」的轻量防竞态原语（M5）。
 * 每次发起请求取 next() token；响应落地前 isLatest(token) 为 false 即丢弃。
 * 用于 Stage 切换/刷新时慢响应不得覆盖新数据。
 */
export function createLatestOnlyGuard(): {next: () => number; isLatest: (token: number) => boolean} {
  let seq = 0;
  return {
    next: () => ++seq,
    isLatest: (token: number) => token === seq,
  };
}

/**
 * 面向普通用户的友好错误文案（M5）。
 * 默认 UI 只显示自然语言；error code 留给「技术详情」折叠区。
 * 按 error_code 与 message 中的 [SCENE_*] 代码前缀匹配。
 */
const FRIENDLY_ERROR_RULES: Array<{match: RegExp; text: string}> = [
  {match: /SCENE_CHAPTER_MISMATCH/, text: '部分场景的时间超出了所属章节，系统正在尝试自动修复。'},
  {match: /SCENE_CATEGORY_INVALID|SCENE_VISUAL_TYPE_INVALID/, text: '部分场景的画面类型不符合规范，系统正在尝试自动修复。'},
  {match: /CHAPTER_TIMING_INVALID/, text: '章节时间与场景时间不一致，系统正在尝试自动修复。'},
  {match: /SCENE_TIMELINE_GAP|SCENE_TIMELINE_OVERLAP/, text: '场景时间轴存在空档或重叠，系统正在尝试自动修复。'},
  {match: /VALIDATION_FAILED/, text: '生成的内容未通过质量校验，系统多次自动修复仍未成功。你可以稍后重试，或调整上游内容后重新生成。'},
  {match: /OUTPUT_TRUNCATED/, text: '生成内容过长被截断。建议缩小范围或拆分后重试。'},
  {match: /EMPTY_RESPONSE/, text: '生成服务暂时没有返回内容，请稍后重试。'},
  {match: /DEPENDENCY_STALE/, text: '上游内容已更新，本阶段需要重新生成后才能继续。'},
  {match: /RATE_LIMIT|429/, text: '生成服务繁忙，请稍后重试。'},
  {match: /TIMEOUT|ETIMEDOUT/, text: '生成服务响应超时，请稍后重试。'},
  {match: /VISUAL_READINESS_FAILED/, text: '视觉素材尚未准备完成，请先准备素材后再进行最终渲染。'},
];

export function friendlyStageError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): string {
  const haystack = `${errorCode ?? ''}\n${errorMessage ?? ''}`;
  for (const rule of FRIENDLY_ERROR_RULES) {
    if (rule.match.test(haystack)) return rule.text;
  }
  return errorMessage?.trim() ? errorMessage : '操作失败，请稍后重试。';
}

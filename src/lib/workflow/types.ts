import {z} from 'zod';

/**
 * 知影工作流阶段与状态 — 唯一枚举真相（M2-A，CONTRACT/架构 §2.1）。
 * 10 个主生产阶段，顺序即拓扑序（索引越小越上游）。
 * Pilot / FullCut 渲染不走此状态机（M1 渲染链已有独立 render_jobs）。
 */

export const WORKFLOW_STAGES = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
  'script_v2',
  'narration_beat_map',
  'visual_breakdown',
  'shot_list',
  'scenes',
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const workflowStageSchema = z.enum(WORKFLOW_STAGES);

export const STAGE_STATUSES = [
  'not_started',
  'generated',
  'edited',
  'locked',
  'stale',
] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

export const stageStatusSchema = z.enum(STAGE_STATUSES);

/** project_versions.source：版本来源。 */
export const VERSION_SOURCES = [
  'ai_generate',
  'manual_edit',
  'repair',
  'rollback',
] as const;

export type VersionSource = (typeof VERSION_SOURCES)[number];

export const versionSourceSchema = z.enum(VERSION_SOURCES);

/** project_versions.content_type。 */
export const CONTENT_TYPES = ['markdown', 'json'] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export const contentTypeSchema = z.enum(CONTENT_TYPES);

/** 阶段在拓扑序中的下标；未知阶段抛错（调用方应先用 schema 校验）。 */
export function stageIndex(stage: WorkflowStage): number {
  const i = WORKFLOW_STAGES.indexOf(stage);
  if (i < 0) {
    throw new Error(`unknown workflow stage: ${stage}`);
  }
  return i;
}

/** 某阶段的全部上游（按顺序）。 */
export function upstreamStages(stage: WorkflowStage): WorkflowStage[] {
  return WORKFLOW_STAGES.slice(0, stageIndex(stage));
}

/** 某阶段的全部下游（按顺序）。 */
export function downstreamStages(stage: WorkflowStage): WorkflowStage[] {
  return WORKFLOW_STAGES.slice(stageIndex(stage) + 1);
}

// ---------- DB 行类型 ----------

export interface ProjectStageRow {
  project_id: string;
  stage: WorkflowStage;
  status: StageStatus;
  active_version: number | null;
  locked_version: number | null;
  updated_at: string;
}

export interface ProjectVersionRow {
  id: string;
  project_id: string;
  stage: WorkflowStage;
  version: number;
  content: string;
  content_type: ContentType;
  source: VersionSource;
  prompt_version: string | null;
  model: string | null;
  job_id: string | null;
  note: string | null;
  created_at: string;
}

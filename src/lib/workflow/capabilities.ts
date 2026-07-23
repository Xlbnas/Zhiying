import type {WorkflowStage} from './types';

/**
 * 阶段能力集中配置（M2-D §二）：API / UI 唯一能力真相。
 * 当前正式开放前六阶段；后四阶段（narration_beat_map 起）属 M2-E，
 * 继续 STAGE_NOT_ENABLED。禁止在各 Route/组件复制名单。
 */

export const M2D_ENABLED_STAGES: readonly WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
  'script_v2',
] as const;

const ENABLED_SET: ReadonlySet<string> = new Set(M2D_ENABLED_STAGES);

export function isStageEnabled(stage: WorkflowStage): boolean {
  return ENABLED_SET.has(stage);
}

import {WORKFLOW_STAGES, type WorkflowStage} from './types';

/**
 * 阶段能力集中配置（M2-E-B §三）：API / UI 唯一能力真相。
 * 当前全部 10 个主生产阶段正式开放（M2-E-B 起）。
 * 禁止在各 Route/组件复制名单。
 */

export const ENABLED_WORKFLOW_STAGES: readonly WorkflowStage[] = WORKFLOW_STAGES;

const ENABLED_SET: ReadonlySet<string> = new Set(ENABLED_WORKFLOW_STAGES);

export function isStageEnabled(stage: WorkflowStage): boolean {
  return ENABLED_SET.has(stage);
}

/**
 * @deprecated 仅兼容旧测试引用；新代码一律使用 ENABLED_WORKFLOW_STAGES。
 * M2-D 时期的前六阶段名单。
 */
export const M2D_ENABLED_STAGES: readonly WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
  'script_v2',
] as const;

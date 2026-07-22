/**
 * 阶段模型配置（M2-B，M2 实施计划 §1.4）。
 *
 * 集中常量表，UI 不得参与模型配置。
 * thinking 由本表显式决定，不依赖供应商默认值（DeepSeek 默认 enabled）。
 * 环境变量 LLM_STAGE_MODEL_<STAGE>（阶段名大写）仅覆盖模型名；
 * thinking / reasoningEffort 不允许环境变量改动，保持阶段语义显式。
 */

import type {WorkflowStage} from '../workflow/types';
import type {LlmEnv, LLMReasoningEffort, LLMThinking} from './types';

export const DEEPSEEK_FLASH = 'deepseek-v4-flash';
export const DEEPSEEK_PRO = 'deepseek-v4-pro';

export interface StageModelConfig {
  model: string;
  thinking: LLMThinking;
  /** thinking=enabled 时显式携带。 */
  reasoningEffort?: LLMReasoningEffort;
  maxTokens: number;
}

const HIGH = 'high' as const;

/** 默认分配：论证树与脚本两版 → Pro；其余 → Flash。 */
export const STAGE_MODELS: Readonly<Record<WorkflowStage, StageModelConfig>> = {
  project_definition: {model: DEEPSEEK_FLASH, thinking: 'disabled', maxTokens: 4096},
  research: {model: DEEPSEEK_FLASH, thinking: 'enabled', reasoningEffort: HIGH, maxTokens: 8192},
  evidence: {model: DEEPSEEK_FLASH, thinking: 'enabled', reasoningEffort: HIGH, maxTokens: 8192},
  argument_tree: {model: DEEPSEEK_PRO, thinking: 'enabled', reasoningEffort: HIGH, maxTokens: 8192},
  script_v1: {model: DEEPSEEK_PRO, thinking: 'enabled', reasoningEffort: HIGH, maxTokens: 16384},
  script_v2: {model: DEEPSEEK_PRO, thinking: 'enabled', reasoningEffort: HIGH, maxTokens: 16384},
  narration_beat_map: {model: DEEPSEEK_FLASH, thinking: 'disabled', maxTokens: 8192},
  visual_breakdown: {model: DEEPSEEK_FLASH, thinking: 'enabled', reasoningEffort: HIGH, maxTokens: 8192},
  shot_list: {model: DEEPSEEK_FLASH, thinking: 'disabled', maxTokens: 16384},
  scenes: {model: DEEPSEEK_FLASH, thinking: 'disabled', maxTokens: 32768},
};

/** 读取阶段配置；LLM_STAGE_MODEL_<STAGE> 可覆盖模型名（如 research → RESEARCH）。 */
export function getStageModelConfig(
  stage: WorkflowStage,
  env: LlmEnv = process.env,
): StageModelConfig {
  const base = STAGE_MODELS[stage];
  const override = env[`LLM_STAGE_MODEL_${stage.toUpperCase()}`];
  if (override && override.trim().length > 0) {
    return {...base, model: override.trim()};
  }
  return {...base};
}

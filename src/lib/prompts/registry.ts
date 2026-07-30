/**
 * Prompt Registry（M2-B，M2 实施计划 §1.5）。
 * 10 个阶段模板集中注册；promptVersion 写入 project_versions 与 llm_usage。
 * 修改 prompt = 提升 promptVersion，旧版本模板保留不删。
 */

import {LLMError} from '../llm/types';
import {WORKFLOW_STAGES, type WorkflowStage} from '../workflow/types';
import {argumentTreePrompt} from './argument-tree';
import {evidencePrompt} from './evidence';
import {narrationBeatMapPrompt} from './narration-beat-map';
import {projectDefinitionPrompt} from './project-definition';
import {researchPrompt} from './research';
import {scenesPrompt} from './scenes';
import {scriptV1Prompt} from './script-v1';
import {scriptV2Prompt} from './script-v2';
import type {StagePrompt} from './shared';
import {shotListPrompt} from './shot-list';
import {visualBreakdownPrompt} from './visual-breakdown';

// script_v2 固定注册 M6 稳定版（script-v2@1.0）。
// script-v2@2.0（行级 directive DSL）刻意不注册：仅供显式 M7 typed narration
// candidate 路径直接引用（prompts/script-v2.ts 的 scriptV2M7Prompt），
// 标准 stage generation 无法经 Registry 拿到它（M7.2.1 P0 hotfix 冻结分流）。
export const PROMPT_REGISTRY: Readonly<Record<WorkflowStage, StagePrompt>> = {
  project_definition: projectDefinitionPrompt,
  research: researchPrompt,
  evidence: evidencePrompt,
  argument_tree: argumentTreePrompt,
  script_v1: scriptV1Prompt,
  script_v2: scriptV2Prompt,
  narration_beat_map: narrationBeatMapPrompt,
  visual_breakdown: visualBreakdownPrompt,
  shot_list: shotListPrompt,
  scenes: scenesPrompt,
};

export function getStagePrompt(stage: WorkflowStage): StagePrompt {
  const prompt = PROMPT_REGISTRY[stage];
  if (!prompt) {
    throw new LLMError('CONFIG_ERROR', `Prompt Registry 缺少阶段模板: ${stage}`);
  }
  return prompt;
}

/** 注册完整性自检（启动/测试用）：10 阶段齐全、promptVersion 非空、JSON 阶段必有 schema。 */
export function assertRegistryComplete(): void {
  for (const stage of WORKFLOW_STAGES) {
    const prompt = PROMPT_REGISTRY[stage];
    if (!prompt) {
      throw new LLMError('CONFIG_ERROR', `Prompt Registry 未注册阶段: ${stage}`);
    }
    if (!prompt.promptVersion || prompt.promptVersion.trim().length === 0) {
      throw new LLMError('CONFIG_ERROR', `阶段 ${stage} 的 promptVersion 为空`);
    }
    if (prompt.outputKind === 'json' && !prompt.zodSchema) {
      throw new LLMError('CONFIG_ERROR', `JSON 阶段 ${stage} 缺少 zodSchema`);
    }
  }
}

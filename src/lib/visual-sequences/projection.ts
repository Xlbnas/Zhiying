/**
 * Visual Sequences Planner 安全投影（M7.3B）。
 *
 * LLM 的唯一输入是从「精确 Narrative Beats artifact」+「精确 Visual Intent
 * Plan artifact」+ 其 provenance 指向的「精确 Narration Plan V2 artifact」
 * 生成的 sanitized projection：
 * - beats 只暴露 beatId/chapter/role/unitIds/summary/payoff；
 * - intents 只暴露引用字段与展示所需的语义摘要（visualIntentId/chapter/beatIds/
 *   intent/strategy/objective/subject{kind,label}/displayText/continuation）——
 *   这些只进 prompt 输入，绝不写入 Sequence artifact（无复制语义）；
 * - units 复用 Beat Planner 同款安全投影；
 * - 禁止包含 sourceText / raw script_v2 / 旧括号导演指令 / 旧 beat_map /
 *   visual_breakdown / shot_list / scenes / asset bindings / render payload。
 */

import {
  buildBeatPlannerInput,
  hashPrompt,
  type BeatPlannerUnit,
} from '../narrative-beats/projection';
import type {NarrativeBeatsArtifactV1} from '../narrative-beats/schema';
import type {NarrationPlanV2} from '../narration/schema-v2';
import type {VisualIntentPlanArtifactV1} from '../visual-intent/schema';

export {hashPrompt};

export interface SequencePlannerBeat {
  beatId: string;
  chapter: number;
  role: string;
  unitIds: string[];
  /** 编辑备注（供 LLM 理解语义），永不上屏、不进 artifact。 */
  summary: string;
  payoff: string | null;
}

export interface SequencePlannerIntent {
  visualIntentId: string;
  chapter: number;
  beatIds: string[];
  intent: string;
  strategy: string;
  objective: string;
  subjectKind: string;
  subjectLabel: string | null;
  displayText: string | null;
  continuationOfVisualIntentId: string | null;
}

export interface SequencePlannerInput {
  chapters: Array<{chapter: number; title: string}>;
  beats: SequencePlannerBeat[];
  units: BeatPlannerUnit[];
  intents: SequencePlannerIntent[];
}

/** 从精确 beats + 精确 visual intent plan + 精确 narration plan 生成 sanitized projection。 */
export function buildSequencePlannerInput(
  beatsArtifact: NarrativeBeatsArtifactV1,
  plan: NarrationPlanV2,
  intentPlan: VisualIntentPlanArtifactV1,
): SequencePlannerInput {
  const narrationProjection = buildBeatPlannerInput(plan);
  return {
    chapters: narrationProjection.chapters,
    beats: beatsArtifact.beats.map((beat) => ({
      beatId: beat.beatId,
      chapter: beat.chapter,
      role: beat.role,
      unitIds: beat.unitIds,
      summary: beat.summary,
      payoff: beat.payoff,
    })),
    units: narrationProjection.units,
    intents: intentPlan.intents.map((intent) => ({
      visualIntentId: intent.visualIntentId,
      chapter: intent.chapter,
      beatIds: intent.beatIds,
      intent: intent.intent,
      strategy: intent.strategy,
      objective: intent.objective,
      subjectKind: intent.subject.kind,
      subjectLabel: intent.subject.label,
      displayText: intent.displayText?.text ?? null,
      continuationOfVisualIntentId: intent.continuationOfVisualIntentId,
    })),
  };
}

/**
 * Visual Intent Planner 安全投影（M7.3A §七）。
 *
 * LLM 的唯一输入是从「精确 Narrative Beats artifact」+ 其 provenance 指向的
 * 「精确 Narration Plan V2 artifact」生成的 sanitized projection：
 * - beats 只暴露 beatId/chapter/role/unitIds/summary/payoff；
 * - units 复用 Beat Planner 同款安全投影（speech: id/chapter/spokenText/
 *   subtitleText/delivery/evidenceIds；silence: id/chapter/durationMs/reason）；
 * - chapters 只暴露 chapter/title；
 * - 禁止包含 sourceText / raw script_v2 / 旧括号导演指令 / 旧 beat_map /
 *   visual_breakdown / shot_list / scenes / narrationSummary /
 *   asset bindings / render payload。
 */

import {
  buildBeatPlannerInput,
  hashPrompt,
  type BeatPlannerUnit,
} from '../narrative-beats/projection';
import type {NarrativeBeatsArtifactV1} from '../narrative-beats/schema';
import type {NarrationPlanV2} from '../narration/schema-v2';

export {hashPrompt};

export interface VisualIntentPlannerBeat {
  beatId: string;
  chapter: number;
  role: string;
  unitIds: string[];
  /** 编辑备注（供 LLM 理解语义），永不上屏。 */
  summary: string;
  payoff: string | null;
}

export interface VisualIntentPlannerInput {
  chapters: Array<{chapter: number; title: string}>;
  beats: VisualIntentPlannerBeat[];
  units: BeatPlannerUnit[];
}

/** 从精确 beats artifact + 精确 narration plan 生成 sanitized projection。 */
export function buildVisualIntentPlannerInput(
  beatsArtifact: NarrativeBeatsArtifactV1,
  plan: NarrationPlanV2,
): VisualIntentPlannerInput {
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
  };
}

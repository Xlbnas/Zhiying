/**
 * Shots Planner 安全投影（M7.3B）。
 *
 * LLM 的唯一输入是从「精确 Visual Sequences artifact」+ 其 provenance 指向的
 * 「精确 Narrative Beats / Visual Intent Plan / Narration Plan V2 artifact」
 * 生成的 sanitized projection：
 * - sequences 只暴露 sequenceId/chapter/beatIds/visualIntentIds；
 * - beats/intents/units 复用与 sequence planner 相同的安全投影；
 * - 禁止包含 sourceText / raw script_v2 / 旧括号导演指令 / 旧 beat_map /
 *   visual_breakdown / shot_list / scenes / asset bindings / render payload /
 *   任何 timing 字段。
 */

import type {NarrativeBeatsArtifactV1} from '../narrative-beats/schema';
import {
  buildBeatPlannerInput,
  hashPrompt,
  type BeatPlannerUnit,
} from '../narrative-beats/projection';
import type {NarrationPlanV2} from '../narration/schema-v2';
import type {VisualIntentPlanArtifactV1} from '../visual-intent/schema';
import type {VisualSequencesArtifactV1} from '../visual-sequences/schema';

export {hashPrompt};

export interface ShotPlannerSequence {
  sequenceId: string;
  chapter: number;
  beatIds: string[];
  visualIntentIds: string[];
}

export interface ShotPlannerBeat {
  beatId: string;
  chapter: number;
  role: string;
  unitIds: string[];
  summary: string;
  payoff: string | null;
}

export interface ShotPlannerIntent {
  visualIntentId: string;
  chapter: number;
  beatIds: string[];
  intent: string;
  strategy: string;
  continuationOfVisualIntentId: string | null;
}

export interface ShotPlannerInput {
  chapters: Array<{chapter: number; title: string}>;
  sequences: ShotPlannerSequence[];
  beats: ShotPlannerBeat[];
  units: BeatPlannerUnit[];
  intents: ShotPlannerIntent[];
}

/** 从精确 sequences + beats + intent + narration plan 生成 sanitized projection。 */
export function buildShotPlannerInput(
  sequencesArtifact: VisualSequencesArtifactV1,
  beatsArtifact: NarrativeBeatsArtifactV1,
  intentPlan: VisualIntentPlanArtifactV1,
  plan: NarrationPlanV2,
): ShotPlannerInput {
  const narrationProjection = buildBeatPlannerInput(plan);
  return {
    chapters: narrationProjection.chapters,
    sequences: sequencesArtifact.sequences.map((seq) => ({
      sequenceId: seq.sequenceId,
      chapter: seq.chapter,
      beatIds: seq.beatIds,
      visualIntentIds: seq.visualIntentIds,
    })),
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
      continuationOfVisualIntentId: intent.continuationOfVisualIntentId,
    })),
  };
}

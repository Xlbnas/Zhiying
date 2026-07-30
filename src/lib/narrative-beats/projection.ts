/**
 * Beat Planner 安全投影（M7.2 §七）。
 *
 * LLM 的唯一输入是从「精确 narration plan v2 artifact」生成的 sanitized
 * projection：
 * - 禁止包含 sourceText / raw script_v2 / 旧括号导演指令 / 旧 beat_map /
 *   visual_breakdown / shot_list / scenes / narrationSummary；
 * - speech 只暴露 spokenText/subtitleText/delivery/evidenceIds；
 * - silence 只暴露 durationMs/reason。
 */

import crypto from 'node:crypto';
import type {NarrationPlanV2} from '../narration/schema-v2';
import type {Delivery} from '../narration/schema-v2';

export type BeatPlannerUnit =
  | {
      id: string;
      chapter: number;
      kind: 'speech';
      spokenText: string;
      subtitleText: string | null;
      delivery: Delivery;
      evidenceIds: string[];
    }
  | {
      id: string;
      chapter: number;
      kind: 'silence';
      durationMs: number;
      reason: 'pause' | 'visual_breath';
    };

export interface BeatPlannerInput {
  chapters: Array<{chapter: number; title: string}>;
  units: BeatPlannerUnit[];
}

/** 从精确 plan 生成 sanitized projection（绝不包含 sourceText）。 */
export function buildBeatPlannerInput(plan: NarrationPlanV2): BeatPlannerInput {
  return {
    chapters: plan.chapters.map((c) => ({chapter: c.chapter, title: c.title})),
    units: plan.units.map((unit): BeatPlannerUnit => {
      if (unit.kind === 'speech') {
        return {
          id: unit.id,
          chapter: unit.chapter,
          kind: 'speech',
          spokenText: unit.spokenText,
          subtitleText: unit.subtitleText,
          delivery: unit.delivery,
          evidenceIds: unit.evidenceIds,
        };
      }
      return {
        id: unit.id,
        chapter: unit.chapter,
        kind: 'silence',
        durationMs: unit.durationMs,
        reason: unit.reason,
      };
    }),
  };
}

/** prompt 内容 hash（dry-run/审计用）：sha256(system + '\n' + user)。 */
export function hashPrompt(system: string, user: string): string {
  return `sha256:${crypto.createHash('sha256').update(`${system}\n${user}`, 'utf8').digest('hex')}`;
}

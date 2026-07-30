/**
 * Narrative Beats deterministic coverage validator（M7.2）。
 *
 * 只校验，不修数据：
 * - 不得自动补 unit、移动 unit、合并/拆分 beat 或重排 beat；
 * - 全部问题以 issues 返回（fail-closed，列全不短路），
 *   由 generate 层进入有限 repair；repair 仍失败则本次 generation 失败。
 *
 * 覆盖规则（提示词 §六）：
 *  1. beatId 严格 B001…B00N 连续；
 *  2. 每个 beat.unitIds 非空（zod 已保证，防御性复查）；
 *  3. 每个 unit ID 存在于精确来源 plan；
 *  4-6. 每个 narration unit 恰好出现一次（不重复、不遗漏）；
 *  8. 每个 beat 的 unit range 在 plan 顺序中连续；
 *  9. beats 全局顺序与 narration units 顺序一致；
 * 10-11. beat 不跨 chapter：beat.chapter 等于其全部 units 的 chapter；
 * 12. 纯 silence beat → role 必须 pause；
 * 13. 含 speech 的 beat → role 不得 pause；
 * 附加：forbidden 下游字段显式拒绝；summary/payoff 内容卫生（leakage）。
 */

import {findDirectiveLeakage, describeLeakage} from '../narration/leakage';
import type {NarrationPlanV2} from '../narration/schema-v2';
import {FORBIDDEN_BEAT_FIELDS, type NarrativeBeatV1} from './schema';

export interface BeatValidationIssue {
  code: string;
  message: string;
}

export function validateNarrativeBeatsCoverage(
  plan: NarrationPlanV2,
  beats: NarrativeBeatV1[],
): BeatValidationIssue[] {
  const issues: BeatValidationIssue[] = [];
  const push = (code: string, message: string): void => {
    issues.push({code, message});
  };

  const indexByUnitId = new Map<string, number>();
  plan.units.forEach((unit, index) => indexByUnitId.set(unit.id, index));

  // 1. beatId 严格连续
  beats.forEach((beat, index) => {
    const expected = `B${String(index + 1).padStart(3, '0')}`;
    if (beat.beatId !== expected) {
      push('BEAT_ID_SEQUENCE', `beats[${index}] beatId 必须是 ${expected}（实际 ${beat.beatId}）`);
    }
  });

  const seenUnitIds = new Set<string>();
  /** 每个 beat 在 plan 顺序中的 index 区间（供全局顺序检查）。 */
  const beatRanges: Array<{beatId: string; indexes: number[]}> = [];

  for (const beat of beats) {
    // 2. unitIds 非空（zod 防御层之外的语义层复查）
    if (beat.unitIds.length === 0) {
      push('EMPTY_UNIT_IDS', `${beat.beatId} unitIds 为空`);
      continue;
    }

    // forbidden 下游/timing/视觉字段（防御未来 schema 演进）
    const beatRecord = beat as unknown as Record<string, unknown>;
    for (const field of FORBIDDEN_BEAT_FIELDS) {
      if (field in beatRecord) {
        push('FORBIDDEN_FIELD', `${beat.beatId} 含禁止字段 ${field}`);
      }
    }

    const indexes: number[] = [];
    let hasSpeech = false;
    let silenceCount = 0;
    for (const unitId of beat.unitIds) {
      // 3. unit 存在
      const planIndex = indexByUnitId.get(unitId);
      if (planIndex === undefined) {
        push('UNKNOWN_UNIT_ID', `${beat.beatId} 引用不存在的 unit ${unitId}`);
        continue;
      }
      // 4. 不重复
      if (seenUnitIds.has(unitId)) {
        push('DUPLICATE_UNIT', `unit ${unitId} 被多个 beat 重复引用（含 ${beat.beatId}）`);
      }
      seenUnitIds.add(unitId);
      indexes.push(planIndex);

      const unit = plan.units[planIndex]!;
      if (unit.kind === 'speech') hasSpeech = true;
      else silenceCount++;
      // 10/11. chapter 一致（不跨 chapter）
      if (unit.chapter !== beat.chapter) {
        push(
          'CHAPTER_MISMATCH',
          `${beat.beatId} chapter=${beat.chapter}，但 ${unitId} 属于 chapter ${unit.chapter}（beat 不得跨 chapter）`,
        );
      }
    }

    // 8. beat 内 unit range 连续
    if (indexes.length > 1) {
      const sorted = [...indexes].sort((a, b) => a - b);
      const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1]! + 1);
      if (!contiguous) {
        push('NON_CONTIGUOUS_RANGE', `${beat.beatId} 的 unit 在 narration 顺序中不连续`);
      }
    }
    beatRanges.push({beatId: beat.beatId, indexes});

    // 12/13. role 规则
    if (!hasSpeech && silenceCount > 0 && beat.role !== 'pause') {
      push('SILENCE_BEAT_ROLE', `${beat.beatId} 全部由 silence 构成，role 必须是 pause（实际 ${beat.role}）`);
    }
    if (hasSpeech && beat.role === 'pause') {
      push('SPEECH_BEAT_ROLE_PAUSE', `${beat.beatId} 含 speech unit，role 不得为 pause`);
    }

    // summary/payoff 内容卫生（编辑备注也不得含指令语法位）
    const summaryLeak = findDirectiveLeakage(beat.summary);
    if (summaryLeak.length > 0) {
      push('SUMMARY_LEAKAGE', `${beat.beatId} summary 含指令泄漏：${describeLeakage(summaryLeak)}`);
    }
    if (beat.payoff !== null) {
      const payoffLeak = findDirectiveLeakage(beat.payoff);
      if (payoffLeak.length > 0) {
        push('PAYOFF_LEAKAGE', `${beat.beatId} payoff 含指令泄漏：${describeLeakage(payoffLeak)}`);
      }
    }
  }

  // 5/6. 遗漏（complete coverage 的另一半）
  for (const unit of plan.units) {
    if (!seenUnitIds.has(unit.id)) {
      push('MISSING_UNIT', `unit ${unit.id}（${unit.kind}）未被任何 beat 覆盖`);
    }
  }

  // 9. 全局顺序：所有 beat 的 plan index 序列必须全局非递减（范围不重叠不倒序）
  let previousMax = -1;
  for (const range of beatRanges) {
    if (range.indexes.length === 0) continue;
    const min = Math.min(...range.indexes);
    const max = Math.max(...range.indexes);
    if (min <= previousMax) {
      push('BEAT_ORDER', `${range.beatId} 的 unit 顺序与 narration 全局顺序不一致（与前一个 beat 重叠或倒序）`);
    }
    previousMax = Math.max(previousMax, max);
  }

  return issues;
}

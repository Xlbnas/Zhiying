/**
 * Shots 确定性语义校验（M7.3B §6.3）。
 *
 * 只读校验，绝不改写输入；issue 使用稳定机器码（collected，不短路）。
 * - 阻断性 issue → classify invalid_source；
 * - SHOT_NEEDS_REVIEW（引用 VISUAL_UNRESOLVED）→ 非阻断，映射 needs_review。
 */

import type {NarrativeBeatsArtifactV1, NarrativeBeatV1} from '../narrative-beats/schema';
import type {NarrationPlanV2} from '../narration/schema-v2';
import type {VisualIntentV1} from '../visual-intent/schema';
import type {VisualSequencesArtifactV1} from '../visual-sequences/schema';
import {FORBIDDEN_SHOT_FIELDS, type ShotV1} from './schema';

export interface ShotValidationIssue {
  code: string;
  message: string;
}

/**
 * forbidden 字段 hard-fail（SHOT_FORBIDDEN_FIELD）。
 * 输入为未解析 raw（schema .strict() 之前）；返回命中清单（空 = 通过）。
 */
export function scanForbiddenShotKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const hits: string[] = [];
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_SHOT_FIELDS as readonly string[]).includes(key)) {
        hits.push(key);
      }
      scan(child);
    }
  };
  scan(raw);
  return hits;
}

/**
 * 校验 shots 对 exact sequences artifact / beats / visual intent plan /
 * narration plan v2 的覆盖/连续性/引用一致性。
 * @param sequencesArtifact exact Visual Sequences artifact（含 .sequences 与 .source）。
 * @param beatsArtifact exact Narrative Beats artifact（beat → unitIds 展开源）。
 * @param intents exact Visual Intent Plan artifact 的 intents。
 * @param plan exact Narration Plan V2（unit 全局顺序）。
 * @param shots 待校验的 shots。
 */
export function validateShots(
  sequencesArtifact: VisualSequencesArtifactV1,
  beatsArtifact: NarrativeBeatsArtifactV1,
  intents: VisualIntentV1[],
  plan: NarrationPlanV2,
  shots: ShotV1[],
): ShotValidationIssue[] {
  const issues: ShotValidationIssue[] = [];
  const sequences = sequencesArtifact.sequences;
  const beats = beatsArtifact.beats;

  // shotId 唯一 + 严格连续 H001…Hnnn
  const seenIds = new Set<string>();
  for (const shot of shots) {
    if (seenIds.has(shot.shotId)) {
      issues.push({code: 'SHOT_ID_DUPLICATE', message: `shotId ${shot.shotId} 重复出现`});
    }
    seenIds.add(shot.shotId);
  }
  shots.forEach((shot, i) => {
    const expected = `H${String(i + 1).padStart(3, '0')}`;
    if (shot.shotId !== expected) {
      issues.push({
        code: 'SHOT_ID_SEQUENCE_BROKEN',
        message: `第 ${i + 1} 个 shot 的 shotId=${shot.shotId}，期望 ${expected}`,
      });
    }
  });

  // 索引：unit 全局顺序（narration plan v2）、beat→units、sequence→beats/units、intent→beats/units
  const unitPos = new Map<string, number>();
  plan.units.forEach((unit, i) => unitPos.set(unit.id, i));
  const beatByUnit = new Map<string, NarrativeBeatV1>();
  for (const beat of beats) {
    for (const unitId of beat.unitIds) beatByUnit.set(unitId, beat);
  }
  const sequenceByUnit = new Map<string, {sequenceId: string; chapter: number}>();
  for (const seq of sequences) {
    for (const beatId of seq.beatIds) {
      const beat = beats.find((b) => b.beatId === beatId);
      if (!beat) continue;
      for (const unitId of beat.unitIds) {
        sequenceByUnit.set(unitId, {sequenceId: seq.sequenceId, chapter: seq.chapter});
      }
    }
  }
  const seqDef = new Map(sequences.map((seq) => [seq.sequenceId, seq]));
  const intentDef = new Map(intents.map((intent) => [intent.visualIntentId, intent]));
  const unitsOfSequence = (sequenceId: string): string[] => {
    const seq = seqDef.get(sequenceId);
    if (!seq) return [];
    const units: string[] = [];
    for (const beatId of seq.beatIds) {
      const beat = beats.find((b) => b.beatId === beatId);
      if (beat) units.push(...beat.unitIds);
    }
    return units.sort((a, b) => (unitPos.get(a) ?? -1) - (unitPos.get(b) ?? -1));
  };
  const intentUnits = new Map<string, Set<string>>();
  for (const intent of intents) {
    const units = new Set<string>();
    for (const beatId of intent.beatIds) {
      const beat = beats.find((b) => b.beatId === beatId);
      if (beat) for (const unitId of beat.unitIds) units.add(unitId);
    }
    intentUnits.set(intent.visualIntentId, units);
  }

  // sequenceId 存在 + shot 顺序与 exact sequences artifact 一致（不交错）
  const seqIndex = new Map<string, number>();
  sequences.forEach((seq, i) => seqIndex.set(seq.sequenceId, i));
  for (const shot of shots) {
    if (!seqDef.has(shot.sequenceId)) {
      issues.push({
        code: 'SHOT_SEQUENCE_NOT_FOUND',
        message: `shot ${shot.shotId} 引用不存在的 sequence ${shot.sequenceId}`,
      });
    }
  }
  {
    const seenSeqOrder: string[] = [];
    const posInShots = new Map<string, number>();
    shots.forEach((shot, i) => {
      if (!seqIndex.has(shot.sequenceId)) return;
      const prev = posInShots.get(shot.sequenceId);
      if (prev === undefined) {
        posInShots.set(shot.sequenceId, i);
        seenSeqOrder.push(shot.sequenceId);
      } else {
        // 同一 sequence 的 shot 再次出现：检查其间没有其他 sequence 的 shot
        for (let j = prev + 1; j < i; j++) {
          if (shots[j]!.sequenceId !== shot.sequenceId) {
            issues.push({
              code: 'SHOT_SEQUENCE_CROSSING',
              message: `shot ${shot.shotId}：sequence ${shot.sequenceId} 的 shots 与其他 sequence 交错，顺序与 exact sequences artifact 不一致`,
            });
            break;
          }
        }
        posInShots.set(shot.sequenceId, i);
      }
    });
  }

  // 每个 sequence 至少一个 shot
  for (const seq of sequences) {
    if (!shots.some((shot) => shot.sequenceId === seq.sequenceId)) {
      issues.push({
        code: 'SHOT_SEQUENCE_UNCOVERED',
        message: `sequence ${seq.sequenceId} 没有任何 shot`,
      });
    }
  }

  // 全局 unit 覆盖：遗漏（GAP）/ 重复（OVERLAP / shot 内 DUPLICATE）
  const coveredBy = new Map<string, string>();
  for (const shot of shots) {
    const withinShot = new Set<string>();
    for (const unitId of shot.unitIds) {
      if (!unitPos.has(unitId)) {
        issues.push({
          code: 'SHOT_UNIT_NOT_FOUND',
          message: `shot ${shot.shotId} 引用不存在的 unit ${unitId}`,
        });
        continue;
      }
      if (withinShot.has(unitId)) {
        issues.push({
          code: 'SHOT_UNIT_DUPLICATE',
          message: `shot ${shot.shotId} 内重复引用 unit ${unitId}`,
        });
        continue;
      }
      withinShot.add(unitId);
      const prev = coveredBy.get(unitId);
      if (prev !== undefined) {
        issues.push({
          code: 'SHOT_UNIT_OVERLAP',
          message: `unit ${unitId} 同时属于 shot ${prev} 与 ${shot.shotId}`,
        });
      } else {
        coveredBy.set(unitId, shot.shotId);
      }
      // 规则 6：unit 必须属于本 shot 的 sequence
      const owner = sequenceByUnit.get(unitId);
      if (owner && owner.sequenceId !== shot.sequenceId) {
        issues.push({
          code: 'SHOT_SEQUENCE_CROSSING',
          message: `shot ${shot.shotId} 的 unit ${unitId} 属于 sequence ${owner.sequenceId}，跨 sequence`,
        });
      }
    }
  }
  // 遗漏：sequence 的 units（speech + silence 都在内）未被任何 shot 覆盖
  for (const seq of sequences) {
    for (const unitId of unitsOfSequence(seq.sequenceId)) {
      if (!coveredBy.has(unitId)) {
        issues.push({
          code: 'SHOT_UNIT_COVERAGE_GAP',
          message: `unit ${unitId}（sequence ${seq.sequenceId}）未被任何 shot 覆盖`,
        });
      }
    }
  }

  for (const shot of shots) {
    const seq = seqDef.get(shot.sequenceId);
    if (!seq) continue;

    // 规则 7：chapter 与 parent sequence 一致
    if (shot.chapter !== seq.chapter) {
      issues.push({
        code: 'SHOT_CHAPTER_MISMATCH',
        message: `shot ${shot.shotId} chapter=${shot.chapter} 与 parent sequence ${shot.sequenceId} 的 chapter=${seq.chapter} 不一致`,
      });
    }

    // 规则 12：shot 内 unitIds 在 Narration Plan V2 中连续
    for (let i = 1; i < shot.unitIds.length; i++) {
      const a = unitPos.get(shot.unitIds[i - 1]!);
      const b = unitPos.get(shot.unitIds[i]!);
      if (a === undefined || b === undefined) continue;
      if (b !== a + 1) {
        issues.push({
          code: 'SHOT_UNIT_NON_CONTIGUOUS',
          message: `shot ${shot.shotId} 的 unitIds 在 narration plan 中不连续（${shot.unitIds[i - 1]} → ${shot.unitIds[i]}）`,
        });
        break;
      }
    }

    // 规则 15/16/17：intent 引用属于 parent sequence，shot unit 范围落在
    // 该 intent 覆盖范围内，且不跨越多个 intent
    const intent = intentDef.get(shot.visualIntentId);
    if (!intent) {
      issues.push({
        code: 'SHOT_INTENT_NOT_FOUND',
        message: `shot ${shot.shotId} 引用不存在的 visual intent ${shot.visualIntentId}`,
      });
    } else {
      if (!seq.visualIntentIds.includes(shot.visualIntentId)) {
        issues.push({
          code: 'SHOT_INTENT_OUTSIDE_SEQUENCE',
          message: `shot ${shot.shotId} 的 intent ${shot.visualIntentId} 不属于 parent sequence ${shot.sequenceId}`,
        });
      }
      const allowed = intentUnits.get(shot.visualIntentId) ?? new Set<string>();
      let crossed = false;
      for (const unitId of shot.unitIds) {
        if (!allowed.has(unitId)) {
          crossed = true;
          break;
        }
      }
      // 跨 intent：unit 的意图归属（经 beatByUnit → 覆盖该 beat 的 intent）必须全部相同
      const unitIntentIds = new Set<string>();
      for (const unitId of shot.unitIds) {
        const beat = beatByUnit.get(unitId);
        if (!beat) continue;
        const covering = intents.filter((i) => i.beatIds.includes(beat.beatId));
        for (const i of covering) unitIntentIds.add(i.visualIntentId);
      }
      if (unitIntentIds.size > 1 || (unitIntentIds.size === 1 && !unitIntentIds.has(shot.visualIntentId))) {
        crossed = true;
      }
      if (crossed) {
        issues.push({
          code: 'SHOT_INTENT_BOUNDARY_CROSSING',
          message: `shot ${shot.shotId} 的 unit 范围超出 intent ${shot.visualIntentId} 覆盖范围或跨越多个 intent`,
        });
      }
      // 规则 18：VISUAL_UNRESOLVED 可引用 → 非阻断 NEEDS_REVIEW
      if (intent.intent === 'VISUAL_UNRESOLVED') {
        issues.push({
          code: 'SHOT_NEEDS_REVIEW',
          message: `shot ${shot.shotId} 引用 VISUAL_UNRESOLVED intent ${shot.visualIntentId}，需人工处理`,
        });
      }
    }
  }

  // 规则 13/14：同 sequence 内 shots 的 unitIds 有序连续；并集 == sequence units
  for (const seq of sequences) {
    const seqShots = shots.filter((shot) => shot.sequenceId === seq.sequenceId);
    const seqUnits = unitsOfSequence(seq.sequenceId);
    const allUnits: string[] = [];
    for (const shot of seqShots) {
      allUnits.push(...shot.unitIds.filter((u) => unitPos.has(u)));
    }
    for (let i = 1; i < allUnits.length; i++) {
      const a = unitPos.get(allUnits[i - 1]!);
      const b = unitPos.get(allUnits[i]!);
      if (a === undefined || b === undefined) continue;
      if (b !== a + 1) {
        issues.push({
          code: 'SHOT_UNIT_NON_CONTIGUOUS',
          message: `sequence ${seq.sequenceId} 内 shots 的 unitIds 拼接后不连续（${allUnits[i - 1]} → ${allUnits[i]}）`,
        });
        break;
      }
    }
    const union = new Set(allUnits);
    const exact =
      union.size === seqUnits.length && seqUnits.every((u) => union.has(u));
    if (!exact) {
      issues.push({
        code: 'SHOT_UNIT_COVERAGE_MISMATCH',
        message: `sequence ${seq.sequenceId} 的 shots unit 并集与其 beats 引用 unit 并集不一致`,
      });
    }
  }

  // 转场规则 19-22
  shots.forEach((shot, i) => {
    const prev = shots[i - 1];
    if (i === 0) {
      if (shot.transitionFromPrevious !== 'cut') {
        issues.push({
          code: 'SHOT_TRANSITION_INVALID',
          message: `第一条 shot ${shot.shotId} 的 transitionFromPrevious=${shot.transitionFromPrevious}，必须为 cut`,
        });
      }
      return;
    }
    if (!prev) return;
    // 规则 20：新 sequence 首 shot 不允许 state_morph/hold
    if (prev.sequenceId !== shot.sequenceId) {
      if (shot.transitionFromPrevious === 'state_morph' || shot.transitionFromPrevious === 'hold') {
        issues.push({
          code: 'SHOT_TRANSITION_INVALID',
          message: `新 sequence ${shot.sequenceId} 的首 shot ${shot.shotId} 不允许 ${shot.transitionFromPrevious}`,
        });
      }
      return;
    }
    // 规则 21：state_morph 仅同 sequence 内（已满足 prev.sequenceId === shot.sequenceId）
    // 规则 22：hold 必须保持同一 visualIntentId 或引用合法 continuation intent
    if (shot.transitionFromPrevious === 'hold') {
      const sameIntent = shot.visualIntentId === prev.visualIntentId;
      const currentIntent = intentDef.get(shot.visualIntentId);
      const legalContinuation =
        currentIntent !== undefined &&
        (currentIntent.intent === 'CONTINUE_PREVIOUS_VISUAL' || currentIntent.intent === 'NO_VISUAL_CHANGE') &&
        currentIntent.continuationOfVisualIntentId === prev.visualIntentId;
      if (!sameIntent && !legalContinuation) {
        issues.push({
          code: 'SHOT_TRANSITION_INVALID',
          message: `shot ${shot.shotId} 的 transition=hold 未保持同一 intent 也未引用合法 continuation intent`,
        });
      }
    }
  });

  return issues;
}

/** 非阻断 issue 码：classify 映射 needs_review 而非 invalid。 */
export const SHOT_NON_BLOCKING_CODES = new Set(['SHOT_NEEDS_REVIEW']);

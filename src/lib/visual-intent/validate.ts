/**
 * Visual Intent Plan deterministic validator（M7.3A）。
 *
 * 只校验，不修数据：
 * - 不得自动补 beat、重排/合并/拆分 intent、猜 subject、把
 *   VISUAL_UNRESOLVED 改成 MG 或任何其他「帮助性」修改；
 * - 全部问题以 issues 返回（fail-closed，列全不短路），
 *   由 generate 层进入有限 repair；repair 仍失败则本次 generation 失败。
 *
 * 规则（提示词契约 §六）：
 *  1. visualIntentId 严格 V001…V00N 连续；
 *  2. 每个 intent.beatIds 非空（zod 已保证，防御性复查）；
 *  3. 每个 beatId 存在于精确来源 beats；
 *  4-6. 每个 Narrative Beat 恰好出现一次（不重复、不遗漏）；
 *  7. 每个 intent 的 beat range 在 beats 顺序中连续；
 *  8. intents 全局顺序与 beats 顺序一致（previousMax 算法）；
 *  9-10. intent 不跨 chapter；intent.chapter 等于其全部 beats 的 chapter；
 * 12. intent↔strategy↔authenticity↔subject 矩阵 + displayText 精确引用 +
 *     continuation 链 + V001 不得为 continuation + unresolved 形态；
 * 13. objective/subject.label/displayText.text 内容卫生（leakage）；
 * 14. forbidden 下游字段显式拒绝。
 */

import type {NarrativeBeatV1} from '../narrative-beats/schema';
import {findDirectiveLeakage, describeLeakage} from '../narration/leakage';
import type {NarrationPlanV2} from '../narration/schema-v2';
import {
  FORBIDDEN_INTENT_FIELDS,
  type AuthenticityRequirement,
  type VisualIntentV1,
  type VisualStrategy,
} from './schema';

export interface VisualIntentIssue {
  code: string;
  message: string;
}

/** intent kind → 允许的 strategy 闭集（矩阵，冻结）。 */
const STRATEGY_MATRIX: Record<string, readonly VisualStrategy[]> = {
  SHOW_PERSON: ['portrait', 'archive_photo'],
  SHOW_PLACE: ['archive_photo', 'archive_video'],
  SHOW_ARCHIVE: ['archive_photo', 'archive_video'],
  SHOW_DOCUMENT: ['document_frame', 'evidence_frame'],
  SHOW_EVIDENCE: ['document_frame', 'evidence_frame'],
  SHOW_EXAMPLE: ['real_world_example'],
  SHOW_PROCESS: ['mg_process'],
  SHOW_RELATIONSHIP: ['mg_relationship'],
  SHOW_COMPARISON: ['mg_comparison'],
  SHOW_DATA: ['mg_data'],
  EMPHASIZE_TEXT: ['title_card'],
  CONTINUE_PREVIOUS_VISUAL: ['continue_previous'],
  NO_VISUAL_CHANGE: ['hold'],
  VISUAL_UNRESOLVED: ['unresolved'],
};

/** intent kind → authenticity 约束（'eq'=必须等于；'neq'=不得等于；null=不约束）。 */
const AUTHENTICITY_MATRIX: Record<
  string,
  {eq?: AuthenticityRequirement; neq?: AuthenticityRequirement} | null
> = {
  SHOW_PERSON: {neq: 'synthetic_allowed'},
  SHOW_PLACE: {eq: 'authentic_required'},
  SHOW_ARCHIVE: {eq: 'authentic_required'},
  SHOW_DOCUMENT: {eq: 'authentic_required'},
  SHOW_EVIDENCE: {eq: 'authentic_required'},
  SHOW_EXAMPLE: null,
  SHOW_PROCESS: null,
  SHOW_RELATIONSHIP: null,
  SHOW_COMPARISON: null,
  SHOW_DATA: null,
  EMPHASIZE_TEXT: {eq: 'not_applicable'},
  CONTINUE_PREVIOUS_VISUAL: {eq: 'inherited'},
  NO_VISUAL_CHANGE: {eq: 'inherited'},
  VISUAL_UNRESOLVED: {eq: 'not_applicable'},
};

const CONTINUATION_KINDS = new Set(['CONTINUE_PREVIOUS_VISUAL', 'NO_VISUAL_CHANGE']);
/** continuation 目标的合法 kind：非 continuation 且非 unresolved。 */
function isValidContinuationTarget(kind: string): boolean {
  return !CONTINUATION_KINDS.has(kind) && kind !== 'VISUAL_UNRESOLVED';
}

export function validateVisualIntentPlan(
  beats: NarrativeBeatV1[],
  plan: NarrationPlanV2,
  intents: VisualIntentV1[],
): VisualIntentIssue[] {
  const issues: VisualIntentIssue[] = [];
  const push = (code: string, message: string): void => {
    issues.push({code, message});
  };

  const indexByBeatId = new Map<string, number>();
  beats.forEach((beat, index) => indexByBeatId.set(beat.beatId, index));
  const unitById = new Map(plan.units.map((u) => [u.id, u] as const));
  const titleByChapter = new Map(plan.chapters.map((c) => [c.chapter, c.title] as const));

  // 1. visualIntentId 严格连续
  intents.forEach((intent, index) => {
    const expected = `V${String(index + 1).padStart(3, '0')}`;
    if (intent.visualIntentId !== expected) {
      push(
        'INTENT_ID_SEQUENCE',
        `intents[${index}] visualIntentId 必须是 ${expected}（实际 ${intent.visualIntentId}）`,
      );
    }
  });

  const seenBeatIds = new Set<string>();
  /** 每个 intent 在 beats 顺序中的 index 区间（供全局顺序检查）。 */
  const intentRanges: Array<{visualIntentId: string; indexes: number[]}> = [];

  intents.forEach((intent, intentIndex) => {
    const id = intent.visualIntentId;

    // forbidden 下游/timing/asset 字段（防御未来 schema 演进）
    const intentRecord = intent as unknown as Record<string, unknown>;
    for (const field of FORBIDDEN_INTENT_FIELDS) {
      if (field in intentRecord) {
        push('FORBIDDEN_FIELD', `${id} 含禁止字段 ${field}`);
      }
    }

    // 2. beatIds 非空（zod 防御层之外的语义层复查）
    if (intent.beatIds.length === 0) {
      push('EMPTY_BEAT_IDS', `${id} beatIds 为空`);
      return;
    }

    const indexes: number[] = [];
    const chapters = new Set<number>();
    for (const beatId of intent.beatIds) {
      // 3. beat 存在
      const beatIndex = indexByBeatId.get(beatId);
      if (beatIndex === undefined) {
        push('UNKNOWN_BEAT_ID', `${id} 引用不存在的 beat ${beatId}`);
        continue;
      }
      // 4. 不重复
      if (seenBeatIds.has(beatId)) {
        push('DUPLICATE_BEAT', `beat ${beatId} 被多个 intent 重复引用（含 ${id}）`);
      }
      seenBeatIds.add(beatId);
      indexes.push(beatIndex);
      chapters.add(beats[beatIndex]!.chapter);
    }

    // 7. intent 内 beat range 连续
    if (indexes.length > 1) {
      const sorted = [...indexes].sort((a, b) => a - b);
      const contiguous = sorted.every((v, i) => i === 0 || v === sorted[i - 1]! + 1);
      if (!contiguous) {
        push('NON_CONTIGUOUS_RANGE', `${id} 的 beat 在 beats 顺序中不连续`);
      }
    }
    intentRanges.push({visualIntentId: id, indexes});

    // 9. intent 不跨 chapter
    if (chapters.size > 1) {
      push(
        'CROSS_CHAPTER',
        `${id} 的 beats 横跨 chapter ${[...chapters].sort((a, b) => a - b).join('/')}（intent 不得跨 chapter）`,
      );
    }
    // 10. intent.chapter 等于其全部 beats 的 chapter
    if (chapters.size === 1) {
      const beatChapter = [...chapters][0]!;
      if (intent.chapter !== beatChapter) {
        push(
          'CHAPTER_MISMATCH',
          `${id} chapter=${intent.chapter}，但其 beats 属于 chapter ${beatChapter}`,
        );
      }
    }

    // 12. intent↔strategy↔authenticity↔subject 矩阵
    const allowedStrategies = STRATEGY_MATRIX[intent.intent];
    if (allowedStrategies && !allowedStrategies.includes(intent.strategy)) {
      push(
        'STRATEGY_MISMATCH',
        `${id} intent=${intent.intent} 不允许 strategy=${intent.strategy}（允许 ${allowedStrategies.join('|')}）`,
      );
    }
    const authRule = AUTHENTICITY_MATRIX[intent.intent];
    if (authRule?.eq && intent.authenticity !== authRule.eq) {
      push(
        'AUTHENTICITY_MISMATCH',
        `${id} intent=${intent.intent} 的 authenticity 必须是 ${authRule.eq}（实际 ${intent.authenticity}）`,
      );
    }
    if (authRule?.neq && intent.authenticity === authRule.neq) {
      push(
        'AUTHENTICITY_MISMATCH',
        `${id} intent=${intent.intent} 的 authenticity 不得为 ${authRule.neq}（真实性要求）`,
      );
    }
    if (intent.intent === 'SHOW_PERSON' && intent.subject.kind !== 'person') {
      push('SUBJECT_KIND_MISMATCH', `${id} intent=SHOW_PERSON 的 subject.kind 必须是 person（实际 ${intent.subject.kind}）`);
    }
    if (CONTINUATION_KINDS.has(intent.intent) && intent.subject.kind !== 'none') {
      push('SUBJECT_KIND_MISMATCH', `${id} intent=${intent.intent} 的 subject.kind 必须是 none（实际 ${intent.subject.kind}）`);
    }

    // 12b. displayText 规则
    if (intent.intent === 'EMPHASIZE_TEXT') {
      if (intent.displayText === null) {
        push('DISPLAY_TEXT_REQUIRED', `${id} intent=EMPHASIZE_TEXT 必须携带 displayText（title card 精确引用）`);
      } else {
        const ref = intent.displayText;
        let sourceText: string | null = null;
        if (ref.sourceKind === 'spoken_exact' || ref.sourceKind === 'subtitle_exact') {
          if (ref.sourceUnitId === null) {
            push('DISPLAY_TEXT_SOURCE_MISSING', `${id} displayText.sourceKind=${ref.sourceKind} 必须携带 sourceUnitId`);
          } else {
            const unit = unitById.get(ref.sourceUnitId);
            if (!unit || unit.kind !== 'speech') {
              push('DISPLAY_TEXT_SOURCE_UNKNOWN', `${id} displayText 引用不存在/非 speech 的 unit ${ref.sourceUnitId}`);
            } else {
              sourceText = ref.sourceKind === 'spoken_exact' ? unit.spokenText : unit.subtitleText;
              if (sourceText === null) {
                push('DISPLAY_TEXT_SOURCE_UNKNOWN', `${id} displayText 引用的 unit ${ref.sourceUnitId} 无 subtitleText`);
              }
            }
          }
        } else {
          if (ref.sourceChapter === null) {
            push('DISPLAY_TEXT_SOURCE_MISSING', `${id} displayText.sourceKind=chapter_title 必须携带 sourceChapter`);
          } else {
            const title = titleByChapter.get(ref.sourceChapter);
            if (title === undefined) {
              push('DISPLAY_TEXT_SOURCE_UNKNOWN', `${id} displayText 引用不存在的 chapter ${ref.sourceChapter}`);
            } else {
              sourceText = title;
            }
          }
        }
        // 与引用源逐字一致
        if (sourceText !== null && ref.text !== sourceText) {
          push(
            'DISPLAY_TEXT_MISMATCH',
            `${id} displayText.text 与引用源（${ref.sourceKind}）不一致——title card 文本必须逐字精确引用`,
          );
        }
        // 不得等于任何 beat.summary/payoff（编辑备注不是上屏文案）
        for (const beat of beats) {
          if (ref.text === beat.summary || (beat.payoff !== null && ref.text === beat.payoff)) {
            push(
              'DISPLAY_TEXT_BEAT_COPY',
              `${id} displayText.text 等于 ${beat.beatId} 的 summary/payoff——编辑备注禁止作为上屏文案`,
            );
            break;
          }
        }
      }
    } else if (intent.displayText !== null) {
      push('DISPLAY_TEXT_FORBIDDEN', `${id} intent=${intent.intent} 不得携带 displayText（仅 EMPHASIZE_TEXT 允许）`);
    }

    // 12c. continuation 链
    if (CONTINUATION_KINDS.has(intent.intent)) {
      if (intentIndex === 0) {
        push('CONTINUATION_FIRST', `V001 不得为 ${intent.intent}（没有可延续的前序画面）`);
      }
      if (intent.continuationOfVisualIntentId === null) {
        push('CONTINUATION_REQUIRED', `${id} intent=${intent.intent} 必须携带 continuationOfVisualIntentId`);
      } else {
        // 必须引用此前最近的非 continuation、非 unresolved intent
        let expected: string | null = null;
        for (let j = intentIndex - 1; j >= 0; j--) {
          if (isValidContinuationTarget(intents[j]!.intent)) {
            expected = intents[j]!.visualIntentId;
            break;
          }
        }
        if (expected === null) {
          push('CONTINUATION_TARGET', `${id} 之前不存在合法的延续目标（非 continuation、非 unresolved 的 intent）`);
        } else if (intent.continuationOfVisualIntentId !== expected) {
          push(
            'CONTINUATION_TARGET',
            `${id} continuationOfVisualIntentId 必须引用此前最近的非 continuation/非 unresolved intent ${expected}（实际 ${intent.continuationOfVisualIntentId}）`,
          );
        }
      }
    } else if (intent.intent === 'VISUAL_UNRESOLVED') {
      if (intent.continuationOfVisualIntentId !== null) {
        push('CONTINUATION_FORBIDDEN', `${id} intent=VISUAL_UNRESOLVED 的 continuationOfVisualIntentId 必须为 null`);
      }
    } else if (intent.continuationOfVisualIntentId !== null) {
      push(
        'CONTINUATION_FORBIDDEN',
        `${id} intent=${intent.intent} 不得携带 continuationOfVisualIntentId（仅 CONTINUE_PREVIOUS_VISUAL/NO_VISUAL_CHANGE 允许）`,
      );
    }

    // 13. 内容卫生（编辑备注/上屏引用都不得含指令语法位）
    const objectiveLeak = findDirectiveLeakage(intent.objective);
    if (objectiveLeak.length > 0) {
      push('OBJECTIVE_LEAKAGE', `${id} objective 含指令泄漏：${describeLeakage(objectiveLeak)}`);
    }
    if (intent.subject.label !== null) {
      const labelLeak = findDirectiveLeakage(intent.subject.label);
      if (labelLeak.length > 0) {
        push('SUBJECT_LABEL_LEAKAGE', `${id} subject.label 含指令泄漏：${describeLeakage(labelLeak)}`);
      }
    }
    if (intent.displayText !== null) {
      const displayLeak = findDirectiveLeakage(intent.displayText.text);
      if (displayLeak.length > 0) {
        push('DISPLAY_TEXT_LEAKAGE', `${id} displayText.text 含指令泄漏：${describeLeakage(displayLeak)}`);
      }
    }
  });

  // 5/6. 遗漏（complete coverage 的另一半）
  for (const beat of beats) {
    if (!seenBeatIds.has(beat.beatId)) {
      push('MISSING_BEAT', `beat ${beat.beatId} 未被任何 intent 覆盖`);
    }
  }

  // 8. 全局顺序：所有 intent 的 beats index 序列必须全局非递减（范围不重叠不倒序）
  let previousMax = -1;
  for (const range of intentRanges) {
    if (range.indexes.length === 0) continue;
    const min = Math.min(...range.indexes);
    const max = Math.max(...range.indexes);
    if (min <= previousMax) {
      push(
        'INTENT_ORDER',
        `${range.visualIntentId} 的 beat 顺序与 beats 全局顺序不一致（与前一个 intent 重叠或倒序）`,
      );
    }
    previousMax = Math.max(previousMax, max);
  }

  return issues;
}

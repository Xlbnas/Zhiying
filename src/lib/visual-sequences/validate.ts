/**
 * Visual Sequences 确定性语义校验（M7.3B §5.3）。
 *
 * 只读校验，绝不改写输入；issue 使用稳定机器码（collected，不短路）。
 * 两类 issue：
 * - 阻断性（coverage/overlap/id 连续性/source 一致性等）→ classify invalid_source；
 * - SEQUENCE_NEEDS_REVIEW（引用 VISUAL_UNRESOLVED intent）→ 非阻断，
 *   classify 映射 needs_review——VISUAL_UNRESOLVED 允许保留，禁止自动改写为 MG。
 */

import type {NarrativeBeatV1} from '../narrative-beats/schema';
import type {VisualIntentV1} from '../visual-intent/schema';
import {FORBIDDEN_SEQUENCE_FIELDS, type VisualSequenceV1} from './schema';

export interface SequenceValidationIssue {
  code: string;
  message: string;
}

/**
 * forbidden 字段 hard-fail（SEQUENCE_FORBIDDEN_FIELD）。
 * 输入为未解析 raw（schema .strict() 之前）；返回命中清单（空 = 通过）。
 * 防御未来 schema 演进把下游/timing/视觉语义副本字段「合法化」。
 */
export function scanForbiddenSequenceKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const hits: string[] = [];
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_SEQUENCE_FIELDS as readonly string[]).includes(key)) {
        hits.push(key);
      }
      scan(child);
    }
  };
  scan(raw);
  return hits;
}

/**
 * 校验 sequences 对 exact beats + exact visual intent plan 的覆盖/连续性/引用一致性。
 * @param beats Narrative Beats artifact 的 beats（顺序即权威顺序）。
 * @param intents Visual Intent Plan artifact 的 intents。
 * @param sequences 待校验的 sequences。
 */
export function validateVisualSequences(
  beats: NarrativeBeatV1[],
  intents: VisualIntentV1[],
  sequences: VisualSequenceV1[],
): SequenceValidationIssue[] {
  const issues: SequenceValidationIssue[] = [];

  // sequenceId 唯一 + 严格连续 Q001…Qnnn
  const seenIds = new Set<string>();
  for (const seq of sequences) {
    if (seenIds.has(seq.sequenceId)) {
      issues.push({code: 'SEQUENCE_ID_DUPLICATE', message: `sequenceId ${seq.sequenceId} 重复出现`});
    }
    seenIds.add(seq.sequenceId);
  }
  sequences.forEach((seq, i) => {
    const expected = `Q${String(i + 1).padStart(3, '0')}`;
    if (seq.sequenceId !== expected) {
      issues.push({
        code: 'SEQUENCE_ID_SEQUENCE_BROKEN',
        message: `第 ${i + 1} 个 sequence 的 sequenceId=${seq.sequenceId}，期望 ${expected}`,
      });
    }
  });

  // beats 权威索引（顺序即全局顺序）
  const beatPos = new Map<string, number>();
  beats.forEach((beat, i) => beatPos.set(beat.beatId, i));
  const intentPos = new Map<string, number>();
  intents.forEach((intent, i) => intentPos.set(intent.visualIntentId, i));

  // 全局 beat 覆盖：不遗漏（GAP）、不重复（OVERLAP / 同 sequence 内 DUPLICATE）
  const coveredBy = new Map<string, string>(); // beatId -> sequenceId
  for (const seq of sequences) {
    const withinSeq = new Set<string>();
    for (const beatId of seq.beatIds) {
      if (!beatPos.has(beatId)) {
        issues.push({
          code: 'SEQUENCE_BEAT_NOT_FOUND',
          message: `sequence ${seq.sequenceId} 引用不存在的 beat ${beatId}`,
        });
        continue;
      }
      if (withinSeq.has(beatId)) {
        issues.push({
          code: 'SEQUENCE_BEAT_DUPLICATE',
          message: `sequence ${seq.sequenceId} 内重复引用 beat ${beatId}`,
        });
        continue;
      }
      withinSeq.add(beatId);
      const prev = coveredBy.get(beatId);
      if (prev !== undefined) {
        issues.push({
          code: 'SEQUENCE_BEAT_OVERLAP',
          message: `beat ${beatId} 同时属于 sequence ${prev} 与 ${seq.sequenceId}`,
        });
      } else {
        coveredBy.set(beatId, seq.sequenceId);
      }
    }
  }
  for (const beat of beats) {
    if (!coveredBy.has(beat.beatId)) {
      issues.push({
        code: 'SEQUENCE_BEAT_COVERAGE_GAP',
        message: `beat ${beat.beatId} 未被任何 sequence 覆盖`,
      });
    }
  }

  // 全局 canonical beat 顺序（M7.3B.R1 P0）：
  // sequences.flatMap(beatIds) 必须与 beats 顺序逐项相同（时间线顺序，不是集合）。
  // 排序后比较只证明集合相等；reversed blocks 等坏输入必须在此被拒绝。
  // 与 gap/overlap/duplicate/within-sequence non-contiguous 并存（同一坏输入可多 issue）。
  {
    const expectedBeatIds = beats.map((beat) => beat.beatId);
    const actualBeatIds = sequences.flatMap((seq) => seq.beatIds);
    const orderOk =
      actualBeatIds.length === expectedBeatIds.length &&
      actualBeatIds.every((id, i) => id === expectedBeatIds[i]);
    if (!orderOk) {
      issues.push({
        code: 'SEQUENCE_BEAT_ORDER_MISMATCH',
        message:
          'sequence blocks 的全局 beat 顺序与 canonical Narrative Beats 顺序不一致（时间线顺序必须逐项相同，不得排序比较）',
      });
    }
  }

  for (const seq of sequences) {
    // beatIds 在 Narrative Beats 中连续（含顺序正确性）
    for (let i = 1; i < seq.beatIds.length; i++) {
      const a = beatPos.get(seq.beatIds[i - 1]!);
      const b = beatPos.get(seq.beatIds[i]!);
      if (a === undefined || b === undefined) continue;
      if (b !== a + 1) {
        issues.push({
          code: 'SEQUENCE_BEAT_NON_CONTIGUOUS',
          message: `sequence ${seq.sequenceId} 的 beatIds 在 beats 顺序中不连续（${seq.beatIds[i - 1]} → ${seq.beatIds[i]}）`,
        });
        break;
      }
    }
    // chapter 一致性 + 不跨 chapter
    for (const beatId of seq.beatIds) {
      const beat = beats[beatPos.get(beatId) ?? -1];
      if (!beat) continue;
      if (beat.chapter !== seq.chapter) {
        issues.push({
          code: 'SEQUENCE_CHAPTER_CROSSING',
          message: `sequence ${seq.sequenceId} chapter=${seq.chapter} 与 beat ${beatId} 的 chapter=${beat.chapter} 不一致`,
        });
        break;
      }
    }

    // intent 引用存在性 + 同 sequence 内重复
    const seqIntents: VisualIntentV1[] = [];
    const seenIntent = new Set<string>();
    for (const intentId of seq.visualIntentIds) {
      const intent = intents[intentPos.get(intentId) ?? -1];
      if (!intent) {
        issues.push({
          code: 'SEQUENCE_INTENT_NOT_FOUND',
          message: `sequence ${seq.sequenceId} 引用不存在的 visual intent ${intentId}`,
        });
        continue;
      }
      if (seenIntent.has(intentId)) {
        issues.push({
          code: 'SEQUENCE_INTENT_DUPLICATE',
          message: `sequence ${seq.sequenceId} 内重复引用 intent ${intentId}`,
        });
      }
      seenIntent.add(intentId);
      seqIntents.push(intent);
    }

    // intent 拆分：一个 intent 不得被多个 sequence 引用
    for (const intent of seqIntents) {
      const otherSeq = sequences.find((s) => s !== seq && s.visualIntentIds.includes(intent.visualIntentId));
      if (otherSeq) {
        issues.push({
          code: 'SEQUENCE_INTENT_SPLIT',
          message: `intent ${intent.visualIntentId} 同时被 sequence ${otherSeq.sequenceId} 与 ${seq.sequenceId} 引用`,
        });
      }
    }

    // visualIntentIds 顺序与其覆盖 beat 的顺序一致
    const coveredBeatPos = seqIntents
      .flatMap((intent) => intent.beatIds.map((b) => beatPos.get(b)).filter((p): p is number => p !== undefined))
      .sort((a, b) => a - b);
    const intentOrderPos = seqIntents.map((intent) =>
      Math.min(...intent.beatIds.map((b) => beatPos.get(b) ?? Infinity)),
    );
    if (intentOrderPos.some((p, i) => i > 0 && p < intentOrderPos[i - 1]!)) {
      issues.push({
        code: 'SEQUENCE_INTENT_ORDER',
        message: `sequence ${seq.sequenceId} 的 visualIntentIds 顺序与其覆盖 beats 的顺序不一致`,
      });
    }

    // sequence.beatIds == 其 intents 覆盖 beatIds 的有序并集
    const unionFromIntents = new Set<string>();
    for (const intent of seqIntents) {
      for (const beatId of intent.beatIds) unionFromIntents.add(beatId);
    }
    const unionSorted = [...unionFromIntents].sort((a, b) => (beatPos.get(a) ?? -1) - (beatPos.get(b) ?? -1));
    const seqBeats = [...new Set(seq.beatIds)].sort(
      (a, b) => (beatPos.get(a) ?? -1) - (beatPos.get(b) ?? -1),
    );
    const sameSet =
      unionSorted.length === seqBeats.length && unionSorted.every((b, i) => b === seqBeats[i]);
    if (!sameSet) {
      issues.push({
        code: 'SEQUENCE_INTENT_COVERAGE_MISMATCH',
        message: `sequence ${seq.sequenceId} 的 beatIds 与其 visualIntentIds 覆盖的 beatIds 不一致`,
      });
    }

    // VISUAL_UNRESOLVED 允许保留 → 非阻断 NEEDS_REVIEW
    for (const intent of seqIntents) {
      if (intent.intent === 'VISUAL_UNRESOLVED') {
        issues.push({
          code: 'SEQUENCE_NEEDS_REVIEW',
          message: `sequence ${seq.sequenceId} 引用 VISUAL_UNRESOLVED intent ${intent.visualIntentId}，需人工处理`,
        });
      }
    }
  }

  // continuation：目标必须存在、更早、且与 dependent 处于同一 sequence
  for (const seq of sequences) {
    for (const intent of seq.visualIntentIds.map((id) => intents[intentPos.get(id) ?? -1]).filter((x): x is VisualIntentV1 => Boolean(x))) {
      const targetId = intent.continuationOfVisualIntentId;
      if (!targetId) continue;
      const target = intents[intentPos.get(targetId) ?? -1];
      if (!target) {
        issues.push({
          code: 'SEQUENCE_CONTINUATION_TARGET_MISSING',
          message: `intent ${intent.visualIntentId} 的 continuation 目标 ${targetId} 不存在`,
        });
        continue;
      }
      if (intentPos.get(targetId)! >= intentPos.get(intent.visualIntentId)!) {
        issues.push({
          code: 'SEQUENCE_CONTINUATION_TARGET_ORDER',
          message: `intent ${intent.visualIntentId} 的 continuation 目标 ${targetId} 必须引用更早的 intent`,
        });
      }
      const targetSeq = sequences.find((s) => s.visualIntentIds.includes(targetId));
      if (targetSeq && targetSeq.sequenceId !== seq.sequenceId) {
        issues.push({
          code: 'SEQUENCE_CONTINUATION_CROSSING',
          message: `intent ${intent.visualIntentId}（sequence ${seq.sequenceId}）的 continuation 目标 ${targetId} 在 sequence ${targetSeq.sequenceId}，跨 sequence`,
        });
      }
    }
  }

  return issues;
}

/** 非阻断 issue 码：classify 映射 needs_review 而非 invalid。 */
export const SEQUENCE_NON_BLOCKING_CODES = new Set(['SEQUENCE_NEEDS_REVIEW']);

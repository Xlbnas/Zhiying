import type {NarrationAudioManifestV2} from '../narration/audio-v2-manifest';
import type {NarrationPlanV2} from '../narration/schema-v2';
import {
  AUDIO_TIMELINE_TOLERANCE_MS_V2,
  SUBTITLE_V2_ALIGNMENT_METHOD,
  SUBTITLE_TIMING_V2_SCHEMA_VERSION,
  SUBTITLE_V2_COMPILER_VERSION,
  subtitleTimingV2Schema,
  type SubtitleTimingV2,
  type SubtitleTimingV2Cue,
} from './schema-v2';

/**
 * Subtitle Compiler V2（M7.1）：NarrationPlanV2 + NarrationAudioManifestV2 →
 * SubtitleTimingV2。纯函数、deterministic。
 *
 * 与 v1 的语义差异（冻结）：
 * - cue 文本唯一来源 = speech.subtitleText；subtitleText=null → 不生成 cue；
 *   silence → cursor 前进 durationMs，不生成 cue
 * - 禁止从 spokenText / sourceText fallback 生成字幕（编译期硬校验：
 *   manifest.spokenText 必须等于 plan.spokenText，字幕取 subtitleText，
 *   两者是独立字段，永不混用）
 * - conservation invariant 对象 = unit 内按顺序拼接的非空 subtitleText
 */

export type SubtitleV2CompileErrorCode =
  | 'NARRATION_AUDIO_INVALID'
  | 'SUBTITLE_TIMING_INVALID'
  | 'AUDIO_TIMELINE_MISMATCH';

export class SubtitleV2CompileError extends Error {
  constructor(
    public readonly code: SubtitleV2CompileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleV2CompileError';
  }
}

const SENTENCE_TERMINATOR = '。！？!?；;';
const SENTENCE_CLOSERS = '”’」』）》】"';
const SENTENCE = new RegExp(
  `[${SENTENCE_TERMINATOR}${SENTENCE_CLOSERS}]*[^${SENTENCE_TERMINATOR}]+[${SENTENCE_TERMINATOR}]*[${SENTENCE_CLOSERS}]*`,
  'gs',
);

const stripWhitespace = (s: string): string => s.replace(/\s+/g, '');

/** 自然句切分 + text-conservation invariant（对象为 subtitleText）。 */
export function splitSubtitleSentencesV2(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    throw new SubtitleV2CompileError('SUBTITLE_TIMING_INVALID', 'subtitleText 为空，无法切句');
  }
  const sentences = (normalized.match(SENTENCE) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) {
    throw new SubtitleV2CompileError('SUBTITLE_TIMING_INVALID', `subtitleText 无法切出自然句: ${text}`);
  }
  if (stripWhitespace(sentences.join('')) !== stripWhitespace(normalized)) {
    throw new SubtitleV2CompileError(
      'SUBTITLE_TIMING_INVALID',
      `分句违反 text-conservation（输出丢失/改写非空白字符）: ${text}`,
    );
  }
  return sentences;
}

function sentenceWeight(sentence: string): number {
  return Math.max([...sentence.replace(/\s+/g, '')].length, 1);
}

function allocateSentences(
  unitId: string,
  unitStartMs: number,
  durationMs: number,
  sentences: string[],
): Array<{text: string; startMs: number; endMs: number}> {
  const weights = sentences.map(sentenceWeight);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cumulative = 0;
  let prevBoundary = unitStartMs;
  return sentences.map((text, index) => {
    cumulative += weights[index]!;
    const boundary =
      index === sentences.length - 1
        ? unitStartMs + durationMs
        : unitStartMs + Math.round((durationMs * cumulative) / total);
    const startMs = index === 0 ? unitStartMs : prevBoundary;
    prevBoundary = boundary;
    if (boundary <= startMs) {
      throw new SubtitleV2CompileError(
        'SUBTITLE_TIMING_INVALID',
        `${unitId} 句 ${index + 1} 时间区间非法（${startMs}→${boundary}ms），拒绝 silent autofix`,
      );
    }
    return {text, startMs, endMs: boundary};
  });
}

/** 编译：严格按 plan units 顺序走全局 cursor；manifest 与 plan 必须逐 unit 对齐。 */
export function compileSubtitleTimingV2(input: {
  plan: NarrationPlanV2;
  manifest: NarrationAudioManifestV2;
  narrationAudioV2ArtifactId: string;
  narrationAudioV2ArtifactVersion: number;
  narrationPlanV2ArtifactId: string;
  narrationPlanV2ArtifactVersion: number;
}): SubtitleTimingV2 {
  const {plan, manifest} = input;
  if (manifest.units.length !== plan.units.length) {
    throw new SubtitleV2CompileError(
      'NARRATION_AUDIO_INVALID',
      `manifest units(${manifest.units.length}) 与 plan units(${plan.units.length}) 数量不一致`,
    );
  }

  const cues: SubtitleTimingV2Cue[] = [];
  let cursorMs = 0;

  plan.units.forEach((unit, index) => {
    const mUnit = manifest.units[index]!;
    if (mUnit.unitId !== unit.id || mUnit.kind !== unit.kind) {
      throw new SubtitleV2CompileError(
        'NARRATION_AUDIO_INVALID',
        `manifest unit[${index}]（${mUnit.unitId}/${mUnit.kind}）与 plan unit（${unit.id}/${unit.kind}）不对齐`,
      );
    }

    if (unit.kind === 'speech') {
      const speech = mUnit as Extract<typeof mUnit, {kind: 'speech'}>;
      // 语义一致性硬校验：manifest 的 spokenText 必须等于 plan.spokenText；
      // 字幕文本取 subtitleText（独立字段，禁止 fallback 到 spokenText/sourceText）
      if (speech.spokenText !== unit.spokenText) {
        throw new SubtitleV2CompileError(
          'NARRATION_AUDIO_INVALID',
          `${unit.id} manifest.spokenText 与 plan.spokenText 不一致（semantic corruption，拒绝 compile）`,
        );
      }
      if (speech.delivery !== unit.delivery) {
        throw new SubtitleV2CompileError(
          'NARRATION_AUDIO_INVALID',
          `${unit.id} manifest.delivery 与 plan.delivery 不一致`,
        );
      }
      cursorMs += speech.durationMs;
      if (unit.subtitleText === null) return; // 不上字幕：只占时间轴
      const sentences = splitSubtitleSentencesV2(unit.subtitleText);
      const allocated = allocateSentences(unit.id, cursorMs - speech.durationMs, speech.durationMs, sentences);
      allocated.forEach((cue, sentenceIndex) => {
        cues.push({
          id: cues.length + 1,
          segmentId: `${unit.id}:S${String(sentenceIndex + 1).padStart(2, '0')}`,
          unitId: unit.id,
          chapter: unit.chapter,
          text: cue.text,
          startMs: cue.startMs,
          endMs: cue.endMs,
          position: 'bottom',
          timingMethod: SUBTITLE_V2_ALIGNMENT_METHOD,
        });
      });
      return;
    }

    // silence：无 cue，cursor 按显式时长前进；manifest 时长必须等于 plan 时长
    const silence = mUnit as Extract<typeof mUnit, {kind: 'silence'}>;
    if (silence.durationMs !== unit.durationMs || silence.reason !== unit.reason) {
      throw new SubtitleV2CompileError(
        'NARRATION_AUDIO_INVALID',
        `${unit.id} silence duration/reason 与 plan 不一致（manifest ${silence.durationMs}/${silence.reason}，plan ${unit.durationMs}/${unit.reason}）`,
      );
    }
    cursorMs += silence.durationMs;
  });

  if (Math.abs(cursorMs - manifest.master.durationMs) > AUDIO_TIMELINE_TOLERANCE_MS_V2) {
    throw new SubtitleV2CompileError(
      'AUDIO_TIMELINE_MISMATCH',
      `字幕时间轴总长 ${cursorMs}ms 与 master ${manifest.master.durationMs}ms 偏差超过 ${AUDIO_TIMELINE_TOLERANCE_MS_V2}ms`,
    );
  }

  const candidate = {
    schemaVersion: SUBTITLE_TIMING_V2_SCHEMA_VERSION,
    compilerVersion: SUBTITLE_V2_COMPILER_VERSION,
    source: {
      narrationAudioV2ArtifactId: input.narrationAudioV2ArtifactId,
      narrationAudioV2ArtifactVersion: input.narrationAudioV2ArtifactVersion,
      narrationPlanV2ArtifactId: input.narrationPlanV2ArtifactId,
      narrationPlanV2ArtifactVersion: input.narrationPlanV2ArtifactVersion,
      scriptV2VersionId: manifest.source.scriptV2VersionId,
      scriptV2Version: manifest.source.scriptV2Version,
      narrationCompilerVersion: manifest.source.narrationCompilerVersion,
      masterSha256: manifest.master.sha256,
      masterDurationMs: manifest.master.durationMs,
    },
    timingBasis: 'narration_master_audio' as const,
    alignmentMethod: SUBTITLE_V2_ALIGNMENT_METHOD,
    cues,
  };
  const parsed = subtitleTimingV2Schema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SubtitleV2CompileError(
      'SUBTITLE_TIMING_INVALID',
      `编译结果未通过契约校验：${first?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

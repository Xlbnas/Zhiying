import type {NarrationAudioManifest} from '../narration/audio';
import type {NarrationPlan} from '../narration/schema';
import {
  AUDIO_TIMELINE_TOLERANCE_MS,
  SUBTITLE_ALIGNMENT_METHOD,
  SUBTITLE_COMPILER_VERSION,
  SUBTITLE_TIMING_SCHEMA_VERSION,
  subtitleTimingSchema,
  type SubtitleTiming,
  type SubtitleTimingCue,
} from './schema';

/**
 * Subtitle Compiler（M3-C）：Narration Plan + Narration Audio Manifest →
 * Subtitle Timing。纯函数、deterministic：无 random / timestamp / UUID / LLM /
 * ASR / forced alignment——同一 (manifest, plan, compilerVersion) 字节级稳定。
 *
 * 时间规则（§四/十九）：
 * - speech：manifest 实测 durationMs，cue 覆盖 [cursor, cursor+D]，cursor 前进
 * - explicit pause（resolved）：无 cue，cursor 前进 durationMs
 * - 无时长 pause / visual_breath：cursor 不变，记入 unresolvedUnitIds
 * - prosody：cursor 不变
 * - 禁止给无时长 directive 拍脑袋默认时长
 *
 * unit 内句子边界（§十六/十七）：cumulative weight 边界，round 不漂移，
 * 首 cue start = unitStart、末 cue end = unitStart + D——unit 总时长永不被改写。
 */

export type SubtitleCompileErrorCode =
  | 'NARRATION_AUDIO_INVALID'
  | 'SUBTITLE_TIMING_INVALID'
  | 'AUDIO_TIMELINE_MISMATCH';

export class SubtitleCompileError extends Error {
  constructor(
    public readonly code: SubtitleCompileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleCompileError';
  }
}

/** 与 M3-B master 时长防线一致的 symmetric 容差（schema 共用同一常量）。 */
export {AUDIO_TIMELINE_TOLERANCE_MS} from './schema';

/** 强终止符 。！？!?；句界 ；;——标点保留在前一句（deterministic，无 LLM/jieba）。 */
const SENTENCE_TERMINATOR = '。！？!?；;';
/** 终止符后的 closing punctuation 跟随前一句，不跑到下一 cue 开头（§五 Hardening）。 */
const SENTENCE_CLOSERS = '”’」』）》】"';
const SENTENCE = new RegExp(
  `[^${SENTENCE_TERMINATOR}]+[${SENTENCE_TERMINATOR}]*[${SENTENCE_CLOSERS}]*`,
  'gs',
);

/**
 * 自然句切分：一个自然句 = 一个 cue。无终止符时整个 speech unit = 1 cue；
 * 空文本属 invalid input（正常 Narration Plan speech unit 不可能为空）。
 */
export function splitSubtitleSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    throw new SubtitleCompileError('SUBTITLE_TIMING_INVALID', 'speech unit 文本为空，无法切句');
  }
  const sentences = (normalized.match(SENTENCE) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  if (sentences.length === 0) {
    throw new SubtitleCompileError('SUBTITLE_TIMING_INVALID', `speech unit 文本无法切出自然句: ${text}`);
  }
  return sentences;
}

/** 句权重 = 去空白后的 Unicode codepoint 数，至少 1（无语言模型）。 */
function sentenceWeight(sentence: string): number {
  return Math.max([...sentence.replace(/\s+/g, '')].length, 1);
}

/**
 * unit 内比例分配：cumulative boundaries——
 * boundary[i] = unitStart + round(D * cumWeight[i] / totalWeight)，
 * 逐句不独立 round，句内 rounding 永不改变 unit 总时长。
 * 极短 duration 导致 endMs <= startMs 时不 silent autofix，直接 reject。
 */
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
        ? unitStartMs + durationMs // 末 cue end 强制 = unit end
        : unitStartMs + Math.round((durationMs * cumulative) / total);
    const startMs = index === 0 ? unitStartMs : prevBoundary; // 首 cue start 强制 = unit start
    prevBoundary = boundary;
    if (boundary <= startMs) {
      throw new SubtitleCompileError(
        'SUBTITLE_TIMING_INVALID',
        `${unitId} 句 ${index + 1} 时间区间非法（${startMs}→${boundary}ms），拒绝 silent autofix`,
      );
    }
    return {text, startMs, endMs: boundary};
  });
}

/**
 * 编译：严格按 plan units 顺序走全局 cursor（§十九），
 * manifest 与 plan 必须逐 unit 对齐（unitId + kind），否则 NARRATION_AUDIO_INVALID。
 */
export function compileSubtitleTiming(input: {
  plan: NarrationPlan;
  manifest: NarrationAudioManifest;
  narrationAudioArtifactId: string;
  narrationAudioArtifactVersion: number;
  narrationPlanArtifactId: string;
  narrationPlanArtifactVersion: number;
}): SubtitleTiming {
  const {plan, manifest} = input;
  if (manifest.units.length !== plan.units.length) {
    throw new SubtitleCompileError(
      'NARRATION_AUDIO_INVALID',
      `manifest units(${manifest.units.length}) 与 plan units(${plan.units.length}) 数量不一致`,
    );
  }

  const cues: SubtitleTimingCue[] = [];
  const unresolvedUnitIds: string[] = [];
  let cursorMs = 0;

  plan.units.forEach((unit, index) => {
    const mUnit = manifest.units[index]!;
    if (mUnit.unitId !== unit.id || mUnit.kind !== unit.kind) {
      throw new SubtitleCompileError(
        'NARRATION_AUDIO_INVALID',
        `manifest unit[${index}]（${mUnit.unitId}/${mUnit.kind}）与 plan unit（${unit.id}/${unit.kind}）不对齐`,
      );
    }

    if (unit.kind === 'speech') {
      const speech = mUnit as Extract<typeof mUnit, {kind: 'speech'}>;
      // §三 Hardening 2：Manifest 必须与它引用的 Plan 语义一致（不 silent repair）。
      // 字幕文本仍来自 Plan，但仅在 manifest.text === plan.text 时才允许 compile；
      // duration 永远用 manifest 的 ffprobe measured truth。
      if (speech.text !== unit.text) {
        throw new SubtitleCompileError(
          'NARRATION_AUDIO_INVALID',
          `${unit.id} manifest.text 与 plan.text 不一致（semantic corruption，拒绝 compile）`,
        );
      }
      const sentences = splitSubtitleSentences(unit.text ?? '');
      const allocated = allocateSentences(unit.id, cursorMs, speech.durationMs, sentences);
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
          timingMethod: SUBTITLE_ALIGNMENT_METHOD,
        });
      });
      cursorMs += speech.durationMs;
      return;
    }

    if (unit.kind === 'pause') {
      const pause = mUnit as Extract<typeof mUnit, {kind: 'pause'}>;
      // manifest.durationMs 必须等于 plan.pauseMs，且 resolved 标记一致
      if (pause.durationMs !== unit.pauseMs || pause.resolved !== (unit.pauseMs !== null)) {
        throw new SubtitleCompileError(
          'NARRATION_AUDIO_INVALID',
          `${unit.id} pause duration/resolved 与 plan 不一致（manifest ${pause.durationMs}/${pause.resolved}，plan ${unit.pauseMs}）`,
        );
      }
      if (pause.durationMs !== null) {
        cursorMs += pause.durationMs; // explicit pause：无 cue，cursor 按校验后的 manifest 时长前进
      } else {
        unresolvedUnitIds.push(unit.id); // 无时长 pause：不占 master 时间，记录待 M3-D
      }
      return;
    }

    if (unit.kind === 'visual_breath') {
      // schema 已锁死 durationMs=null / resolved=false，unit 对齐即可
      unresolvedUnitIds.push(unit.id);
      return;
    }
    // prosody：directive 必须与 plan 一致；cursor 不变
    const prosody = mUnit as Extract<typeof mUnit, {kind: 'prosody'}>;
    if (prosody.directive !== unit.directive) {
      throw new SubtitleCompileError(
        'NARRATION_AUDIO_INVALID',
        `${unit.id} prosody directive 与 plan 不一致（manifest "${prosody.directive}"，plan "${unit.directive}"）`,
      );
    }
  });

  // §二十：全局 cursor 必须 ≈ master.durationMs（容差沿用 M3-B 音频取整 100ms）
  if (Math.abs(cursorMs - manifest.master.durationMs) > AUDIO_TIMELINE_TOLERANCE_MS) {
    throw new SubtitleCompileError(
      'AUDIO_TIMELINE_MISMATCH',
      `字幕时间轴总长 ${cursorMs}ms 与 master ${manifest.master.durationMs}ms 偏差超过 ${AUDIO_TIMELINE_TOLERANCE_MS}ms`,
    );
  }

  const candidate = {
    schemaVersion: SUBTITLE_TIMING_SCHEMA_VERSION,
    compilerVersion: SUBTITLE_COMPILER_VERSION,
    source: {
      narrationAudioArtifactId: input.narrationAudioArtifactId,
      narrationAudioArtifactVersion: input.narrationAudioArtifactVersion,
      narrationPlanArtifactId: input.narrationPlanArtifactId,
      narrationPlanArtifactVersion: input.narrationPlanArtifactVersion,
      scriptV2Version: manifest.source.scriptV2Version,
      narrationCompilerVersion: manifest.source.compilerVersion,
      masterSha256: manifest.master.sha256,
      masterDurationMs: manifest.master.durationMs,
    },
    timingBasis: 'narration_master_audio' as const,
    alignmentMethod: SUBTITLE_ALIGNMENT_METHOD,
    unresolvedUnitIds,
    cues,
  };
  const parsed = subtitleTimingSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SubtitleCompileError(
      'SUBTITLE_TIMING_INVALID',
      `编译结果未通过契约校验：${first?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

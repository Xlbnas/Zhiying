import {z} from 'zod';
import {findDirectiveLeakage, describeLeakage} from '../narration/leakage';

/**
 * Subtitle Timing V2 数据契约（M7.1）。
 *
 * 与 v1（subtitle-timing@1.0）并存：v1 路径只读兼容，v2 消费
 * narration-plan@2.0 + narration-audio@2.0。核心变更：
 * - cue 文本唯一来源 = speech.subtitleText（禁止 spokenText/sourceText fallback）
 * - subtitleText=null 不生成 cue；silence unit 不生成 cue
 * - conservation invariant 对象 = 按顺序拼接的非空 subtitleText
 * - 不再存在 unresolvedUnitIds（silence 时长全部显式）
 */

export const SUBTITLE_TIMING_V2_SCHEMA_VERSION = 'subtitle-timing@2.0';
export const SUBTITLE_V2_COMPILER_VERSION = '2.0';
export const SUBTITLE_TIMING_V2_ARTIFACT_KIND = 'subtitle_timing_v2';
export const SUBTITLE_V2_ALIGNMENT_METHOD = 'measured_unit_proportional_text';
/** 与 v1 同一容差常量（master 整体 ffprobe 与逐 unit integer duration 的双向 rounding）。 */
export const AUDIO_TIMELINE_TOLERANCE_MS_V2 = 100;

export const subtitleTimingV2CueSchema = z.object({
  id: z.number().int().positive(),
  segmentId: z.string().regex(/^N\d{3}:S\d{2}$/),
  unitId: z.string().regex(/^N\d{3}$/),
  chapter: z.number().int().positive(),
  /** 唯一来源：narration-plan@2.0 speech.subtitleText（经 leakage 校验）。 */
  text: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  position: z.literal('bottom'),
  timingMethod: z.literal(SUBTITLE_V2_ALIGNMENT_METHOD),
});

export const subtitleTimingV2Schema = z
  .object({
    schemaVersion: z.literal(SUBTITLE_TIMING_V2_SCHEMA_VERSION),
    compilerVersion: z.literal(SUBTITLE_V2_COMPILER_VERSION),
    source: z.object({
      narrationAudioV2ArtifactId: z.string().min(1),
      narrationAudioV2ArtifactVersion: z.number().int().positive(),
      narrationPlanV2ArtifactId: z.string().min(1),
      narrationPlanV2ArtifactVersion: z.number().int().positive(),
      scriptV2VersionId: z.string().min(1),
      scriptV2Version: z.number().int().positive(),
      narrationCompilerVersion: z.literal('2.0'),
      masterSha256: z.string().min(1),
      masterDurationMs: z.number().int().positive(),
    }),
    timingBasis: z.literal('narration_master_audio'),
    alignmentMethod: z.literal(SUBTITLE_V2_ALIGNMENT_METHOD),
    cues: z.array(subtitleTimingV2CueSchema),
  })
  .superRefine((timing, ctx) => {
    timing.cues.forEach((cue, index) => {
      if (cue.id !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue[${index}] id 必须是 ${index + 1}（实际 ${cue.id}）`,
        });
      }
      if (cue.endMs <= cue.startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} endMs(${cue.endMs}) 必须大于 startMs(${cue.startMs})`,
        });
      }
      if (index > 0 && cue.startMs < timing.cues[index - 1]!.endMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} 与前一条重叠/乱序`,
        });
      }
      if (cue.endMs > timing.source.masterDurationMs + AUDIO_TIMELINE_TOLERANCE_MS_V2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} endMs 超过 masterDurationMs + 容差`,
        });
      }
      const leak = findDirectiveLeakage(cue.text);
      if (leak.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} 文本含指令泄漏：${describeLeakage(leak)}`,
        });
      }
    });
  });

export type SubtitleTimingV2Cue = z.infer<typeof subtitleTimingV2CueSchema>;
export type SubtitleTimingV2 = z.infer<typeof subtitleTimingV2Schema>;

import {z} from 'zod';

/**
 * Subtitle Timing 数据契约（M3-C）。
 *
 * 定位：Narration Audio Manifest（ffprobe 实测）+ Narration Plan →
 * deterministic 字幕时间轴。同一 (audio artifact, compilerVersion) 重复编译
 * 结果字节级稳定——无 random / timestamp / UUID / LLM。
 *
 * 时间真相（§四/十五/三十九）：
 * - unit 边界 = M3-B ffprobe 实测（真实）
 * - unit 内自然句边界 = 按文本 codepoint weight 的 deterministic 估算
 *   （alignmentMethod 明示，不得误解为 word-accurate / forced aligned）
 *
 * 时间基准对齐当前 Narration Master WAV，不是未来 M3-D 的视频时间轴。
 * schemaVersion（数据契约）与 compilerVersion（编译器行为）严格分开。
 */

export const SUBTITLE_TIMING_SCHEMA_VERSION = 'subtitle-timing@1.0';
export const SUBTITLE_COMPILER_VERSION = '1.0';
export const SUBTITLE_TIMING_ARTIFACT_KIND = 'subtitle_timing';
/** unit 边界实测 + unit 内句子按文本权重比例分配（估算）。 */
export const SUBTITLE_ALIGNMENT_METHOD = 'measured_unit_proportional_text';

export const subtitleTimingCueSchema = z.object({
  /** 全局连续序号 1…N（编译器顺序生成，禁止 random/UUID）。 */
  id: z.number().int().positive(),
  /** 稳定 ID：N001:S01（unit + 句序，deterministic）。 */
  segmentId: z.string().regex(/^N\d{3}:S\d{2}$/),
  unitId: z.string().regex(/^N\d{3}$/),
  /** 取自 Narration Plan unit.chapter（不从 Script V2 标题推断）。 */
  chapter: z.number().int().positive(),
  /** 仅来自 Narration Plan speech.text（Evidence 已在 M3-A 剥离）。 */
  text: z.string().min(1),
  /** 内部真相一律整数毫秒；渲染层秒值由 adapter 派生。 */
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
  /** M3-C 无 Scene Timing reconciliation，统一 bottom（M3-D 再定视觉语义）。 */
  position: z.literal('bottom'),
  timingMethod: z.literal(SUBTITLE_ALIGNMENT_METHOD),
});

export const subtitleTimingSchema = z
  .object({
    schemaVersion: z.literal(SUBTITLE_TIMING_SCHEMA_VERSION),
    /** 历史可读字段；是否 current 由 timing.ts 判定。 */
    compilerVersion: z.string().min(1),
    /** Source snapshot（§九/二十五）：绑定 audio artifact + master sha256。 */
    source: z.object({
      narrationAudioArtifactId: z.string().min(1),
      narrationAudioArtifactVersion: z.number().int().positive(),
      narrationPlanArtifactId: z.string().min(1),
      narrationPlanArtifactVersion: z.number().int().positive(),
      scriptV2Version: z.number().int().positive(),
      narrationCompilerVersion: z.string().min(1),
      masterSha256: z.string().min(1),
      masterDurationMs: z.number().int().positive(),
    }),
    /** 时间坐标对齐当前 Narration Master WAV。 */
    timingBasis: z.literal('narration_master_audio'),
    alignmentMethod: z.literal(SUBTITLE_ALIGNMENT_METHOD),
    /** 无时长 pause / visual_breath：不占 master 时间，记录供 M3-D reconciliation。 */
    unresolvedUnitIds: z.array(z.string().regex(/^N\d{3}$/)),
    cues: z.array(subtitleTimingCueSchema),
  })
  .superRefine((timing, ctx) => {
    timing.cues.forEach((cue, index) => {
      // id = 1…N 连续
      if (cue.id !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue[${index}] id 必须是 ${index + 1}（实际 ${cue.id}）`,
        });
      }
      // endMs > startMs
      if (cue.endMs <= cue.startMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} endMs(${cue.endMs}) 必须大于 startMs(${cue.startMs})`,
        });
      }
      // 单调不重叠
      if (index > 0 && cue.startMs < timing.cues[index - 1]!.endMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} 与前一条重叠/乱序`,
        });
      }
      // 不越过 master 总时长
      if (cue.endMs > timing.source.masterDurationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cue ${cue.segmentId} endMs 超过 masterDurationMs`,
        });
      }
    });
  });

export type SubtitleTimingCue = z.infer<typeof subtitleTimingCueSchema>;
export type SubtitleTiming = z.infer<typeof subtitleTimingSchema>;

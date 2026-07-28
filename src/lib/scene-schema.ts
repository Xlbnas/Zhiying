import {z} from 'zod';

/**
 * 知影 Scene 数据契约 — 唯一数据真相（schemaVersion: 1.0）
 * 对应 samples/FullCutScenes.json 的结构。
 * 任何 import / export / Player props / render payload 都必须经过这里的 schema。
 */

export const sceneSchema = z.object({
  id: z.string(),
  chapter: z.number(),
  chapterTitle: z.string(),
  start: z.number(),
  end: z.number(),
  duration: z.number(),
  startFrame: z.number(),
  durationInFrames: z.number(),
  category: z.string(),
  visualType: z.string().nullable(),
  template: z.string().nullable(),
  sourceTemplate: z.string().nullable(),
  narrationSummary: z.string(),
  description: z.string(),
  notes: z.string().default(''),
  assetIds: z.array(z.string()).default([]),
  licenseStatus: z.string().default('not-applicable'),
  subtitlePosition: z.enum(['bottom', 'mid', 'lowerThird', 'midLower']).default('bottom'),
  transitionIn: z.string().default('none'),
  transitionOut: z.string().default('none'),
});

export const chapterTimingSchema = z.object({
  chapter: z.number(),
  title: z.string(),
  start: z.number(),
  end: z.number(),
});

export const projectMetaSchema = z.object({
  title: z.string(),
  composition: z.string().default('ZhiyingFullCut'),
  fps: z.number().default(30),
  width: z.number().default(1920),
  height: z.number().default(1080),
  durationSec: z.number(),
  durationInFrames: z.number(),
  timingBasis: z.string().optional(),
  sceneCount: z.number().optional(),
  categoryCounts: z.record(z.string(), z.number()).optional(),
  /** M1 demo 专用 Pilot 开场覆盖层开关：仅 defaultProps / Legacy M1 链路显式
      置 true；workflow 项目缺省 = 不出现（M5 残留修复）。 */
  showPilotIntro: z.boolean().optional(),
});

export const fullCutDataSchema = z.object({
  schemaVersion: z.string().default('1.0'),
  templateVersion: z.string().default('freud-mg-v1.0'),
  project: projectMetaSchema,
  chapterTiming: z.array(chapterTimingSchema),
  scenes: z.array(sceneSchema),
});

export const subtitleCueSchema = z.object({
  id: z.number(),
  segmentId: z.string(),
  chapter: z.number(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  position: z.enum(['bottom', 'mid', 'lowerThird', 'midLower']).default('bottom'),
});

/**
 * Composition props —— Player 与 Renderer 同构使用（CONTRACT §2）。
 *
 * audio.bgm / audio.sfx（M2-E-D 引入，带默认值保证 Legacy M1 行为不变）：
 * Freud 示例项目的定制配乐（bgmVolume 含该片专用时间轴），属示例遗留资产；
 * Legacy 路径不传字段 → 默认值 = 原硬编码路径 → 行为完全不变；
 * Workflow Visual Preview 显式置 null → 不挂载，消除对示例音频的硬依赖。
 */
export const DEFAULT_BGM_PATH = 'full/audio/FullCut_BGM.wav';
export const DEFAULT_SFX_PATH = 'full/audio/FullCut_SFX.wav';

export const zhiyingFullCutPropsSchema = z.object({
  data: fullCutDataSchema,
  subtitles: z.array(subtitleCueSchema).default([]),
  audio: z.object({
    /** staticFile 相对路径，如 full/audio/narration.wav；null = 无旁白 */
    narration: z.string().nullable().default(null),
    /** Freud 示例 BGM；null = 不挂载（Workflow Visual Preview） */
    bgm: z.string().nullable().default(DEFAULT_BGM_PATH),
    /** Freud 示例 SFX；null = 不挂载（Workflow Visual Preview） */
    sfx: z.string().nullable().default(DEFAULT_SFX_PATH),
  }),
  showSubtitles: z.boolean().default(true),
});

export type Scene = z.infer<typeof sceneSchema>;
export type ChapterTiming = z.infer<typeof chapterTimingSchema>;
export type ProjectMeta = z.infer<typeof projectMetaSchema>;
export type FullCutData = z.infer<typeof fullCutDataSchema>;
export type SubtitleCue = z.infer<typeof subtitleCueSchema>;
export type ZhiyingFullCutProps = z.infer<typeof zhiyingFullCutPropsSchema>;

export const SCHEMA_VERSION = '1.0';
export const TEMPLATE_VERSION = 'freud-mg-v1.0';
export const COMPOSITION_ID = 'ZhiyingFullCut';
export const COMPOSITION_ID_NO_SUBTITLES = 'ZhiyingFullCutNoSubtitles';

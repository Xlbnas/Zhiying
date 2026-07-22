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
 */
export const zhiyingFullCutPropsSchema = z.object({
  data: fullCutDataSchema,
  subtitles: z.array(subtitleCueSchema).default([]),
  audio: z.object({
    /** staticFile 相对路径，如 full/audio/narration.wav；null = 无旁白 */
    narration: z.string().nullable().default(null),
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

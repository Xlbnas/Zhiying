/**
 * Narrative Beats artifact 契约（M7.2，narrative-beats@1.0）。
 *
 * 语义边界（冻结）：
 * - Beat 只回答「narration units 在语义上如何组成连续叙事节拍、
 *   每个节拍在论证中承担什么作用」。
 * - Beat 不得引用下游 Sequence/Shot/Scene/Asset，不得拥有视觉意图、
 *   转场或任何最终 timing（毫秒/帧），不提供上屏文案。
 *   这些字段由 .strict() + 显式 forbidden-key 检查双重拒绝。
 * - summary/payoff 是编辑备注：永不进入 TTS、字幕、MG、title card 或成片。
 * - artifact 永远只是 candidate；不 current/selected/active/locked。
 *   M7 pipeline snapshot 将来通过 exact artifact ID 引用它。
 */

import {z} from 'zod';

export const NARRATIVE_BEATS_KIND = 'narrative_beats';
export const NARRATIVE_BEATS_SCHEMA_VERSION = 'narrative-beats@1.0';
export const NARRATIVE_BEATS_COMPILER_VERSION = '1.0';
export const NARRATIVE_BEATS_PROMPT_VERSION = 'narrative-beats@1.0';

/** summary/payoff 长度上限（编辑备注，不是文案）。 */
export const MAX_BEAT_SUMMARY_LEN = 240;
export const MAX_BEAT_PAYOFF_LEN = 240;

export const narrativeBeatRoleSchema = z.enum([
  'hook',
  'question',
  'context',
  'claim',
  'explanation',
  'example',
  'evidence',
  'contrast',
  'transition',
  'summary',
  'quote',
  'pause',
]);
export type NarrativeBeatRole = z.infer<typeof narrativeBeatRoleSchema>;

const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const narrativeBeatV1Schema = z
  .object({
    beatId: z.string().regex(/^B\d{3}$/),
    chapter: z.number().int().positive(),
    /** 引用 Narration Plan V2 的全部 unit 类型（speech + silence 都必须被覆盖）。 */
    unitIds: z.array(z.string().min(1)).min(1),
    role: narrativeBeatRoleSchema,
    /** 编辑备注，永不上屏。 */
    summary: z.string().min(1).max(MAX_BEAT_SUMMARY_LEN),
    /** 该 beat 在论证推进中完成的结果；允许 null，不得作为上屏文案。 */
    payoff: z.string().min(1).max(MAX_BEAT_PAYOFF_LEN).nullable(),
  })
  .strict();
export type NarrativeBeatV1 = z.infer<typeof narrativeBeatV1Schema>;

export const narrativeBeatsSourceSchema = z
  .object({
    /** 精确来源 artifact ID（禁止 latest/current 解析）。 */
    narrationPlanV2ArtifactId: z.string().min(1),
    /** 来源 artifact content_json 的 sha256——source 漂移必现。 */
    narrationPlanV2ContentHash: sha256HashSchema,
    narrationPlanSchemaVersion: z.literal('narration-plan@2.0'),
    narrationCompilerVersion: z.literal('2.0'),
    scriptV2VersionId: z.string().min(1),
    scriptV2ContentHash: sha256HashSchema,
  })
  .strict();
export type NarrativeBeatsSource = z.infer<typeof narrativeBeatsSourceSchema>;

export const narrativeBeatsGenerationSchema = z
  .object({
    /** 调用方提供的幂等键：同 requestId + 同 source → 同一 artifact。 */
    requestId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** 真实 LLM 请求次数（首次 + repair）。 */
    attemptCount: z.number().int().positive(),
  })
  .strict();
export type NarrativeBeatsGeneration = z.infer<typeof narrativeBeatsGenerationSchema>;

export const narrativeBeatsArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(NARRATIVE_BEATS_SCHEMA_VERSION),
    compilerVersion: z.literal(NARRATIVE_BEATS_COMPILER_VERSION),
    promptVersion: z.literal(NARRATIVE_BEATS_PROMPT_VERSION),
    source: narrativeBeatsSourceSchema,
    generation: narrativeBeatsGenerationSchema,
    beats: z.array(narrativeBeatV1Schema).min(1),
  })
  .strict();
export type NarrativeBeatsArtifactV1 = z.infer<typeof narrativeBeatsArtifactV1Schema>;

/**
 * LLM 输出契约（proposal/repair 共用）：只含 beats 数组。
 * 与 artifact beat schema 同一 shape——LLM 不得输出任何额外字段。
 */
export const narrativeBeatsProposalSchema = z
  .object({
    beats: z.array(narrativeBeatV1Schema).min(1),
  })
  .strict();
export type NarrativeBeatsProposal = z.infer<typeof narrativeBeatsProposalSchema>;

/**
 * Beat 层禁止出现的下游/timing/视觉字段（M7.2 冻结边界）。
 * .strict() 已拒绝未知 key；本清单用于语义校验时给出精确错误码，
 * 并防御未来 schema 演进时有人把这些字段「合法化」。
 */
export const FORBIDDEN_BEAT_FIELDS = [
  'sequenceId',
  'visualIntent',
  'visualStrategy',
  'shotId',
  'sceneId',
  'assetId',
  'assetRequirement',
  'transition',
  'startMs',
  'endMs',
  'startFrame',
  'durationFrames',
  'durationIntentMs',
  'displayText',
] as const;

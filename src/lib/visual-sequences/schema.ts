/**
 * Visual Sequences artifact 契约（M7.3B，visual-sequences@1.0）。
 *
 * 语义边界：
 * - Sequence 只回答「哪些连续的 Narrative Beats 构成一个连续视觉体
 *   （Q001…Qnnn），它引用哪些 Visual Intent」。
 * - Sequence 是纯结构性契约：只含 sequenceId/chapter/beatIds/visualIntentIds。
 *   beatIds 是「语义切片锚点」，不是最终时间。
 * - Sequence 不得引用下游 Shot/Scene/Asset，不得拥有任何最终 timing
 *   （毫秒/帧）、转场、fit/focal/crop、template/render 字段，
 *   不得复制 Visual Intent 内容（intent/strategy/authenticity/objective/
 *   subject/displayText/evidenceIds 等全部禁止）。
 * - artifact 永远只是 candidate；不 current/selected/active/locked。
 *   M7 pipeline snapshot 将来通过 exact artifact ID 引用它。
 */

import {z} from 'zod';

export const VISUAL_SEQUENCES_KIND = 'visual_sequence_plan';
export const VISUAL_SEQUENCES_SCHEMA_VERSION = 'visual-sequences@1.0';
export const VISUAL_SEQUENCES_COMPILER_VERSION = '1.0';
export const VISUAL_SEQUENCES_PROMPT_VERSION = 'visual-sequences@1.0';

/** 历史兼容版本数组（本轮只含 1.0；stale 判定在 classify 层）。 */
export const VISUAL_SEQUENCES_COMPILER_VERSIONS = ['1.0'] as const;
export const VISUAL_SEQUENCES_PROMPT_VERSIONS = ['visual-sequences@1.0'] as const;

const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * Visual Sequence 最小结构（M7.3B §五）：
 * 一个连续视觉体，跨 1..n 个连续 Narrative Beats，包含 1..n 个 Visual Intent 引用。
 * 只允许这些结构性字段；视觉语义一律经 visualIntentId 引用，不复制内容。
 * reference ID 在 schema 层精确限制（M7.3B.R1 P1）：beatIds 必须 B\d{3}、
 * visualIntentIds 必须 V\d{3}——malformed reference 在 schema 层拒绝，
 * 不得只依靠 semantic NOT_FOUND。
 */
export const visualSequenceV1Schema = z
  .object({
    sequenceId: z.string().regex(/^Q\d{3}$/),
    chapter: z.number().int().positive(),
    /** 引用 Narrative Beats artifact 的 beatId（B\d{3}），连续、非空、全局恰好覆盖一次。 */
    beatIds: z.array(z.string().regex(/^B\d{3}$/)).min(1),
    /** 顺序引用 Visual Intent Plan artifact 的 visualIntentId（V\d{3}）；不复制 intent 内容。 */
    visualIntentIds: z.array(z.string().regex(/^V\d{3}$/)).min(1),
  })
  .strict();
export type VisualSequenceV1 = z.infer<typeof visualSequenceV1Schema>;

/**
 * Sequence 的 exact immutable source（M7.3B §5.2）。
 * 全部字段由服务端从 exact parent provenance 确定性填充，禁止 latest/current 猜来源。
 */
export const visualSequencesSourceV1Schema = z
  .object({
    /** 精确来源 beats artifact ID（禁止 latest/current 解析）。 */
    narrativeBeatsArtifactId: z.string().min(1),
    /** 来源 beats artifact content_json 的 sha256——source 漂移必现。 */
    narrativeBeatsContentHash: sha256HashSchema,
    narrativeBeatsSchemaVersion: z.literal('narrative-beats@1.0'),
    narrativeBeatsCompilerVersion: z.literal('1.0'),
    /** 精确来源 visual intent artifact ID。 */
    visualIntentPlanArtifactId: z.string().min(1),
    visualIntentPlanContentHash: sha256HashSchema,
    visualIntentSchemaVersion: z.literal('visual-intent-plan@1.0'),
    visualIntentCompilerVersion: z.literal('1.1'),
    /** 经双 provenance 传递的 narration plan 与 script_v2（两链必须完全一致）。 */
    narrationPlanV2ArtifactId: z.string().min(1),
    narrationPlanV2ContentHash: sha256HashSchema,
    scriptV2VersionId: z.string().min(1),
    scriptV2ContentHash: sha256HashSchema,
  })
  .strict();
export type VisualSequencesSourceV1 = z.infer<typeof visualSequencesSourceV1Schema>;

export const visualSequencesGenerationSchema = z
  .object({
    /** 调用方提供的幂等键：同 requestId + 同 source → 同一 artifact。 */
    requestId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** 真实 LLM 请求次数（首次 + repair）。 */
    attemptCount: z.number().int().positive(),
  })
  .strict();
export type VisualSequencesGeneration = z.infer<typeof visualSequencesGenerationSchema>;

export const visualSequencesArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(VISUAL_SEQUENCES_SCHEMA_VERSION),
    compilerVersion: z.enum(VISUAL_SEQUENCES_COMPILER_VERSIONS),
    promptVersion: z.enum(VISUAL_SEQUENCES_PROMPT_VERSIONS),
    source: visualSequencesSourceV1Schema,
    generation: visualSequencesGenerationSchema,
    sequences: z.array(visualSequenceV1Schema).min(1),
  })
  .strict();
export type VisualSequencesArtifactV1 = z.infer<typeof visualSequencesArtifactV1Schema>;

/**
 * LLM 输出契约（proposal/repair 共用）：只含 sequences 数组。
 * LLM 不得输出 source/hash/版本/generation/服务器路径/素材/时序字段——
 * wrapper 由服务端确定性构造。
 */
export const visualSequencesProposalSchema = z
  .object({
    sequences: z.array(visualSequenceV1Schema).min(1),
  })
  .strict();
export type VisualSequencesProposal = z.infer<typeof visualSequencesProposalSchema>;

/**
 * Sequence 层禁止出现的下游/timing/asset/视觉语义副本字段（M7.3B §5.1）。
 * .strict() 已拒绝未知 key；本清单用于语义校验时给出精确错误码
 * （SEQUENCE_FORBIDDEN_FIELD），并防御未来 schema 演进时有人把这些字段「合法化」。
 */
export const FORBIDDEN_SEQUENCE_FIELDS = [
  'shotIds',
  'sceneId',
  'assetId',
  'requirementId',
  'templateId',
  'templateProps',
  'resolvedAsset',
  'fitPolicy',
  'focalPoint',
  'cropSafe',
  'transition',
  'startMs',
  'endMs',
  'durationMs',
  'frame',
  'spokenText',
  'subtitleText',
  'displayText',
  'objective',
  'subject',
  'intent',
  'strategy',
  'authenticity',
  'voice',
  'delivery',
  'pace',
  'energy',
  'emotion',
] as const;
export type ForbiddenSequenceField = (typeof FORBIDDEN_SEQUENCE_FIELDS)[number];

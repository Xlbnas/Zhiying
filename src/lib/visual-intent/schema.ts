/**
 * Visual Intent Plan artifact 契约（M7.3A，visual-intent-plan@1.0）。
 *
 * 语义边界（冻结）：
 * - Visual Intent 只回答「每个 Narrative Beat 在画面上意图展示什么、
 *   以什么策略展示、真实性要求是什么」。
 * - Intent 不得引用下游 Sequence/Shot/Scene/Asset，不得拥有任何最终
 *   timing（毫秒/帧）、转场、fit/focal/crop 或 template/render 字段。
 *   这些字段由 .strict() + 显式 forbidden-key 检查双重拒绝。
 * - objective/subject.label 是编辑备注：永不进入 TTS、字幕、MG、
 *   title card 或成片。displayText 是 title card 唯一合法上屏文本来源，
 *   且必须精确引用 spokenText/subtitleText/chapter title。
 * - artifact 永远只是 candidate；不 current/selected/active/locked。
 *   M7 pipeline snapshot 将来通过 exact artifact ID 引用它。
 */

import {z} from 'zod';

export const VISUAL_INTENT_KIND = 'visual_intent_plan';
export const VISUAL_INTENT_SCHEMA_VERSION = 'visual-intent-plan@1.0';
export const VISUAL_INTENT_COMPILER_VERSION = '1.0';
export const VISUAL_INTENT_PROMPT_VERSION = 'visual-intent-plan@1.0';

/** objective/subject.label 长度上限（编辑备注，不是文案）。 */
export const MAX_INTENT_OBJECTIVE_LEN = 240;
export const MAX_SUBJECT_LABEL_LEN = 120;

export const visualIntentKindSchema = z.enum([
  'SHOW_PERSON',
  'SHOW_PLACE',
  'SHOW_ARCHIVE',
  'SHOW_DOCUMENT',
  'SHOW_EVIDENCE',
  'SHOW_EXAMPLE',
  'SHOW_PROCESS',
  'SHOW_RELATIONSHIP',
  'SHOW_COMPARISON',
  'SHOW_DATA',
  'EMPHASIZE_TEXT',
  'CONTINUE_PREVIOUS_VISUAL',
  'NO_VISUAL_CHANGE',
  'VISUAL_UNRESOLVED',
]);
export type VisualIntentKind = z.infer<typeof visualIntentKindSchema>;

export const visualStrategySchema = z.enum([
  'portrait',
  'archive_photo',
  'archive_video',
  'document_frame',
  'evidence_frame',
  'real_world_example',
  'mg_process',
  'mg_relationship',
  'mg_comparison',
  'mg_data',
  'title_card',
  'continue_previous',
  'hold',
  'unresolved',
]);
export type VisualStrategy = z.infer<typeof visualStrategySchema>;

export const authenticityRequirementSchema = z.enum([
  'authentic_required',
  'authentic_preferred',
  'synthetic_allowed',
  'inherited',
  'not_applicable',
]);
export type AuthenticityRequirement = z.infer<typeof authenticityRequirementSchema>;

export const visualSubjectKindSchema = z.enum([
  'person',
  'place',
  'archive',
  'document',
  'evidence',
  'example',
  'process',
  'relationship',
  'comparison',
  'data',
  'text',
  'none',
]);
export type VisualSubjectKind = z.infer<typeof visualSubjectKindSchema>;

/**
 * title card 上屏文本的精确引用：只允许 spokenText/subtitleText/chapter title
 * 三个来源，文本必须与引用源逐字一致（validate 层强制）。
 */
export const displayTextReferenceSchema = z
  .object({
    sourceKind: z.enum(['spoken_exact', 'subtitle_exact', 'chapter_title']),
    /** spoken_exact/subtitle_exact 必填；chapter_title 为 null。 */
    sourceUnitId: z.string().min(1).nullable(),
    /** chapter_title 必填；spoken/subtitle 为 null。 */
    sourceChapter: z.number().int().positive().nullable(),
    text: z.string().min(1),
  })
  .strict();
export type DisplayTextReference = z.infer<typeof displayTextReferenceSchema>;

const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const visualIntentSubjectSchema = z
  .object({
    kind: visualSubjectKindSchema,
    /** 编辑备注（如「讲述者」「事发街道」），永不上屏。 */
    label: z.string().min(1).max(MAX_SUBJECT_LABEL_LEN).nullable(),
    evidenceIds: z.array(z.string().min(1)),
  })
  .strict();
export type VisualIntentSubject = z.infer<typeof visualIntentSubjectSchema>;

export const visualIntentV1Schema = z
  .object({
    visualIntentId: z.string().regex(/^V\d{3}$/),
    chapter: z.number().int().positive(),
    /** 引用 Narrative Beats artifact 的 beatId；每个 beat 恰好被覆盖一次。 */
    beatIds: z.array(z.string().min(1)).min(1),
    intent: visualIntentKindSchema,
    strategy: visualStrategySchema,
    authenticity: authenticityRequirementSchema,
    /** 编辑备注，永不上屏。 */
    objective: z.string().min(1).max(MAX_INTENT_OBJECTIVE_LEN),
    subject: visualIntentSubjectSchema,
    /** CONTINUE_PREVIOUS_VISUAL/NO_VISUAL_CHANGE 必填；其余必须为 null。 */
    continuationOfVisualIntentId: z.string().min(1).nullable(),
    /** 仅 EMPHASIZE_TEXT 非 null（title card 精确引用）。 */
    displayText: displayTextReferenceSchema.nullable(),
  })
  .strict();
export type VisualIntentV1 = z.infer<typeof visualIntentV1Schema>;

export const visualIntentSourceSchema = z
  .object({
    /** 精确来源 beats artifact ID（禁止 latest/current 解析）。 */
    narrativeBeatsArtifactId: z.string().min(1),
    /** 来源 beats artifact content_json 的 sha256——source 漂移必现。 */
    narrativeBeatsContentHash: sha256HashSchema,
    narrativeBeatsSchemaVersion: z.literal('narrative-beats@1.0'),
    narrativeBeatsCompilerVersion: z.literal('1.0'),
    /** 经 beats provenance 传递的精确 narration plan（displayText 核对源）。 */
    narrationPlanV2ArtifactId: z.string().min(1),
    narrationPlanV2ContentHash: sha256HashSchema,
    scriptV2VersionId: z.string().min(1),
    scriptV2ContentHash: sha256HashSchema,
  })
  .strict();
export type VisualIntentSource = z.infer<typeof visualIntentSourceSchema>;

export const visualIntentGenerationSchema = z
  .object({
    /** 调用方提供的幂等键：同 requestId + 同 source → 同一 artifact。 */
    requestId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** 真实 LLM 请求次数（首次 + repair）。 */
    attemptCount: z.number().int().positive(),
  })
  .strict();
export type VisualIntentGeneration = z.infer<typeof visualIntentGenerationSchema>;

export const visualIntentPlanArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(VISUAL_INTENT_SCHEMA_VERSION),
    compilerVersion: z.literal(VISUAL_INTENT_COMPILER_VERSION),
    promptVersion: z.literal(VISUAL_INTENT_PROMPT_VERSION),
    source: visualIntentSourceSchema,
    generation: visualIntentGenerationSchema,
    intents: z.array(visualIntentV1Schema).min(1),
  })
  .strict();
export type VisualIntentPlanArtifactV1 = z.infer<typeof visualIntentPlanArtifactV1Schema>;

/**
 * LLM 输出契约（proposal/repair 共用）：只含 intents 数组。
 * 与 artifact intent schema 同一 shape——LLM 不得输出任何额外字段。
 */
export const visualIntentProposalSchema = z
  .object({
    intents: z.array(visualIntentV1Schema).min(1),
  })
  .strict();
export type VisualIntentProposal = z.infer<typeof visualIntentProposalSchema>;

/**
 * Visual Intent 层禁止出现的下游/timing/asset 字段（M7.3A 冻结边界）。
 * .strict() 已拒绝未知 key；本清单用于语义校验时给出精确错误码，
 * 并防御未来 schema 演进时有人把这些字段「合法化」。
 */
export const FORBIDDEN_INTENT_FIELDS = [
  'sequenceId',
  'shotId',
  'sceneId',
  'assetId',
  'requirementId',
  'startMs',
  'endMs',
  'durationMs',
  'durationFrames',
  'startFrame',
  'endFrame',
  'transition',
  'fitPolicy',
  'focalPoint',
  'cropSafe',
  'templateProps',
  'resolvedAsset',
  'renderSegmentId',
] as const;

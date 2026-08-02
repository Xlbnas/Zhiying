/**
 * Shots artifact 契约（M7.3B，shots@1.0）。
 *
 * 语义边界：
 * - Shot 只回答「一个 Visual Sequence 内部如何按 Narration Plan V2 unit
 *   边界切分为连续镜头（H001…Hnnn），每个镜头引用哪个 Visual Intent、
 *   与前一个镜头的转场类型」。
 * - unitIds 是「语义切片锚点」，不是最终时间。
 * - Shot 不得包含任何最终 timing（毫秒/帧）、render segment、素材/模板/
 *   fit/focal/crop 字段，不得复制 Visual Intent 内容（intent/strategy/
 *   authenticity/objective/subject/displayText/evidenceIds），
 *   不得包含 spokenText/subtitleText/voice/performance 字段。
 * - artifact 永远只是 candidate；不 current/selected/active/locked。
 *   M7 pipeline snapshot 将来通过 exact artifact ID 引用它。
 */

import {z} from 'zod';

export const SHOTS_KIND = 'shot_plan';
export const SHOTS_SCHEMA_VERSION = 'shots@1.0';
export const SHOTS_COMPILER_VERSION = '1.0';
export const SHOTS_PROMPT_VERSION = 'shots@1.0';

/** 历史兼容版本数组（本轮只含 1.0；stale 判定在 classify 层）。 */
export const SHOTS_COMPILER_VERSIONS = ['1.0'] as const;
export const SHOTS_PROMPT_VERSIONS = ['shots@1.0'] as const;

const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const shotTransitionSchema = z.enum(['cut', 'crossfade', 'fade_black', 'hold', 'state_morph']);
export type ShotTransition = z.infer<typeof shotTransitionSchema>;

/**
 * Shot 最小结构（M7.3B §6.1）：
 * 语义切片锚点（unitIds）+ 唯一 Visual Intent 引用 + 与前一镜头的转场决策。
 * 只允许这些结构性字段。
 * reference ID 在 schema 层精确限制（M7.3B.R1 P1）：unitIds 必须 N\d{3}、
 * visualIntentId 必须 V\d{3}——malformed reference 在 schema 层拒绝。
 */
export const shotV1Schema = z
  .object({
    shotId: z.string().regex(/^H\d{3}$/),
    /** 精确 parent sequence（exact Visual Sequence artifact 的 sequenceId，Q\d{3}）。 */
    sequenceId: z.string().regex(/^Q\d{3}$/),
    chapter: z.number().int().positive(),
    /** 引用 Narration Plan V2 unit 边界（N\d{3}），连续非空；speech 与 silence 都必须被覆盖。 */
    unitIds: z.array(z.string().regex(/^N\d{3}$/)).min(1),
    /** 只引用 Visual Intent（V\d{3}），不复制 intent 内容。 */
    visualIntentId: z.string().regex(/^V\d{3}$/),
    transitionFromPrevious: shotTransitionSchema,
  })
  .strict();
export type ShotV1 = z.infer<typeof shotV1Schema>;

/**
 * Shots 的 exact immutable source（M7.3B §6.2）。
 * Visual Sequence artifact 自身记录的 source 必须与 Shots source 完全一致
 * （classify/validate 强制核对，不只听 transitive provenance）。
 */
export const shotsSourceV1Schema = z
  .object({
    /** 精确来源 visual sequences artifact ID（禁止 latest/current 解析）。 */
    visualSequencesArtifactId: z.string().min(1),
    /** 来源 sequences artifact content_json 的 sha256——source 漂移必现。 */
    visualSequencesContentHash: sha256HashSchema,
    visualSequencesSchemaVersion: z.literal('visual-sequences@1.0'),
    visualSequencesCompilerVersion: z.literal('1.0'),
    /** 经 sequences provenance 传递的精确上游（全部 hash 钉死）。 */
    narrativeBeatsArtifactId: z.string().min(1),
    narrativeBeatsContentHash: sha256HashSchema,
    visualIntentPlanArtifactId: z.string().min(1),
    visualIntentPlanContentHash: sha256HashSchema,
    narrationPlanV2ArtifactId: z.string().min(1),
    narrationPlanV2ContentHash: sha256HashSchema,
    scriptV2VersionId: z.string().min(1),
    scriptV2ContentHash: sha256HashSchema,
  })
  .strict();
export type ShotsSourceV1 = z.infer<typeof shotsSourceV1Schema>;

export const shotsGenerationSchema = z
  .object({
    /** 调用方提供的幂等键：同 requestId + 同 source → 同一 artifact。 */
    requestId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** 真实 LLM 请求次数（首次 + repair）。 */
    attemptCount: z.number().int().positive(),
  })
  .strict();
export type ShotsGeneration = z.infer<typeof shotsGenerationSchema>;

export const shotsArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(SHOTS_SCHEMA_VERSION),
    compilerVersion: z.enum(SHOTS_COMPILER_VERSIONS),
    promptVersion: z.enum(SHOTS_PROMPT_VERSIONS),
    source: shotsSourceV1Schema,
    generation: shotsGenerationSchema,
    shots: z.array(shotV1Schema).min(1),
  })
  .strict();
export type ShotsArtifactV1 = z.infer<typeof shotsArtifactV1Schema>;

/**
 * LLM 输出契约（proposal/repair 共用）：只含 shots 数组。
 * LLM 不得输出 source/hash/版本/generation/服务器路径/素材/时序字段——
 * wrapper 由服务端确定性构造。
 */
export const shotsProposalSchema = z
  .object({
    shots: z.array(shotV1Schema).min(1),
  })
  .strict();
export type ShotsProposal = z.infer<typeof shotsProposalSchema>;

/**
 * Shot 层禁止出现的下游/timing/asset/语音语义字段（M7.3B §6.1）。
 * .strict() 已拒绝未知 key；本清单用于语义校验时给出精确错误码
 * （SHOT_FORBIDDEN_FIELD），并防御未来 schema 演进时有人把这些字段「合法化」。
 */
export const FORBIDDEN_SHOT_FIELDS = [
  'beatSummary',
  'spokenText',
  'subtitleText',
  'displayText',
  'intent',
  'strategy',
  'authenticity',
  'objective',
  'subject',
  'assetId',
  'requirementId',
  'assetQuery',
  'templateId',
  'templateProps',
  'stateProps',
  'fitPolicy',
  'focalPoint',
  'cropSafe',
  'startMs',
  'endMs',
  'durationMs',
  'frames',
  'renderSegment',
  'voiceProfile',
  'delivery',
  'pace',
  'energy',
  'emotion',
] as const;
export type ForbiddenShotField = (typeof FORBIDDEN_SHOT_FIELDS)[number];

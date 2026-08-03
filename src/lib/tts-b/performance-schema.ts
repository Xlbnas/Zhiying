/**
 * TTS-B Narration Performance Plan schema（设计文档 §5/§6）。
 * provider-neutral synthesis intent：adapter 当前不消费 pace/energy/emotion，
 * 文档明示「未声称 IndexTTS2 当前已支持」，TTS-C 做 provider capability compile。
 */
import {z} from 'zod';
import {
  NARRATION_PERFORMANCE_PLAN_COMPILER_VERSION,
  NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION,
  NARRATION_PERFORMANCE_PLAN_SCHEMA_VERSION,
} from './constants';

const unitIdSchema = z.string().regex(/^N\d{3}$/);

export const deliveryOverrideSchema = z.enum([
  'normal',
  'slow',
  'fast',
  'soft',
  'firm',
  'emphasis',
]);
export type DeliveryOverride = z.infer<typeof deliveryOverrideSchema>;

export const paceSchema = z.enum(['slow', 'normal', 'fast']);
export type Pace = z.infer<typeof paceSchema>;

export const energySchema = z.enum(['low', 'normal', 'high']);
export type Energy = z.infer<typeof energySchema>;

export const emotionNoneSchema = z.object({mode: z.literal('none')}).strict();

export const semanticEmotionLabelSchema = z.enum([
  'neutral',
  'warm',
  'serious',
  'reflective',
  'empathetic',
  'urgent',
  'authoritative',
]);
export type SemanticEmotionLabel = z.infer<typeof semanticEmotionLabelSchema>;

export const emotionSchema = z.discriminatedUnion('mode', [
  emotionNoneSchema,
  z
    .object({
      mode: z.literal('semantic'),
      label: semanticEmotionLabelSchema,
    })
    .strict(),
]);
export type Emotion = z.infer<typeof emotionSchema>;

/** LLM 输出契约：只允许 items 数组。禁止 source/hash/artifact ID/路径/文本副本/参数袋。 */
export const performanceItemsProposalSchema = z
  .object({
    items: z.array(
      z
        .object({
          unitId: unitIdSchema,
          deliveryOverride: deliveryOverrideSchema.nullable(),
          pace: paceSchema,
          energy: energySchema,
          emotion: emotionSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const performanceItemV1Schema = z
  .object({
    unitId: unitIdSchema,
    deliveryOverride: deliveryOverrideSchema.nullable(),
    pace: paceSchema,
    energy: energySchema,
    emotion: emotionSchema,
  })
  .strict();

export type PerformanceItemV1 = z.infer<typeof performanceItemV1Schema>;

/** source（全部服务端构造，禁止 LLM 输出 source）。 */
export const narrationPerformancePlanSourceSchema = z
  .object({
    narrationPlanArtifactId: z.string().min(1),
    narrationPlanContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    narrationPlanSchemaVersion: z.literal('narration-plan@2.0'),
    narrationPlanCompilerVersion: z.literal('2.0'),
    scriptV2VersionId: z.string().min(1),
    scriptV2Version: z.number().int().positive(),
    scriptV2ContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    projectVoiceAssignmentArtifactId: z.string().min(1),
    projectVoiceAssignmentContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    voiceProfileId: z.string().min(1),
    voiceProfileRevisionId: z.string().min(1),
    canonicalAudioSha256: z.string().regex(/^[0-9a-f]{64}$/),
    adapterCompatibilityKey: z.literal('indextts2-adapter-registry@1'),
  })
  .strict();

export const narrationPerformancePlanArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(NARRATION_PERFORMANCE_PLAN_SCHEMA_VERSION),
    compilerVersion: z.literal(NARRATION_PERFORMANCE_PLAN_COMPILER_VERSION),
    promptVersion: z.literal(NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION),
    source: narrationPerformancePlanSourceSchema,
    generation: z
      .object({
        requestId: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        attemptCount: z.number().int().positive(),
      })
      .strict(),
    items: z.array(performanceItemV1Schema),
  })
  .strict();

export type NarrationPerformancePlanArtifactV1 = z.infer<
  typeof narrationPerformancePlanArtifactV1Schema
>;

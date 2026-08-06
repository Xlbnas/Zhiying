/**
 * TTS-C.1C.1 — provider capability snapshot v1（普通 TS 常量 + zod schema）。
 *
 * 冻结绑定（引用而非复制，禁止修改）：
 * - provider === tts_jobs.provider 取值 `indextts2`
 *   （src/lib/tts-b/performance-schema.ts:98，frozen）
 * - adapterCompatibilityKey === frozen narration performance plan source 的
 *   `indextts2-adapter-registry@1`（src/lib/tts-b/performance-schema.ts:100，frozen）
 *
 * v1 只声明四个表现力 control：deliveryOverride / pace / energy / emotionSemantic。
 * 当前 IndexTTS2 adapter 不消费这些表现力参数（合成请求仅
 * text/voiceProfile/voiceRevision/useRandom/emotion 五字段，非默认 useRandom/emotion
 * 显式 422），因此 v1 四项均 supported:false——如实反映现状，不做能力宣称。
 *
 * 明确不纳入 v1（后续产品增强需求，未取消；真实 schema 引入时必须 bump
 * snapshotVersion / compilerVersion）：
 *   useRandom / emotion text / emotion vector / emotionAlpha / 八维情绪向量 /
 *   情绪参考音频
 */
import {z} from 'zod';

export const PROVIDER_CAPABILITY_PROVIDER = 'indextts2';
export const PROVIDER_CAPABILITY_ADAPTER_COMPATIBILITY_KEY = 'indextts2-adapter-registry@1';
export const PROVIDER_CAPABILITY_SNAPSHOT_VERSION = 'indextts2-capability@1';
export const PROVIDER_CAPABILITY_COMPILER_VERSION = '1.0' as const;

/** 单个 control 的声明形状：supported 表示 provider 有消费该 control 的通道。 */
export const capabilityControlSchema = z.object({supported: z.boolean()}).strict();

/** capability snapshot v1 shape schema。未来引入新 control 时必须 bump snapshotVersion。 */
export const providerCapabilitySnapshotV1Schema = z
  .object({
    provider: z.literal(PROVIDER_CAPABILITY_PROVIDER),
    adapterCompatibilityKey: z.literal(PROVIDER_CAPABILITY_ADAPTER_COMPATIBILITY_KEY),
    snapshotVersion: z.literal(PROVIDER_CAPABILITY_SNAPSHOT_VERSION),
    controls: z
      .object({
        deliveryOverride: capabilityControlSchema,
        pace: capabilityControlSchema,
        energy: capabilityControlSchema,
        emotionSemantic: capabilityControlSchema,
      })
      .strict(),
  })
  .strict();

export type ProviderCapabilitySnapshotV1 = z.infer<
  typeof providerCapabilitySnapshotV1Schema
>;

/**
 * v1 固化快照：IndexTTS2 adapter 当前不消费任何表现力 control，四项全部
 * supported:false。本常量是 v1 的唯一权威实例；编译比对以传入 snapshot 为准，
 * 默认使用本常量（执行时 snapshot version 与编译时记录不一致 → fail-closed，属 C.2）。
 */
export const INDEXTTS2_CAPABILITY_SNAPSHOT_V1: ProviderCapabilitySnapshotV1 = {
  provider: PROVIDER_CAPABILITY_PROVIDER,
  adapterCompatibilityKey: PROVIDER_CAPABILITY_ADAPTER_COMPATIBILITY_KEY,
  snapshotVersion: PROVIDER_CAPABILITY_SNAPSHOT_VERSION,
  controls: {
    deliveryOverride: {supported: false},
    pace: {supported: false},
    energy: {supported: false},
    emotionSemantic: {supported: false},
  },
};

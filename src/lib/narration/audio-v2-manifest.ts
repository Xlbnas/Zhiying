import {z} from 'zod';
import {deliverySchema} from './schema-v2';

/**
 * Narration Audio V2（M7.1）：narration-audio@2.0 manifest schema +
 * TTS 增量复用决策（reuse planner）+ v2 enqueue（带 leakage hard gate）。
 *
 * 本轮只实现机制与测试：不在 production 执行任何 TTS 合成。
 * Duration 唯一真相仍为 ffprobe 实测（manifest 生成时记录，本层不宣称）。
 *
 * 复用规则（REVIEW DECISIONS 1.3）：
 * - v2 job（payload 含完整 ttsInputFingerprint）：fingerprint 完全一致才允许复用
 * - legacy job（v1 payload，无 fingerprint 字段）：默认不得猜测复用；
 *   仅当文本/声音/provider/model/delivery 全部可证明等价时，
 *   走受控 legacy compatibility 判定（显式 reason code，测试锁定）
 */

export const NARRATION_AUDIO_V2_SCHEMA_VERSION = 'narration-audio@2.0';
export const NARRATION_AUDIO_V2_ARTIFACT_KIND = 'narration_audio_manifest_v2';

const manifestV2SpeechUnitSchema = z.object({
  unitId: z.string().regex(/^N\d{3}$/),
  kind: z.literal('speech'),
  /** 唯一进入 TTS 的文本（= plan speech.spokenText）。 */
  spokenText: z.string().min(1),
  delivery: deliverySchema,
  ttsInputFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  filePath: z.string(),
  durationMs: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  sha256: z.string(),
  ttsJobId: z.string(),
});

const manifestV2SilenceUnitSchema = z.object({
  unitId: z.string().regex(/^N\d{3}$/),
  kind: z.literal('silence'),
  durationMs: z.number().int().positive(),
  reason: z.enum(['pause', 'visual_breath']),
});

export const narrationAudioManifestV2Schema = z.object({
  schemaVersion: z.literal(NARRATION_AUDIO_V2_SCHEMA_VERSION),
  source: z.object({
    narrationPlanV2ArtifactId: z.string().min(1),
    narrationPlanV2ArtifactVersion: z.number().int().positive(),
    scriptV2VersionId: z.string().min(1),
    scriptV2Version: z.number().int().positive(),
    narrationCompilerVersion: z.literal('2.0'),
  }),
  provider: z.object({
    name: z.string(),
    model: z.string(),
    providerVersion: z.string().nullable(),
    providerCommit: z.string().nullable(),
    voiceProfile: z.object({id: z.string(), revision: z.string()}),
    useRandom: z.literal(false),
  }),
  units: z.array(
    z.discriminatedUnion('kind', [manifestV2SpeechUnitSchema, manifestV2SilenceUnitSchema]),
  ),
  master: z.object({
    filePath: z.string(),
    durationMs: z.number().int().positive(),
    sha256: z.string(),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
  }),
});

export type NarrationAudioManifestV2 = z.infer<typeof narrationAudioManifestV2Schema>;
export type NarrationAudioManifestV2Unit = NarrationAudioManifestV2['units'][number];

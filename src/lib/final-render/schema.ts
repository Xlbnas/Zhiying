import crypto from 'node:crypto';
import {z} from 'zod';
import {zhiyingFullCutPropsSchema, type ZhiyingFullCutProps} from '../scene-schema';

/**
 * Final Render Source / Attempt 数据契约（M3-E）。
 *
 * final_render_source：immutable production render input snapshot——
 * 同一 sourceKey 幂等 reuse，内容永不 UPDATE（无 jobId/latestJobId/createdAt，
 * 时间戳只用 artifacts row 自身字段）。
 *
 * final_render_attempt：每一次人工 Final Render 一条，绑定 jobId →
 * exact immutable source artifact。source identity 与 execution attempt 明确分离。
 *
 * props / propsSha256 / sourceKey 全部 deterministic：同一 authoritative
 * sources 重复 build 字节级稳定（无 timestamp/random/temp path）。
 */

export const FINAL_RENDER_SOURCE_SCHEMA_VERSION = 'final-render-source@1.0';
/**
 * props builder / runtime narration logical path / source snapshot contract
 * 任一变化即升级——旧 source artifact 保留历史，不再 reuse。
 */
export const FINAL_RENDER_SOURCE_COMPILER_VERSION = '1.0';
export const FINAL_RENDER_SOURCE_ARTIFACT_KIND = 'final_render_source';

export const FINAL_RENDER_ATTEMPT_SCHEMA_VERSION = 'final-render-attempt@1.0';
export const FINAL_RENDER_ATTEMPT_ARTIFACT_KIND = 'final_render_attempt';

/** runtime narration 逻辑路径（bundled public root 内相对路径；system-owned，不接受用户输入）。 */
export const RUNTIME_NARRATION_PATTERN =
  /^runtime-audio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;

export function buildRuntimeNarrationLogicalPath(projectId: string, audioArtifactId: string): string {
  return `runtime-audio/${projectId}/${audioArtifactId}.wav`;
}

export const finalRenderSourceSchema = z.object({
  schemaVersion: z.literal(FINAL_RENDER_SOURCE_SCHEMA_VERSION),
  /** 历史可读字段；reuse 判定要求等于当前 compilerVersion。 */
  compilerVersion: z.string().min(1),
  mode: z.literal('final'),
  sourceKey: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.object({
    scenesVersionId: z.string().min(1),
    scenesVersion: z.number().int().positive(),
    narrationAudioArtifactId: z.string().min(1),
    narrationAudioArtifactVersion: z.number().int().positive(),
    subtitleTimingArtifactId: z.string().min(1),
    subtitleTimingArtifactVersion: z.number().int().positive(),
    timingReconciliationArtifactId: z.string().min(1),
    timingReconciliationArtifactVersion: z.number().int().positive(),
    masterSha256: z.string().regex(/^[0-9a-f]{64}$/),
    masterDurationMs: z.number().int().positive(),
    reconciliationCompilerVersion: z.string().min(1),
    subtitleCompilerVersion: z.string().min(1),
  }),
  narration: z.object({
    logicalPath: z.string().regex(RUNTIME_NARRATION_PATTERN),
    /** dataDir 相对路径（exact historical master，供 Worker 解析）。 */
    masterFilePath: z.string().min(1),
  }),
  propsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** normalized props 全量快照（Worker 不再 resolve 任何 current）。 */
  props: zhiyingFullCutPropsSchema,
});

export const finalRenderAttemptSchema = z.object({
  schemaVersion: z.literal(FINAL_RENDER_ATTEMPT_SCHEMA_VERSION),
  jobId: z.string().min(1),
  finalRenderSourceArtifactId: z.string().min(1),
  finalRenderSourceArtifactVersion: z.number().int().positive(),
  sourceKey: z.string().regex(/^[0-9a-f]{64}$/),
  propsSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type FinalRenderSource = z.infer<typeof finalRenderSourceSchema>;
export type FinalRenderAttempt = z.infer<typeof finalRenderAttemptSchema>;

/** normalized props → deterministic sha256（props JSON 字段序由 zod parse 输出固定）。 */
export function computePropsSha256(props: ZhiyingFullCutProps): string {
  return crypto.createHash('sha256').update(JSON.stringify(props)).digest('hex');
}

/**
 * sourceKey：固定字段序 keyObject 的 sha256。
 * 含 FINAL_RENDER_SOURCE_COMPILER_VERSION——contract 升级即全部旧 source stale。
 */
export function computeSourceKey(input: {
  projectId: string;
  source: FinalRenderSource['source'];
  propsSha256: string;
}): string {
  const keyObject = {
    compilerVersion: FINAL_RENDER_SOURCE_COMPILER_VERSION,
    projectId: input.projectId,
    scenesVersionId: input.source.scenesVersionId,
    scenesVersion: input.source.scenesVersion,
    narrationAudioArtifactId: input.source.narrationAudioArtifactId,
    narrationAudioArtifactVersion: input.source.narrationAudioArtifactVersion,
    subtitleTimingArtifactId: input.source.subtitleTimingArtifactId,
    subtitleTimingArtifactVersion: input.source.subtitleTimingArtifactVersion,
    timingReconciliationArtifactId: input.source.timingReconciliationArtifactId,
    timingReconciliationArtifactVersion: input.source.timingReconciliationArtifactVersion,
    masterSha256: input.source.masterSha256,
    masterDurationMs: input.source.masterDurationMs,
    reconciliationCompilerVersion: input.source.reconciliationCompilerVersion,
    subtitleCompilerVersion: input.source.subtitleCompilerVersion,
    propsSha256: input.propsSha256,
  };
  return crypto.createHash('sha256').update(JSON.stringify(keyObject)).digest('hex');
}

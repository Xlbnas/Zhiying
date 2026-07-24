import type {ScenesAiOutput} from '../prompts/scenes';
import {
  RECONCILIATION_COMPILER_VERSION,
  RECONCILIATION_FPS,
  RECONCILIATION_STRATEGY,
  TIMING_RECONCILIATION_SCHEMA_VERSION,
  timingReconciliationSchema,
  type ReconciledScene,
  type TimingReconciliation,
} from './schema';

/**
 * Timing Reconciliation Compiler（M3-D）：纯函数、deterministic。
 *
 * 算法：bounded cumulative proportional allocation（独立 review 修订一）。
 * - W = weightTotalFrames = Σ durationInFrames（不是 authoredTotalFrames）
 * - T = targetTotalFrames = round(masterDurationMs × fps / 1000)（唯一 ms→frame 换算点）
 * - 内部边界 raw_i = round(T × cum_i / W)，再 clamp 到 [prev+1, T-(n-i)]——
 *   clamp 是正式算法的一部分（保证每 scene ≥1 帧且为后续 scene 各留 1 帧），
 *   不是 silent repair
 * - Identity property：T === W 时 effective 严格等于 source（逐 scene 不变）
 * - T < sceneCount → RECONCILIATION_IMPOSSIBLE，禁止生成任何 artifact
 */

export type ReconciliationCompileErrorCode =
  | 'SCENES_INVALID'
  | 'RECONCILIATION_INVALID'
  | 'RECONCILIATION_IMPOSSIBLE';

export class ReconciliationCompileError extends Error {
  constructor(
    public readonly code: ReconciliationCompileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReconciliationCompileError';
  }
}

/** master ms → target frames（唯一换算点，deterministic）。 */
export function computeTargetTotalFrames(masterDurationMs: number, fps: number): number {
  return Math.round((masterDurationMs * fps) / 1000);
}

/**
 * bounded cumulative proportional allocation。
 * 输入：source durationInFrames 权重（每 scene ≥1，由 frozen Scenes 语义校验保证）。
 * 输出：effective durationFrames（每 scene ≥1，Σ === targetTotalFrames）。
 */
export function allocateSceneFrames(
  sourceDurationFrames: number[],
  targetTotalFrames: number,
): number[] {
  const n = sourceDurationFrames.length;
  if (n === 0) {
    throw new ReconciliationCompileError('SCENES_INVALID', 'scenes 为空');
  }
  if (targetTotalFrames < n) {
    throw new ReconciliationCompileError(
      'RECONCILIATION_IMPOSSIBLE',
      `targetTotalFrames(${targetTotalFrames}) < sceneCount(${n})：不可能每 scene ≥1 帧`,
    );
  }
  const weight = sourceDurationFrames.reduce((sum, w) => sum + w, 0);
  const boundaries: number[] = new Array<number>(n + 1);
  boundaries[0] = 0;
  boundaries[n] = targetTotalFrames;
  let cumulative = 0;
  for (let i = 1; i < n; i++) {
    cumulative += sourceDurationFrames[i - 1]!;
    const raw = Math.round((targetTotalFrames * cumulative) / weight);
    const lower = boundaries[i - 1]! + 1; // 前 scene 至少 1 帧
    const upper = targetTotalFrames - (n - i); // 为剩余 scene 各留 1 帧
    boundaries[i] = Math.min(Math.max(raw, lower), upper);
  }
  return sourceDurationFrames.map((_, i) => boundaries[i + 1]! - boundaries[i]!);
}

export interface ReconciliationSourceRefs {
  scenesVersionId: string;
  scenesVersion: number;
  narrationAudioArtifactId: string;
  narrationAudioArtifactVersion: number;
  subtitleTimingArtifactId: string;
  subtitleTimingArtifactVersion: number;
  narrationPlanArtifactId: string;
  narrationPlanArtifactVersion: number;
  scriptV2Version: number;
  narrationCompilerVersion: string;
  subtitleCompilerVersion: string;
  masterSha256: string;
  masterDurationMs: number;
}

/**
 * 编译：validated ScenesAiOutput + source refs + unresolved 透传
 * → TimingReconciliation（经 zod 完整校验，含 residual 语义重推导）。
 */
export function compileTimingReconciliation(input: {
  scenes: ScenesAiOutput;
  refs: ReconciliationSourceRefs;
  unresolvedNarrationUnitIds: string[];
}): TimingReconciliation {
  const {scenes, refs} = input;
  const fps = RECONCILIATION_FPS;
  const sourceDurations = scenes.scenes.map((s) => s.durationInFrames);
  const lastScene = scenes.scenes[scenes.scenes.length - 1];
  if (!lastScene) {
    throw new ReconciliationCompileError('SCENES_INVALID', 'scenes 为空');
  }

  const authoredTotalFrames = Math.round(lastScene.end * fps);
  const rendererEndFrame = Math.max(
    ...scenes.scenes.map((s) => s.startFrame + s.durationInFrames),
  );
  const weightTotalFrames = sourceDurations.reduce((sum, w) => sum + w, 0);

  const targetTotalFrames = computeTargetTotalFrames(refs.masterDurationMs, fps);
  const effectiveDurations = allocateSceneFrames(sourceDurations, targetTotalFrames);

  const reconciledScenes: ReconciledScene[] = [];
  let weightCursor = 0;
  let effectiveCursor = 0;
  scenes.scenes.forEach((scene, index) => {
    const sourceWeightDuration = scene.durationInFrames;
    const effectiveDuration = effectiveDurations[index]!;
    reconciledScenes.push({
      sceneId: scene.id,
      chapter: scene.chapter,
      authoredStartFrame: scene.startFrame,
      authoredDurationInFrames: scene.durationInFrames,
      sourceWeightStartFrame: weightCursor,
      sourceWeightEndFrame: weightCursor + sourceWeightDuration,
      sourceWeightDurationFrames: sourceWeightDuration,
      effectiveStartFrame: effectiveCursor,
      effectiveEndFrame: effectiveCursor + effectiveDuration,
      effectiveDurationFrames: effectiveDuration,
    });
    weightCursor += sourceWeightDuration;
    effectiveCursor += effectiveDuration;
  });

  const renderedDurationMs = (targetTotalFrames / fps) * 1000;
  const candidate = {
    schemaVersion: TIMING_RECONCILIATION_SCHEMA_VERSION,
    compilerVersion: RECONCILIATION_COMPILER_VERSION,
    source: {...refs},
    fps,
    strategy: RECONCILIATION_STRATEGY,
    scaleRatio: targetTotalFrames / weightTotalFrames,
    sourceVisual: {authoredTotalFrames, rendererEndFrame, weightTotalFrames},
    target: {
      totalFrames: targetTotalFrames,
      renderedDurationMs,
      frameResidualMs: renderedDurationMs - refs.masterDurationMs,
    },
    unresolvedNarrationUnitIds: [...input.unresolvedNarrationUnitIds],
    scenes: reconciledScenes,
  };
  const parsed = timingReconciliationSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ReconciliationCompileError(
      'RECONCILIATION_INVALID',
      `编译结果未通过契约校验：${first?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

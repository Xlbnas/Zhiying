import {z} from 'zod';
import {SCENES_SYSTEM_FPS} from '../workflow/scenes-semantic-validation';

/**
 * Timing Reconciliation 数据契约（M3-D）。
 *
 * 定位：Narration Audio Manifest（时长真相）+ locked Scenes（视觉源 timing）→
 * deterministic effective scene frame timeline。同一 (三 source snapshot,
 * compilerVersion) 重复编译字节级稳定——无 random / timestamp / LLM。
 *
 * Canonical truth：integer frame boundaries（Renderer 消费帧；秒值由
 * frames/fps 派生，仅作展示/audit）。scaleRatio 浮点只作 audit，
 * 不得用于重新推导 authoritative boundaries。
 *
 * Scenes 源数据只读——source timing 与 effective timing 同时记录，
 * 绝不 UPDATE / overwrite project_versions。
 */

export const TIMING_RECONCILIATION_SCHEMA_VERSION = 'timing-reconciliation@1.0';
/**
 * M3-D Final Data-Integrity Hardening：compiler algorithm 未变，但
 * current/reuse semantic contract 变强（target exact Math.round 校验、
 * current Scenes semantic snapshot 绑定、adapter source timing 兼容性校验）——
 * 旧 compiler@1.0 artifact 不再自动 current/reuse，保留为历史，重新 Build → 1.1。
 */
export const RECONCILIATION_COMPILER_VERSION = '1.1';
export const TIMING_RECONCILIATION_ARTIFACT_KIND = 'timing_reconciliation';
/** bounded cumulative proportional allocation（clamp 是正式算法一部分，非 silent repair）。 */
export const RECONCILIATION_STRATEGY = 'bounded_cumulative_proportional_frames';
/** reconciliation 的 fps 唯一来源：frozen Scenes 系统帧率。 */
export const RECONCILIATION_FPS = SCENES_SYSTEM_FPS;
/** frame residual 上界：半帧（ms）。 */
export const HALF_FRAME_MS = 500 / RECONCILIATION_FPS;
/** 浮点派生字段校验 epsilon。 */
const FLOAT_EPSILON = 1e-6;

export const reconciledSceneSchema = z.object({
  sceneId: z.string().regex(/^S\d{3}$/),
  chapter: z.number().int().positive(),
  /** 原 Scene 自己声明的 startFrame（round(start×fps)，逐 scene 独立 round）。 */
  authoredStartFrame: z.number().int().min(0),
  authoredDurationInFrames: z.number().int().positive(),
  /** proportional weighting 的构造性连续 source 坐标（durationInFrames 累计）。 */
  sourceWeightStartFrame: z.number().int().min(0),
  sourceWeightEndFrame: z.number().int().positive(),
  sourceWeightDurationFrames: z.number().int().positive(),
  /** reconciled effective timing（canonical truth）。 */
  effectiveStartFrame: z.number().int().min(0),
  effectiveEndFrame: z.number().int().positive(),
  effectiveDurationFrames: z.number().int().positive(),
});

export const timingReconciliationSchema = z
  .object({
    schemaVersion: z.literal(TIMING_RECONCILIATION_SCHEMA_VERSION),
    /** 历史可读字段；是否 current 由 timing.ts 判定。 */
    compilerVersion: z.string().min(1),
    /** Source snapshot（ immutable provenance，任一前进即 stale）。 */
    source: z.object({
      scenesVersionId: z.string().min(1),
      scenesVersion: z.number().int().positive(),
      narrationAudioArtifactId: z.string().min(1),
      narrationAudioArtifactVersion: z.number().int().positive(),
      subtitleTimingArtifactId: z.string().min(1),
      subtitleTimingArtifactVersion: z.number().int().positive(),
      narrationPlanArtifactId: z.string().min(1),
      narrationPlanArtifactVersion: z.number().int().positive(),
      scriptV2Version: z.number().int().positive(),
      narrationCompilerVersion: z.string().min(1),
      subtitleCompilerVersion: z.string().min(1),
      masterSha256: z.string().min(1),
      masterDurationMs: z.number().int().positive(),
    }),
    fps: z.literal(RECONCILIATION_FPS),
    strategy: z.literal(RECONCILIATION_STRATEGY),
    /** audit/display 专用：targetTotalFrames / weightTotalFrames，非 timing truth。 */
    scaleRatio: z.number().positive(),
    /** 三种 source frame 概念明确拆分（独立 review 修订二）。 */
    sourceVisual: z.object({
      /** round(lastScene.end × fps)：秒级 authored timeline 的项目总帧。 */
      authoredTotalFrames: z.number().int().positive(),
      /** max(scene.startFrame + durationInFrames)：现有 Renderer Sequence 实际覆盖的最末帧。 */
      rendererEndFrame: z.number().int().positive(),
      /** Σ durationInFrames：proportional allocation 的 weight denominator。 */
      weightTotalFrames: z.number().int().positive(),
    }),
    target: z.object({
      /** round(masterDurationMs × fps / 1000)：唯一 ms→frame 换算点。 */
      totalFrames: z.number().int().positive(),
      renderedDurationMs: z.number(),
      frameResidualMs: z.number(),
    }),
    /** 无时长 pause / visual_breath：只透传，不增加任何 duration。 */
    unresolvedNarrationUnitIds: z.array(z.string().regex(/^N\d{3}$/)),
    scenes: z.array(reconciledSceneSchema).min(1),
  })
  .superRefine((rec, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({code: z.ZodIssueCode.custom, message});
    };
    const {fps} = rec;

    // ---- target 派生字段语义校验（防 schema-valid-but-tampered residual）----
    // canonical video frame truth：master ms → target frames 的唯一正式规则是
    // Math.round——exact half-frame tie 只有一个合法答案，不允许 ±1 frame tamper
    // 仅靠 half-frame bound 蒙混（Hardening 1）。
    const expectedTarget = Math.round((rec.source.masterDurationMs * fps) / 1000);
    if (rec.target.totalFrames !== expectedTarget) {
      fail(
        `targetTotalFrames(${rec.target.totalFrames}) != Math.round(masterDurationMs×fps/1000)(${expectedTarget})`,
      );
    }
    const expectedRendered = (rec.target.totalFrames / fps) * 1000;
    if (Math.abs(rec.target.renderedDurationMs - expectedRendered) > FLOAT_EPSILON) {
      fail(`renderedDurationMs(${rec.target.renderedDurationMs}) 不等于 totalFrames/fps×1000(${expectedRendered})`);
    }
    const expectedResidual = rec.target.renderedDurationMs - rec.source.masterDurationMs;
    if (Math.abs(rec.target.frameResidualMs - expectedResidual) > FLOAT_EPSILON) {
      fail(`frameResidualMs(${rec.target.frameResidualMs}) 不等于 renderedDurationMs-masterDurationMs(${expectedResidual})`);
    }
    if (Math.abs(rec.target.frameResidualMs) > HALF_FRAME_MS + FLOAT_EPSILON) {
      fail(`frameResidualMs 超过半帧上界 ${HALF_FRAME_MS}ms`);
    }
    // scaleRatio 仅为 audit，但也必须与 integer totals 一致
    const expectedScale = rec.target.totalFrames / rec.sourceVisual.weightTotalFrames;
    if (Math.abs(rec.scaleRatio - expectedScale) > FLOAT_EPSILON) {
      fail(`scaleRatio 与 target/weight 不一致`);
    }
    // 最低可行性：每 scene 至少 1 帧
    if (rec.target.totalFrames < rec.scenes.length) {
      fail(`targetTotalFrames(${rec.target.totalFrames}) < sceneCount(${rec.scenes.length})`);
    }

    // ---- scene 序列（S001…S00N、weight 连续、effective 连续）----
    let weightSum = 0;
    let rendererEnd = 0;
    rec.scenes.forEach((scene, index) => {
      const expectedId = `S${String(index + 1).padStart(3, '0')}`;
      if (scene.sceneId !== expectedId) {
        fail(`scenes[${index}] sceneId 必须是 ${expectedId}（顺序不变）`);
      }
      // source weight 坐标：构造性连续、duration 自洽、与 authored duration 一致
      if (index === 0 && scene.sourceWeightStartFrame !== 0) {
        fail(`首个 scene sourceWeightStartFrame 必须为 0`);
      }
      if (index > 0 && scene.sourceWeightStartFrame !== rec.scenes[index - 1]!.sourceWeightEndFrame) {
        fail(`${scene.sceneId} sourceWeight 坐标不连续`);
      }
      if (scene.sourceWeightEndFrame - scene.sourceWeightStartFrame !== scene.sourceWeightDurationFrames) {
        fail(`${scene.sceneId} sourceWeightDurationFrames != end-start`);
      }
      if (scene.sourceWeightDurationFrames !== scene.authoredDurationInFrames) {
        fail(`${scene.sceneId} source weight duration 与 authored durationInFrames 不一致`);
      }
      weightSum += scene.sourceWeightDurationFrames;
      rendererEnd = Math.max(rendererEnd, scene.authoredStartFrame + scene.authoredDurationInFrames);
      // effective：连续、>=1 帧、duration 自洽
      if (index === 0 && scene.effectiveStartFrame !== 0) {
        fail(`首个 scene effectiveStartFrame 必须为 0`);
      }
      if (index > 0 && scene.effectiveStartFrame !== rec.scenes[index - 1]!.effectiveEndFrame) {
        fail(`${scene.sceneId} effective 坐标不连续（gap/overlap）`);
      }
      if (scene.effectiveEndFrame <= scene.effectiveStartFrame) {
        fail(`${scene.sceneId} effectiveEndFrame 必须大于 effectiveStartFrame`);
      }
      if (scene.effectiveEndFrame - scene.effectiveStartFrame !== scene.effectiveDurationFrames) {
        fail(`${scene.sceneId} effectiveDurationFrames != end-start`);
      }
    });
    if (rec.scenes.length > 0) {
      const last = rec.scenes[rec.scenes.length - 1]!;
      if (last.effectiveEndFrame !== rec.target.totalFrames) {
        fail(`末 scene effectiveEndFrame(${last.effectiveEndFrame}) != targetTotalFrames(${rec.target.totalFrames})`);
      }
      if (last.sourceWeightEndFrame !== rec.sourceVisual.weightTotalFrames) {
        fail(`weightTotalFrames 与末 scene sourceWeightEndFrame 不一致`);
      }
    }
    if (weightSum !== rec.sourceVisual.weightTotalFrames) {
      fail(`weightTotalFrames != Σ sourceWeightDurationFrames`);
    }
    if (rendererEnd !== rec.sourceVisual.rendererEndFrame) {
      fail(`rendererEndFrame != max(authoredStartFrame+authoredDurationInFrames)`);
    }
  });

export type ReconciledScene = z.infer<typeof reconciledSceneSchema>;
export type TimingReconciliation = z.infer<typeof timingReconciliationSchema>;

import {scenesAiOutputSchema, type ScenesAiOutput} from '../prompts/scenes';
import type {ChapterTiming, Scene} from '../scene-schema';
import {validateScenesSemantics} from '../workflow/scenes-semantic-validation';
import {ReconciliationCompileError} from './compiler';
import type {TimingReconciliation} from './schema';

/**
 * Renderer Adapter（M3-D §十八）：pure，证明 reconciliation 可安全映射到
 * 现有 frozen Scenes contract。不接 Render Bridge、不触发 render。
 *
 * 只替换 timing 字段（start/end/duration/startFrame/durationInFrames +
 * chapterTiming 的 start/end），scene id/chapter/template/category/内容/
 * assetIds/licenseStatus/transition 全部原样；不修改输入 object。
 * 输出必须重新通过 scenesAiOutputSchema + validateScenesSemantics。
 */
export function applyTimingReconciliation(input: {
  scenes: Scene[];
  chapterTiming: ChapterTiming[];
  reconciliation: TimingReconciliation;
}): ScenesAiOutput {
  const {reconciliation} = input;
  const fps = reconciliation.fps;
  if (input.scenes.length !== reconciliation.scenes.length) {
    throw new ReconciliationCompileError(
      'RECONCILIATION_INVALID',
      `source scenes(${input.scenes.length}) 与 reconciliation scenes(${reconciliation.scenes.length}) 数量不一致`,
    );
  }

  const scenes: Scene[] = input.scenes.map((scene, index) => {
    const rec = reconciliation.scenes[index]!;
    if (rec.sceneId !== scene.id || rec.chapter !== scene.chapter) {
      throw new ReconciliationCompileError(
        'RECONCILIATION_INVALID',
        `scene[${index}]（${scene.id}/第${scene.chapter}章）与 reconciliation（${rec.sceneId}/第${rec.chapter}章）不对齐`,
      );
    }
    return {
      ...scene,
      start: rec.effectiveStartFrame / fps,
      end: rec.effectiveEndFrame / fps,
      duration: rec.effectiveDurationFrames / fps,
      startFrame: rec.effectiveStartFrame,
      durationInFrames: rec.effectiveDurationFrames,
    };
  });

  // chapterTiming：每章首 scene effectiveStart / 末 scene effectiveEnd（scene 不跨章）
  const chapterTiming: ChapterTiming[] = input.chapterTiming.map((chapter) => {
    const chapterScenes = reconciliation.scenes.filter((s) => s.chapter === chapter.chapter);
    const first = chapterScenes[0];
    const last = chapterScenes[chapterScenes.length - 1];
    if (!first || !last) {
      throw new ReconciliationCompileError(
        'RECONCILIATION_INVALID',
        `第 ${chapter.chapter} 章在 reconciliation 中无 scene`,
      );
    }
    return {
      ...chapter,
      start: first.effectiveStartFrame / fps,
      end: last.effectiveEndFrame / fps,
    };
  });

  const candidate = {chapterTiming, scenes};
  const structural = scenesAiOutputSchema.safeParse(candidate);
  if (!structural.success) {
    throw new ReconciliationCompileError(
      'RECONCILIATION_INVALID',
      `adapter 输出未通过结构校验：${structural.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const semantic = validateScenesSemantics(structural.data);
  if (!semantic.ok) {
    throw new ReconciliationCompileError(
      'RECONCILIATION_INVALID',
      `adapter 输出未通过 frozen Scenes 语义校验：[${semantic.issues[0]!.code}] ${semantic.issues[0]!.message}`,
    );
  }
  return structural.data;
}

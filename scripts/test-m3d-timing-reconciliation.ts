/**
 * M3-D Timing Reconciliation 测试（bounded cumulative proportional allocation +
 * artifact 层 + 高层 mock 闭环）。
 *
 * 用法：npx tsx scripts/test-m3d-timing-reconciliation.ts
 * 使用临时数据目录（data/test-m3d），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3d');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {
  enqueueNarrationAudioJobs,
  tryFinalizeNarrationAudio,
} from '../src/lib/narration/audio';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {MOCK_FIXTURES} from '../src/lib/prompts/fixtures';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {applyTimingReconciliation} from '../src/lib/reconciliation/adapter';
import {
  allocateSceneFrames,
  compileTimingReconciliation,
  computeTargetTotalFrames,
  ReconciliationCompileError,
  type ReconciliationSourceRefs,
} from '../src/lib/reconciliation/compiler';
import {
  HALF_FRAME_MS,
  RECONCILIATION_COMPILER_VERSION,
  RECONCILIATION_FPS,
  TIMING_RECONCILIATION_ARTIFACT_KIND,
  timingReconciliationSchema,
  type TimingReconciliation,
} from '../src/lib/reconciliation/schema';
import {
  buildTimingReconciliation,
  checkTimingReconciliationReadiness,
  getCurrentTimingReconciliation,
  TimingReconciliationError,
} from '../src/lib/reconciliation/timing';
import {buildSubtitleTiming} from '../src/lib/subtitles/timing';
import type {ChapterTiming, Scene} from '../src/lib/scene-schema';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {resetTtsProviderForTest} from '../src/lib/tts';
import type {TtsJobRow} from '../src/lib/tts-jobs';
import {validateScenesSemantics} from '../src/lib/workflow/scenes-semantic-validation';
import {runLlmJob} from '../src/worker/llm-executor';
import {runTtsJob} from '../src/worker/tts-executor';
import {editVersion} from '../src/lib/workflow/operations';
import {getStage, lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

const CTX = {isShuttingDown: () => false, log: () => {}};

const SCRIPT_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–02:00）

那条消息你看到了。（停顿 1s）

你没有回。为什么偏偏是这一条？

[画面留白]

## 第 2 章 追问（02:00–05:00）

弗洛伊德怀疑过这种忘记。（放慢）他说，有些遗忘背后藏着不情愿。<!-- E01 -->
`;

const SCRIPT_V2_UNRESOLVED = SCRIPT_V2.replace('（停顿 1s）', '（停顿）');

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

async function runStageOnce(pid: string, stage: WorkflowStage): Promise<void> {
  const job = enqueueWorkflowStageJob(pid, stage);
  const claimed = claimNextAnyJob('w-m3d');
  if (!claimed || claimed.type !== 'llm' || claimed.job.id !== job.id) {
    throw new Error(`claim 失败 ${stage}`);
  }
  await runLlmJob(claimed.job, CTX);
  if (getLlmJob(job.id)!.status !== 'succeeded') throw new Error(`${stage} 未成功`);
}

function setScriptV2(pid: string, content: string): void {
  editVersion({
    projectId: pid, stage: 'script_v2',
    content, contentType: 'markdown', source: 'manual_edit',
  }, {confirmStale: true});
  lockStage(pid, 'script_v2');
}

async function runAllTtsJobs(pid: string): Promise<void> {
  for (;;) {
    const claimed = claimNextAnyJob('w-m3d');
    if (!claimed) break;
    if (claimed.type !== 'tts') throw new Error(`意外 job 类型 ${claimed.type}`);
    if ((claimed.job as TtsJobRow).project_id !== pid) throw new Error('意外拿到其他项目 tts job');
    await runTtsJob(claimed.job as TtsJobRow, CTX);
  }
}

/** 正式高层链：Workflow 全 10 阶段 locked + Narration Plan/Audio/Subtitle ready。 */
async function buildFullChain(pid: string, script: string): Promise<void> {
  for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
    await runStageOnce(pid, stage);
    lockStage(pid, stage);
  }
  setScriptV2(pid, script);
  buildNarrationPlan(pid);
  enqueueNarrationAudioJobs(pid);
  await runAllTtsJobs(pid);
  if (!tryFinalizeNarrationAudio(pid)) throw new Error('audio finalize 失败');
  buildSubtitleTiming(pid);
  for (const stage of WORKFLOW_STAGES.slice(6)) {
    await runStageOnce(pid, stage);
    lockStage(pid, stage);
  }
}

function reconciliationArtifactRows(pid: string): Array<{id: string; version: number; content_json: string}> {
  return getDb()
    .prepare(`SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC`)
    .all(pid, TIMING_RECONCILIATION_ARTIFACT_KIND) as Array<{id: string; version: number; content_json: string}>;
}

// ---------- 纯 compiler fixture ----------

function mkScene(index: number, startFrame: number, durationInFrames: number, chapter = 1): Scene {
  const start = startFrame / RECONCILIATION_FPS;
  const duration = durationInFrames / RECONCILIATION_FPS;
  return {
    id: `S${String(index).padStart(3, '0')}`,
    chapter,
    chapterTitle: `第${chapter}章`,
    start,
    end: start + duration,
    duration,
    startFrame,
    durationInFrames,
    category: 'MG',
    visualType: 'MG',
    template: 'MG_MessageFocus',
    sourceTemplate: 'MG_MessageFocus',
    narrationSummary: 'n',
    description: 'd',
    notes: '',
    assetIds: [],
    licenseStatus: 'not-applicable',
    subtitlePosition: 'bottom',
    transitionIn: 'none',
    transitionOut: 'cut',
  };
}

/** 由连续帧区间构造 scenes（durationInFrames 累计即下一 scene startFrame）。 */
function mkScenes(durations: number[], chapter = 1): Scene[] {
  const scenes: Scene[] = [];
  let cursor = 0;
  durations.forEach((d, i) => {
    scenes.push(mkScene(i + 1, cursor, d, chapter));
    cursor += d;
  });
  return scenes;
}

function mkChapterTiming(scenes: Scene[]): ChapterTiming[] {
  const chapters = [...new Set(scenes.map((s) => s.chapter))];
  return chapters.map((chapter) => {
    const list = scenes.filter((s) => s.chapter === chapter);
    return {chapter, title: `第${chapter}章`, start: list[0]!.start, end: list[list.length - 1]!.end};
  });
}

const BASE_REFS: ReconciliationSourceRefs = {
  scenesVersionId: 'sv-1',
  scenesVersion: 1,
  narrationAudioArtifactId: 'audio-1',
  narrationAudioArtifactVersion: 1,
  subtitleTimingArtifactId: 'sub-1',
  subtitleTimingArtifactVersion: 1,
  narrationPlanArtifactId: 'plan-1',
  narrationPlanArtifactVersion: 1,
  scriptV2Version: 1,
  narrationCompilerVersion: '1.1',
  subtitleCompilerVersion: '1.2',
  masterSha256: 'sha',
  masterDurationMs: 2000,
};

function compileRec(
  scenes: Scene[],
  masterDurationMs: number,
  unresolved: string[] = [],
): TimingReconciliation {
  return compileTimingReconciliation({
    scenes: {chapterTiming: mkChapterTiming(scenes), scenes},
    refs: {...BASE_REFS, masterDurationMs},
    unresolvedNarrationUnitIds: unresolved,
  });
}

function durationsOf(rec: TimingReconciliation): number[] {
  return rec.scenes.map((s) => s.effectiveDurationFrames);
}

function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return (
      (err instanceof ReconciliationCompileError || err instanceof TimingReconciliationError) &&
      err.code === code
    );
  }
}

async function main(): Promise<void> {
  resetTtsProviderForTest();

  // ===== Compiler：基础 =====

  // 1. 单 scene
  {
    const rec = compileRec(mkScenes([100]), 2000); // T=60
    ok(rec.scenes.length === 1 && rec.scenes[0]!.effectiveStartFrame === 0 && rec.scenes[0]!.effectiveEndFrame === 60, '01 单 scene 占满 target');
  }
  // 2. 多 scene proportional
  {
    const rec = compileRec(mkScenes([100, 100]), 3333); // T=100
    ok(JSON.stringify(durationsOf(rec)) === JSON.stringify([50, 50]), '02 多 scene proportional allocation');
  }
  // 3-9. 通用 invariants（多 fixture property）
  {
    const fixtures: number[][] = [[100], [100, 100], [30, 70, 50], [10, 20, 30, 40], [100, 1, 100]];
    let allOk = true;
    let orderOk = true;
    let chapterOk = true;
    for (const ds of fixtures) {
      const rec = compileRec(mkScenes(ds), 5000); // T=150
      const scenes = rec.scenes;
      if (scenes[0]!.effectiveStartFrame !== 0) allOk = false;
      if (scenes[scenes.length - 1]!.effectiveEndFrame !== rec.target.totalFrames) allOk = false;
      scenes.forEach((s, i) => {
        if (i > 0 && s.effectiveStartFrame !== scenes[i - 1]!.effectiveEndFrame) allOk = false;
        if (s.effectiveEndFrame <= s.effectiveStartFrame) allOk = false;
        if (s.effectiveDurationFrames !== s.effectiveEndFrame - s.effectiveStartFrame) allOk = false;
        if (s.sceneId !== `S${String(i + 1).padStart(3, '0')}`) orderOk = false;
        if (s.chapter !== 1) chapterOk = false;
      });
      if (scenes.reduce((sum, s) => sum + s.effectiveDurationFrames, 0) !== rec.target.totalFrames) allOk = false;
    }
    ok(allOk, '03-07 首 start=0 / 末 end=T / 连续 / 无 overlap / duration=end-start / Σ=T');
    ok(orderOk, '08 scene 顺序不变（S001…S00N）');
    ok(chapterOk, '09 chapter/id 保持');
  }
  // 10. byte-stable
  {
    const a = JSON.stringify(compileRec(mkScenes([30, 70, 50]), 5000, ['N002']));
    const b = JSON.stringify(compileRec(mkScenes([30, 70, 50]), 5000, ['N002']));
    ok(a === b, '10 repeated compile byte-stable');
  }

  // ===== Target frame =====

  ok(computeTargetTotalFrames(2000, 30) === 60, '11 master ms → target frames deterministic');
  ok(RECONCILIATION_FPS === 30, '12 fps = frozen 30');
  // 13. 非整 frame audio duration → residual ≤ half-frame
  {
    const rec = compileRec(mkScenes([100]), 1017); // T=round(30.51)=31
    const expectedResidual = (31 / 30) * 1000 - 1017;
    ok(
      rec.target.totalFrames === 31 &&
        Math.abs(rec.target.frameResidualMs - expectedResidual) < 1e-6 &&
        Math.abs(rec.target.frameResidualMs) <= HALF_FRAME_MS + 1e-6,
      '13 非整 frame audio：T=31 且 residual 语义正确 ≤ 半帧',
      rec.target,
    );
  }
  // 14. residual 性质：任意 master ≤ 半帧
  {
    let bound = true;
    for (let ms = 1; ms <= 5000; ms += 37) {
      const t = computeTargetTotalFrames(ms, RECONCILIATION_FPS);
      if (Math.abs((t / RECONCILIATION_FPS) * 1000 - ms) > HALF_FRAME_MS + 1e-6) bound = false;
    }
    ok(bound, '14 residual ≤ half-frame（1..5000ms 扫描）');
  }
  // 15. exact frame boundary：master=1000ms → T=30、residual=0
  {
    const rec = compileRec(mkScenes([100]), 1000);
    ok(rec.target.totalFrames === 30 && rec.target.frameResidualMs === 0 && rec.target.renderedDurationMs === 1000, '15 exact frame boundary residual=0');
  }

  // ===== Allocation =====

  // 16. equal durations
  ok(JSON.stringify(allocateSceneFrames([50, 50, 50], 150)) === JSON.stringify([50, 50, 50]), '16 equal source durations');
  // 17. unequal durations
  ok(JSON.stringify(allocateSceneFrames([100, 50, 50], 100)) === JSON.stringify([50, 25, 25]), '17 unequal durations proportional');
  // 18. cumulative no drift（多 fixture Σ === T）
  {
    let drift = false;
    const cases: Array<[number[], number]> = [
      [[30, 70, 50], 100],
      [[7, 13, 29, 101], 77],
      [[100, 1, 100], 150],
      [[3, 3, 3, 3, 3], 16],
    ];
    for (const [ds, t] of cases) {
      const alloc = allocateSceneFrames(ds, t);
      if (alloc.reduce((s, x) => s + x, 0) !== t) drift = true;
    }
    ok(!drift, '18 cumulative rounding 无 drift（Σ effective === T）');
  }
  // 19. very short scene 仍 ≥1
  {
    const alloc = allocateSceneFrames([100, 1, 100], 150);
    ok(alloc[1]! >= 1 && alloc.reduce((s, x) => s + x, 0) === 150, '19 middle short scene ≥1 且总量精确', alloc);
  }
  // 20. minimum-one-frame contract（全 fixture）
  {
    let minOk = true;
    const cases: Array<[number[], number]> = [
      [[100, 1, 1], 3],
      [[1, 1, 100], 3],
      [[1, 100], 2],
      [[5, 5, 5, 5], 4],
    ];
    for (const [ds, t] of cases) {
      if (allocateSceneFrames(ds, t).some((d) => d < 1)) minOk = false;
    }
    ok(minOk, '20 minimum-one-frame：所有 scene ≥1 帧');
  }
  // 21. T < sceneCount → RECONCILIATION_IMPOSSIBLE
  ok(
    throwsCode(() => allocateSceneFrames([10, 10], 1), 'RECONCILIATION_IMPOSSIBLE') &&
      throwsCode(() => compileRec(mkScenes([100, 100]), 33), 'RECONCILIATION_IMPOSSIBLE'), // T=round(0.99)=1... master=33ms→T=1<2
    '21 targetTotalFrames < sceneCount → IMPOSSIBLE（不生成 artifact）',
  );
  // 22. large scene count（85 scenes）
  {
    const ds = Array.from({length: 85}, (_, i) => 30 + (i % 7));
    const w = ds.reduce((s, x) => s + x, 0);
    const alloc = allocateSceneFrames(ds, w * 2);
    ok(
      alloc.length === 85 && alloc.every((d) => d >= 1) && alloc.reduce((s, x) => s + x, 0) === w * 2,
      '22 large scene count（85）总量精确且全 ≥1',
    );
  }

  // ===== Identity property（独立 review 修订一）=====

  // 23. [1,100] T=101 → 严格 [1,100]
  ok(JSON.stringify(allocateSceneFrames([1, 100], 101)) === JSON.stringify([1, 100]), '23 identity：[1,100]@101 严格不变');
  // 24. [10,20,30] T=60 → 完全不变
  ok(JSON.stringify(allocateSceneFrames([10, 20, 30], 60)) === JSON.stringify([10, 20, 30]), '24 identity：[10,20,30]@60 完全不变');
  // 24b. identity 时 effective boundaries == source cumulative boundaries
  {
    const rec = compileRec(mkScenes([10, 20, 30]), 2000); // T=60=weight
    const identity = rec.scenes.every(
      (s) =>
        s.effectiveStartFrame === s.sourceWeightStartFrame &&
        s.effectiveEndFrame === s.sourceWeightEndFrame,
    );
    ok(identity, '24b identity：effective boundaries == source weight boundaries');
  }
  // 25. severe compression [100,1,1] T=3 → [1,1,1] deterministic
  {
    const a = allocateSceneFrames([100, 1, 1], 3);
    const b = allocateSceneFrames([100, 1, 1], 3);
    ok(
      JSON.stringify(a) === JSON.stringify([1, 1, 1]) && JSON.stringify(a) === JSON.stringify(b),
      '25 severe compression [100,1,1]@3 → [1,1,1] deterministic',
    );
  }
  // 26. boundary reservation：raw 边界会吞掉后续 scene 时 upper 各留 1 帧
  {
    // [100,1,1]@3：raw_1=round(3×100/102)=3 → upper=3-2=1 强制为后续 2 scene 各留 1 帧
    const alloc = allocateSceneFrames([100, 1, 1], 3);
    // [1,1,100]@3：raw_1=round(3×1/102)=0 → lower=1；raw_2=0 → clamp [2,2]
    const alloc2 = allocateSceneFrames([1, 1, 100], 3);
    ok(
      JSON.stringify(alloc) === JSON.stringify([1, 1, 1]) &&
        JSON.stringify(alloc2) === JSON.stringify([1, 1, 1]),
      '26 boundary reservation：upper/lower clamp 为剩余 scene 各留 ≥1 帧',
    );
  }

  // ===== Source totals distinction（修订二）=====
  {
    // durations [0.35,0.15,0.35,0.35]（连续秒、逐 scene round(×30)）：
    // authored=round(1.2×30)=36；rendererEnd=26+11=37；weight=11+5+11+11=38 —— 三者全不同，
    // 且每 scene startFrame/durationInFrames 与 round(start/duration×30) 一致（契约合法）。
    const ds = [0.35, 0.15, 0.35, 0.35];
    let cursor = 0;
    const scenes: Scene[] = ds.map((d, i) => {
      const start = cursor;
      cursor += d;
      return {
        ...mkScene(i + 1, 0, 1),
        start,
        end: cursor,
        duration: d,
        startFrame: Math.round(start * 30),
        durationInFrames: Math.round(d * 30),
      };
    });
    const data = {chapterTiming: [{chapter: 1, title: '第1章', start: 0, end: 1.2}], scenes};
    const structural = scenesAiOutputSchema.safeParse(data);
    const semantic = structural.success ? validateScenesSemantics(structural.data) : {ok: false as const, issues: []};
    ok(structural.success && semantic.ok, '27a 三分歧 fixture 满足 frozen Scenes 语义契约', structural.success ? semantic : structural.error.issues);
    const rec = compileTimingReconciliation({
      scenes: data,
      refs: {...BASE_REFS, masterDurationMs: 2533}, // T=round(75.99)=76
      unresolvedNarrationUnitIds: [],
    });
    ok(
      rec.sourceVisual.authoredTotalFrames === 36 &&
        rec.sourceVisual.rendererEndFrame === 37 &&
        rec.sourceVisual.weightTotalFrames === 38,
      '27b authored(36) / rendererEnd(37) / weight(38) 三者区分正确',
      rec.sourceVisual,
    );
    // allocation 必须用 weightTotalFrames=38：raw=round(76×cum/38) → [22,10,22,22]；
    // 若误用 authored 36 首边界即为 23
    ok(
      JSON.stringify(durationsOf(rec)) === JSON.stringify([22, 10, 22, 22]),
      '27c allocation denominator = weightTotalFrames（非 authored/rendererEnd）',
      durationsOf(rec),
    );
  }

  // ===== Adapter（纯）=====
  {
    const scenes = mkScenes([60, 90]);
    const before = JSON.stringify(scenes);
    const rec = compileRec(scenes, 5000); // T=150 == weight → identity? weight=150，T=150 identity
    const out = applyTimingReconciliation({scenes, chapterTiming: mkChapterTiming(scenes), reconciliation: rec});
    const semantic = validateScenesSemantics(out);
    ok(semantic.ok, '44 adapter 输出重新通过 frozen Scenes 语义校验');
    // 45. 只改 timing 字段
    const NON_TIMING = ['id', 'chapter', 'chapterTitle', 'category', 'visualType', 'template', 'sourceTemplate', 'narrationSummary', 'description', 'notes', 'assetIds', 'licenseStatus', 'subtitlePosition', 'transitionIn', 'transitionOut'] as const;
    const onlyTiming = out.scenes.every((s, i) =>
      NON_TIMING.every((k) => JSON.stringify(s[k]) === JSON.stringify(scenes[i]![k])),
    );
    ok(onlyTiming, '45 adapter 只修改 timing 字段');
    // 46. 输入 object 不可变
    ok(JSON.stringify(scenes) === before, '46 adapter 不修改 source Scene object');
    // 非 identity 缩放下的 adapter + chapterTiming 派生
    const rec2 = compileRec(mkScenes([60, 90]), 3333); // T=100
    const out2 = applyTimingReconciliation({scenes, chapterTiming: mkChapterTiming(scenes), reconciliation: rec2});
    const ch = out2.chapterTiming[0]!;
    ok(
      validateScenesSemantics(out2).ok &&
        ch.start === out2.scenes[0]!.start &&
        ch.end === out2.scenes[out2.scenes.length - 1]!.end,
      '44b 缩放 adapter + chapterTiming 按章首末 scene 派生',
    );
  }

  // ===== 高层 mock 闭环 =====

  const pidA = newProject();
  await buildFullChain(pidA, SCRIPT_V2);

  // 47. 闭环 build → ready
  const buildA = buildTimingReconciliation(pidA);
  {
    const readiness = checkTimingReconciliationReadiness(pidA);
    const masterMs = readiness.masterDurationMs!;
    ok(
      readiness.status === 'ready' && readiness.sceneCount === 2 &&
        readiness.target?.totalFrames === computeTargetTotalFrames(masterMs, RECONCILIATION_FPS) &&
        Math.abs(readiness.target!.frameResidualMs) <= HALF_FRAME_MS + 1e-6,
      '47 高层闭环 → ready（sceneCount/target/residual 正确）',
      readiness.target,
    );
    ok(
      readiness.sourceVisual?.authoredTotalFrames === 435 &&
        readiness.sourceVisual.rendererEndFrame === 435 &&
        readiness.sourceVisual.weightTotalFrames === 435,
      '47b mock fixture 三个 source totals（435/435/435，无分歧）',
      readiness.sourceVisual,
    );
  }
  // 48. effective 总量 == target 且首末锚定
  {
    const rec = buildA.reconciliation;
    ok(
      rec.scenes[0]!.effectiveStartFrame === 0 &&
        rec.scenes[rec.scenes.length - 1]!.effectiveEndFrame === rec.target.totalFrames &&
        rec.scenes.reduce((s, x) => s + x.effectiveDurationFrames, 0) === rec.target.totalFrames,
      '48 effective Σ === targetTotalFrames',
    );
  }
  // 42/43. unresolved 透传（visual_breath N004），不加任何 duration
  ok(
    JSON.stringify(buildA.reconciliation.unresolvedNarrationUnitIds) === JSON.stringify(['N004']),
    '42/43 unresolved（visual_breath）透传且不加 duration',
    buildA.reconciliation.unresolvedNarrationUnitIds,
  );
  // 31. first build new / 32. second reuse
  ok(!buildA.reused && buildA.artifact.version === 1, '31 first build → new artifact');
  {
    const again = buildTimingReconciliation(pidA);
    ok(again.reused && again.artifact.id === buildA.artifact.id, '32 second build → idempotent reuse');
  }
  // 高层 adapter：mock scenes + reconciliation
  {
    const stage = getStage(pidA, 'scenes')!;
    const row = getDb().prepare('SELECT content FROM project_versions WHERE project_id = ? AND stage = ? AND version = ?')
      .get(pidA, 'scenes', stage.locked_version) as {content: string};
    const data = scenesAiOutputSchema.parse(JSON.parse(row.content));
    const out = applyTimingReconciliation({
      scenes: data.scenes, chapterTiming: data.chapterTiming, reconciliation: buildA.reconciliation,
    });
    ok(validateScenesSemantics(out).ok, '44c 高层链 adapter 输出过 frozen 语义校验');
  }

  // ===== Source gate =====

  // 28. scenes not locked → SCENES_NOT_CURRENT
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
      await runStageOnce(pid, stage);
      lockStage(pid, stage);
    }
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    tryFinalizeNarrationAudio(pid);
    buildSubtitleTiming(pid);
    ok(
      throwsCode(() => buildTimingReconciliation(pid), 'SCENES_NOT_CURRENT'),
      '28 scenes 未 locked → SCENES_NOT_CURRENT',
    );
    ok(checkTimingReconciliationReadiness(pid).status === 'not_ready', '28b 缺 scenes → readiness not_ready');
  }
  // 29. audio missing → NARRATION_AUDIO_NOT_READY；plan not current → NARRATION_PLAN_NOT_CURRENT
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES) {
      await runStageOnce(pid, stage);
      lockStage(pid, stage);
    }
    ok(
      throwsCode(() => buildTimingReconciliation(pid), 'NARRATION_PLAN_NOT_CURRENT'),
      '29a plan missing → NARRATION_PLAN_NOT_CURRENT',
    );
    buildNarrationPlan(pid);
    ok(
      throwsCode(() => buildTimingReconciliation(pid), 'NARRATION_AUDIO_NOT_READY'),
      '29b audio missing → NARRATION_AUDIO_NOT_READY',
    );
  }
  // 30. subtitle missing → SUBTITLE_TIMING_NOT_READY
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
      await runStageOnce(pid, stage);
      lockStage(pid, stage);
    }
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    tryFinalizeNarrationAudio(pid);
    for (const stage of WORKFLOW_STAGES.slice(6)) {
      await runStageOnce(pid, stage);
      lockStage(pid, stage);
    }
    ok(
      throwsCode(() => buildTimingReconciliation(pid), 'SUBTITLE_TIMING_NOT_READY'),
      '30 subtitle missing → SUBTITLE_TIMING_NOT_READY',
    );
  }

  // ===== Source integrity（篡改 locked scenes 内容，不 blind trust）=====
  {
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    const original = MOCK_FIXTURES.scenes;
    const tamper = (content: string): void => {
      getDb().prepare("UPDATE project_versions SET content = ? WHERE project_id = ? AND stage = 'scenes' AND version = 1").run(content, pid);
    };
    const restore = (): void => tamper(original);

    tamper('not-json{{');
    ok(throwsCode(() => buildTimingReconciliation(pid), 'SCENES_INVALID'), '23s 坏 JSON → SCENES_INVALID');
    restore();

    const gap = JSON.parse(original) as {scenes: Array<{start: number; startFrame: number}>};
    gap.scenes[1]!.start = 7.5;
    gap.scenes[1]!.startFrame = 225;
    tamper(JSON.stringify(gap));
    ok(throwsCode(() => buildTimingReconciliation(pid), 'SCENES_INVALID'), '24s source gap → SCENES_INVALID');
    restore();

    const overlap = JSON.parse(original) as {scenes: Array<{start: number; startFrame: number}>};
    overlap.scenes[1]!.start = 6.0;
    overlap.scenes[1]!.startFrame = 180;
    tamper(JSON.stringify(overlap));
    ok(throwsCode(() => buildTimingReconciliation(pid), 'SCENES_INVALID'), '25s source overlap → SCENES_INVALID');
    restore();

    const order = JSON.parse(original) as {scenes: Array<{id: string}>};
    order.scenes[0]!.id = 'S002';
    order.scenes[1]!.id = 'S001';
    tamper(JSON.stringify(order));
    ok(throwsCode(() => buildTimingReconciliation(pid), 'SCENES_INVALID'), '26s source order/id mismatch → SCENES_INVALID');
    restore();

    const frame = JSON.parse(original) as {scenes: Array<{startFrame: number}>};
    frame.scenes[0]!.startFrame = 1;
    tamper(JSON.stringify(frame));
    ok(throwsCode(() => buildTimingReconciliation(pid), 'SCENES_INVALID'), '27s source frame mismatch → SCENES_INVALID');
    restore();

    ok(buildTimingReconciliation(pid).artifact.version === 1, '27s-b restore 后可正常 build');
  }

  // ===== Stale A/B 区分 =====

  // A：scenes 新版本重新 locked（narration 仍 ready）→ stale
  {
    const edited = JSON.parse(MOCK_FIXTURES.scenes) as {scenes: Array<{description: string}>};
    edited.scenes[0]!.description = '人工修订的画面描述（v2）';
    editVersion({
      projectId: pidA, stage: 'scenes',
      content: JSON.stringify(edited), contentType: 'json', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pidA, 'scenes');
    ok(getStage(pidA, 'scenes')!.locked_version === 2, '33a scenes v2 locked');
    ok(
      checkTimingReconciliationReadiness(pidA).status === 'stale' &&
        getCurrentTimingReconciliation(pidA) === null,
      '33b A：scenes 前进（仍 ready）→ old reconciliation stale',
    );
    const rebuild = buildTimingReconciliation(pidA);
    ok(
      !rebuild.reused && rebuild.artifact.id !== buildA.artifact.id &&
        reconciliationArtifactRows(pidA).length === 2,
      '33c scenes 前进后 rebuild → 新 artifact，旧版保留',
    );
  }
  // B：上游修改导致 scenes stage 本身 stale → not_ready
  {
    const shotList = JSON.parse(MOCK_FIXTURES.shot_list) as {shots: Array<{notes: string}>};
    shotList.shots[0]!.notes = 'edited upstream';
    editVersion({
      projectId: pidA, stage: 'shot_list',
      content: JSON.stringify(shotList), contentType: 'json', source: 'manual_edit',
    }, {confirmStale: true});
    ok(getStage(pidA, 'scenes')!.status === 'stale', '34a 上游编辑 → scenes stage stale');
    ok(
      checkTimingReconciliationReadiness(pidA).status === 'not_ready',
      '34b B：scenes stage 本身 stale → reconciliation not_ready（非 stale）',
    );
    ok(
      throwsCode(() => buildTimingReconciliation(pidA), 'SCENES_NOT_CURRENT'),
      '34c B：build 拒绝（SCENES_NOT_CURRENT）',
    );
    // 恢复：先锁定 shot_list（edited），再重跑 scenes 阶段并锁定
    lockStage(pidA, 'shot_list');
    await runStageOnce(pidA, 'scenes');
    lockStage(pidA, 'scenes');
    ok(
      checkTimingReconciliationReadiness(pidA).status === 'stale' &&
        buildTimingReconciliation(pidA).reused === false,
      '34d scenes 重跑锁定 → stale → 可 rebuild',
    );
  }
  // 35. narration chain 前进 → old reconciliation stale → rebuild 新链 → 新 artifact
  {
    setScriptV2(pidA, SCRIPT_V2.replace('那条消息你看到了。', '那条消息你看到了。你真的看到了。'));
    // script_v2 编辑传播 stale：narration chain 与 scenes 下游全部失效 → not_ready
    ok(
      checkTimingReconciliationReadiness(pidA).status === 'not_ready' &&
        getCurrentTimingReconciliation(pidA) === null,
      '35a Script V2 前进瞬间 → scenes/audio 均不 current → not_ready',
    );
    buildNarrationPlan(pidA);
    enqueueNarrationAudioJobs(pidA);
    await runAllTtsJobs(pidA);
    tryFinalizeNarrationAudio(pidA);
    buildSubtitleTiming(pidA);
    for (const stage of WORKFLOW_STAGES.slice(6)) {
      await runStageOnce(pidA, stage);
      lockStage(pidA, stage);
    }
    const readiness = checkTimingReconciliationReadiness(pidA);
    ok(
      readiness.status === 'stale' &&
        readiness.sources?.audioArtifactVersion === 2 &&
        readiness.sources.subtitleArtifactVersion === 2,
      '35b narration chain 重建（audio/subtitle v2）→ old reconciliation stale',
      readiness.sources,
    );
    const rebuild = buildTimingReconciliation(pidA);
    ok(!rebuild.reused, '35c rebuild → new artifact');
  }
  // 36. reconciliation compiler 旧版 → stale（source 不变也失效）
  {
    const row = reconciliationArtifactRows(pidA)[0]!;
    const json = JSON.parse(row.content_json) as {compilerVersion: string};
    json.compilerVersion = '0.9';
    getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), row.id);
    ok(
      getCurrentTimingReconciliation(pidA) === null &&
        checkTimingReconciliationReadiness(pidA).status === 'stale',
      '36 reconciliation compiler 旧版 → stale',
    );
    const rebuilt = buildTimingReconciliation(pidA);
    ok(!rebuilt.reused && rebuilt.artifact.id !== row.id, '36b 旧 compiler artifact 不 reuse，建新 artifact');
  }

  // ===== Corrupted artifacts（skip，不 crash 不 current）=====
  {
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2_UNRESOLVED);
    // 42b. 无时长 pause 也透传 unresolved
    const built = buildTimingReconciliation(pid);
    ok(
      built.reconciliation.unresolvedNarrationUnitIds.includes('N002') &&
        built.reconciliation.unresolvedNarrationUnitIds.includes('N004'),
      '42c 无时长 pause + visual_breath 均透传 unresolved',
      built.reconciliation.unresolvedNarrationUnitIds,
    );

    const insert = (content: string): void => {
      getDb()
        .prepare(
          `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?), ?, NULL, ?)`,
        )
        .run(crypto.randomUUID(), pid, TIMING_RECONCILIATION_ARTIFACT_KIND, pid, TIMING_RECONCILIATION_ARTIFACT_KIND, content, new Date().toISOString());
    };
    insert('bad json{{'); // 37
    insert(JSON.stringify({schemaVersion: 'wrong'})); // 38
    const badFrames = JSON.parse(JSON.stringify(built.reconciliation)) as TimingReconciliation;
    badFrames.scenes[0]!.effectiveEndFrame += 5; // 破坏连续性 → superRefine 拒绝
    insert(JSON.stringify(badFrames)); // 39
    const badResidual = JSON.parse(JSON.stringify(built.reconciliation)) as TimingReconciliation;
    badResidual.target.frameResidualMs = 5; // schema-valid shape 但语义篡改 → superRefine 拒绝
    insert(JSON.stringify(badResidual)); // 41
    ok(
      getCurrentTimingReconciliation(pid)?.artifact.id === built.artifact.id &&
        checkTimingReconciliationReadiness(pid).status === 'ready',
      '37/38/39/41 坏 JSON/错 schema/非法帧/篡改 residual → skip（good artifact 仍 current）',
    );
    // 40. 篡改 provenance（schema-valid）→ 不认 current、不 reuse
    const tampers: Array<[string, (j: {source: Record<string, unknown>}) => void]> = [
      ['scenesVersion', (j) => { j.source.scenesVersion = 999; }],
      ['subtitleTimingArtifactId', (j) => { j.source.subtitleTimingArtifactId = 'tampered'; }],
      ['narrationCompilerVersion', (j) => { j.source.narrationCompilerVersion = '9.9'; }],
    ];
    let allOk = true;
    for (const [, tamper] of tampers) {
      const currentId = getCurrentTimingReconciliation(pid)?.artifact.id;
      if (!currentId) { allOk = false; break; }
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(currentId) as
        | {id: string; content_json: string}
        | undefined;
      const json = JSON.parse(row!.content_json) as {source: Record<string, unknown>};
      tamper(json);
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), currentId);
      if (getCurrentTimingReconciliation(pid) !== null) allOk = false;
      const rebuilt = buildTimingReconciliation(pid);
      if (rebuilt.reused || rebuilt.artifact.id === currentId) allOk = false;
    }
    ok(allOk, '40 篡改 provenance → 不认 current / 不 reuse / 建新 artifact');
  }

  // ===== Final Data-Integrity Hardening =====

  // H1-1. exact-half-frame：master=1050ms（raw 31.5）→ Math.round → 32
  {
    const rec = compileRec(mkScenes([100, 100]), 1050);
    ok(
      rec.target.totalFrames === 32 &&
        Math.abs(rec.target.frameResidualMs - ((32 / 30) * 1000 - 1050)) < 1e-6,
      'H1-1 exact-half-frame（1050ms→31.5）正式 rounding = 32',
      rec.target,
    );
  }
  // H1-2. totalFrames=31 的内部全自洽 tamper → 新 schema 必须拒绝（防 ±1 frame tamper）
  {
    const valid = compileRec(mkScenes([100, 100]), 1050);
    const tampered = JSON.parse(JSON.stringify(valid)) as TimingReconciliation;
    tampered.target.totalFrames = 31;
    tampered.target.renderedDurationMs = (31 / 30) * 1000;
    tampered.target.frameResidualMs = tampered.target.renderedDurationMs - 1050;
    tampered.scaleRatio = 31 / 200;
    tampered.scenes[1]!.effectiveEndFrame = 31;
    tampered.scenes[1]!.effectiveDurationFrames = 15;
    // 其余 superRefine 全部自洽（residual 恰好 -half-frame，bound 内）
    const parsed = timingReconciliationSchema.safeParse(tampered);
    ok(
      !parsed.success &&
        (parsed.error?.issues.some((i) => i.message.includes('targetTotalFrames')) ?? false),
      'H1-2 ±1 frame semantic tamper（内部自洽）→ schema 拒绝',
      parsed.success ? 'accepted!' : parsed.error?.issues[0]?.message,
    );
  }

  // H3. adapter source timing compatibility
  {
    const scenesA = mkScenes([60, 90]);
    const recA = compileRec(scenesA, 3333); // T=100
    // Scenes B：同 id/chapter/non-timing，timing 合法但不同
    const scenesB = mkScenes([100, 100]);
    ok(
      throwsCode(
        () => applyTimingReconciliation({scenes: scenesB, chapterTiming: mkChapterTiming(scenesB), reconciliation: recA}),
        'RECONCILIATION_INVALID',
      ),
      'H3-1 adapter：同 id 但 timing 不同的 Scenes B + reconciliation A → 拒绝',
    );
    // 输入本身语义非法（gap）→ 拒绝（不 blind trust caller）
    const gapScenes = mkScenes([60, 90]);
    gapScenes[1]!.start += 1;
    ok(
      throwsCode(
        () => applyTimingReconciliation({scenes: gapScenes, chapterTiming: mkChapterTiming(scenesA), reconciliation: recA}),
        'RECONCILIATION_INVALID',
      ),
      'H3-2 adapter：输入 scenes 未过 frozen 语义校验 → 拒绝',
    );
    // 匹配 source → 正常通过
    const outOk = applyTimingReconciliation({scenes: scenesA, chapterTiming: mkChapterTiming(scenesA), reconciliation: recA});
    ok(validateScenesSemantics(outOk).ok, 'H3-3 adapter：匹配 source → 正常通过');
  }

  // H2/H6. artifact 层 semantic snapshot gate + compiler 1.1
  {
    ok(RECONCILIATION_COMPILER_VERSION === '1.2', 'H6-0 compilerVersion = 1.2');
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    buildTimingReconciliation(pid);

    const tamperCurrent = (
      mutate: (rec: TimingReconciliation) => void,
    ): {tamperedId: string; rebuilt: ReturnType<typeof buildTimingReconciliation>} | null => {
      const current = getCurrentTimingReconciliation(pid);
      if (!current) return null;
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(current.artifact.id) as
        | {content_json: string}
        | undefined;
      const json = JSON.parse(row!.content_json) as TimingReconciliation;
      mutate(json);
      // tamper 后必须仍是 schema-valid（证明是 semantic corruption 而非 shape error）
      if (!timingReconciliationSchema.safeParse(json).success) {
        throw new Error('tamper 构造失败：artifact 不再 schema-valid');
      }
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), current.artifact.id);
      const rebuilt = buildTimingReconciliation(pid);
      return {tamperedId: current.artifact.id, rebuilt};
    };
    const expectRejected = (
      label: string,
      result: {tamperedId: string; rebuilt: ReturnType<typeof buildTimingReconciliation>} | null,
    ): void => {
      ok(
        result !== null &&
          !result.rebuilt.reused &&
          result.rebuilt.artifact.id !== result.tamperedId,
        label,
      );
    };

    // H2-A. authoredTotalFrames tamper（shape 合法、内部无派生约束）
    {
      const current = getCurrentTimingReconciliation(pid)!;
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(current.artifact.id) as {content_json: string};
      const json = JSON.parse(row.content_json) as TimingReconciliation;
      json.sourceVisual.authoredTotalFrames += 1;
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), current.artifact.id);
      const notCurrent = getCurrentTimingReconciliation(pid) === null;
      const stale = checkTimingReconciliationReadiness(pid).status === 'stale';
      const rebuilt = buildTimingReconciliation(pid);
      ok(
        notCurrent && stale && !rebuilt.reused && rebuilt.artifact.id !== current.artifact.id,
        'H2-A authoredTotalFrames tamper → not current / stale / 不 reuse / 新 artifact',
      );
    }
    // H2-B. authoredStartFrame semantic tamper（同步调 rendererEnd 保持内部自洽）
    expectRejected(
      'H2-B authoredStartFrame+1（内部自洽）→ not current / 不 reuse / 新 artifact',
      tamperCurrent((rec) => {
        rec.scenes[1]!.authoredStartFrame += 1;
        rec.sourceVisual.rendererEndFrame = Math.max(
          ...rec.scenes.map((s) => s.authoredStartFrame + s.authoredDurationInFrames),
        );
      }),
    );
    // H2-C. authoredDuration/sourceWeight 内部全自洽 tamper（≠ current scenes）
    expectRejected(
      'H2-C authoredDuration+sourceWeight 内部自洽 tamper → not current / 不 reuse / 新 artifact',
      tamperCurrent((rec) => {
        const w0 = rec.scenes[0]!.authoredDurationInFrames - 5;
        rec.scenes[0]!.authoredDurationInFrames = w0;
        rec.scenes[0]!.sourceWeightDurationFrames = w0;
        rec.scenes[0]!.sourceWeightEndFrame = rec.scenes[0]!.sourceWeightStartFrame + w0;
        rec.scenes[1]!.sourceWeightStartFrame = rec.scenes[0]!.sourceWeightEndFrame;
        rec.scenes[1]!.sourceWeightEndFrame =
          rec.scenes[1]!.sourceWeightStartFrame + rec.scenes[1]!.sourceWeightDurationFrames;
        rec.sourceVisual.weightTotalFrames = rec.scenes[1]!.sourceWeightEndFrame;
        rec.sourceVisual.rendererEndFrame = Math.max(
          ...rec.scenes.map((s) => s.authoredStartFrame + s.authoredDurationInFrames),
        );
        rec.scaleRatio = rec.target.totalFrames / rec.sourceVisual.weightTotalFrames;
      }),
    );
    // H6. 旧 compiler 1.0 artifact → stale；rebuild → 1.1 current
    {
      const current = getCurrentTimingReconciliation(pid)!;
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(current.artifact.id) as {content_json: string};
      const json = JSON.parse(row.content_json) as {compilerVersion: string};
      json.compilerVersion = '1.0';
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), current.artifact.id);
      const stale = checkTimingReconciliationReadiness(pid).status === 'stale' &&
        getCurrentTimingReconciliation(pid) === null;
      const rebuilt = buildTimingReconciliation(pid);
      ok(
        stale && !rebuilt.reused && rebuilt.reconciliation.compilerVersion === '1.2' &&
          checkTimingReconciliationReadiness(pid).status === 'ready',
        'H6 旧 compiler 1.0 → stale → rebuild 1.2 current',
      );
    }
    // H7. 全部被篡改 artifact 保留为历史
    {
      const rows = reconciliationArtifactRows(pid);
      ok(rows.length === 5, 'H7 被篡改 artifact 全部保留历史（不 DELETE）', rows.length);
    }
  }

  // ===== Deterministic Output Binding Micro-Hardening（H8）=====
  {
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    const built = buildTimingReconciliation(pid);
    const formalDurations = durationsOf(built.reconciliation);

    const tamperCurrent = (
      mutate: (rec: TimingReconciliation) => void,
    ): {tamperedId: string; rebuilt: ReturnType<typeof buildTimingReconciliation>} => {
      const current = getCurrentTimingReconciliation(pid);
      if (!current) throw new Error('tamper 前提失败：无 current artifact');
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(current.artifact.id) as {content_json: string};
      const json = JSON.parse(row.content_json) as TimingReconciliation;
      mutate(json);
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), current.artifact.id);
      return {tamperedId: current.artifact.id, rebuilt: buildTimingReconciliation(pid)};
    };

    // H8-A. effective timeline schema-valid semantic tamper（[100,124]→[101,123]，总量/连续性不变）
    {
      const current = getCurrentTimingReconciliation(pid)!;
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(current.artifact.id) as {content_json: string};
      const json = JSON.parse(row.content_json) as TimingReconciliation;
      json.scenes[0]!.effectiveEndFrame += 1;
      json.scenes[0]!.effectiveDurationFrames += 1;
      json.scenes[1]!.effectiveStartFrame += 1;
      json.scenes[1]!.effectiveDurationFrames -= 1;
      // 先断言：这不是 shape/schema corruption
      const stillValid = timingReconciliationSchema.safeParse(json).success;
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), current.artifact.id);
      const notCurrent = getCurrentTimingReconciliation(pid) === null;
      const stale = checkTimingReconciliationReadiness(pid).status === 'stale';
      const rebuilt = buildTimingReconciliation(pid);
      ok(
        stillValid && notCurrent && stale && !rebuilt.reused &&
          rebuilt.artifact.id !== current.artifact.id,
        'H8-A effective timeline schema-valid tamper → not current / stale / 不 reuse',
      );
      ok(
        JSON.stringify(durationsOf(rebuilt.reconciliation)) === JSON.stringify(formalDurations),
        'H8-A2 rebuild 恢复正式 compiler output（effective 未被 tamper 污染）',
        [durationsOf(rebuilt.reconciliation), formalDurations],
      );
    }
    // H8-B. unresolvedNarrationUnitIds schema-valid semantic tamper（['N004']→[]）
    {
      const current = getCurrentTimingReconciliation(pid)!;
      const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(current.artifact.id) as {content_json: string};
      const json = JSON.parse(row.content_json) as TimingReconciliation;
      json.unresolvedNarrationUnitIds = [];
      const parsedValid = timingReconciliationSchema.safeParse(json).success;
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), current.artifact.id);
      const notCurrent = getCurrentTimingReconciliation(pid) === null;
      const stale = checkTimingReconciliationReadiness(pid).status === 'stale';
      const rebuilt = buildTimingReconciliation(pid);
      ok(
        parsedValid && notCurrent && stale && !rebuilt.reused &&
          rebuilt.artifact.id !== current.artifact.id,
        'H8-B unresolved list schema-valid tamper → not current / stale / 不 reuse',
      );
      ok(
        JSON.stringify(rebuilt.reconciliation.unresolvedNarrationUnitIds) ===
          JSON.stringify(built.reconciliation.unresolvedNarrationUnitIds),
        'H8-B2 rebuild 后 unresolved == current subtitle.timing.unresolvedUnitIds',
        rebuilt.reconciliation.unresolvedNarrationUnitIds,
      );
    }
    // H8-C. deterministic equality positive case：untouched artifact → idempotent reuse
    {
      const again = buildTimingReconciliation(pid);
      ok(again.reused, 'H8-C 正常 artifact → second Build reused=true（gate 不破坏幂等）');
    }
    // H8-D. 旧 compiler 1.1 → stale → rebuild 1.2 current
    {
      const {tamperedId, rebuilt} = tamperCurrent((rec) => {
        (rec as {compilerVersion: string}).compilerVersion = '1.1';
      });
      ok(
        !rebuilt.reused && rebuilt.artifact.id !== tamperedId &&
          rebuilt.reconciliation.compilerVersion === '1.2' &&
          checkTimingReconciliationReadiness(pid).status === 'ready',
        'H8-D 旧 compiler 1.1 → stale → rebuild 1.2 current',
      );
    }
    // H8-E. historical retention：全部 tampered/old artifact 保留
    {
      const rows = reconciliationArtifactRows(pid);
      ok(rows.length === 4, 'H8-E tampered/old artifact 全部保留历史（不 DELETE）', rows.length);
    }
  }

  console.log(`\nM3-D: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('M3-D 测试异常终止:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
    fs.rmSync(path.join('data', 'test-m3d'), {recursive: true, force: true});
  });

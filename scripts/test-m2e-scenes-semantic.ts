/**
 * M2-E-A Scenes 语义校验测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m2e-scenes-semantic.ts
 * 使用临时数据目录（data/test-m2e），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2e');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {executeStageGeneration} from '../src/lib/llm/executor';
import {LLMError, type LLMProvider, type LLMRequest, type LLMResponse} from '../src/lib/llm/types';
import {scenesAiOutputSchema, scenesPrompt} from '../src/lib/prompts/scenes';
import {
  MG_TEMPLATE_REGISTRY,
  SCENES_SYSTEM_FPS,
  validateScenesSemantics,
  type SceneSemanticIssueCode,
  type ScenesSemanticInput,
} from '../src/lib/workflow/scenes-semantic-validation';
import type {ChapterTiming, Scene} from '../src/lib/scene-schema';
import {PATCH as stagePATCH} from '../src/app/api/projects/[id]/stage/[stage]/route';

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

// ---------- 合法基线 ----------

function scene(partial: Partial<Scene> & Pick<Scene, 'id' | 'chapter' | 'chapterTitle' | 'start' | 'end'>): Scene {
  const duration = partial.end - partial.start;
  return {
    duration,
    startFrame: Math.round(partial.start * SCENES_SYSTEM_FPS),
    durationInFrames: Math.round(duration * SCENES_SYSTEM_FPS),
    category: 'B-roll',
    visualType: 'Asset',
    template: null,
    sourceTemplate: null,
    narrationSummary: '摘要',
    description: '画面职责描述',
    notes: '',
    assetIds: [],
      assetRequirements: [],
    licenseStatus: 'not-applicable',
    subtitlePosition: 'bottom',
    transitionIn: 'none',
    transitionOut: 'cut',
    ...partial,
  } as Scene;
}

function makeValid(): ScenesSemanticInput {
  const chapterTiming: ChapterTiming[] = [
    {chapter: 1, title: '开篇', start: 0, end: 6.5},
    {chapter: 2, title: '深入', start: 6.5, end: 14.5},
  ];
  const scenes: Scene[] = [
    scene({id: 'S001', chapter: 1, chapterTitle: '开篇', start: 0, end: 6.5}),
    scene({
      id: 'S002', chapter: 2, chapterTitle: '深入', start: 6.5, end: 14.5,
      category: 'MG', visualType: 'MG', template: 'MG_MessageFocus', templateProps: {message: '聚焦信息'}, sourceTemplate: 'MG_MessageFocus',
    }),
  ];
  return {chapterTiming, scenes};
}

function mutate(fn: (input: ScenesSemanticInput) => void): ScenesSemanticInput {
  const input = JSON.parse(JSON.stringify(makeValid())) as ScenesSemanticInput;
  fn(input);
  return input;
}

function expectPass(input: ScenesSemanticInput, label: string): void {
  const result = validateScenesSemantics(input);
  ok(result.ok, label, result.ok ? undefined : result.issues.slice(0, 3));
}

function expectFail(input: ScenesSemanticInput, code: SceneSemanticIssueCode, label: string): void {
  const result = validateScenesSemantics(input);
  ok(
    !result.ok && result.issues.some((issue) => issue.code === code),
    label,
    result.ok ? 'unexpected pass' : result.issues.map((i) => i.code),
  );
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e'), {recursive: true, force: true});
  const db = getDb();

  // ============ ID 语义（1–5） ============
  expectPass(makeValid(), '[1] 合法基线 PASS');
  expectFail(mutate((v) => { v.scenes[0]!.id = 'S002'; }), 'SCENE_ID_SEQUENCE_INVALID', '[2] 非 S001 开始 FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.id = 'S003'; }), 'SCENE_ID_SEQUENCE_INVALID', '[3] 跳号 FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.id = 'S001'; }), 'SCENE_ID_SEQUENCE_INVALID', '[4] 重复 ID FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.id = 'scene-1'; }), 'SCENE_ID_SEQUENCE_INVALID', '[5] 非标准格式 FAIL');

  // ============ Scene timing（6–12） ============
  expectFail(mutate((v) => { v.scenes[0]!.start = -1; v.scenes[0]!.duration = 7.5; }), 'SCENE_TIME_INVALID', '[6] start < 0 FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.end = 0; v.scenes[0]!.duration = 0; v.scenes[0]!.durationInFrames = 0; }), 'SCENE_TIME_INVALID', '[7] end <= start FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.duration = 7; }), 'SCENE_DURATION_MISMATCH', '[8] duration mismatch FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.start = 7.5; v.scenes[1]!.duration = 7; v.scenes[1]!.startFrame = 225; v.scenes[1]!.durationInFrames = 210; }), 'SCENE_TIMELINE_GAP', '[9] Scene gap FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.start = 6.0; v.scenes[1]!.duration = 8.5; v.scenes[1]!.startFrame = 180; v.scenes[1]!.durationInFrames = 255; v.scenes[1]!.end = 14.5; }), 'SCENE_TIMELINE_OVERLAP', '[10] Scene overlap FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.start = 1; v.scenes[0]!.duration = 5.5; v.scenes[0]!.startFrame = 30; v.scenes[0]!.durationInFrames = 165; }), 'SCENE_TIMELINE_GAP', '[11] first Scene start != 0 FAIL');
  {
    const chain = mutate((v) => {
      v.chapterTiming[1]!.end = 21;
      v.scenes.push(scene({id: 'S003', chapter: 2, chapterTitle: '深入', start: 14.5, end: 21, category: 'Minimal', visualType: 'Minimal'}));
    });
    expectPass(chain, '[12] 正常连续 timeline（3 场链）PASS');
  }

  // ============ Frames（13–15） ============
  expectFail(mutate((v) => { v.scenes[0]!.startFrame = 1; }), 'SCENE_FRAME_MISMATCH', '[13] startFrame mismatch FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.durationInFrames = 241; }), 'SCENE_FRAME_MISMATCH', '[14] durationInFrames mismatch FAIL');
  {
    // 小数帧换算：必须使用 Math.round（floor 会得到 37/70，round 应为 38/71）
    const decimal: ScenesSemanticInput = {
      chapterTiming: [{chapter: 1, title: 'c', start: 0, end: 3.6}],
      scenes: [
        scene({id: 'S001', chapter: 1, chapterTitle: 'c', start: 0, end: 1.25}),
        scene({id: 'S002', chapter: 1, chapterTitle: 'c', start: 1.25, end: 3.6}),
      ],
    };
    const s1 = decimal.scenes[0]!;
    const s2 = decimal.scenes[1]!;
    ok(
      s1.durationInFrames === 38 && s2.startFrame === 38 && s2.durationInFrames === 71 &&
        Math.round(1.25 * 30) === 38 && Math.round(2.35 * 30) === 71,
      '[15] 小数帧换算统一 Math.round（37.5→38 / 70.5→71，非 floor）',
      {s1: s1.durationInFrames, s2start: s2.startFrame, s2dur: s2.durationInFrames},
    );
    expectPass(decimal, '[15] 小数 fixture 帧一致 PASS');
  }

  // ============ Chapter Timing（16–20） ============
  expectFail(mutate((v) => { v.chapterTiming[0]!.chapter = 2; v.chapterTiming[1]!.chapter = 3; v.scenes.forEach((s) => { s.chapter += 1; }); }), 'CHAPTER_TIMING_INVALID', '[16] chapter 不从 1 开始 FAIL');
  expectFail(mutate((v) => { v.chapterTiming[1]!.chapter = 3; v.scenes[1]!.chapter = 3; }), 'CHAPTER_TIMING_INVALID', '[17] chapter 跳号 FAIL');
  expectFail(mutate((v) => { v.chapterTiming[1]!.start = 7.5; v.scenes[1]!.start = 7.5; v.scenes[1]!.startFrame = 225; }), 'CHAPTER_TIMING_INVALID', '[18] chapter gap FAIL');
  expectFail(mutate((v) => { v.chapterTiming[1]!.start = 6.0; }), 'CHAPTER_TIMING_INVALID', '[19] chapter overlap FAIL');
  expectFail(mutate((v) => { v.chapterTiming[1]!.end = 15.0; }), 'CHAPTER_TIMING_INVALID', '[20] 最终 chapter end != final scene end FAIL');

  // ============ Chapter ↔ Scene（21–26） ============
  expectFail(mutate((v) => { v.scenes[1]!.chapter = 99; }), 'SCENE_CHAPTER_MISMATCH', '[21] scene chapter 不存在 FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.start = 6.0; v.scenes[1]!.duration = 8.5; v.scenes[1]!.startFrame = 180; v.scenes[1]!.durationInFrames = 255; }), 'SCENE_CHAPTER_MISMATCH', '[22] scene 落到 chapter 外 FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.end = 7.0; v.scenes[0]!.duration = 7.0; v.scenes[0]!.durationInFrames = 210; }), 'SCENE_CHAPTER_MISMATCH', '[23] Scene 跨 chapter boundary FAIL');
  expectFail(mutate((v) => { v.chapterTiming.push({chapter: 3, title: '空章', start: 14.5, end: 20}); }), 'CHAPTER_TIMING_INVALID', '[24] chapter 没有 Scene FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.chapterTitle = '别的标题'; }), 'SCENE_CHAPTER_TITLE_MISMATCH', '[25] chapterTitle mismatch FAIL');
  {
    const multi = makeValid();
    multi.chapterTiming.push({chapter: 3, title: '收束', start: 14.5, end: 20});
    multi.scenes.push(scene({id: 'S003', chapter: 3, chapterTitle: '收束', start: 14.5, end: 20, category: 'Archive', visualType: 'Archive'}));
    expectPass(multi, '[26] 完整合法多章 PASS');
  }

  // ============ MG 模板（27–30） ============
  expectFail(mutate((v) => { v.scenes[1]!.template = null; }), 'MG_TEMPLATE_REQUIRED', '[27] MG template null FAIL');
  expectFail(mutate((v) => { v.scenes[1]!.template = 'cool-3d-chart-v7'; }), 'MG_TEMPLATE_NOT_REGISTERED', '[28] MG template 未注册 FAIL');
  ok(MG_TEMPLATE_REGISTRY.size === 6, '[29] Registry 含 6 个 production 数据驱动模板（M6）');
  expectPass(makeValid(), '[29] 合法 MG template PASS');
  {
    expectFail(mutate((v) => { v.scenes[0]!.template = 'MG_TimePass'; }), 'NON_MG_TEMPLATE_NOT_NULL', '[30] 非 MG template 非 null FAIL');
    expectFail(mutate((v) => { v.scenes[0]!.sourceTemplate = 'MG_TimePass'; }), 'MG_TEMPLATE_NOT_REGISTERED', '[30] M1 demo 模板不再是合法值（M6）FAIL');
    const withSource = mutate((v) => { v.scenes[0]!.sourceTemplate = 'MG_MessageFocus'; });
    expectPass(withSource, '[30] 非 MG sourceTemplate 为 production 已注册 ID PASS');
    expectFail(mutate((v) => { v.scenes[0]!.sourceTemplate = 'made-up-template'; }), 'MG_TEMPLATE_NOT_REGISTERED', '[30] 非 MG sourceTemplate 未注册 FAIL');
  }

  // ============ 枚举式契约值（31–33） ============
  expectFail(mutate((v) => { v.scenes[0]!.category = 'Animation'; }), 'SCENE_CATEGORY_INVALID', '[31] category 非允许值 FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.visualType = 'Video'; }), 'SCENE_VISUAL_TYPE_INVALID', '[32] visualType 非允许值 FAIL');
  expectFail(mutate((v) => { v.scenes[0]!.licenseStatus = 'unknown'; }), 'SCENE_LICENSE_STATUS_INVALID', '[33] licenseStatus unknown FAIL');

  // ============ R. Structured Output Repair 集成 ============
  {
    const semanticInvalid = JSON.stringify(mutate((v) => { v.scenes[1]!.id = 'S003'; }));
    const valid = JSON.stringify(makeValid());
    class SequenceProvider implements LLMProvider {
      readonly name = 'mock';
      private index = 0;
      constructor(private readonly texts: string[]) {}
      generate(req: LLMRequest): Promise<LLMResponse> {
        const text = this.texts[Math.min(this.index++, this.texts.length - 1)]!;
        return Promise.resolve({
          text,
          requestId: `seq-${this.index}`,
          model: req.model,
          finishReason: 'stop',
          usage: {promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 10},
        });
      }
    }

    // R1：首次结构合法但语义非法 → repair 后通过
    const result = await executeStageGeneration({
      db, provider: new SequenceProvider([semanticInvalid, valid]),
      stage: 'scenes', input: {topic: 't', coreQuestion: 'q'}, projectId: 'm2e-r1', env: {},
    });
    ok(
      result.repairCount === 1 && result.requestIds.length === 2 && result.versionSource === 'repair',
      '[R1] 语义非法 → repair 1 次后通过',
    );
    ok(
      validateScenesSemantics(JSON.parse(result.content) as ScenesSemanticInput).ok,
      '[R1] 最终内容是 repair 后的合法内容',
    );
    const rows1 = db.prepare('SELECT * FROM llm_usage WHERE project_id = ?').all('m2e-r1');
    ok(rows1.length === 2, '[R1] 首次与 repair 各自独立 usage（2 行）', rows1.length);

    // R2：连续语义非法超过 repair 上限 → VALIDATION_FAILED，usage 保留
    let threw: string | null = null;
    try {
      await executeStageGeneration({
        db, provider: new SequenceProvider([semanticInvalid]),
        stage: 'scenes', input: {topic: 't', coreQuestion: 'q'}, projectId: 'm2e-r2', env: {},
      });
    } catch (err) {
      threw = err instanceof LLMError ? err.code : String(err);
    }
    ok(threw === 'VALIDATION_FAILED', '[R2] 连续语义非法 → VALIDATION_FAILED', threw);
    const rows2 = db.prepare('SELECT * FROM llm_usage WHERE project_id = ?').all('m2e-r2');
    ok(rows2.length === 3, '[R2] 3 次请求 usage 全部保留', rows2.length);
  }

  // ============ M. Manual Edit 共用性（Scenes 未开放，验证共享 validator） ============
  {
    const schemaValidButSemanticBad = mutate((v) => { v.scenes[1]!.id = 'S003'; });
    ok(
      scenesAiOutputSchema.safeParse(schemaValidButSemanticBad).success,
      '[M] 结构 zod 通过（语义问题结构层不拦）',
    );
    const issues = scenesPrompt.semanticValidate!(schemaValidButSemanticBad);
    ok(
      issues.length > 0 && issues.some((i) => i.code === 'SCENE_ID_SEQUENCE_INVALID'),
      '[M] 共享 semanticValidate 拦下语义非法（LLM 与未来 PATCH 同一套规则）',
    );
    const validData = makeValid();
    ok(
      scenesPrompt.semanticValidate!(validData).length === 0,
      '[M] 合法数据过共享 semanticValidate',
    );
    // Scenes 已开放（M2-E-B）：PATCH 可达；给合法内容时 not_started 被状态机拒绝
    const {createProjectWithWorkflow} = await import('../src/lib/projects');
    const pid = createProjectWithWorkflow({topic: 't', coreQuestion: 'q'}).project.id;
    const res = await stagePATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({content: JSON.stringify(makeValid())}),
      }),
      {params: Promise.resolve({id: pid, stage: 'scenes'})},
    );
    const json = (await res.json()) as {error?: string};
    ok(
      res.status === 409 && json.error === 'NO_ACTIVE_VERSION',
      '[M] capabilities 已开放 scenes（合法内容 PATCH 可达，未生成被 NO_ACTIVE_VERSION 拒绝）',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M2-E-A 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M2-E-A Scenes 语义校验测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

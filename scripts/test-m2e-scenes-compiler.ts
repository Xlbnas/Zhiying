/**
 * M5 Scenes Deterministic Compiler 测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m2e-scenes-compiler.ts
 * 覆盖：
 *   1. category/visualType/licenseStatus alias 归一
 *   2. 跨章 / 章前 / gap / overlap / 末场不等于末章末 → deterministic reflow
 *   3. 多 chapter / scene 数变化后的权重 reflow
 *   4. 幂等 + 确定性
 *   5. 无法 deterministic 修复的问题（未知 chapter、无法映射 enum）仍留给语义校验
 *   6. 集成：executeStageGeneration 首次输出 timing/enum 全错 → 0 次 repair 通过
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2e-scenes-compiler');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {executeStageGeneration} from '../src/lib/llm/executor';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {compileScenesAiOutput} from '../src/lib/scenes/compiler';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {
  MG_TEMPLATE_REGISTRY,
  SCENES_SYSTEM_FPS,
  validateScenesSemantics,
  type ScenesSemanticInput,
} from '../src/lib/workflow/scenes-semantic-validation';
import type {Scene} from '../src/lib/scene-schema';

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

// ---------- 构造 helper ----------

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

function baseInput(): ScenesSemanticInput {
  return {
    chapterTiming: [
      {chapter: 1, title: '开篇', start: 0, end: 30},
      {chapter: 2, title: '深入', start: 30, end: 90},
    ],
    scenes: [
      scene({id: 'S001', chapter: 1, chapterTitle: '开篇', start: 0, end: 15}),
      scene({id: 'S002', chapter: 1, chapterTitle: '开篇', start: 15, end: 30}),
      scene({id: 'S003', chapter: 2, chapterTitle: '深入', start: 30, end: 60}),
      scene({
        id: 'S004', chapter: 2, chapterTitle: '深入', start: 60, end: 90,
        category: 'MG', visualType: 'MG', template: 'MG_MessageFocus', templateProps: {message: '聚焦信息'}, sourceTemplate: 'MG_MessageFocus',
      }),
    ],
  };
}

function mutate(fn: (v: ScenesSemanticInput) => void): ScenesSemanticInput {
  const v = JSON.parse(JSON.stringify(baseInput())) as ScenesSemanticInput;
  fn(v);
  return v;
}

function compileAndValidate(input: ScenesSemanticInput, label: string): void {
  const parsed = scenesAiOutputSchema.parse(JSON.parse(JSON.stringify(input)));
  const {output} = compileScenesAiOutput(parsed);
  const result = validateScenesSemantics(output as ScenesSemanticInput);
  ok(result.ok, label, result.ok ? undefined : result.issues.slice(0, 4));
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e-scenes-compiler'), {recursive: true, force: true});
  const db = getDb();

  // ---------- 1. 合法基线：编译后仍合法且内容不变 ----------
  {
    const parsed = scenesAiOutputSchema.parse(baseInput());
    const {output, fixes} = compileScenesAiOutput(parsed);
    const result = validateScenesSemantics(output as ScenesSemanticInput);
    ok(result.ok, '[01] 合法基线编译后仍 PASS', result.ok ? undefined : result.issues.slice(0, 3));
    ok(
      JSON.stringify(output.scenes.map((s) => [s.start, s.end])) ===
        JSON.stringify([[0, 15], [15, 30], [30, 60], [60, 90]]),
      '[02] 合法基线时间轴不被改写',
    );
    ok(fixes.length === 0, '[03] 合法基线零 fixes');
  }

  // ---------- 2. enum alias ----------
  compileAndValidate(mutate((v) => {
    v.scenes[0]!.category = 'Reality B-roll';
    v.scenes[1]!.category = 'archival';
  }), '[04] category alias（Reality B-roll / archival）归一后 PASS');

  compileAndValidate(mutate((v) => {
    v.scenes[0]!.visualType = 'Reality B-roll';
    v.scenes[1]!.visualType = 'b-roll';
  }), '[05] visualType alias（Reality B-roll / b-roll → Asset）归一后 PASS');

  {
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      v.scenes[0]!.category = 'Reality B-roll';
      v.scenes[1]!.category = 'ARCHIVE';
      v.scenes[2]!.visualType = 'b-roll';
      v.scenes[2]!.licenseStatus = 'Not Applicable';
    }));
    const {output} = compileScenesAiOutput(parsed);
    ok(output.scenes[0]!.category === 'B-roll', '[06] category Reality B-roll → B-roll');
    ok(output.scenes[1]!.category === 'Archive', '[07] category ARCHIVE → Archive（大小写）');
    ok(output.scenes[2]!.visualType === 'Asset', '[08] visualType b-roll → Asset');
    ok(output.scenes[2]!.licenseStatus === 'not-applicable', '[09] licenseStatus Not Applicable → not-applicable');
  }

  // ---------- 3. timing reflow ----------
  compileAndValidate(mutate((v) => {
    // S002 跨出第 1 章边界进入第 2 章
    v.scenes[1]!.start = 15;
    v.scenes[1]!.end = 45;
  }), '[10] scene 跨 chapter end → reflow 后 PASS');

  compileAndValidate(mutate((v) => {
    // S003 在第 2 章开始前就开始
    v.scenes[2]!.start = 20;
    v.scenes[2]!.end = 55;
  }), '[11] scene 早于 chapter start → reflow 后 PASS');

  compileAndValidate(mutate((v) => {
    // S001 与 S002 之间制造 gap
    v.scenes[0]!.end = 10;
    v.scenes[1]!.start = 15;
  }), '[12] timeline gap → reflow 后 PASS');

  compileAndValidate(mutate((v) => {
    // S001 与 S002 overlap
    v.scenes[0]!.end = 20;
  }), '[13] timeline overlap → reflow 后 PASS');

  compileAndValidate(mutate((v) => {
    // 末场 end != 末章 end
    v.scenes[3]!.end = 80;
  }), '[14] final scene.end != final chapter.end → reflow 后 PASS');

  compileAndValidate(mutate((v) => {
    // chapter 之间不连续（gap）
    v.chapterTiming[1]!.start = 40;
  }), '[15] chapterTiming 章间 gap → 连续化后 PASS');

  compileAndValidate(mutate((v) => {
    // 首章不从 0 开始
    v.chapterTiming[0]!.start = 5;
  }), '[16] 首章 start != 0 → 连续化后 PASS');

  // ---------- 4. 多 chapter + 权重分配 ----------
  {
    const input = mutate((v) => {
      v.chapterTiming = [
        {chapter: 1, title: '一', start: 0, end: 20},
        {chapter: 2, title: '二', start: 20, end: 60},
        {chapter: 3, title: '三', start: 60, end: 120},
      ];
      v.scenes = [
        scene({id: 'S001', chapter: 1, chapterTitle: '一', start: 0, end: 8}),
        scene({id: 'S002', chapter: 2, chapterTitle: '二', start: 9, end: 30}),
        scene({id: 'S003', chapter: 3, chapterTitle: '三', start: 31, end: 50}),
        scene({id: 'S004', chapter: 3, chapterTitle: '三', start: 50, end: 99}),
      ];
    });
    const parsed = scenesAiOutputSchema.parse(input);
    const {output} = compileScenesAiOutput(parsed);
    const result = validateScenesSemantics(output as ScenesSemanticInput);
    ok(result.ok, '[17] 三 chapter 乱序时间 → 各章内 reflow PASS', result.ok ? undefined : result.issues.slice(0, 3));
    const ch3 = output.scenes.filter((s) => s.chapter === 3);
    ok(
      ch3[0]!.start === 60 && ch3.at(-1)!.end === 120,
      '[18] 第 3 章首 scene.start=章首、末 scene.end=章末',
      ch3.map((s) => [s.start, s.end]),
    );
    ok(
      ch3[0]!.chapterTitle === '三' && ch3[1]!.chapterTitle === '三',
      '[19] chapterTitle 由程序按章注入',
    );
  }

  // ---------- 5. 时长权重：scene 数变化后重新分配 ----------
  {
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      // 第 1 章（30s）内 S001 权重 10、S002 权重 20（用 end-start 表达）
      v.scenes[0]!.start = 0;
      v.scenes[0]!.end = 10;
      v.scenes[1]!.start = 100;
      v.scenes[1]!.end = 120;
    }));
    const {output} = compileScenesAiOutput(parsed);
    const [s1, s2] = output.scenes;
    ok(s1!.start === 0 && s2!.end === 30, '[20] 权重 reflow 边界正确');
    ok(
      Math.abs(s1!.duration - 10) < 0.01 && Math.abs(s2!.duration - 20) < 0.01,
      '[21] 时长按权重 1:2 比例分配',
      [s1!.duration, s2!.duration],
    );
    ok(
      s1!.startFrame === 0 && s1!.durationInFrames === 300 && s2!.durationInFrames === 600,
      '[22] 帧字段由程序换算',
    );
  }

  // ---------- 6. 幂等 + 确定性 ----------
  {
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      v.scenes[0]!.category = 'Reality B-roll';
      v.scenes[1]!.start = 15;
      v.scenes[1]!.end = 45;
      v.chapterTiming[1]!.start = 40;
    }));
    const first = compileScenesAiOutput(parsed).output;
    const second = compileScenesAiOutput(JSON.parse(JSON.stringify(first))).output;
    ok(
      JSON.stringify(first) === JSON.stringify(second),
      '[23] 幂等：对已编译输出再编译结果不变',
    );
    const third = compileScenesAiOutput(JSON.parse(JSON.stringify(parsed))).output;
    ok(
      JSON.stringify(first) === JSON.stringify(third),
      '[24] 确定性：同输入两次编译输出一致',
    );
  }

  // ---------- 7. 无法 deterministic 修复的问题仍留语义校验 ----------
  {
    // MG 模板 ID 变体归一（生产故障类别：模型改写注册 ID 的大小写/分隔符）
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      v.scenes[3]!.template = 'mg_message_focus';
      v.scenes[3]!.sourceTemplate = 'MG-MessageFocus';
    }));
    const {output} = compileScenesAiOutput(parsed);
    ok(output.scenes[3]!.template === 'MG_MessageFocus', '[26a] template mg_message_focus → MG_MessageFocus');
    ok(output.scenes[3]!.sourceTemplate === 'MG_MessageFocus', '[26b] sourceTemplate MG-MessageFocus → MG_MessageFocus');
    const result = validateScenesSemantics(output as ScenesSemanticInput);
    ok(result.ok, '[26c] 模板 ID 变体归一后语义校验 PASS', result.ok ? undefined : result.issues.slice(0, 3));
  }
  {
    // 模型编造的模板 ID：归一不了 → 仍报 MG_TEMPLATE_NOT_REGISTERED（留 repair；
    // scenes@1.2 起 repair prompt 携带完整注册表）
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      v.scenes[3]!.template = 'MG_FreudCouch';
      v.scenes[3]!.sourceTemplate = 'MG_FreudCouch';
    }));
    const {output} = compileScenesAiOutput(parsed);
    const result = validateScenesSemantics(output as ScenesSemanticInput);
    ok(
      !result.ok && result.issues.some((i) => i.code === 'MG_TEMPLATE_NOT_REGISTERED'),
      '[26d] 编造模板 ID 仍报 MG_TEMPLATE_NOT_REGISTERED（留 LLM repair）',
    );
  }
  {
    // scenes@1.2：system prompt 必须携带完整注册表（生产根因：此前模型看不到合法 ID）
    const {scenesPrompt} = await import('../src/lib/prompts/scenes');
    const missing = [...MG_TEMPLATE_REGISTRY].filter((id) => !scenesPrompt.system.includes(id));
    ok(missing.length === 0 && scenesPrompt.promptVersion === 'scenes@1.3', '[26e] system prompt 携带全部 production 注册模板 ID（scenes@1.3）', missing);
  }

  {
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      v.scenes[0]!.category = '全息投影'; // 无法映射
    }));
    const {output} = compileScenesAiOutput(parsed);
    const result = validateScenesSemantics(output as ScenesSemanticInput);
    ok(
      !result.ok && result.issues.some((i) => i.code === 'SCENE_CATEGORY_INVALID'),
      '[25] 无法映射的 category 仍报 SCENE_CATEGORY_INVALID（留给 LLM repair）',
    );
  }
  {
    const parsed = scenesAiOutputSchema.parse(mutate((v) => {
      v.scenes[0]!.chapter = 99; // 不存在的章
      v.scenes[0]!.chapterTitle = '不存在';
    }));
    const {output} = compileScenesAiOutput(parsed);
    const result = validateScenesSemantics(output as ScenesSemanticInput);
    ok(
      !result.ok && result.issues.some((i) => i.code === 'SCENE_CHAPTER_MISMATCH'),
      '[26] 未知 chapter 仍报 SCENE_CHAPTER_MISMATCH（留给 LLM repair）',
    );
  }

  // ---------- 8. 集成：LLM 首次输出 timing/enum 全错 → 0 次 repair 通过 ----------
  {
    const broken = mutate((v) => {
      v.scenes[0]!.category = 'Reality B-roll';
      v.scenes[1]!.category = 'archival';
      v.scenes[0]!.visualType = 'Reality B-roll';
      v.scenes[1]!.start = 15;
      v.scenes[1]!.end = 45; // 跨章
      v.scenes[3]!.end = 80; // 末场 ≠ 末章末
      v.chapterTiming[1]!.start = 40; // 章间 gap
    });
    const provider: LLMProvider = {
      name: 'mock-sequence',
      async generate(req: LLMRequest): Promise<LLMResponse> {
        return {
          requestId: `req-${Date.now()}`,
          model: req.model,
          text: JSON.stringify(broken),
          finishReason: 'stop',
          usage: {promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1},
        };
      },
    };
    const result = await executeStageGeneration({
      db,
      provider,
      stage: 'scenes',
      input: {topic: '测试', coreQuestion: '测试？', upstream: {}},
    });
    ok(result.repairCount === 0, '[27] 集成：timing/enum 全错但 0 次 repair 通过', {repairCount: result.repairCount});
    const stored = JSON.parse(result.content) as ScenesSemanticInput;
    const sem = validateScenesSemantics(stored);
    ok(sem.ok, '[28] 集成：持久化内容过语义校验', sem.ok ? undefined : sem.issues.slice(0, 3));
    ok(stored.scenes[0]!.category === 'B-roll', '[29] 集成：alias 归一进入 artifact');
    ok(stored.scenes.at(-1)!.end === stored.chapterTiming.at(-1)!.end, '[30] 集成：末场 end == 末章 end');
  }

  // ---------- 9. 集成：repair 返回仍非法 timing → normalize 后收敛 ----------
  {
    const stillBroken = mutate((v) => {
      v.scenes[1]!.end = 70; // 仍然跨章
    });
    let calls = 0;
    const provider: LLMProvider = {
      name: 'mock-sequence',
      async generate(req: LLMRequest): Promise<LLMResponse> {
        calls += 1;
        const text = calls === 1
          ? JSON.stringify(mutate((v) => { v.scenes[0]!.category = '全息投影'; }))
          : JSON.stringify(stillBroken);
        return {
          requestId: `req-${calls}`,
          model: req.model,
          text,
          finishReason: 'stop',
          usage: {promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1},
        };
      },
    };
    const result = await executeStageGeneration({
      db,
      provider,
      stage: 'scenes',
      input: {topic: '测试', coreQuestion: '测试？', upstream: {}},
    });
    ok(
      result.repairCount === 1 && calls === 2,
      '[31] 语义错误进 1 次 repair；repair 返回非法 timing 由 compiler 收敛',
      {repairCount: result.repairCount, calls},
    );
  }

  closeDb();
  console.log(`\nM5 scenes-compiler: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('scenes-compiler 测试异常终止:', err);
  process.exit(1);
});

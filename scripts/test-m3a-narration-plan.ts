/**
 * M3-A Narration Plan 测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m3a-narration-plan.ts
 * 使用临时数据目录（data/test-m3a），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3a');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {compileNarrationPlan, NarrationCompileError} from '../src/lib/narration/compiler';
import {
  buildNarrationPlan,
  checkNarrationReadiness,
  NARRATION_PLAN_ARTIFACT_KIND,
  NarrationPlanError,
} from '../src/lib/narration/plan';
import {
  NARRATION_COMPILER_VERSION,
  NARRATION_PLAN_SCHEMA_VERSION,
  narrationPlanSchema,
  type NarrationPlan,
} from '../src/lib/narration/schema';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runLlmJob} from '../src/worker/llm-executor';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
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

const FIXTURE_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–02:00）

那条消息你看到了。（停顿 1s）

你没有回。为什么偏偏是这一条？

[画面留白]

## 第 2 章 追问（02:00–05:00）

弗洛伊德怀疑过这种忘记。（放慢）他说，有些遗忘背后藏着不情愿。<!-- E01 E02 -->

这是真的吗？我们慢慢看。<!-- E03 -->
`;

function compile(md: string, version = 1): NarrationPlan {
  return compileNarrationPlan({
    scriptV2Markdown: md,
    scriptV2Version: version,
    promptVersion: 'script-v2@1.0',
  });
}

function speechTexts(plan: NarrationPlan): string[] {
  return plan.units.filter((u) => u.kind === 'speech').map((u) => u.text ?? '');
}

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

function claimLlm() {
  const claimed = claimNextAnyJob('w-m3a');
  return claimed && claimed.type === 'llm' ? claimed : null;
}

async function genAndLock(pid: string, stage: WorkflowStage): Promise<void> {
  const job = enqueueWorkflowStageJob(pid, stage);
  const claimed = claimLlm();
  if (!claimed || claimed.job.id !== job.id) throw new Error(`claim 失败 ${stage}`);
  await runLlmJob(claimed.job, CTX);
  if (getLlmJob(job.id)!.status !== 'succeeded') throw new Error(`${stage} 未成功`);
  lockStage(pid, stage);
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m3a'), {recursive: true, force: true});
  const db = getDb();

  const plan = compile(FIXTURE_V2);

  // ============ Parsing ============
  const allSpeech = speechTexts(plan);
  ok(!allSpeech.some((t) => t.includes('Script V2')), '[1] H1 标题不进入 speech');
  ok(!allSpeech.some((t) => t.includes('差异说明')), '[2] blockquote 差异说明不进入 speech');
  ok(
    plan.chapters.length === 2 && plan.chapters[0]!.chapter === 1 && plan.chapters[0]!.title === '开场' &&
      plan.chapters[1]!.chapter === 2 && plan.chapters[1]!.title === '追问',
    '[3] chapter heading 正确解析（编号 + 标题剥离声明区间）',
  );
  ok(!allSpeech.some((t) => t.includes('<!--') || t.includes('E01')), '[4] Evidence HTML 注释被剥离');
  {
    const ev = plan.units.find((u) => u.evidenceIds.length > 0);
    const allIds = plan.units.flatMap((u) => u.evidenceIds);
    ok(
      ev !== undefined && allIds.join(',') === 'E01,E02,E03',
      '[5] Evidence IDs 正确保存（去重 + 顺序）',
      allIds,
    );
  }
  ok(allSpeech.length >= 4, '[6] 普通正文 → speech units');
  {
    const again = compile(FIXTURE_V2);
    ok(
      JSON.stringify(again.units.map((u) => u.text)) === JSON.stringify(plan.units.map((u) => u.text)),
      '[7] 多段 speech 顺序稳定（重复编译一致）',
    );
  }

  // ============ Directives ============
  {
    const pauses = plan.units.filter((u) => u.kind === 'pause');
    ok(pauses.length === 1 && pauses[0]!.pauseMs === 1000 && pauses[0]!.text === null, '[8] （停顿 1s）→ pauseMs=1000');
    const half = compile(FIXTURE_V2.replace('（停顿 1s）', '（停顿 0.5s）'));
    const p2 = half.units.filter((u) => u.kind === 'pause');
    ok(p2.length === 1 && p2[0]!.pauseMs === 500, '[9] （停顿 0.5s）→ pauseMs=500');
    const prosody = plan.units.filter((u) => u.kind === 'prosody');
    ok(prosody.length === 1 && prosody[0]!.directive === '放慢' && prosody[0]!.text === null, '[10] （放慢）→ prosody directive');
    const breaths = plan.units.filter((u) => u.kind === 'visual_breath');
    ok(breaths.length === 1 && breaths[0]!.text === null && breaths[0]!.pauseMs === null, '[11] [画面留白] → visual_breath');
    ok(
      !plan.units.some((u) => (u.text ?? '').includes('停顿') || (u.text ?? '').includes('画面留白') || (u.text ?? '').includes('放慢')),
      '[12] directive 不进入 speech text',
    );
  }

  // ============ IDs ============
  ok(plan.units[0]!.id === 'N001', '[13] N001 起始');
  ok(
    plan.units.every((u, i) => u.id === `N${String(i + 1).padStart(3, '0')}`),
    '[14] 连续编号 N001…N00N',
  );
  ok(
    JSON.stringify(compile(FIXTURE_V2)) === JSON.stringify(plan),
    '[15] 相同 input 重复 compile 字节级一致',
  );

  // ============ Chapters ============
  {
    const ch1Units = plan.units.filter((u) => u.chapter === 1);
    const ch2Units = plan.units.filter((u) => u.chapter === 2);
    ok(ch1Units.length > 0 && ch2Units.length > 0, '[16] unit chapter 归属正确');
    ok(
      plan.chapters[0]!.firstUnitId === ch1Units[0]!.id && plan.chapters[0]!.lastUnitId === ch1Units[ch1Units.length - 1]!.id &&
        plan.chapters[1]!.firstUnitId === ch2Units[0]!.id && plan.chapters[1]!.lastUnitId === ch2Units[ch2Units.length - 1]!.id,
      '[17] chapter firstUnitId / lastUnitId 正确',
    );
    ok(
      plan.units.findIndex((u) => u.chapter === 2) > plan.units.findLastIndex((u) => u.chapter === 1),
      '[18] 章节顺序：第 2 章 units 全部在第 1 章之后',
    );
  }

  // ============ Validation ============
  {
    // 只有 directive 的章节：不产生空 speech unit（编译器跳过空 run），plan 本身合法
    const directiveOnly = compile(`# Script V2\n\n## 第 1 章 空章（00:00–01:00）\n\n（停顿 1s）\n`);
    ok(
      directiveOnly.units.length === 1 && directiveOnly.units[0]!.kind === 'pause' &&
        !directiveOnly.units.some((u) => u.kind === 'speech'),
      '[19] directive-only 段落不产生空 speech unit（pause 仍合法）',
    );
    // 手工构造 empty speech unit → schema 层必然拒绝
    const bad = narrationPlanSchema.safeParse({
      schemaVersion: NARRATION_PLAN_SCHEMA_VERSION,
      compilerVersion: NARRATION_COMPILER_VERSION,
      source: {stage: 'script_v2', version: 1, promptVersion: null},
      chapters: [{chapter: 1, title: 'x', firstUnitId: 'N001', lastUnitId: 'N001'}],
      units: [{id: 'N001', chapter: 1, kind: 'speech', text: '  ', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'}],
    });
    ok(!bad.success, '[19] empty speech text 被 schema 拒绝');
    let threw2: string | null = null;
    try {
      compile(`## 第 2 章 错序（00:00–01:00）\n\n句子一。\n\n## 第 1 章 错序（01:00–02:00）\n\n句子二。\n`);
    } catch (err) {
      threw2 = err instanceof NarrationCompileError ? err.code : String(err);
    }
    ok(threw2 === 'NARRATION_PLAN_INVALID', '[20] chapter 编号不递增被拒绝', threw2);
    let threw3: string | null = null;
    try {
      compile(`# Script V2\n\n没有章节的正文。\n`);
    } catch (err) {
      threw3 = err instanceof NarrationCompileError ? err.code : String(err);
    }
    ok(threw3 === 'SCRIPT_V2_INVALID', '[21] 无章节标记的 Script 被拒绝', threw3);
  }

  // ============ Source ============
  {
    let threw: string | null = null;
    try {
      buildNarrationPlan('no-such-project');
    } catch (err) {
      threw = err instanceof NarrationPlanError ? err.code : String(err);
    }
    ok(threw === 'PROJECT_NOT_FOUND', '[22] 项目不存在 → PROJECT_NOT_FOUND', threw);
    const pid = newProject();
    let threw2: string | null = null;
    try {
      buildNarrationPlan(pid);
    } catch (err) {
      threw2 = err instanceof NarrationPlanError ? err.code : String(err);
    }
    ok(threw2 === 'SCRIPT_V2_NOT_LOCKED', '[23] script_v2 未锁定 → SCRIPT_V2_NOT_LOCKED', threw2);
  }

  // ============ Artifact + 真实 Workflow ============
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
      await genAndLock(pid, stage);
    }
    // 用真实 Script V2 内容（含 directives）替换 locked 内容，走真实 build
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: FIXTURE_V2, contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'script_v2');

    const {plan: built, artifact, reused} = buildNarrationPlan(pid);
    ok(!reused, '[26] 首次 build → 新 artifact');
    ok(
      artifact.kind === NARRATION_PLAN_ARTIFACT_KIND && artifact.version === 1,
      '[26] narration_plan artifact 落库（kind/version）',
    );
    ok(
      built.source.stage === 'script_v2' && built.source.version === 2 && built.source.promptVersion === null,
      '[27] source = script_v2.locked_version v2（manual_edit 来源 promptVersion=null）',
    );
    ok(
      built.compilerVersion === NARRATION_COMPILER_VERSION && built.schemaVersion === NARRATION_PLAN_SCHEMA_VERSION,
      '[28/29] compilerVersion 与 schemaVersion 正确',
    );
    ok(narrationPlanSchema.safeParse(built).success, '[28] plan 通过契约 schema 复验');

    // 幂等：同 source 重复 build 复用
    const again = buildNarrationPlan(pid);
    ok(again.reused && again.artifact.id === artifact.id, '[30] 同 source 重复 build 幂等（复用已有 artifact）');
    ok(
      (db.prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?').get(pid, NARRATION_PLAN_ARTIFACT_KIND) as {c: number}).c === 1,
      '[30] 不产生重复 artifact 行',
    );

    // readiness
    const ready = checkNarrationReadiness(pid);
    ok(ready.status === 'ready' && ready.scriptV2LockedVersion === 2, '[30] readiness = ready');

    // stale：script_v2 新版本后旧 plan 判 stale
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: FIXTURE_V2 + '\n\n补充一句新的口播。\n', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'script_v2');
    const stale = checkNarrationReadiness(pid);
    ok(
      stale.status === 'stale' && stale.currentPlan === null && stale.latestPlanSourceVersion === 2,
      '[31] script_v2 前进后旧 plan = stale（旧 artifact 保留不删）',
    );
    // re-lock 新 Script V2 → 新 plan artifact
    const rebuilt = buildNarrationPlan(pid);
    ok(
      !rebuilt.reused && rebuilt.plan.source.version === 3 && rebuilt.artifact.version === 2,
      '[32] 新 source version → 新 plan artifact（version 递增）',
    );
    ok(
      rebuilt.plan.units[rebuilt.plan.units.length - 1]!.text!.includes('补充一句新的口播'),
      '[32] 新 plan 内容来自新 Script V2',
    );
    const ready2 = checkNarrationReadiness(pid);
    ok(ready2.status === 'ready' && ready2.scriptV2LockedVersion === 3, '[32] rebuild 后 readiness = ready');
  }

  // ============ H. Hardening：corrupted artifact / chapter 括号 / Evidence 边界 / compiler 迁移 ============
  {
    // H-C：corrupted artifact 安全（不 crash、不当 current、按剩余合法 artifact 判断）
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
      await genAndLock(pid, stage);
    }
    const insertArtifact = (content: string): void => {
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?), ?, NULL, ?)`,
      ).run(crypto.randomUUID(), pid, NARRATION_PLAN_ARTIFACT_KIND, pid, NARRATION_PLAN_ARTIFACT_KIND, content, new Date().toISOString());
    };
    // A：非 JSON
    insertArtifact('not-json');
    let r = checkNarrationReadiness(pid);
    ok(r.status === 'missing' && r.currentPlan === null, '[H-A] content_json 非 JSON → 不 crash 且不当 current');
    // B：合法 JSON 但空对象
    insertArtifact('{}');
    r = checkNarrationReadiness(pid);
    ok(r.status === 'missing', '[H-B] 空对象 artifact → 不当 current');
    // C：schemaVersion 错误
    const badSchema = JSON.parse(JSON.stringify(compile(FIXTURE_V2))) as Record<string, unknown>;
    badSchema.schemaVersion = 'narration-plan@999';
    insertArtifact(JSON.stringify(badSchema));
    r = checkNarrationReadiness(pid);
    ok(r.status === 'missing', '[H-C] schemaVersion 错误 → 不当 current');
    // D：合法 plan 但 compilerVersion 为旧版 1.0（≠ 当前 1.1）→ stale（历史保留、不是 current）
    const oldPlan = JSON.parse(JSON.stringify(compile(FIXTURE_V2))) as Record<string, unknown>;
    oldPlan.compilerVersion = '1.0';
    insertArtifact(JSON.stringify(oldPlan));
    r = checkNarrationReadiness(pid);
    ok(
      r.status === 'stale' && r.currentPlan === null && r.latestPlanSourceVersion === 1,
      '[H-D] compiler 1.0 artifact → stale（不 current，保留历史）',
      {status: r.status, latest: r.latestPlanSourceVersion},
    );
    // Build：产生新的 1.1 artifact（不复用旧版），再次 build 幂等
    const rebuilt = buildNarrationPlan(pid);
    ok(
      !rebuilt.reused && rebuilt.plan.compilerVersion === '1.1',
      '[H-V] compiler 1.0 → Build 产生 1.1 新 artifact',
    );
    ok(checkNarrationReadiness(pid).status === 'ready', '[H-V] rebuild 后 ready');
    const again = buildNarrationPlan(pid);
    ok(again.reused && again.plan.compilerVersion === '1.1', '[H-V] 再次 build 幂等复用 1.1');
  }
  {
    // H-P：chapter 标题只剥离正式时间区间，合法括号标题保留
    const md = `## 第 1 章 开场（00:00–02:00）

开场句。

## 第 2 章 记忆（上）

记忆句。

## 第 3 章 一个问题（第二部分）

问题句。

## 第 4 章 范围（00:00-02:00）

范围句。

## 第 5 章 混合（00:00—02:00）

混合句。
`;
    const p = compile(md);
    const titles = p.chapters.map((c) => c.title);
    ok(
      titles[0] === '开场' && titles[1] === '记忆（上）' && titles[2] === '一个问题（第二部分）' &&
        titles[3] === '范围' && titles[4] === '混合',
      '[H-P] 时间区间（– - —）正确剥离，记忆（上）/（第二部分）等括号保留',
      titles,
    );
  }
  {
    // H-E：Evidence paragraph 边界
    const trailing = compile(`## 第 1 章 c（00:00–01:00）\n\n句子一。<!-- E01 -->\n`);
    ok(
      trailing.units.find((u) => u.kind === 'speech')?.evidenceIds.join(',') === 'E01',
      '[H-E1] trailing Evidence 归属前面的 speech',
    );
    const leading = compile(`## 第 1 章 c（00:00–01:00）\n\n<!-- E02 -->\n句子二。\n`);
    const leadingSpeech = leading.units.find((u) => u.kind === 'speech');
    ok(
      leadingSpeech?.evidenceIds.join(',') === 'E02',
      '[H-E2] leading Evidence 归属后面的第一个 speech',
    );
    const twoPara = compile(`## 第 1 章 c（00:00–01:00）\n\n句子一。\n\n<!-- E02 -->\n句子二。\n`);
    const speeches = twoPara.units.filter((u) => u.kind === 'speech');
    ok(
      !speeches[0]!.evidenceIds.includes('E02') && speeches[1]!.evidenceIds.join(',') === 'E02',
      '[H-E3] 两段场景：E02 只归第二段 speech，不跨 paragraph',
      speeches.map((s) => s.evidenceIds),
    );
    const multi = compile(`## 第 1 章 c（00:00–01:00）\n\n句子一。<!-- E01 E02 E01 -->\n`);
    ok(
      multi.units.find((u) => u.kind === 'speech')?.evidenceIds.join(',') === 'E01,E02',
      '[H-E4] 多 ID 去重且保持首次出现顺序',
    );
    const orphan = compile(`## 第 1 章 c（00:00–01:00）\n\n<!-- E09 -->\n\n（停顿 1s）\n\n## 第 2 章 d（01:00–02:00）\n\n后段句子。\n`);
    const allIds = orphan.units.flatMap((u) => u.evidenceIds);
    ok(
      !allIds.includes('E09') && orphan.units.some((u) => u.kind === 'speech'),
      '[H-E5] 无 speech 段内的 Evidence 被丢弃（不跨段、不 crash）',
      allIds,
    );
    // deterministic 保持
    ok(
      JSON.stringify(compile(FIXTURE_V2)) === JSON.stringify(compile(FIXTURE_V2)),
      '[H-E6] 修复后编译仍 deterministic',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m3a'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M3-A 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M3-A Narration Plan 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

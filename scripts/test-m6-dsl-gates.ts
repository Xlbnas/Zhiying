/**
 * M7.2.1 P0 hotfix 回归测试：script-v2 DSL 分流 + 三层 TTS 硬门禁（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m6-dsl-gates.ts
 * 使用临时数据目录（data/test-m6-dsl-gates），结束后清理。
 * 任一断言失败即非零退出。
 *
 * 覆盖（提示词 §七）：
 * 1. m6 新项目 prompt selection 不使用 script-v2@2.0；
 * 2. M7 explicit candidate prompt（scriptV2M7Prompt）仍是 script-v2@2.0 且不注册；
 * 3. @delivery/@pause/@silence/行内混合/纯指令单元 在 M6 narration build 全部 fail-closed；
 * 4. 独立行/行内/多指令混合均拦截；
 * 5. 正常语义「他停顿了一下」「沉默持续了一分钟」不误杀；
 * 6. TTS enqueue 对污染 plan 零 job（NARRATION_PLAN_CONTAMINATED）；
 * 7. worker 对历史污染 job 零 provider call（PAYLOAD_CONTAMINATED terminal）；
 * 8. clean M6 narration 正常生成 + 入队；
 * 9. M7 compiler-v2 对合法 DSL 正确得到 SpeechUnit/SilenceUnit。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m6-dsl-gates');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {compileNarrationPlan, NarrationCompileError} from '../src/lib/narration/compiler';
import {compileNarrationPlanV2} from '../src/lib/narration/compiler-v2';
import {
  buildNarrationPlan,
  NARRATION_PLAN_ARTIFACT_KIND,
  NarrationPlanError,
} from '../src/lib/narration/plan';
import {
  enqueueNarrationAudioJobs,
  getNarrationAudioOverview,
  NarrationAudioError,
} from '../src/lib/narration/audio';
import {
  canRequestAudioGeneration,
  CONTAMINATION_RECOVERY_STEPS,
  detectPlanContamination,
} from '../src/lib/narration/contamination';
import {
  NARRATION_COMPILER_VERSION,
  NARRATION_PLAN_SCHEMA_VERSION,
} from '../src/lib/narration/schema';
import {getStagePrompt, PROMPT_REGISTRY} from '../src/lib/prompts/registry';
import {scriptV2M7Prompt, scriptV2Prompt} from '../src/lib/prompts/script-v2';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {DEFAULT_VOICE_PROFILE} from '../src/lib/tts';
import type {TtsProvider, TtsResult} from '../src/lib/tts/types';
import {enqueueTtsJobTx, getTtsJob} from '../src/lib/tts-jobs';
import {runTtsJob} from '../src/worker/tts-executor';
import crypto from 'node:crypto';

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

function newProject(): string {
  return createProjectWithWorkflow({topic: 'DSL 门禁测试', coreQuestion: '控制指令会进 TTS 吗？'}).project.id;
}

function lockScriptV2(pid: string, content: string, promptVersion: string): void {
  // 直接构造 locked script_v2（等价 editVersion + lockStage 的终态；
  // editVersion 要求先有 AI 生成版本，测试夹具改用手工版本行）。
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, prompt_version, model, job_id, note, created_at)
       VALUES (?, ?, 'script_v2', 1, ?, 'markdown', 'manual_edit', ?, NULL, NULL, NULL, ?)`,
    )
    .run(crypto.randomUUID(), pid, content, promptVersion, now);
  getDb()
    .prepare(
      `UPDATE project_stages SET status = 'locked', active_version = 1, locked_version = 1, updated_at = ?
       WHERE project_id = ? AND stage = 'script_v2'`,
    )
    .run(now, pid);
}

const CHAPTER = '## 第 1 章 开场（00:00–02:00）';

const CLEAN_SCRIPT = `# Script V2

> 差异说明：测试。

${CHAPTER}

那条消息你看到了。（停顿 1s）

你没有回。为什么偏偏是这一条？

[画面留白]
`;

function expectCompileError(
  label: string,
  md: string,
  code: 'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6' | 'NARRATION_PLAN_INVALID',
): void {
  try {
    compileNarrationPlan({scriptV2Markdown: md, scriptV2Version: 1, promptVersion: 'script-v2@2.0'});
    fail++;
    console.log(`FAIL  ${label}（未抛错）`);
  } catch (err) {
    ok(
      err instanceof NarrationCompileError && err.code === code,
      `${label} → ${code}`,
      err instanceof Error ? `${err.name}: ${err.message.slice(0, 120)}` : err,
    );
  }
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m6-dsl-gates'), {recursive: true, force: true});
  const db = getDb();

  // ============ 1/2. Prompt 分流 ============
  ok(scriptV2Prompt.promptVersion === 'script-v2@1.0', '[P1] 默认 scriptV2Prompt = script-v2@1.0');
  ok(
    PROMPT_REGISTRY.script_v2 === scriptV2Prompt && getStagePrompt('script_v2').promptVersion === 'script-v2@1.0',
    '[P2] Registry/executor 路径 script_v2 → script-v2@1.0（m6 新项目默认）',
  );
  ok(
    !scriptV2Prompt.system.includes('@delivery') &&
      !scriptV2Prompt.system.includes('@pause') &&
      !scriptV2Prompt.system.includes('@silence'),
    '[P3] M6 prompt 不含 DSL 指令（新建 m6 项目不会生成 @delivery/@pause/@silence）',
  );
  ok(scriptV2M7Prompt.promptVersion === 'script-v2@2.0', '[P4] M7 candidate prompt 保留 script-v2@2.0');
  ok(
    scriptV2M7Prompt.system.includes('@pause') && scriptV2M7Prompt.system.includes('@silence'),
    '[P5] M7 candidate prompt DSL grammar 完整（未删除 script-v2@2.0）',
  );
  ok(
    !Object.values(PROMPT_REGISTRY).includes(scriptV2M7Prompt),
    '[P6] script-v2@2.0 未注册进 PROMPT_REGISTRY（标准 generation 拿不到）',
  );

  // ============ 3/4. Gate A：M6 narration build fail-closed ============
  expectCompileError('[A1] 独立行 @delivery soft', `${CLEAN_SCRIPT}\n@delivery soft\n月底了。\n`, 'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6');
  expectCompileError('[A2] 独立行 @pause 400ms', `${CLEAN_SCRIPT}\n@pause 400ms\n`, 'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6');
  expectCompileError(
    '[A3] 独立行 @silence 1s reason=visual_breath',
    `${CLEAN_SCRIPT}\n@silence 1s reason=visual_breath\n`,
    'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6',
  );
  expectCompileError(
    '[A4] 行内混入 speech @pause 300ms speech',
    `# Script V2\n\n${CHAPTER}\n\n你看到了。@pause 300ms 你没有回。\n`,
    'NARRATION_PLAN_INVALID',
  );
  expectCompileError(
    '[A5] 纯指令单元（整段只有 directive）',
    `# Script V2\n\n${CHAPTER}\n\n@silence 2s reason=visual_breath\n`,
    'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6',
  );
  expectCompileError(
    '[A6] 多指令混合独立行（@pause 1s @delivery normal）',
    `# Script V2\n\n${CHAPTER}\n\n@pause 1s @delivery normal\n你看到了。\n`,
    'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6',
  );
  expectCompileError(
    '[A7] 未知 @directive（@fadein 200ms）',
    `# Script V2\n\n${CHAPTER}\n\n@fadein 200ms\n你看到了。\n`,
    'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6',
  );
  expectCompileError(
    '[A8] 旧式未知括号指令（停顿0.5秒，放慢）混入 speech',
    `# Script V2\n\n${CHAPTER}\n\n（停顿0.5秒，放慢）你看到了。\n`,
    'NARRATION_PLAN_INVALID',
  );

  // A 级错误必须列出 raw token / unit
  try {
    compileNarrationPlan({
      scriptV2Markdown: `# Script V2\n\n${CHAPTER}\n\n@delivery soft\n@pause 400ms\n月底了。\n`,
      scriptV2Version: 1,
      promptVersion: 'script-v2@2.0',
    });
    ok(false, '[A9] DSL 错误列出 line/raw token');
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    ok(
      err instanceof NarrationCompileError &&
        err.code === 'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6' &&
        msg.includes('@delivery') && msg.includes('@pause') && msg.includes('L'),
      '[A9] DSL 错误列出 line/raw token',
      msg.slice(0, 160),
    );
  }

  // buildNarrationPlan 全路径：locked DSL script → NarrationPlanError 同码传播
  {
    const pid = newProject();
    lockScriptV2(pid, `# Script V2\n\n${CHAPTER}\n\n@delivery soft\n月底了。\n@pause 400ms\n你回了。\n`, 'script-v2@2.0');
    try {
      buildNarrationPlan(pid);
      ok(false, '[A10] buildNarrationPlan(locked DSL script) → SCRIPT_V2_DSL_UNSUPPORTED_IN_M6');
    } catch (err) {
      ok(
        err instanceof NarrationPlanError && err.code === 'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6',
        '[A10] buildNarrationPlan(locked DSL script) → SCRIPT_V2_DSL_UNSUPPORTED_IN_M6',
        err instanceof Error ? err.message.slice(0, 100) : err,
      );
    }
    const artifactCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?`).get(pid, NARRATION_PLAN_ARTIFACT_KIND) as {c: number}
    ).c;
    ok(artifactCount === 0, '[A11] fail-closed 零 artifact（不保存、不设 current）');
  }

  // ============ 5. 正常语义不误杀 ============
  {
    const plan = compileNarrationPlan({
      scriptV2Markdown: `# Script V2\n\n${CHAPTER}\n\n说到这里，他停顿了一下。沉默持续了一分钟。制造悬念不是靠指令。\n`,
      scriptV2Version: 1,
      promptVersion: 'script-v2@1.0',
    });
    const texts = plan.units.filter((u) => u.kind === 'speech').map((u) => u.text ?? '');
    ok(
      texts.some((t) => t.includes('他停顿了一下')) && texts.some((t) => t.includes('沉默持续了一分钟')),
      '[N1] 正常语义「停顿/沉默/悬念」不误杀',
      texts,
    );
  }

  // ============ 8. clean M6 narration 正常生成 + 入队 ============
  {
    const pid = newProject();
    lockScriptV2(pid, CLEAN_SCRIPT, 'script-v2@1.0');
    const {plan, artifact} = buildNarrationPlan(pid);
    ok(plan.units.length > 0 && artifact.version === 1, '[C1] clean M6 narration 正常生成');
    ok(
      plan.units.some((u) => u.kind === 'pause' && u.pauseMs === 1000) &&
        plan.units.some((u) => u.kind === 'visual_breath'),
      '[C2] 旧式（停顿 1s）/[画面留白] 仍正确编译为 pause/visual_breath unit',
    );
    const result = enqueueNarrationAudioJobs(pid);
    ok(result.enqueued === plan.units.filter((u) => u.kind === 'speech').length, '[C3] clean plan 全部 speech 入队', result);
  }

  // ============ 6. Gate B：污染 plan 整批拒绝（零 job） ============
  {
    const pid = newProject();
    lockScriptV2(pid, CLEAN_SCRIPT, 'script-v2@1.0');
    // 手工插入污染 artifact（模拟 c16513b 部署期间 M6 compiler 产生的脏数据；
    // 新 compiler 已拒绝生成此类 plan，只能直接 INSERT 构造历史形态）
    const contaminatedPlan = {
      schemaVersion: NARRATION_PLAN_SCHEMA_VERSION,
      compilerVersion: NARRATION_COMPILER_VERSION,
      source: {stage: 'script_v2', version: 1, promptVersion: 'script-v2@2.0'},
      chapters: [{chapter: 1, title: '开场', firstUnitId: 'N001', lastUnitId: 'N003'}],
      units: [
        {id: 'N001', chapter: 1, kind: 'speech', text: '@delivery soft 月底了。@pause 400ms 你有没有问过自己。', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'},
        {id: 'N002', chapter: 1, kind: 'speech', text: '这三块拼起来，就是你的财务地图。', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'},
        {id: 'N003', chapter: 1, kind: 'speech', text: '@silence 1s reason=visual_breath', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'},
      ],
    };
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, 1, ?, NULL, ?)`,
    ).run(crypto.randomUUID(), pid, NARRATION_PLAN_ARTIFACT_KIND, JSON.stringify(contaminatedPlan), new Date().toISOString());

    try {
      enqueueNarrationAudioJobs(pid);
      ok(false, '[B1] 污染 plan enqueue → NARRATION_PLAN_CONTAMINATED');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      ok(
        err instanceof NarrationAudioError &&
          err.code === 'NARRATION_PLAN_CONTAMINATED' &&
          msg.includes('N001') && msg.includes('N003') && msg.includes('@delivery'),
        '[B1] 污染 plan enqueue → NARRATION_PLAN_CONTAMINATED（列出全部污染 unit）',
        msg.slice(0, 200),
      );
    }
    const jobCount = (db.prepare(`SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?`).get(pid) as {c: number}).c;
    ok(jobCount === 0, '[B2] 整批拒绝：零 TTS job（不是跳过污染单元继续）');
  }

  // ============ 7. Gate C：历史污染 job 零 provider call ============
  {
    const pid = newProject();
    let synthesizeCalls = 0;
    const spyProvider: TtsProvider = {
      name: 'mock',
      async synthesize(): Promise<TtsResult> {
        synthesizeCalls++;
        throw new Error('不应到达 provider');
      },
    };
    const job = enqueueTtsJobTx(pid, 'mock', DEFAULT_VOICE_PROFILE.id, DEFAULT_VOICE_PROFILE.revision, {
      schemaVersion: '1.0',
      narrationPlanArtifactId: 'contaminated-plan',
      narrationPlanArtifactVersion: 1,
      scriptV2Version: 1,
      compilerVersion: '1.2',
      unitId: 'N001',
      unitText: '@delivery soft 月底了。@pause 400ms 你有没有问过自己。',
    });
    // 直接置 running（等价 scheduler claim 终态，避免 claim 到其他用例的 queued job）
    db.prepare(
      `UPDATE tts_jobs SET status = 'running', claimed_by = 'w-dsl-gate', claimed_at = ?, heartbeat_at = ?, attempt = 1
       WHERE id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), job.id);
    const runningJob = getTtsJob(job.id)!;
    ok(runningJob.status === 'running', '[W1] 污染 job 进入 running（拦截在执行器）');
    {
      await runTtsJob(runningJob, CTX, {providers: {mock: spyProvider}});
      const after = getTtsJob(job.id)!;
      ok(synthesizeCalls === 0, '[W2] worker 零 provider call', {synthesizeCalls});
      ok(
        after.status === 'failed' && after.error_code === 'PAYLOAD_CONTAMINATED',
        '[W3] 历史污染 job → terminal failed/PAYLOAD_CONTAMINATED',
        {status: after.status, error: after.error_code},
      );
      // terminal：不可重试消耗——status 不会回到 queued
      ok(after.status !== 'queued' && after.finished_at !== null, '[W4] terminal：不重试、不回到 queued');
    }
  }

  // Gate C 不误杀：clean payload 正常到达 provider（ffprobeImpl 注入避免依赖系统 ffprobe）
  {
    const pid = newProject();
    let synthesizeCalls = 0;
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40, 0)]);
    const cleanProvider: TtsProvider = {
      name: 'mock',
      async synthesize(req): Promise<TtsResult> {
        synthesizeCalls++;
        return {
          audio: wav,
          format: 'wav',
          provider: 'mock',
          model: 'mock-tts',
          settings: {
            voiceProfileId: req.voiceProfile.id,
            voiceProfileRevision: req.voiceProfile.revision,
            useRandom: false,
          },
        };
      },
    };
    const job = enqueueTtsJobTx(pid, 'mock', DEFAULT_VOICE_PROFILE.id, DEFAULT_VOICE_PROFILE.revision, {
      schemaVersion: '1.0',
      narrationPlanArtifactId: 'clean-plan',
      narrationPlanArtifactVersion: 1,
      scriptV2Version: 1,
      compilerVersion: '1.2',
      unitId: 'N001',
      unitText: '说到这里，他停顿了一下。',
    });
    db.prepare(
      `UPDATE tts_jobs SET status = 'running', claimed_by = 'w-dsl-gate', claimed_at = ?, heartbeat_at = ?, attempt = 1
       WHERE id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), job.id);
    {
      await runTtsJob(getTtsJob(job.id)!, CTX, {
        providers: {mock: cleanProvider},
        ffprobeImpl: () => ({durationMs: 800, codec: 'pcm_s16le', sampleRate: 48000, channels: 1}),
      });
      const after = getTtsJob(job.id)!;
      ok(synthesizeCalls === 1 && after.status === 'succeeded', '[W5] clean payload 正常合成（Gate C 不误杀）', {
        synthesizeCalls,
        status: after.status,
      });
    }
  }

  // ============ UX 闭环：blocked_contaminated overview ============
  {
    // clean plan → 正常 audio status（无 contamination）
    const pid = newProject();
    lockScriptV2(pid, CLEAN_SCRIPT, 'script-v2@1.0');
    buildNarrationPlan(pid);
    const clean = getNarrationAudioOverview(pid);
    ok(
      clean.status === 'missing' && clean.contamination === null && canRequestAudioGeneration(clean.status),
      '[U1] clean plan → 正常 audio status（missing，contamination=null，按钮可用）',
      {status: clean.status},
    );
  }
  {
    // contaminated plan（含历史 succeeded 污染 job）→ blocked_contaminated
    const pid = newProject();
    lockScriptV2(pid, CLEAN_SCRIPT, 'script-v2@1.0');
    const contaminatedPlan = {
      schemaVersion: NARRATION_PLAN_SCHEMA_VERSION,
      compilerVersion: NARRATION_COMPILER_VERSION,
      source: {stage: 'script_v2', version: 1, promptVersion: 'script-v2@2.0'},
      chapters: [{chapter: 1, title: '开场', firstUnitId: 'N001', lastUnitId: 'N003'}],
      units: [
        {id: 'N001', chapter: 1, kind: 'speech', text: '@delivery soft 月底了。@pause 400ms 你有没有问过自己。', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'},
        {id: 'N002', chapter: 1, kind: 'speech', text: '这三块拼起来，就是你的财务地图。', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'},
        {id: 'N003', chapter: 1, kind: 'speech', text: '@silence 1s reason=visual_breath', directive: null, pauseMs: null, evidenceIds: [], sourceText: 'x'},
      ],
    };
    const artifactId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, 1, ?, NULL, ?)`,
    ).run(artifactId, pid, NARRATION_PLAN_ARTIFACT_KIND, JSON.stringify(contaminatedPlan), new Date().toISOString());
    // 历史 succeeded 污染 job（模拟事故期 6 个已合成音频）
    const histJob = enqueueTtsJobTx(pid, 'mock', DEFAULT_VOICE_PROFILE.id, DEFAULT_VOICE_PROFILE.revision, {
      schemaVersion: '1.0',
      narrationPlanArtifactId: artifactId,
      narrationPlanArtifactVersion: 1,
      scriptV2Version: 1,
      compilerVersion: NARRATION_COMPILER_VERSION,
      unitId: 'N001',
      unitText: '@delivery soft 月底了。',
    });
    db.prepare(`UPDATE tts_jobs SET status = 'succeeded', duration_ms = 800, output_path = 'x.wav', finished_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), histJob.id);

    const overview = getNarrationAudioOverview(pid);
    ok(
      overview.status === 'blocked_contaminated',
      '[U2] 污染 plan（含历史 succeeded job）→ blocked_contaminated（历史成功不变 ready）',
      {status: overview.status, complete: overview.speechComplete},
    );
    ok(
      overview.contamination !== null &&
        overview.contamination.unitCount === 2 &&
        overview.contamination.units.map((u) => u.unitId).join(',') === 'N001,N003',
      '[U3] contamination 列出全部污染 unit（N001+N003，非部分）',
      overview.contamination?.units,
    );
    ok(
      overview.contamination !== null &&
        overview.contamination.units[0]!.summary.includes('@delivery') &&
        !overview.contamination.units[0]!.summary.includes('你有没有问过自己'),
      '[U4] API 只返回 token 摘要，不泄露完整正文',
      overview.contamination?.units[0],
    );
    ok(
      overview.contamination !== null &&
        overview.contamination.recoveryRequired === true &&
        overview.contamination.recoverySteps.length === CONTAMINATION_RECOVERY_STEPS.length,
      '[U5] recoveryRequired=true + 恢复步骤完整',
    );
    ok(
      !canRequestAudioGeneration(overview.status) && !canRequestAudioGeneration('ready') &&
        canRequestAudioGeneration('missing') && canRequestAudioGeneration('failed'),
      '[U6] UI 按钮判定：blocked/ready 禁用，missing/failed 可用（同一纯函数）',
    );
    // POST 仍 fail-closed：409 等价错误 + 零新增 job
    const jobsBefore = (db.prepare(`SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?`).get(pid) as {c: number}).c;
    try {
      enqueueNarrationAudioJobs(pid);
      ok(false, '[U7] blocked plan POST enqueue → NARRATION_PLAN_CONTAMINATED');
    } catch (err) {
      ok(
        err instanceof NarrationAudioError && err.code === 'NARRATION_PLAN_CONTAMINATED',
        '[U7] blocked plan POST enqueue → NARRATION_PLAN_CONTAMINATED（route 映射 409）',
      );
    }
    const jobsAfter = (db.prepare(`SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?`).get(pid) as {c: number}).c;
    ok(jobsAfter === jobsBefore, '[U8] POST 零新增 job', {before: jobsBefore, after: jobsAfter});
  }
  {
    // 正常语义 plan 的 overview 不被误判为污染
    const pid = newProject();
    lockScriptV2(pid, `# Script V2\n\n${CHAPTER}\n\n说到这里，他停顿了一下。沉默持续了一分钟。\n`, 'script-v2@1.0');
    const {plan} = buildNarrationPlan(pid);
    ok(detectPlanContamination(plan) === null, '[U9] 正常语义「他停顿了一下」overview 不误杀');
    ok(getNarrationAudioOverview(pid).status !== 'blocked_contaminated', '[U10] 正常 plan 不进入 blocked 状态');
  }

  // ============ 9. M7 compiler-v2 对合法 DSL 仍正确 ============
  {
    const planV2 = compileNarrationPlanV2({
      scriptV2Markdown: `# Script V2\n\n${CHAPTER}\n\n@delivery soft\n月底了。\n@pause 400ms\n你有没有问过自己？\n@silence 1s reason=visual_breath\n`,
      scriptV2VersionId: 'test-version',
      scriptV2Version: 1,
      scriptV2PromptVersion: 'script-v2@2.0',
      inputMode: 'strict',
    });
    const speech = planV2.units.filter((u) => u.kind === 'speech');
    const silence = planV2.units.filter((u) => u.kind === 'silence');
    ok(
      speech.length === 2 &&
        speech.every((u) => u.spokenText !== null && !u.spokenText.includes('@')) &&
        silence.length === 2,
      '[M7-1] compiler-v2 strict：合法 DSL → SpeechUnit×2 + SilenceUnit×2，spokenText 无指令',
      planV2.units.map((u) => (u.kind === 'speech' ? u.spokenText : `${u.kind}:${u.durationMs}`)),
    );
    ok(
      silence.some((u) => u.durationMs === 400) && silence.some((u) => u.durationMs === 1000),
      '[M7-2] @pause 400ms / @silence 1s 解析为精确时长（非口播）',
    );
  }

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.log('[test] M6 DSL 门禁测试存在失败 ❌');
    process.exit(1);
  }
  console.log('[test] M6 DSL 门禁测试全部通过 ✅');
}

main()
  .catch((err) => {
    console.error('[test] 未捕获异常：', err);
    process.exit(1);
  })
  .finally(() => {
    closeDb();
  });

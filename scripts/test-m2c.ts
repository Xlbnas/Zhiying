/**
 * M2-C project_definition 单阶段端到端自动化测试。
 *
 * 用法：npx tsx scripts/test-m2c.ts
 * 使用临时数据目录（data/test-m2c），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2c');
process.env.LLM_PROVIDER = 'mock';

import Database from 'better-sqlite3';
import {closeDb, getDb, getDbPath} from '../src/lib/db';
import {enqueueRenderJob} from '../src/lib/jobs';
import {
  cancelQueuedLlmJob,
  commitLlmJobResult,
  completeLlmJob,
  enqueueLlmJob,
  failLlmJob,
  getLlmJob,
  getVersionByJobId,
  LlmJobError,
  llmJobPayloadSchema,
  recoverStaleLlmJobs,
  requestCancelLlmJob,
  requeueLlmJob,
  type LlmJobRow,
} from '../src/lib/llm-jobs';
import {MockLLMProvider} from '../src/lib/llm/mock';
import {LLMError, type LLMProvider, type LLMRequest, type LLMResponse} from '../src/lib/llm/types';
import {getProjectInput} from '../src/lib/project-inputs';
import {
  createProjectWithWorkflow,
  getProjectRow,
  isLegacyM1Project,
} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';
import {runLlmJob, type LlmExecutorDeps} from '../src/worker/llm-executor';
import {editVersion} from '../src/lib/workflow/operations';
import {
  assertRerunAllowed,
  getStage,
  listStages,
  lockStage,
  WorkflowError,
} from '../src/lib/workflow/stages';
import {getVersion} from '../src/lib/workflow/versions';
import {WORKFLOW_STAGES} from '../src/lib/workflow/types';
import {POST as lockStagePOST} from '../src/app/api/workflow/lock-stage/route';
import {POST as runStagePOST} from '../src/app/api/workflow/run-stage/route';
import {POST as cancelJobPOST} from '../src/app/api/workflow/cancel-job/route';
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CTX = {isShuttingDown: () => false, log: () => {}};

function newProject(topic = '测试主题'): string {
  return createProjectWithWorkflow({topic, coreQuestion: '这是一个可研究的问题吗？'})
    .project.id;
}

function claimLlm(): {type: 'llm'; job: LlmJobRow} | null {
  const claimed = claimNextAnyJob('w-test');
  return claimed && claimed.type === 'llm' ? claimed : null;
}

function countRows(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as {c: number}).c;
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2c'), {recursive: true, force: true});
  const db = getDb();

  // ============ A. 项目创建原子性 ============
  {
    const before = countRows('SELECT COUNT(*) AS c FROM projects');
    const result = createProjectWithWorkflow({
      topic: '原子性测试',
      coreQuestion: '核心问题可研究吗？',
    });
    const pid = result.project.id;
    ok(getProjectRow(pid)?.title === '原子性测试', '[A] project 行创建（title=topic）');
    ok(getProjectInput(pid)?.topic === '原子性测试', '[A] project_inputs 行创建');
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_stages WHERE project_id = ?', pid) === 10 &&
        listStages(pid).every((s) => s.status === 'not_started'),
      '[A] 10 个 project_stages 初始化（全部 not_started）',
    );
    // 失败原子性：非法输入不得留下半成品
    let threw = false;
    try {
      createProjectWithWorkflow({topic: '', coreQuestion: 'x'});
    } catch {
      threw = true;
    }
    ok(threw, '[A] 非法输入（空 topic）被拒绝');
    ok(
      countRows('SELECT COUNT(*) AS c FROM projects') === before + 1 &&
        countRows('SELECT COUNT(*) AS c FROM project_inputs') === before + 1,
      '[A] 失败创建零副作用（无半成品）',
    );
  }

  // ============ B. Project Inputs 持久化 ============
  {
    const pid = newProject('输入持久化');
    const input = getProjectInput(pid);
    ok(
      input?.topic === '输入持久化' &&
        input.targetDuration === '10 分钟' &&
        input.language === '中文' &&
        input.scientificRigor === '高',
      '[B] zod 默认值在写入时固化',
    );
    const raw = db
      .prepare('SELECT config_json FROM project_inputs WHERE project_id = ?')
      .get(pid) as {config_json: string};
    ok(
      (JSON.parse(raw.config_json) as {topic?: string}).topic === '输入持久化',
      '[B] config_json 落库可重读',
    );
    db.prepare("UPDATE project_inputs SET config_json = 'not-json{{' WHERE project_id = ?").run(pid);
    let corruptThrew = false;
    try {
      getProjectInput(pid);
    } catch {
      corruptThrew = true;
    }
    ok(corruptThrew, '[B] 损坏的 config_json 读取时显式报错（不静默降级）');
  }

  // ============ C. Job enqueue 去重 ============
  {
    const pid = newProject();
    const promptInput = getProjectInput(pid)!;
    const job = enqueueLlmJob(pid, {schemaVersion: '1.0', stage: 'project_definition', promptInput});
    ok(job.status === 'queued' && job.stage === 'project_definition', '[C] project_definition 入队');
    const payload = llmJobPayloadSchema.parse(JSON.parse(job.payload_json));
    ok(
      payload.promptInput.topic === '测试主题' && payload.stage === 'project_definition',
      '[C] payload 为完整输入快照',
    );
    let dupThrew: string | null = null;
    try {
      enqueueLlmJob(pid, {schemaVersion: '1.0', stage: 'project_definition', promptInput});
    } catch (err) {
      dupThrew = err instanceof LlmJobError ? err.code : String(err);
    }
    ok(dupThrew === 'JOB_ALREADY_ACTIVE', '[C] duplicate queued 被拒绝（JOB_ALREADY_ACTIVE）');
    // 终态后可再次入队
    cancelQueuedLlmJob(job.id);
    const job2 = enqueueLlmJob(pid, {schemaVersion: '1.0', stage: 'project_definition', promptInput});
    ok(job2.status === 'queued' && job2.id !== job.id, '[C] 终态后允许再次入队');
    cancelQueuedLlmJob(job2.id);
  }

  // ============ D. Scheduler 双队列全局 FIFO ============
  {
    const pid = newProject();
    const renderJob = enqueueRenderJob(
      pid,
      'fullcut',
      zhiyingFullCutPropsSchema.parse({
        data: {project: {title: 't', durationSec: 1, durationInFrames: 30}, chapterTiming: [], scenes: []},
        audio: {narration: null},
      }),
    );
    const llmJob = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    // 控制 queued_at：render 早于 llm
    db.prepare("UPDATE render_jobs SET queued_at = '2026-01-01T00:00:01.000Z' WHERE id = ?").run(renderJob.id);
    db.prepare("UPDATE llm_jobs SET queued_at = '2026-01-01T00:00:02.000Z' WHERE id = ?").run(llmJob.id);
    const first = claimNextAnyJob('w-d');
    ok(first?.type === 'render' && first.job.id === renderJob.id, '[D] 全局 FIFO：早 queued_at 先 claim（render 先）');
    const second = claimNextAnyJob('w-d');
    ok(second?.type === 'llm' && second.job.id === llmJob.id, '[D] 一次只 claim 一个，次轮才取 llm');
    ok(claimNextAnyJob('w-d') === null, '[D] 队列空后返回 null');
    // 收尾已 claim 的任务，再做 tie-break 组
    db.prepare("UPDATE render_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
    db.prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
    // tie-break：queued_at 相同 → type + id 稳定序（llm < render）
    const r2 = enqueueRenderJob(
      pid,
      'fullcut',
      zhiyingFullCutPropsSchema.parse({
        data: {project: {title: 't', durationSec: 1, durationInFrames: 30}, chapterTiming: [], scenes: []},
        audio: {narration: null},
      }),
    );
    const l2 = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    db.prepare("UPDATE render_jobs SET queued_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(r2.id);
    db.prepare("UPDATE llm_jobs SET queued_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(l2.id);
    const tie = claimNextAnyJob('w-d');
    ok(tie?.type === 'llm', '[D] queued_at 相同：type+id 稳定 tie-break（确定性）', tie?.type);
    // 清理 D 的 running 任务
    db.prepare("UPDATE render_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
    db.prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
  }

  // ============ E. LLM Mock 闭环：queued → running → succeeded ============
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm();
    ok(claimed?.job.id === job.id && claimed.job.status === 'running', '[E] claim 后 running');
    await runLlmJob(claimed!.job, CTX);
    const after = getLlmJob(job.id)!;
    ok(after.status === 'succeeded', '[E] 任务 succeeded');
    const stage = getStage(pid, 'project_definition')!;
    ok(stage.status === 'generated' && stage.active_version === 1, '[E] status=generated，active_version=1');
    const version = getVersion(pid, 'project_definition', 1)!;
    ok(
      version.source === 'ai_generate' &&
        version.prompt_version === 'project-definition@1.0' &&
        version.model === 'deepseek-v4-flash' &&
        version.job_id === job.id &&
        version.content_type === 'markdown' &&
        version.content.length > 0,
      '[E] version 字段完整（source/prompt_version/model/job_id/content_type）',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM llm_usage WHERE job_id = ?', job.id) >= 1,
      '[E] usage 已记录',
    );

    // ============ F. Edit：generated → edited ============
    const edited = editVersion({
      projectId: pid,
      stage: 'project_definition',
      content: version.content + '\n\n人工补充：范围微调。',
      contentType: 'markdown',
      source: 'manual_edit',
    });
    ok(edited.version === 2, '[F] 编辑产生新版本 v2');
    const stageF = getStage(pid, 'project_definition')!;
    ok(stageF.status === 'edited' && stageF.active_version === 2, '[F] status=edited，active=2');

    // ============ G. Lock：edited → locked ============
    lockStage(pid, 'project_definition');
    const stageG = getStage(pid, 'project_definition')!;
    ok(stageG.status === 'locked' && stageG.locked_version === 2, '[G] locked，locked_version=2');

    // ============ H. Rerun 门控 ============
    let confirmThrew: string | null = null;
    try {
      assertRerunAllowed(pid, 'project_definition', {confirmStale: false});
    } catch (err) {
      confirmThrew = err instanceof WorkflowError ? err.code : String(err);
    }
    ok(confirmThrew === 'CONFIRM_STALE_REQUIRED', '[H] locked + confirmStale=false → 拒绝');
    let passed = true;
    try {
      assertRerunAllowed(pid, 'project_definition', {confirmStale: true});
    } catch {
      passed = false;
    }
    ok(passed, '[H] locked + confirmStale=true → 门控通过');
    const rerun = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    ok(rerun.status === 'queued', '[H] confirm 后可重新入队');
    const rerunClaim = claimLlm();
    await runLlmJob(rerunClaim!.job, CTX);
    const stageH = getStage(pid, 'project_definition')!;
    ok(
      stageH.status === 'generated' && stageH.active_version === 3 && stageH.locked_version === 2,
      '[H] 重生成产生 v3，status 回 generated，locked_version 保留',
    );
  }

  // ============ I. Retry：provider 错误 → queued 重试 → 上限 failed ============
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    const errorProvider = new MockLLMProvider({
      providerError: new LLMError('PROVIDER_HTTP_ERROR', '模拟 500', {status: 500}),
    });
    const deps: LlmExecutorDeps = {provider: errorProvider};
    const c1 = claimLlm()!;
    await runLlmJob(c1.job, CTX, deps);
    const afterFirst = getLlmJob(job.id)!;
    ok(
      afterFirst.status === 'queued' && afterFirst.attempt === 1 && afterFirst.error_code === 'PROVIDER_HTTP_ERROR',
      '[I] 第 1 次失败 → 回 queued（attempt=1）',
    );
    const c2 = claimLlm()!;
    await runLlmJob(c2.job, CTX, deps);
    const afterSecond = getLlmJob(job.id)!;
    ok(
      afterSecond.status === 'failed' && afterSecond.attempt === 2,
      '[I] 达 max_attempts → failed（不无限重试）',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === 0,
      '[I] 失败不产生版本',
    );
  }
  {
    // non-retryable：VALIDATION_FAILED 一次即 failed
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    const badProvider = new MockLLMProvider({
      providerError: new LLMError('VALIDATION_FAILED', '模拟校验失败'),
    });
    const c = claimLlm()!;
    await runLlmJob(c.job, CTX, {provider: badProvider});
    const after = getLlmJob(job.id)!;
    ok(after.status === 'failed' && after.attempt === 1, '[I] VALIDATION_FAILED → 直接 failed（不烧 token）');
  }

  // ============ J. Cancel：queued 与 running ============
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    ok(cancelQueuedLlmJob(job.id), '[J] queued 任务直接取消');
    ok(getLlmJob(job.id)!.status === 'cancelled', '[J] queued → cancelled');
    ok(claimNextAnyJob('w-j') === null, '[J] cancelled 不再被 claim');
  }
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    // 探针 Provider：记录 AbortSignal 是否真正触发
    class AbortProbe implements LLMProvider {
      readonly name = 'mock';
      aborted = false;
      generate(req: LLMRequest): Promise<LLMResponse> {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new LLMError('PROVIDER_TIMEOUT', '测试占位（不应到达）'));
          }, 500);
          req.signal?.addEventListener(
            'abort',
            () => {
              this.aborted = true;
              clearTimeout(timer);
              reject(new LLMError('CANCELLED', '请求已被用户取消'));
            },
            {once: true},
          );
        });
      }
    }
    const probe = new AbortProbe();
    const claimed = claimLlm()!;
    const running = runLlmJob(claimed.job, CTX, {provider: probe, heartbeatMs: 20});
    await sleep(60);
    requestCancelLlmJob(job.id);
    await running;
    ok(probe.aborted, '[J] running 取消：AbortSignal 真正触发 Provider 中止');
    ok(getLlmJob(job.id)!.status === 'cancelled', '[J] running → cancelled（非 failed）');
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === 0,
      '[J] 取消不产生 project_version',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM llm_usage WHERE job_id = ?', job.id) === 0,
      '[J] 取消的请求无 Response → 无 usage',
    );
  }

  // ============ K. Heartbeat：长请求期间持续推进 ============
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm()!;
    const atClaim = getLlmJob(job.id)!.heartbeat_at!;
    const running = runLlmJob(
      claimed.job,
      CTX,
      {provider: new MockLLMProvider({delayMs: 180}), heartbeatMs: 30},
    );
    await sleep(80);
    const mid = getLlmJob(job.id)!.heartbeat_at!;
    await sleep(80);
    const later = getLlmJob(job.id)!.heartbeat_at!;
    await running;
    ok(mid > atClaim && later >= mid, '[K] 长 Mock 请求期间 heartbeat_at 持续推进', {
      atClaim, mid, later,
    });
    ok(getLlmJob(job.id)!.status === 'succeeded', '[K] 心跳不干扰正常完成');
  }

  // ============ L. Stale Recovery ============
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    db.prepare(
      "UPDATE llm_jobs SET heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(job.id);
    const recovered = recoverStaleLlmJobs(60_000);
    ok(recovered.requeued === 1 && recovered.cancelled === 0, '[L] stale running 任务被回收（1 个）');
    const after = getLlmJob(job.id)!;
    ok(
      after.status === 'queued' && after.attempt === 1 && after.claimed_by === null,
      '[L] 回收后回 queued，attempt 保留',
    );
    cancelQueuedLlmJob(job.id);
  }

  // ============ M. Crash Idempotency ============
  {
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0',
      stage: 'project_definition',
      promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm()!;
    await runLlmJob(claimed.job, CTX);
    ok(getVersionByJobId(job.id) !== undefined, '[M] 首次执行版本落库');
    // 模拟 crash 窗口：版本已在，job 被 stale recovery 回 queued 后再次执行
    db.prepare(
      "UPDATE llm_jobs SET status = 'running', finished_at = NULL WHERE id = ?",
    ).run(job.id);
    let providerCalls = 0;
    class CountProbe extends MockLLMProvider {
      override async generate(req: LLMRequest): Promise<LLMResponse> {
        providerCalls++;
        return super.generate(req);
      }
    }
    const before = countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid);
    await runLlmJob(getLlmJob(job.id)!, CTX, {provider: new CountProbe()});
    ok(providerCalls === 0, '[M] 版本已存在 → 不再调用 Provider', providerCalls);
    ok(getLlmJob(job.id)!.status === 'succeeded', '[M] 直接 complete job');
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === before,
      '[M] 不产生重复版本/重复费用',
    );
  }

  // ============ N. Legacy M1 ============
  {
    const legacyId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id,
         current_stage, created_at, updated_at)
       VALUES (?, '旧导入项目', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    ).run(legacyId, at, at);
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, created_at)
       VALUES (?, ?, 'scenes', 1, '{}', ?)`,
    ).run(crypto.randomUUID(), legacyId, at);
    ok(isLegacyM1Project(legacyId), '[N] 无 stages 项目识别为 legacy');
    ok(!isLegacyM1Project(newProject()), '[N] M2 项目非 legacy');
    // 读取操作不触发自动初始化
    void listStages(legacyId);
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_stages WHERE project_id = ?', legacyId) === 0,
      '[N] legacy 项目不被自动伪造 Workflow 历史',
    );
  }

  // ============ O. API 边界（直接调用 Route Handler） ============
  {
    const pid = newProject();
    // run-stage 后四阶段已开放（M2-E-B），但前序未锁 → 409 UPSTREAM_NOT_LOCKED
    const res1 = await runStagePOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({projectId: pid, stage: 'narration_beat_map'}),
      }),
    );
    const json1 = (await res1.json()) as {error?: string};
    ok(res1.status === 409 && json1.error === 'UPSTREAM_NOT_LOCKED', '[O] run-stage narration_beat_map（已开放，前序未锁）→ 409 UPSTREAM_NOT_LOCKED');
    // run-stage 上游未锁（M2-D 已开放 research，但 pd 未 locked）→ 409 UPSTREAM_NOT_LOCKED
    const res1b = await runStagePOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({projectId: pid, stage: 'research'}),
      }),
    );
    const json1b = (await res1b.json()) as {error?: string};
    ok(res1b.status === 409 && json1b.error === 'UPSTREAM_NOT_LOCKED', '[O] run-stage research（pd 未锁）→ 409 UPSTREAM_NOT_LOCKED');
    // run-stage project_definition → 202
    const res2 = await runStagePOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({projectId: pid, stage: 'project_definition'}),
      }),
    );
    const json2 = (await res2.json()) as {job?: {id: string; status: string}};
    ok(res2.status === 202 && json2.job?.status === 'queued', '[O] run-stage pd → 202 queued');
    // 重复 run → 409 JOB_ALREADY_ACTIVE
    const res3 = await runStagePOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({projectId: pid, stage: 'project_definition'}),
      }),
    );
    const json3 = (await res3.json()) as {error?: string};
    ok(res3.status === 409 && json3.error === 'JOB_ALREADY_ACTIVE', '[O] 重复 run → 409 JOB_ALREADY_ACTIVE');
    // 有活跃任务时 PATCH → 409
    const res4 = await stagePATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({content: '人工编辑内容'}),
      }),
      {params: Promise.resolve({id: pid, stage: 'project_definition'})},
    );
    const json4 = (await res4.json()) as {error?: string};
    ok(res4.status === 409 && json4.error === 'JOB_ALREADY_ACTIVE', '[O] 活跃任务中编辑 → 409 JOB_ALREADY_ACTIVE');
    // cancel-job（queued）→ 200 cancelled
    const jobId = json2.job!.id;
    const res5 = await cancelJobPOST(
      new Request('http://test', {method: 'POST', body: JSON.stringify({jobId})}),
    );
    const json5 = (await res5.json()) as {job?: {status: string}};
    ok(res5.status === 200 && json5.job?.status === 'cancelled', '[O] cancel queued job → cancelled');
    // 取消后 PATCH（not_started 无版本）→ 409 NO_ACTIVE_VERSION
    const res6 = await stagePATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({content: '人工编辑内容'}),
      }),
      {params: Promise.resolve({id: pid, stage: 'project_definition'})},
    );
    const json6 = (await res6.json()) as {error?: string};
    ok(res6.status === 409 && json6.error === 'NO_ACTIVE_VERSION', '[O] 未生成阶段编辑 → 409 NO_ACTIVE_VERSION');
    // lock-stage（not_started）→ 409
    const res7 = await lockStagePOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({projectId: pid, stage: 'project_definition'}),
      }),
    );
    ok(res7.status === 409, '[O] 未生成阶段锁定 → 409');
    // PATCH 后四阶段已开放（M2-E-B）；not_started 阶段编辑 → 409 NO_ACTIVE_VERSION
    const res8 = await stagePATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({content: 'x'}),
      }),
      {params: Promise.resolve({id: pid, stage: 'narration_beat_map'})},
    );
    const json8 = (await res8.json()) as {error?: string};
    ok(res8.status === 409 && json8.error === 'NO_ACTIVE_VERSION', '[O] PATCH narration_beat_map（已开放，未生成）→ 409 NO_ACTIVE_VERSION');
    // legacy 项目 run-stage → 404 STAGE_NOT_FOUND
    const legacyId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id,
         current_stage, created_at, updated_at)
       VALUES (?, 'legacy', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    ).run(legacyId, at, at);
    const res9 = await runStagePOST(
      new Request('http://test', {
        method: 'POST',
        body: JSON.stringify({projectId: legacyId, stage: 'project_definition'}),
      }),
    );
    ok(res9.status === 404, '[O] legacy 项目 run-stage → 404（无工作流）');
  }

  // ============ P. Hardening：shutdown abort / late cancel fence / 终态保护 ============
  {
    // P1：shutdown 真正 abort LLM（render 与 llm 共用统一取消句柄）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm()!;
    class ShutdownProbe implements LLMProvider {
      readonly name = 'mock';
      aborted = false;
      generate(req: LLMRequest): Promise<LLMResponse> {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new LLMError('PROVIDER_TIMEOUT', '占位（不应到达）'));
          }, 500);
          req.signal?.addEventListener('abort', () => {
            this.aborted = true;
            clearTimeout(timer);
            reject(new LLMError('CANCELLED', '请求已被取消'));
          }, {once: true});
        });
      }
    }
    const probe = new ShutdownProbe();
    let shuttingDown = false;
    const workerController = new AbortController();
    const running = runLlmJob(claimed.job, {
      isShuttingDown: () => shuttingDown,
      log: () => {},
      shutdownSignal: workerController.signal,
    }, {provider: probe});
    await sleep(60);
    shuttingDown = true;
    workerController.abort(); // 模拟 Worker 收到 SIGTERM
    await running;
    const after = getLlmJob(job.id)!;
    ok(probe.aborted, '[P1] shutdown → Provider 被真正 abort');
    ok(after.status === 'queued', '[P1] shutdown → requeue（回 queued，非 cancelled/failed）', after.status);
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === 0,
      '[P1] shutdown 不创建 project_version',
    );
    cancelQueuedLlmJob(job.id);
  }
  {
    // P2：late cancel fence——Provider 已完成后、generateVersion 前 cancel 才到达
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm()!;
    const before = countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid);
    // heartbeatMs 足够大，确保取消轮询 timer 不在测试窗口内触发（Provider 正常完成），
    // 隔离验证 Commit Fence 本身。
    const running = runLlmJob(
      claimed.job,
      {isShuttingDown: () => false, log: () => {}},
      {provider: new MockLLMProvider(), heartbeatMs: 100_000},
    );
    // runLlmJob 同步前导（start 检查/payload/provider）已过、Provider 微任务尚未完成时
    // 写入 cancel 标记 —— 确定性落在「Provider 已返回附近」的窗口。
    requestCancelLlmJob(job.id);
    await running;
    const after = getLlmJob(job.id)!;
    ok(after.status === 'cancelled', '[P2] late cancel → cancelled（fence 拦截）', after.status);
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === before,
      '[P2] cancel_requested=true 时不进入 generateVersion（版本数不增加）',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM llm_usage WHERE job_id = ?', job.id) === 1,
      '[P2] 已产生的 llm_usage 保留（API 费用已发生）',
    );
  }
  {
    // P3：fence shutdown 分支——Provider 完成时 shutdown 已置位 → requeue 不提交
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm()!;
    let shuttingDown = false;
    const running = runLlmJob(
      claimed.job,
      {isShuttingDown: () => shuttingDown, log: () => {}},
      {provider: new MockLLMProvider(), heartbeatMs: 100_000},
    );
    shuttingDown = true; // Provider 微任务完成前同步置位
    await running;
    const after = getLlmJob(job.id)!;
    ok(after.status === 'queued', '[P3] fence 检测 shutdown → requeue（非 cancelled）', after.status);
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === 0,
      '[P3] fence shutdown 分支不创建 project_version',
    );
    cancelQueuedLlmJob(job.id);
  }
  {
    // P4：normal success（无 cancel/shutdown，fence 正常放行）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    const claimed = claimLlm()!;
    await runLlmJob(
      claimed.job,
      {isShuttingDown: () => false, log: () => {}},
      {provider: new MockLLMProvider()},
    );
    ok(getLlmJob(job.id)!.status === 'succeeded', '[P4] 无取消/退出 → succeeded');
    ok(
      getStage(pid, 'project_definition')!.status === 'generated' &&
        countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', pid) === 1,
      '[P4] fence 放行：version 创建 + status=generated',
    );
  }
  {
    // P5：终态保护——cancelled/failed 不得被迟到的 complete 覆盖
    const pid = newProject();
    const j1 = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    db.prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE id = ?").run(j1.id);
    ok(completeLlmJob(j1.id) === false, '[P5] cancelled 任务 complete 被拒绝（changes=0）');
    ok(getLlmJob(j1.id)!.status === 'cancelled', '[P5] cancelled 不被覆盖为 succeeded');
    const j2 = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    db.prepare("UPDATE llm_jobs SET status = 'failed' WHERE id = ?").run(j2.id);
    ok(completeLlmJob(j2.id) === false && getLlmJob(j2.id)!.status === 'failed', '[P5] failed 不被覆盖为 succeeded');
  }

  // ============ Q. Commit Atomicity：双连接跨进程竞态 ============
  // Connection A = Worker（getDb 单例）；Connection B = Next.js Cancel API（独立连接）
  const dbB = new Database(getDbPath());
  dbB.pragma('journal_mode = WAL');
  dbB.pragma('busy_timeout = 5000');
  {
    // Q1：Cancel wins——B 先提交 cancel_requested=1，A 的 commit 被拒绝、不建版本
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    dbB.transaction(() => {
      dbB.prepare(
        `UPDATE llm_jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`,
      ).run(job.id);
    }).immediate();
    const result = commitLlmJobResult({
      jobId: job.id, projectId: pid, stage: 'project_definition',
      content: '# 内容', contentType: 'markdown', source: 'ai_generate',
      promptVersion: 'project-definition@1.0', model: 'deepseek-v4-flash',
    });
    ok(result.code === 'CANCELLED', '[Q1] Cancel wins：commit 返回 CANCELLED', result.code);
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE job_id = ?', job.id) === 0,
      '[Q1] Cancel wins：不创建 project_version',
    );
    ok(
      getLlmJob(job.id)!.status === 'cancelled',
      '[Q1] Cancel wins：事务返回时 DB 已是 cancelled（无需额外 mark）',
    );
  }
  {
    // Q2：Worker wins——A 先原子提交，B 的 cancel 匹配 0 行、终态不变
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    const result = commitLlmJobResult({
      jobId: job.id, projectId: pid, stage: 'project_definition',
      content: '# 内容', contentType: 'markdown', source: 'ai_generate',
      promptVersion: 'project-definition@1.0', model: 'deepseek-v4-flash',
    });
    ok(result.code === 'COMMITTED', '[Q2] Worker 原子提交 COMMITTED', result.code);
    const cancelChanges = dbB.transaction(() => {
      return dbB.prepare(
        `UPDATE llm_jobs SET cancel_requested = 1 WHERE id = ? AND status IN ('queued', 'running')`,
      ).run(job.id).changes;
    }).immediate();
    ok(cancelChanges === 0, '[Q2] Worker wins：succeeded 后 cancel UPDATE 匹配 0 行');
    const after = getLlmJob(job.id)!;
    ok(
      after.status === 'succeeded' && after.cancel_requested === 0,
      '[Q2] Worker wins：终态 succeeded 不被 cancel 改变',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE job_id = ?', job.id) === 1,
      '[Q2] Worker wins：version 恰好 1 条',
    );
    ok(getStage(pid, 'project_definition')!.status === 'generated', '[Q2] Worker wins：stage generated');
  }
  {
    // Q3：原子 rollback——workflow 变更在事务中途抛错，job 侧零副作用
    const bareId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id,
         current_stage, created_at, updated_at)
       VALUES (?, '无 stages 项目', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    ).run(bareId, at, at);
    const bareJobId = crypto.randomUUID();
    const barePayload = JSON.stringify({
      schemaVersion: '2.0',
      stage: 'project_definition',
      promptInput: {topic: 't', coreQuestion: 'q'},
      upstreamVersions: {},
    });
    db.prepare(
      `INSERT INTO llm_jobs (id, project_id, stage, status, payload_json, queued_at, started_at, attempt)
       VALUES (?, ?, 'project_definition', 'running', ?, ?, ?, 1)`,
    ).run(bareJobId, bareId, barePayload, at, at);
    let threw: string | null = null;
    try {
      commitLlmJobResult({
        jobId: bareJobId, projectId: bareId, stage: 'project_definition',
        content: '# 内容', contentType: 'markdown', source: 'ai_generate',
      });
    } catch (err) {
      threw = err instanceof WorkflowError ? err.code : String(err);
    }
    ok(threw === 'STAGE_NOT_FOUND', '[Q3] workflow 变更中途抛错（STAGE_NOT_FOUND）', threw);
    const bareAfter = getLlmJob(bareJobId)!;
    ok(bareAfter.status === 'running', '[Q3] rollback：job 仍 running（未 succeeded）');
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ?', bareId) === 0 &&
        countRows('SELECT COUNT(*) AS c FROM project_stages WHERE project_id = ?', bareId) === 0,
      '[Q3] rollback：version / stage 零变化（无部分提交）',
    );
    db.prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE id = ?").run(bareJobId);
  }
  {
    // Q4：success consistency——提交后四者一致
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    const result = commitLlmJobResult({
      jobId: job.id, projectId: pid, stage: 'project_definition',
      content: '# 一致性', contentType: 'markdown', source: 'ai_generate',
      promptVersion: 'project-definition@1.0', model: 'deepseek-v4-flash',
    });
    const stage = getStage(pid, 'project_definition')!;
    const finalJob = getLlmJob(job.id)!;
    const committedVersion = result.code === 'COMMITTED' ? result.version : null;
    ok(
      result.code === 'COMMITTED' &&
        committedVersion !== null &&
        committedVersion.job_id === job.id &&
        stage.active_version === committedVersion.version &&
        stage.status === 'generated' &&
        finalJob.status === 'succeeded',
      '[Q4] version.job_id / active_version / stage.status / job.status 四者一致',
    );
    // getVersionByJobId 防御性保留（历史兼容/异常 recovery）
    ok(
      committedVersion !== null && getVersionByJobId(job.id)?.id === committedVersion.id,
      '[Q4] getVersionByJobId 防御性 helper 保留可用',
    );
  }
  dbB.close();

  // ============ R. Cancellation Durability（cancel once accepted → never resurrect） ============
  const dbB2 = new Database(getDbPath());
  dbB2.pragma('journal_mode = WAL');
  dbB2.pragma('busy_timeout = 5000');
  const staleHeartbeat = (jobId: string): void => {
    db.prepare("UPDATE llm_jobs SET heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(jobId);
  };
  {
    // R1：commit cancel 原子终结
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    requestCancelLlmJob(job.id);
    const result = commitLlmJobResult({
      jobId: job.id, projectId: pid, stage: 'project_definition',
      content: '# x', contentType: 'markdown', source: 'ai_generate',
    });
    const after = getLlmJob(job.id)!;
    ok(
      result.code === 'CANCELLED' && after.status === 'cancelled' && after.finished_at !== null,
      '[R1] commit 返回 CANCELLED 时 DB 已是 cancelled 终态',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE job_id = ?', job.id) === 0,
      '[R1] cancel 原子终结不建版本',
    );

    // R2：crash-after-cancel-decision 模拟——之后什么都不做，recovery 也不复活
    const rec = recoverStaleLlmJobs(0);
    ok(
      rec.requeued === 0 && rec.cancelled === 0 && getLlmJob(job.id)!.status === 'cancelled',
      '[R2] 已 cancelled 任务不被 recovery 复活（0 requeue）',
    );
  }
  {
    // R3：stale + cancel 意图 → cancelled（不清零、不复活）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    requestCancelLlmJob(job.id);
    staleHeartbeat(job.id);
    const rec = recoverStaleLlmJobs(60_000);
    const after = getLlmJob(job.id)!;
    ok(
      rec.cancelled === 1 && rec.requeued === 0 &&
        after.status === 'cancelled' && after.cancel_requested === 1,
      '[R3] stale + cancel_requested=1 → cancelled（意图保留）',
    );
  }
  {
    // R4：普通 stale → queued（原语义）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    staleHeartbeat(job.id);
    const rec = recoverStaleLlmJobs(60_000);
    ok(
      rec.requeued === 1 && rec.cancelled === 0 && getLlmJob(job.id)!.status === 'queued',
      '[R4] stale + cancel_requested=0 → queued',
    );
    cancelQueuedLlmJob(job.id);
  }
  {
    // R5：retryable failure 遇上 cancel → cancelled（不回 queued）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    requestCancelLlmJob(job.id);
    const outcome = failLlmJob(job.id, 'PROVIDER_HTTP_ERROR', '模拟失败', {retryable: true});
    const after = getLlmJob(job.id)!;
    ok(
      outcome === 'CANCELLED' && after.status === 'cancelled' && after.cancel_requested === 1,
      '[R5] retryable fail + cancel_requested=1 → cancelled（不复活）',
    );
  }
  {
    // R6：普通 retryable failure → queued
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    const outcome = failLlmJob(job.id, 'PROVIDER_HTTP_ERROR', '模拟失败', {retryable: true});
    ok(
      outcome === 'REQUEUED' && getLlmJob(job.id)!.status === 'queued',
      '[R6] retryable fail + 无 cancel → queued',
    );
    cancelQueuedLlmJob(job.id);
  }
  {
    // R7：shutdown requeue 遇上 cancel → cancelled（取消优先）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    requestCancelLlmJob(job.id);
    const outcome = requeueLlmJob(job.id);
    ok(
      outcome === 'CANCELLED' && getLlmJob(job.id)!.status === 'cancelled',
      '[R7] shutdown requeue + cancel_requested=1 → cancelled（取消优先）',
    );
  }
  {
    // R8：普通 shutdown requeue → queued
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    const outcome = requeueLlmJob(job.id);
    ok(
      outcome === 'REQUEUED' && getLlmJob(job.id)!.status === 'queued',
      '[R8] shutdown requeue + 无 cancel → queued',
    );
    cancelQueuedLlmJob(job.id);
  }
  {
    // R9：Worker wins——A 先原子提交，B 的 cancel 写入失败（API 409）
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    const committed = commitLlmJobResult({
      jobId: job.id, projectId: pid, stage: 'project_definition',
      content: '# x', contentType: 'markdown', source: 'ai_generate',
    });
    ok(committed.code === 'COMMITTED', '[R9] 前置：Worker 原子提交成功');
    const accepted = dbB2
      .prepare(`UPDATE llm_jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`)
      .run(job.id).changes;
    ok(accepted === 0 && getLlmJob(job.id)!.status === 'succeeded', '[R9] succeeded 后 cancel 写入 0 行，终态不变');
    const res = await cancelJobPOST(
      new Request('http://test', {method: 'POST', body: JSON.stringify({jobId: job.id})}),
    );
    const json = (await res.json()) as {error?: string};
    ok(res.status === 409 && json.error === 'JOB_NOT_ACTIVE', '[R9] Cancel API 对已 succeeded 返回 409 JOB_NOT_ACTIVE');
  }
  {
    // R10：Cancel wins（双连接）——B 先 cancel，A commit → cancelled 无版本
    const pid = newProject();
    const job = enqueueLlmJob(pid, {
      schemaVersion: '1.0', stage: 'project_definition', promptInput: getProjectInput(pid)!,
    });
    claimLlm();
    dbB2.transaction(() => {
      dbB2.prepare(
        `UPDATE llm_jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`,
      ).run(job.id);
    }).immediate();
    const result = commitLlmJobResult({
      jobId: job.id, projectId: pid, stage: 'project_definition',
      content: '# x', contentType: 'markdown', source: 'ai_generate',
    });
    ok(
      result.code === 'CANCELLED' && getLlmJob(job.id)!.status === 'cancelled' &&
        countRows('SELECT COUNT(*) AS c FROM project_versions WHERE job_id = ?', job.id) === 0,
      '[R10] B 先 cancel → A commit 原子终结 cancelled，无版本',
    );
  }
  dbB2.close();

  // 全局一致性：10 阶段枚举未被意外改动
  ok(WORKFLOW_STAGES.length === 10 && WORKFLOW_STAGES[0] === 'project_definition', '[Z] 10 阶段枚举完整');

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2c'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M2-C 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M2-C 单阶段闭环测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

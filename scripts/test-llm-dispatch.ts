/**
 * Worker-side LLM Dispatch 测试（临时 DB + Scriptable Mock Provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-llm-dispatch.ts
 * 覆盖：
 * - Web 无 LLM key（模拟 production：任何 getProvider 必然 CONFIG_ERROR）仍能 202 enqueue；
 * - worker executor 执行 dispatch → provider calls=1 → run=1 → artifact=1 → usage=真实 attempts；
 * - 同 requestId 双击/双 POST 只产生一个 dispatch；
 * - 已有 artifact requestId → 200 reused（零 dispatch、零 provider）；
 * - failed run 终态 → POST 409 同终态；indeterminate 同；
 * - run running（租约有效）→ POST 202 running；executor in_progress → 信封 requeue；
 * - dispatch crash 恢复（lease 过期 + run running → requeue；无 run → failed WORKER_CRASH）；
 * - Narrative Beats 与 Visual Intent 两种 stage 全链路走通；GET dispatchJobs 状态面。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-llm-dispatch');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {resetProviderForTest} from '../src/lib/llm';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2, getNarrationPlanV2Artifact} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {buildNarrativeBeats} from '../src/lib/narrative-beats/plan';
import {NARRATIVE_BEATS_KIND, type NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {BEATS_USAGE_STAGE} from '../src/lib/narrative-beats/generate';
import {VISUAL_INTENT_USAGE_STAGE} from '../src/lib/visual-intent/generate';
import {VISUAL_INTENT_KIND, type VisualIntentV1} from '../src/lib/visual-intent/schema';
import {
  claimGenerationRun,
  findGenerationRun,
  type GenerationRunRow,
} from '../src/lib/llm-generation/runs';
import {
  enqueueGenerationDispatch,
  getDispatchJob,
  listDispatchJobs,
  recoverStaleDispatchJobs,
} from '../src/lib/llm-generation/dispatch';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runDispatchJob} from '../src/worker/dispatch-executor';
import {GET as beatsGET, POST as beatsPOST} from '../src/app/api/projects/[id]/narrative-beats/route';
import {GET as visualGET, POST as visualPOST} from '../src/app/api/projects/[id]/visual-intents/route';

// 上次中断运行可能留下临时 DB（claimNextAnyJob 全局 FIFO 会捡到旧 dispatch）——
// 启动即清空（getDb 为惰性单例，此处尚未打开）。
fs.rmSync(path.resolve(process.cwd(), 'data', 'test-llm-dispatch'), {recursive: true, force: true});

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

// ── Scriptable Mock Provider（确定性故障注入） ──
class ScriptableProvider implements LLMProvider {
  readonly name = 'scriptable-mock';
  readonly requests: LLMRequest[] = [];
  private queue: Array<{text?: string}> = [];

  push(resp: {text?: string}): void {
    this.queue.push(resp);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error('scriptable provider: 无预置响应'));
    return Promise.resolve({
      text: next.text ?? '',
      requestId: `scr-${this.requests.length}`,
      model: request.model,
      finishReason: 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
  }
}

const UPSTREAM: WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
];

/** strict DSL：2 章、6 units（4 speech + 2 silence，含 pause 与 visual_breath）。 */
const STRICT_MD = `# Script V2

## 第 1 章 开场（00:00–01:00）

第一句。第二句。

@silence 500ms reason=pause

第三句。

## 第 2 章 展开（01:00–02:00）

第四句。第五句。

@silence 800ms reason=visual_breath

第六句。
`;

function newProjectWithScript(content: string, promptVersion: string): string {
  const projectId = createProjectWithWorkflow({topic: 'dispatch', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({
    projectId,
    stage: 'script_v2',
    content,
    contentType: 'markdown',
    source: 'manual_edit',
    promptVersion,
  });
  lockStage(projectId, 'script_v2');
  return projectId;
}

/** 每个 unit 独立成 beat 的合法基线：speech→explanation，silence→pause。 */
function makeValidBeats(plan: NarrationPlanV2): NarrativeBeatV1[] {
  return plan.units.map((unit, index) => ({
    beatId: `B${String(index + 1).padStart(3, '0')}`,
    chapter: unit.chapter,
    unitIds: [unit.id],
    role: unit.kind === 'silence' ? 'pause' : 'explanation',
    summary: `节拍 ${index + 1} 的编辑备注。`,
    payoff: null,
  }));
}

/** 每个 beat 独立成 intent 的合法基线（与 test-m73a fixture 同构，1.1 validator 通过）。 */
function makeValidIntents(plan: NarrationPlanV2): VisualIntentV1[] {
  const n4 = plan.units[3]!;
  if (n4.kind !== 'speech') throw new Error('fixture: N004 必须是 speech');
  return [
    {
      visualIntentId: 'V001',
      chapter: 1,
      beatIds: ['B001'],
      intent: 'SHOW_PERSON',
      strategy: 'portrait',
      authenticity: 'authentic_required',
      objective: '展示讲述者形象。',
      subject: {kind: 'person', label: '讲述者', evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: null,
    },
    {
      visualIntentId: 'V002',
      chapter: 1,
      beatIds: ['B002'],
      intent: 'CONTINUE_PREVIOUS_VISUAL',
      strategy: 'continue_previous',
      authenticity: 'inherited',
      objective: '停顿期间保持人物画面。',
      subject: {kind: 'none', label: null, evidenceIds: []},
      continuationOfVisualIntentId: 'V001',
      displayText: null,
    },
    {
      visualIntentId: 'V003',
      chapter: 1,
      beatIds: ['B003'],
      intent: 'SHOW_PLACE',
      strategy: 'archive_photo',
      authenticity: 'authentic_required',
      objective: '展示事发地点旧照。',
      subject: {kind: 'place', label: '旧城区', evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: null,
    },
    {
      visualIntentId: 'V004',
      chapter: 2,
      beatIds: ['B004'],
      intent: 'EMPHASIZE_TEXT',
      strategy: 'title_card',
      authenticity: 'not_applicable',
      objective: '关键句上屏强调。',
      subject: {kind: 'text', label: null, evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: n4.spokenText},
    },
    {
      visualIntentId: 'V005',
      chapter: 2,
      beatIds: ['B005'],
      intent: 'SHOW_DATA',
      strategy: 'mg_data',
      authenticity: 'synthetic_allowed',
      objective: '用数据图说明规模。',
      subject: {kind: 'data', label: '规模对比', evidenceIds: []},
      continuationOfVisualIntentId: null,
      displayText: null,
    },
    {
      visualIntentId: 'V006',
      chapter: 2,
      beatIds: ['B006'],
      intent: 'NO_VISUAL_CHANGE',
      strategy: 'hold',
      authenticity: 'inherited',
      objective: '保持数据图到结束。',
      subject: {kind: 'none', label: null, evidenceIds: []},
      continuationOfVisualIntentId: 'V005',
      displayText: null,
    },
  ];
}

// ── probes ──

function runRow(projectId: string, stage: string, requestId: string): GenerationRunRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM generation_runs WHERE project_id = ? AND stage = ? AND request_id = ?`)
    .get(projectId, stage, requestId) as GenerationRunRow | undefined;
}

function runCount(projectId: string, stage: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM generation_runs WHERE project_id = ? AND stage = ?`)
    .get(projectId, stage) as {c: number};
  return row.c;
}

function artifactCount(projectId: string, kind: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?`)
    .get(projectId, kind) as {c: number};
  return row.c;
}

function usageCount(projectId: string, stage: string, requestId?: string): number {
  const row = (
    requestId === undefined
      ? getDb().prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = ?`).get(projectId, stage)
      : getDb()
          .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = ? AND job_id = ?`)
          .get(projectId, stage, requestId)
  ) as {c: number};
  return row.c;
}

function attemptCount(runId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM generation_attempts WHERE run_id = ?`)
    .get(runId) as {c: number};
  return row.c;
}

function dispatchCount(projectId: string, requestId?: string): number {
  const row = (
    requestId === undefined
      ? getDb().prepare(`SELECT COUNT(*) AS c FROM generation_dispatch_jobs WHERE project_id = ?`).get(projectId)
      : getDb()
          .prepare(`SELECT COUNT(*) AS c FROM generation_dispatch_jobs WHERE project_id = ? AND request_id = ?`)
          .get(projectId, requestId)
  ) as {c: number};
  return row.c;
}

/** Worker 主循环一步：claim 全局下一个 job（应为 dispatch）并以注入 provider 执行。 */
async function runNextDispatch(provider: LLMProvider): Promise<void> {
  const claimed = claimNextAnyJob('worker-test-dispatch');
  if (!claimed || claimed.type !== 'dispatch') {
    throw new Error(`expected queued dispatch job, got ${claimed?.type ?? 'null'}`);
  }
  await runDispatchJob(
    claimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider, heartbeatMs: 60_000},
  );
}

function postBeats(projectId: string, body: unknown): Promise<Response> {
  return beatsPOST(new Request('http://test', {method: 'POST', body: JSON.stringify(body)}), {
    params: Promise.resolve({id: projectId}),
  });
}

function postVisual(projectId: string, body: unknown): Promise<Response> {
  return visualPOST(new Request('http://test', {method: 'POST', body: JSON.stringify(body)}), {
    params: Promise.resolve({id: projectId}),
  });
}

/** 手工插入 running dispatch（模拟崩溃 worker 留下的过期租约信封）。 */
function insertStaleDispatch(input: {
  projectId: string;
  stage: string;
  requestId: string;
  sourceArtifactId: string;
  leaseExpiredAgoMs: number;
}): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  const iso = new Date(now).toISOString();
  getDb()
    .prepare(
      `INSERT INTO generation_dispatch_jobs (
         id, project_id, stage, request_id, source_artifact_id,
         status, owner_token, lease_expires_at,
         generation_run_id, result_artifact_id, error_code, error_message,
         created_at, started_at, finished_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'running', 'crashed-owner', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      input.projectId,
      input.stage,
      input.requestId,
      input.sourceArtifactId,
      new Date(now - input.leaseExpiredAgoMs).toISOString(),
      iso,
      iso,
      iso,
    );
  return id;
}

async function main(): Promise<void> {
  // ============ D1：Narrative Beats 全链路（Web 无 LLM key → enqueue → worker 执行） ============
  let d1ProjectId = '';
  let beatsArtifactId = '';
  let narrationPlanArtifactId = '';
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    d1ProjectId = projectId;
    const build = buildNarrationPlanV2(projectId);
    narrationPlanArtifactId = build.artifact.id;
    const validBeats = makeValidBeats(build.plan);
    const provider = new ScriptableProvider();

    // Web 无 LLM key（production 模拟：任何 getProvider 必然 CONFIG_ERROR）仍能 202 enqueue
    const env = process.env as Record<string, string | undefined>;
    env.LLM_PROVIDER = 'deepseek';
    delete env.DEEPSEEK_API_KEY;
    resetProviderForTest();
    let createJson: {dispatchId: string; requestId: string; status: string; candidateOnly: boolean};
    try {
      const createRes = await postBeats(projectId, {
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-d1-0001',
      });
      ok(createRes.status === 202, '[D1a] Web 无 LLM key：新 requestId POST → 202 queued');
      createJson = (await createRes.json()) as typeof createJson;
      ok(
        createJson.status === 'queued' &&
          createJson.requestId === 'req-d1-0001' &&
          createJson.dispatchId.length > 0 &&
          createJson.candidateOnly === true,
        '[D1b] 202 响应含 dispatchId + status=queued + candidateOnly',
        createJson,
      );
    } finally {
      env.LLM_PROVIDER = 'mock';
      resetProviderForTest();
    }
    ok(
      provider.requests.length === 0 &&
        runCount(projectId, BEATS_USAGE_STAGE) === 0 &&
        artifactCount(projectId, NARRATIVE_BEATS_KIND) === 0 &&
        usageCount(projectId, BEATS_USAGE_STAGE) === 0,
      '[D1c] enqueue 阶段零 provider / 零 run / 零 artifact / 零 usage',
    );
    ok(dispatchCount(projectId, 'req-d1-0001') === 1, '[D1d] dispatch 恰好 1 行');

    // worker executor 执行：provider calls=1 → run=1 → artifact=1 → usage=真实 attempts
    provider.push({text: JSON.stringify({beats: validBeats})});
    await runNextDispatch(provider);
    ok(provider.requests.length === 1, '[D1e] worker executor provider 恰好 1 次调用');
    const run = runRow(projectId, BEATS_USAGE_STAGE, 'req-d1-0001');
    ok(
      run !== undefined && run.status === 'succeeded' && run.result_artifact_id !== null,
      '[D1f] generation_run 恰好 1 行且 succeeded + result artifact',
    );
    ok(runCount(projectId, BEATS_USAGE_STAGE) === 1, '[D1g] generation_runs 恰好 1 行');
    ok(artifactCount(projectId, NARRATIVE_BEATS_KIND) === 1, '[D1h] beats artifact 恰好 1 行');
    const attempts = attemptCount(run!.id);
    ok(
      attempts === 1 && usageCount(projectId, BEATS_USAGE_STAGE, 'req-d1-0001') === attempts,
      '[D1i] usage 行数 = 真实 attempt 数（1）',
    );
    const dispatch = getDispatchJob(getDb(), createJson.dispatchId);
    ok(
      dispatch !== null &&
        dispatch.status === 'succeeded' &&
        dispatch.generation_run_id === run!.id &&
        dispatch.result_artifact_id === run!.result_artifact_id &&
        dispatch.finished_at !== null,
      '[D1j] dispatch succeeded + generation_run/result_artifact 关联',
    );
    beatsArtifactId = run!.result_artifact_id!;

    // GET 状态面含 dispatchJobs
    const listRes = await beatsGET(new Request('http://test'), {params: Promise.resolve({id: projectId})});
    const listJson = (await listRes.json()) as {
      dispatchJobs: Array<{requestId: string; status: string; generationRunId: string | null}>;
    };
    ok(
      Array.isArray(listJson.dispatchJobs) &&
        listJson.dispatchJobs.some(
          (d) => d.requestId === 'req-d1-0001' && d.status === 'succeeded' && d.generationRunId === run!.id,
        ),
      '[D1k] GET 响应含 dispatchJobs（succeeded + run 关联）',
    );
  }

  // ============ D2：同 requestId 双击/双 POST 只产生一个 dispatch ============
  {
    const projectId = d1ProjectId;
    const provider = new ScriptableProvider();
    const body = {narrationPlanV2ArtifactId: narrationPlanArtifactId, requestId: 'req-d2-0001'};
    const r1 = await postBeats(projectId, body);
    const r2 = await postBeats(projectId, body);
    ok(r1.status === 202 && r2.status === 202, '[D2a] 同 requestId 双 POST → 均 202 queued');
    const j1 = (await r1.json()) as {dispatchId: string};
    const j2 = (await r2.json()) as {dispatchId: string};
    ok(j1.dispatchId === j2.dispatchId, '[D2b] 双击幂等：同一 dispatchId');
    ok(dispatchCount(projectId, 'req-d2-0001') === 1, '[D2c] 同 requestId 只产生一个 dispatch');
    // 排干：执行该 dispatch（保持后续用例队列干净）
    const planRef = getNarrationPlanV2Artifact(projectId, narrationPlanArtifactId);
    provider.push({text: JSON.stringify({beats: makeValidBeats(planRef!.plan)})});
    await runNextDispatch(provider);
    ok(provider.requests.length === 1, '[D2d] 排干执行 provider 恰好 1 次');
    // 执行后再 POST 同 requestId → 200 reused，仍只有 1 个 dispatch
    const r3 = await postBeats(projectId, body);
    ok(r3.status === 200, '[D2e] 执行完成后同 requestId POST → 200 reused');
    ok(dispatchCount(projectId, 'req-d2-0001') === 1, '[D2f] reused 不产生第二个 dispatch');
  }

  // ============ D3：已有 artifact requestId → 200 reused（零 dispatch、零 provider） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    // library build 直接生成（无 dispatch 信封）
    const libProvider = new ScriptableProvider();
    libProvider.push({text: JSON.stringify({beats: makeValidBeats(build.plan)})});
    const built = await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d3-0001',
      provider: libProvider,
    });
    ok(built.kind === 'succeeded', '[D3a] library build 生成 artifact');
    const routeProvider = new ScriptableProvider();
    const res = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d3-0001',
    });
    ok(res.status === 200, '[D3b] 已有 artifact requestId POST → 200 reused');
    const json = (await res.json()) as {reused: boolean; status: string; artifactId: string; runId: string | null};
    ok(
      json.reused === true && json.status === 'succeeded' && json.runId !== null,
      '[D3c] 200 响应 reused + status=succeeded + run 追溯',
      json,
    );
    ok(
      dispatchCount(projectId) === 0 && routeProvider.requests.length === 0 && libProvider.requests.length === 1,
      '[D3d] 零 dispatch、零新增 provider 调用',
    );
  }

  // ============ D4：failed / indeterminate 终态 → POST 409 同终态 ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const beats = makeValidBeats(build.plan);

    // failed：enqueue → worker 三次非法输出 → run failed → POST 409
    const enqueueRes = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d4-0001',
    });
    ok(enqueueRes.status === 202, '[D4a] 失败用例 enqueue → 202 queued');
    const failProvider = new ScriptableProvider();
    failProvider.push({text: JSON.stringify({beats: beats.slice(0, 5)})});
    failProvider.push({text: JSON.stringify({beats: beats.slice(0, 5)})});
    failProvider.push({text: JSON.stringify({beats: beats.slice(0, 5)})});
    await runNextDispatch(failProvider);
    const failRun = runRow(projectId, BEATS_USAGE_STAGE, 'req-d4-0001');
    ok(
      failRun !== undefined && failRun.status === 'failed' && failRun.error_code === 'VALIDATION_FAILED',
      '[D4b] worker 执行后 run failed（VALIDATION_FAILED）',
    );
    const failDispatch = listDispatchJobs(getDb(), projectId, BEATS_USAGE_STAGE).find(
      (d) => d.requestId === 'req-d4-0001',
    );
    ok(
      failDispatch !== undefined && failDispatch.status === 'failed' && failDispatch.errorCode === 'VALIDATION_FAILED',
      '[D4c] dispatch failed + errorCode 映射',
    );
    const failPost = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d4-0001',
    });
    ok(failPost.status === 409, '[D4d] failed run 同 requestId POST → 409');
    const failJson = (await failPost.json()) as {status: string; errorCode: string};
    ok(
      failJson.status === 'failed' && failJson.errorCode === 'VALIDATION_FAILED',
      '[D4e] 409 响应与 run 终态一致',
      failJson,
    );

    // indeterminate：run 租约过期 → 同事务转 indeterminate → POST 409（稳定同终态）
    const claim = claimGenerationRun(getDb(), {
      projectId,
      stage: BEATS_USAGE_STAGE,
      requestId: 'req-d4-0002',
      sourceArtifactId: build.artifact.id,
    });
    ok(claim.kind === 'claimed', '[D4f] indeterminate 用例 run claimed');
    getDb()
      .prepare(`UPDATE generation_runs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), claim.run.id);
    const reclaim = claimGenerationRun(getDb(), {
      projectId,
      stage: BEATS_USAGE_STAGE,
      requestId: 'req-d4-0002',
      sourceArtifactId: build.artifact.id,
    });
    ok(
      reclaim.kind === 'terminal' && reclaim.run.status === 'indeterminate',
      '[D4g] 租约过期 → run indeterminate',
    );
    const indPost = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d4-0002',
    });
    ok(indPost.status === 409, '[D4h] indeterminate run 同 requestId POST → 409');
    const indJson = (await indPost.json()) as {status: string; errorCode: string};
    ok(indJson.status === 'indeterminate', '[D4i] 409 响应 status=indeterminate', indJson);
    ok(dispatchCount(projectId, 'req-d4-0002') === 0, '[D4j] 终态短路零 dispatch');
  }

  // ============ D5：crash 恢复 + run running 语义 ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);

    // (a) run running（租约有效）→ POST 202 running；executor → build in_progress → 信封 requeue
    const claim = claimGenerationRun(getDb(), {
      projectId,
      stage: BEATS_USAGE_STAGE,
      requestId: 'req-d5-0001',
      sourceArtifactId: build.artifact.id,
    });
    ok(claim.kind === 'claimed', '[D5a] 他人持有的 running run 就绪');
    const runningPost = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d5-0001',
    });
    ok(runningPost.status === 202, '[D5b] run running 时 POST → 202');
    const runningJson = (await runningPost.json()) as {status: string; runId: string; dispatchId: string | null};
    ok(
      runningJson.status === 'running' && runningJson.runId === claim.run.id,
      '[D5c] 202 响应 status=running + runId（零 dispatch 创建）',
      runningJson,
    );
    ok(dispatchCount(projectId, 'req-d5-0001') === 0, '[D5d] run running 短路：零 dispatch');

    // 手工制造 dispatch 信封（模拟 crash recovery requeue 后的状态）→ executor 不得重复调用 provider
    const enq = enqueueGenerationDispatch(getDb(), {
      projectId,
      stage: BEATS_USAGE_STAGE,
      requestId: 'req-d5-0001',
      sourceArtifactId: build.artifact.id,
    });
    ok(enq.kind === 'running', '[D5e] enqueue 遇到 running run → kind=running（仍不建 dispatch）');
    insertStaleDispatch({
      projectId,
      stage: BEATS_USAGE_STAGE,
      requestId: 'req-d5-0001',
      sourceArtifactId: build.artifact.id,
      leaseExpiredAgoMs: 60_000,
    });
    // UNIQUE 冲突：insertStaleDispatch 与 enqueue 同键——enqueue 未建行，故插入成功
    ok(dispatchCount(projectId, 'req-d5-0001') === 1, '[D5f] stale dispatch 信封插入');

    // (b) crash 恢复：lease 过期 + run running（租约有效）→ dispatch requeue
    // （staleMs=0：任何已过期租约立即判定 stale；生产启动用默认 2min 宽限）
    const recovered = recoverStaleDispatchJobs(getDb(), 0);
    const afterRecover = listDispatchJobs(getDb(), projectId, BEATS_USAGE_STAGE).find(
      (d) => d.requestId === 'req-d5-0001',
    );
    ok(
      recovered.requeued === 1 && recovered.failed === 0 && afterRecover?.status === 'queued',
      '[D5g] crash 恢复：run running（租约有效）→ dispatch requeue',
      {recovered, status: afterRecover?.status},
    );

    // executor 执行 requeued 信封 → build in_progress → 再次 requeue（零 provider 调用）
    const idleProvider = new ScriptableProvider();
    await runNextDispatch(idleProvider);
    const afterReexec = listDispatchJobs(getDb(), projectId, BEATS_USAGE_STAGE).find(
      (d) => d.requestId === 'req-d5-0001',
    );
    ok(
      idleProvider.requests.length === 0 && afterReexec?.status === 'queued',
      '[D5h] executor in_progress → 信封再 requeue（零 provider 调用）',
    );
    const runAfter = runRow(projectId, BEATS_USAGE_STAGE, 'req-d5-0001');
    ok(runAfter !== undefined && runAfter.status === 'running', '[D5i] run 未被 executor 转移（仍 running）');
    // 清理：删除 requeued 信封，避免后续用例的全局 FIFO claim 捡到它（本 project 不再使用）
    getDb()
      .prepare(`DELETE FROM generation_dispatch_jobs WHERE project_id = ? AND request_id = ?`)
      .run(projectId, 'req-d5-0001');

    // (c) crash 恢复：lease 过期 + 无 generation run → dispatch failed WORKER_CRASH
    insertStaleDispatch({
      projectId,
      stage: BEATS_USAGE_STAGE,
      requestId: 'req-d5-0002',
      sourceArtifactId: build.artifact.id,
      leaseExpiredAgoMs: 60_000,
    });
    const recovered2 = recoverStaleDispatchJobs(getDb(), 0);
    const crashed = listDispatchJobs(getDb(), projectId, BEATS_USAGE_STAGE).find(
      (d) => d.requestId === 'req-d5-0002',
    );
    ok(
      recovered2.failed === 1 && crashed?.status === 'failed' && crashed.errorCode === 'WORKER_CRASH',
      '[D5j] crash 恢复：无 run → dispatch failed(WORKER_CRASH)',
      {recovered2, status: crashed?.status, errorCode: crashed?.errorCode},
    );
    // WORKER_CRASH 终态稳定：同 requestId 再 POST → 409（不自动重试）
    const crashPost = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d5-0002',
    });
    ok(crashPost.status === 409, '[D5k] WORKER_CRASH dispatch 同 requestId POST → 409');
    const crashJson = (await crashPost.json()) as {status: string; errorCode: string};
    ok(
      crashJson.status === 'failed' && crashJson.errorCode === 'WORKER_CRASH',
      '[D5l] 409 响应 WORKER_CRASH（不自动重试可能已计费的请求）',
      crashJson,
    );
  }

  // ============ D6：Visual Intent stage 全链路（source = D1 beats artifact） ============
  {
    const projectId = d1ProjectId;
    const planRef = getNarrationPlanV2Artifact(projectId, narrationPlanArtifactId);
    const provider = new ScriptableProvider();
    provider.push({text: JSON.stringify({intents: makeValidIntents(planRef!.plan)})});

    const createRes = await postVisual(projectId, {
      narrativeBeatsArtifactId: beatsArtifactId,
      requestId: 'req-d6-0001',
    });
    ok(createRes.status === 202, '[D6a] visual stage 新 requestId POST → 202 queued');
    const createJson = (await createRes.json()) as {dispatchId: string; status: string};
    ok(createJson.status === 'queued' && createJson.dispatchId.length > 0, '[D6b] 202 含 dispatchId');
    ok(provider.requests.length === 0, '[D6c] Web POST 零 provider 调用');

    await runNextDispatch(provider);
    ok(provider.requests.length === 1, '[D6d] worker executor provider 恰好 1 次调用');
    const run = runRow(projectId, VISUAL_INTENT_USAGE_STAGE, 'req-d6-0001');
    ok(
      run !== undefined && run.status === 'succeeded' && run.result_artifact_id !== null,
      '[D6e] visual generation_run succeeded + result artifact',
    );
    ok(artifactCount(projectId, VISUAL_INTENT_KIND) === 1, '[D6f] visual intent artifact 恰好 1 行');
    ok(
      usageCount(projectId, VISUAL_INTENT_USAGE_STAGE, 'req-d6-0001') === attemptCount(run!.id),
      '[D6g] usage 行数 = 真实 attempt 数',
    );
    const dispatch = getDispatchJob(getDb(), createJson.dispatchId);
    ok(
      dispatch !== null && dispatch.status === 'succeeded' && dispatch.generation_run_id === run!.id,
      '[D6h] visual dispatch succeeded + run 关联',
    );

    // GET 状态面 + 同 requestId → 200 reused
    const listRes = await visualGET(new Request('http://test'), {params: Promise.resolve({id: projectId})});
    const listJson = (await listRes.json()) as {
      dispatchJobs: Array<{requestId: string; status: string}>;
      candidates: Array<{requestId: string | null}>;
    };
    ok(
      listJson.dispatchJobs.some((d) => d.requestId === 'req-d6-0001' && d.status === 'succeeded') &&
        listJson.candidates.some((c) => c.requestId === 'req-d6-0001'),
      '[D6i] visual GET 含 dispatchJobs + 新 candidate',
    );
    const reuseRes = await postVisual(projectId, {
      narrativeBeatsArtifactId: beatsArtifactId,
      requestId: 'req-d6-0001',
    });
    ok(reuseRes.status === 200, '[D6j] visual 同 requestId POST → 200 reused');
    const reuseJson = (await reuseRes.json()) as {reused: boolean; intentCount: number};
    ok(reuseJson.reused === true && reuseJson.intentCount === 6, '[D6k] 200 reused + intentCount=6');
    ok(provider.requests.length === 1, '[D6l] reused 零新增 provider 调用');
  }

  // ============ D7：run succeeded 但 dispatch 不存在 → POST 200 reused（run 短路） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const libProvider = new ScriptableProvider();
    libProvider.push({text: JSON.stringify({beats: makeValidBeats(build.plan)})});
    await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d7-0001',
      provider: libProvider,
    });
    // 删除 artifact 内容扫描不可见的情形无法构造（artifact 存在即命中 legacy 扫描），
    // 此处验证：artifact 命中 → 200 reused 且零 dispatch（与 D3 互证 run 短路一致性）。
    const run = findGenerationRun(getDb(), projectId, BEATS_USAGE_STAGE, 'req-d7-0001');
    ok(run !== null && run.status === 'succeeded', '[D7a] run succeeded 就绪');
    const res = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-d7-0001',
    });
    ok(res.status === 200 && dispatchCount(projectId) === 0, '[D7b] 200 reused + 零 dispatch（幂等稳定）');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-llm-dispatch'), {recursive: true, force: true});

  await new Promise((resolve) => setImmediate(resolve));

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] Worker-side LLM Dispatch 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] Worker-side LLM Dispatch 测试全部通过 ✅');
}

void main();

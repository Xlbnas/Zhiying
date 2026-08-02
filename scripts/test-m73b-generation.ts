/**
 * M7.3B Generation / Worker dispatch / single-flight 测试（临时 DB + Mock，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m73b-generation.ts
 * 覆盖（11.4）：
 * - Web 只 enqueue（route 零 provider、零 secret 依赖）；
 * - Worker 用 Mock provider 执行（ScriptableProvider/BlockableProvider）；
 * - 同 requestId + 同 source 幂等复用（200 reused，零二次 provider）；
 * - 同 requestId + 不同 source → 409（REQUEST_ID_CONFLICT）；
 * - 并发 single-flight（run 进行中再 POST → 202 running，provider 仅一次调用）；
 * - 3 次失败 → failed 终态稳定（409）；
 * - repair attemptCount 真实递增（attempt journal 2 行）；
 * - source drift before dispatch（enqueue 后漂移 → dispatch failed，provider calls=0）；
 * - source drift during generation（commit-time fence → run failed SOURCE_STALE）；
 * - source drift before artifact commit（零 artifact 行、无 partial/duplicate）；
 * - NODE_ENV=production 下 setProviderForTest throw；
 * - 全部流程不触碰 projects.pipeline_version / m7_pipeline_snapshot_id。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m73b-generation');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {LLMError, type LLMProvider, type LLMRequest, type LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {buildNarrativeBeats} from '../src/lib/narrative-beats/plan';
import type {NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {buildVisualIntentPlan} from '../src/lib/visual-intent/plan';
import type {VisualIntentV1} from '../src/lib/visual-intent/schema';
import {buildVisualSequences, composeSequencesSourceKey, setVisualSequencesProviderForTest} from '../src/lib/visual-sequences/plan';
import type {VisualSequenceV1} from '../src/lib/visual-sequences/schema';
import {
  classifyVisualSequencesCandidate,
  getVisualSequencesArtifact,
  listVisualSequencesRows,
} from '../src/lib/visual-sequences/classify';
import {buildShots, setShotsProviderForTest} from '../src/lib/shots/plan';
import type {ShotV1} from '../src/lib/shots/schema';
import {classifyShotsCandidate, getShotsArtifact, listShotsRows} from '../src/lib/shots/classify';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runDispatchJob} from '../src/lib/../worker/dispatch-executor';
import {enqueueGenerationDispatch} from '../src/lib/llm-generation/dispatch';
import {RequestIdConflictError} from '../src/lib/llm-generation/runs';
import {GET as seqGET, POST as seqPOST} from '../src/app/api/projects/[id]/visual-sequences/route';
import {GET as shotGET, POST as shotPOST} from '../src/app/api/projects/[id]/shots/route';
import {POST as visualPOST} from '../src/app/api/projects/[id]/visual-intents/route';

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-generation'), {recursive: true, force: true});

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

class ScriptableProvider implements LLMProvider {
  readonly name = 'scriptable-mock';
  readonly requests: LLMRequest[] = [];
  private queue: Array<{text?: string; finishReason?: string; error?: LLMError}> = [];

  push(resp: {text?: string; finishReason?: string; error?: LLMError}): void {
    this.queue.push(resp);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error('scriptable provider: 无预置响应'));
    if (next.error) return Promise.reject(next.error);
    return Promise.resolve({
      text: next.text ?? '',
      requestId: `scr-${this.requests.length}`,
      model: request.model,
      finishReason: next.finishReason ?? 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
  }
}

/** 可阻塞 Mock Provider：generate 停在 Promise barrier 上，release() 后放行。 */
class BlockableProvider implements LLMProvider {
  readonly name = 'blockable-mock';
  readonly requests: LLMRequest[] = [];
  private gate: Promise<void> | null = null;
  private releaseFn: (() => void) | null = null;

  constructor(private readonly text: string) {}

  arm(): void {
    this.gate = new Promise((resolve) => {
      this.releaseFn = resolve;
    });
  }

  release(): void {
    this.releaseFn?.();
    this.gate = null;
    this.releaseFn = null;
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const respond = (): LLMResponse => ({
      text: this.text,
      requestId: `blk-${this.requests.length}`,
      model: request.model,
      finishReason: 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
    if (this.gate) return this.gate.then(respond);
    return Promise.resolve(respond());
  }
}

const UPSTREAM: WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
];

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
  const projectId = createProjectWithWorkflow({topic: 'm73b', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({projectId, stage: 'script_v2', content, contentType: 'markdown', source: 'manual_edit', promptVersion});
  lockStage(projectId, 'script_v2');
  return projectId;
}

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

function makeValidIntents(plan: NarrationPlanV2): VisualIntentV1[] {
  const n4 = plan.units[3]!;
  if (n4.kind !== 'speech') throw new Error('fixture: N004 必须是 speech');
  return [
    {visualIntentId: 'V001', chapter: 1, beatIds: ['B001'], intent: 'SHOW_PERSON', strategy: 'portrait', authenticity: 'authentic_required', objective: 'o', subject: {kind: 'person', label: '讲述者', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V002', chapter: 1, beatIds: ['B002'], intent: 'CONTINUE_PREVIOUS_VISUAL', strategy: 'continue_previous', authenticity: 'inherited', objective: 'o', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: 'V001', displayText: null},
    {visualIntentId: 'V003', chapter: 1, beatIds: ['B003'], intent: 'SHOW_PLACE', strategy: 'archive_photo', authenticity: 'authentic_required', objective: 'o', subject: {kind: 'place', label: '旧城区', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V004', chapter: 2, beatIds: ['B004'], intent: 'EMPHASIZE_TEXT', strategy: 'title_card', authenticity: 'not_applicable', objective: 'o', subject: {kind: 'text', label: null, evidenceIds: []}, continuationOfVisualIntentId: null, displayText: {sourceKind: 'spoken_exact', sourceUnitId: n4.id, sourceChapter: null, text: n4.spokenText}},
    {visualIntentId: 'V005', chapter: 2, beatIds: ['B005'], intent: 'SHOW_DATA', strategy: 'mg_data', authenticity: 'synthetic_allowed', objective: 'o', subject: {kind: 'data', label: '规模', evidenceIds: []}, continuationOfVisualIntentId: null, displayText: null},
    {visualIntentId: 'V006', chapter: 2, beatIds: ['B006'], intent: 'NO_VISUAL_CHANGE', strategy: 'hold', authenticity: 'inherited', objective: 'o', subject: {kind: 'none', label: null, evidenceIds: []}, continuationOfVisualIntentId: 'V005', displayText: null},
  ];
}

function makeValidSequences(): VisualSequenceV1[] {
  return [
    {sequenceId: 'Q001', chapter: 1, beatIds: ['B001', 'B002', 'B003'], visualIntentIds: ['V001', 'V002', 'V003']},
    {sequenceId: 'Q002', chapter: 2, beatIds: ['B004', 'B005', 'B006'], visualIntentIds: ['V004', 'V005', 'V006']},
  ];
}

function makeValidShots(): ShotV1[] {
  return [
    {shotId: 'H001', sequenceId: 'Q001', chapter: 1, unitIds: ['N001'], visualIntentId: 'V001', transitionFromPrevious: 'cut'},
    {shotId: 'H002', sequenceId: 'Q001', chapter: 1, unitIds: ['N002'], visualIntentId: 'V002', transitionFromPrevious: 'hold'},
    {shotId: 'H003', sequenceId: 'Q001', chapter: 1, unitIds: ['N003'], visualIntentId: 'V003', transitionFromPrevious: 'state_morph'},
    {shotId: 'H004', sequenceId: 'Q002', chapter: 2, unitIds: ['N004'], visualIntentId: 'V004', transitionFromPrevious: 'cut'},
    {shotId: 'H005', sequenceId: 'Q002', chapter: 2, unitIds: ['N005'], visualIntentId: 'V005', transitionFromPrevious: 'state_morph'},
    {shotId: 'H006', sequenceId: 'Q002', chapter: 2, unitIds: ['N006'], visualIntentId: 'V006', transitionFromPrevious: 'hold'},
  ];
}

/** Worker-side dispatch：claim 下一个 dispatch 并以注入 provider 执行（模拟 worker 主循环一步）。 */
async function runNextDispatch(provider: LLMProvider): Promise<void> {
  const claimed = claimNextAnyJob('worker-test-m73b');
  if (!claimed || claimed.type !== 'dispatch') {
    throw new Error(`expected queued dispatch job, got ${claimed?.type ?? 'null'}`);
  }
  await runDispatchJob(
    claimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider, heartbeatMs: 60_000},
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(
  fn: (req: Request, params: {params: Promise<{id: string}>}) => Promise<Response>,
  projectId: string,
  body: unknown,
): Promise<{status: number; json: Record<string, unknown>}> {
  const res = await fn(
    new Request('http://test', {method: 'POST', body: JSON.stringify(body)}),
    {params: Promise.resolve({id: projectId})},
  );
  return {status: res.status, json: (await res.json()) as Record<string, unknown>};
}

async function getJson(
  fn: (req: Request, params: {params: Promise<{id: string}>}) => Promise<Response>,
  projectId: string,
): Promise<{status: number; json: Record<string, unknown>}> {
  const res = await fn(new Request('http://test', {method: 'GET'}), {params: Promise.resolve({id: projectId})});
  return {status: res.status, json: (await res.json()) as Record<string, unknown>};
}

function runRow(projectId: string, stage: string, requestId: string): {id: string; status: string; error_code: string | null; result_artifact_id: string | null} | undefined {
  return getDb()
    .prepare(
      `SELECT id, status, error_code, result_artifact_id FROM generation_runs
       WHERE project_id = ? AND stage = ? AND request_id = ?`,
    )
    .get(projectId, stage, requestId) as ReturnType<typeof runRow>;
}

function attemptRows(runId: string): Array<{attempt_number: number; status: string}> {
  return getDb()
    .prepare(`SELECT attempt_number, status FROM generation_attempts WHERE run_id = ? ORDER BY attempt_number ASC`)
    .all(runId) as Array<{attempt_number: number; status: string}>;
}

async function main(): Promise<void> {
  const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const buildA = buildNarrationPlanV2(projectId);
  const plan = buildA.plan;
  const beats = makeValidBeats(plan);
  const intents = makeValidIntents(plan);

  const beatsProvider = new ScriptableProvider();
  beatsProvider.push({text: JSON.stringify({beats})});
  const beatsBuild = await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-beats-m73b-0001', provider: beatsProvider});
  if (beatsBuild.kind !== 'succeeded') throw new Error('fixture: beats build failed');
  const beatsArtifactId = beatsBuild.artifact.id;

  const intentProvider = new ScriptableProvider();
  intentProvider.push({text: JSON.stringify({intents})});
  const intentBuild = await buildVisualIntentPlan({projectId, narrativeBeatsArtifactId: beatsArtifactId, requestId: 'req-intent-m73b-0001', provider: intentProvider});
  if (intentBuild.kind !== 'succeeded') throw new Error('fixture: intent build failed');
  const intentArtifactId = intentBuild.artifact.id;

  // ═══════ G. sequences generation（11.4） ═══════
  console.log('── G. sequences generation');

  // G1：Web 只 enqueue（无 provider 注入，202 queued）
  const g1 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-0001',
  });
  ok(g1.status === 202 && g1.json.status === 'queued', 'G1 Web POST → 202 queued（enqueue-only）', g1);

  // G2：worker 执行成功
  const seqProvider = new ScriptableProvider();
  seqProvider.push({text: JSON.stringify({sequences: makeValidSequences()})});
  await runNextDispatch(seqProvider);
  const seqRows = listVisualSequencesRows(projectId);
  ok(seqRows.length === 1, 'G2a worker 执行后 1 个 sequences artifact');
  const seqArtifactId = seqRows[0]!.id;
  const seqClass = classifyVisualSequencesCandidate(projectId, seqRows[0]!);
  ok(seqClass.status === 'current_candidate', 'G2b artifact classify=current_candidate', seqClass);
  const seqRun = runRow(projectId, 'm7_visual_sequences', 'req-seq-gen-0001');
  ok(seqRun?.status === 'succeeded', 'G2c generation run succeeded', seqRun);

  // G3：同 requestId + 同 source → 200 reused，零二次 provider
  const callsBefore = seqProvider.requests.length;
  const g3 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-0001',
  });
  ok(g3.status === 200 && g3.json.reused === true, 'G3a 同 requestId+source → 200 reused', g3);
  ok(seqProvider.requests.length === callsBefore, 'G3b 幂等复用零二次 provider 调用');

  // G4：同 requestId + 不同 source → 409 REQUEST_ID_CONFLICT
  // 造第二个 intent artifact（新 requestId）
  const intentAltProvider = new ScriptableProvider();
  intentAltProvider.push({text: JSON.stringify({intents})});
  const intentAltBuild = await buildVisualIntentPlan({projectId, narrativeBeatsArtifactId: beatsArtifactId, requestId: 'req-intent-alt-0001', provider: intentAltProvider});
  if (intentAltBuild.kind !== 'succeeded') throw new Error('fixture: intent alt build failed');
  const g4 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentAltBuild.artifact.id,
    requestId: 'req-seq-gen-0001',
  });
  ok(g4.status === 409 && g4.json.error === 'REQUEST_ID_CONFLICT', 'G4 同 requestId 不同 source → 409', g4);

  // G5：并发 single-flight（run 进行中再 POST → 202 running，provider 仅一次调用）
  const blockable = new BlockableProvider(JSON.stringify({sequences: makeValidSequences()}));
  blockable.arm();
  const g5a = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentAltBuild.artifact.id,
    requestId: 'req-seq-gen-sf-0001',
  });
  ok(g5a.status === 202 && g5a.json.status === 'queued', 'G5a SF enqueue → 202 queued', g5a);
  const workerPromise = runNextDispatch(blockable).catch((err) => {
    // 挂起中的 provider 在 release 前不应失败
    throw err;
  });
  await sleep(150); // 等 worker claim 并进入 generate（挂起）
  const g5b = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentAltBuild.artifact.id,
    requestId: 'req-seq-gen-sf-0001',
  });
  ok(g5b.status === 202 && g5b.json.status === 'running', 'G5b run 进行中再 POST → 202 running（不重复入队）', g5b);
  ok(blockable.requests.length === 1, 'G5c 挂起期间 provider 仅 1 次调用');
  blockable.release();
  await workerPromise;
  const sfRows = listVisualSequencesRows(projectId).filter((r) => {
    const parsed = JSON.parse(r.content_json) as {generation?: {requestId?: string}};
    return parsed.generation?.requestId === 'req-seq-gen-sf-0001';
  });
  ok(sfRows.length === 1, 'G5d 并发后仍只有 1 个 artifact（无重复）');

  // G6：repair attemptCount 真实递增
  const g6a = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-repair-0001',
  });
  ok(g6a.status === 202, 'G6a repair enqueue → 202');
  const repairProvider = new ScriptableProvider();
  // 第一次：gap 坏输出；第二次：合法
  repairProvider.push({text: JSON.stringify({sequences: [{sequenceId: 'Q001', chapter: 1, beatIds: ['B001'], visualIntentIds: ['V001']}]})});
  repairProvider.push({text: JSON.stringify({sequences: makeValidSequences()})});
  await runNextDispatch(repairProvider);
  const repairRow = listVisualSequencesRows(projectId).find((r) => {
    const parsed = JSON.parse(r.content_json) as {generation?: {requestId?: string}};
    return parsed.generation?.requestId === 'req-seq-gen-repair-0001';
  });
  ok(Boolean(repairRow), 'G6b repair 后 artifact 存在');
  const repairContent = JSON.parse(repairRow!.content_json) as {generation?: {attemptCount?: number}};
  ok(repairContent.generation?.attemptCount === 2, 'G6c attemptCount=2（首次+1 repair）', repairContent.generation);
  const repairRun = runRow(projectId, 'm7_visual_sequences', 'req-seq-gen-repair-0001');
  ok(repairRun?.status === 'succeeded', 'G6d repair run succeeded');
  const attempts = repairRun ? attemptRows(repairRun.id) : [];
  ok(
    attempts.length === 2 &&
      attempts[0]!.status === 'validation_failed' &&
      attempts[1]!.status === 'succeeded',
    'G6e attempt journal 2 行（validation_failed → succeeded）',
    attempts,
  );

  // G7：3 次失败 → VALIDATION_FAILED → failed 终态稳定
  const g7a = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-fail-0001',
  });
  ok(g7a.status === 202, 'G7a fail enqueue → 202');
  const failProvider = new ScriptableProvider();
  for (let i = 0; i < 3; i++) {
    failProvider.push({text: JSON.stringify({sequences: [{sequenceId: 'Q001', chapter: 1, beatIds: ['B001'], visualIntentIds: ['V001']}]})});
  }
  await runNextDispatch(failProvider);
  const failRun = runRow(projectId, 'm7_visual_sequences', 'req-seq-gen-fail-0001');
  ok(failRun?.status === 'failed' && failRun.error_code === 'VALIDATION_FAILED', 'G7b 3 次失败 → run failed VALIDATION_FAILED', failRun);
  const failAttempts = failRun ? attemptRows(failRun.id) : [];
  ok(failAttempts.length === 3 && failAttempts.every((a) => a.status === 'validation_failed'), 'G7c attempt journal 3 行全 validation_failed');
  const g7b = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-fail-0001',
  });
  ok(g7b.status === 409 && g7b.json.status === 'failed' && g7b.json.errorCode === 'VALIDATION_FAILED', 'G7d 终态稳定 409（同 requestId 不再调 provider）', g7b);

  // G8：source drift before dispatch（enqueue 后漂移 → worker precheck 抛 → dispatch failed，provider calls=0）
  const g8 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-drift-pre-0001',
  });
  ok(g8.status === 202, 'G8a drift-before-dispatch enqueue → 202');
  const originalBeatsContent = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(beatsArtifactId) as {content_json: string}).content_json;
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(
    JSON.stringify({...JSON.parse(originalBeatsContent), beats: []}),
    beatsArtifactId,
  );
  const driftProvider = new ScriptableProvider();
  await runNextDispatch(driftProvider);
  const driftRun = runRow(projectId, 'm7_visual_sequences', 'req-seq-gen-drift-pre-0001');
  ok(driftRun === undefined, 'G8b drift-before-dispatch 不创建 generation run（precheck 在 claim 前失败）', driftRun);
  ok(driftProvider.requests.length === 0, 'G8c drift-before-dispatch provider calls=0');
  // dispatch 终态 failed（precheck throw——beats 行契约损坏 → exact 读取 null → BEATS_NOT_FOUND）
  const driftDispatch = getDb()
    .prepare(`SELECT status, error_code FROM generation_dispatch_jobs WHERE project_id = ? AND stage = 'm7_visual_sequences' AND request_id = ?`)
    .get(projectId, 'req-seq-gen-drift-pre-0001') as {status: string; error_code: string | null};
  ok(driftDispatch.status === 'failed' && driftDispatch.error_code === 'BEATS_NOT_FOUND', 'G8d dispatch failed BEATS_NOT_FOUND（exact source fail-closed）', driftDispatch);
  // 恢复 beats 行（后续用例依赖）
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(originalBeatsContent, beatsArtifactId);

  // G9/G10：source drift during generation → commit-time fence SOURCE_STALE，零 artifact 行
  const seqRowsBefore = listVisualSequencesRows(projectId).length;
  const g9 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-drift-mid-0001',
  });
  ok(g9.status === 202, 'G9a drift-mid enqueue → 202');
  const midBlockable = new BlockableProvider(JSON.stringify({sequences: makeValidSequences()}));
  midBlockable.arm();
  const midWorker = runNextDispatch(midBlockable);
  await sleep(150);
  // 挂起期间漂移 source
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(
    JSON.stringify({...JSON.parse(originalBeatsContent), beats: [JSON.parse(originalBeatsContent).beats[0]]}),
    beatsArtifactId,
  );
  midBlockable.release();
  await midWorker;
  const midRun = runRow(projectId, 'm7_visual_sequences', 'req-seq-gen-drift-mid-0001');
  ok(midRun?.status === 'failed' && midRun.error_code === 'SOURCE_STALE', 'G9b 生成期间 source 漂移 → run failed SOURCE_STALE（commit fence）', midRun);
  ok(listVisualSequencesRows(projectId).length === seqRowsBefore, 'G10a 漂移后零新增 artifact（无 partial）');
  // 恢复 beats 行后，同 requestId 终态稳定 409（SOURCE_STALE）
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(originalBeatsContent, beatsArtifactId);
  const g10 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-drift-mid-0001',
  });
  ok(g10.status === 409 && g10.json.errorCode === 'SOURCE_STALE', 'G10b 同 requestId 终态稳定 409', g10);

  // G11：NODE_ENV=production 下 setProviderForTest throw
  {
    const env = process.env as Record<string, string | undefined>;
    const savedEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    let seqThrew = false;
    let shotThrew = false;
    try {
      setVisualSequencesProviderForTest(null);
    } catch {
      seqThrew = true;
    }
    try {
      setShotsProviderForTest(null);
    } catch {
      shotThrew = true;
    }
    if (savedEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = savedEnv;
    ok(seqThrew, 'G11a NODE_ENV=production 时 setVisualSequencesProviderForTest throw');
    ok(shotThrew, 'G11b NODE_ENV=production 时 setShotsProviderForTest throw');
  }

  // G12：Web 无 LLM secret 依赖（route enqueue 全程不触碰 provider 配置）
  ok(!process.env.DEEPSEEK_API_KEY, 'G12a 测试进程无 DEEPSEEK_API_KEY（Web 侧无 secret）');

  // ═══════ H. shots generation ═══════
  console.log('── H. shots generation');
  // 用已生成的 sequences artifact 构建 shots（需要真实 sequences artifact——用 req-seq-gen-0001 的产物）
  const goodSeqRow = listVisualSequencesRows(projectId).find((r) => {
    const parsed = JSON.parse(r.content_json) as {generation?: {requestId?: string}};
    return parsed.generation?.requestId === 'req-seq-gen-0001';
  });
  if (!goodSeqRow) throw new Error('fixture: sequences artifact missing');
  const seqArtifactId2 = goodSeqRow.id;
  const h1 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seqArtifactId2,
    requestId: 'req-shots-gen-0001',
  });
  ok(h1.status === 202 && h1.json.status === 'queued', 'H1 shots Web POST → 202 queued', h1);
  const shotProvider = new ScriptableProvider();
  shotProvider.push({text: JSON.stringify({shots: makeValidShots()})});
  await runNextDispatch(shotProvider);
  const shotRows = listShotsRows(projectId);
  ok(shotRows.length === 1, 'H2a worker 执行后 1 个 shots artifact');
  const shotClass = classifyShotsCandidate(projectId, shotRows[0]!);
  ok(shotClass.status === 'current_candidate', 'H2b shots artifact classify=current_candidate', shotClass);

  // H3：同 requestId 不同 sequences source → 409
  // 造第二个 sequences artifact（新 requestId 重新生成）
  const seqProvider2 = new ScriptableProvider();
  seqProvider2.push({text: JSON.stringify({sequences: makeValidSequences()})});
  const seq2Build = await buildVisualSequences({
    projectId,
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-gen-0002',
    provider: seqProvider2,
  });
  if (seq2Build.kind !== 'succeeded') throw new Error('fixture: second sequences build failed');
  const h3 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seq2Build.artifact.id,
    requestId: 'req-shots-gen-0001',
  });
  ok(h3.status === 409 && h3.json.error === 'REQUEST_ID_CONFLICT', 'H3 同 requestId 不同 sequences source → 409', h3);

  // H4：shots 幂等复用
  const callsBeforeShots = shotProvider.requests.length;
  const h4 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seqArtifactId2,
    requestId: 'req-shots-gen-0001',
  });
  ok(h4.status === 200 && h4.json.reused === true, 'H4a shots 同 requestId+source → 200 reused', h4);
  ok(shotProvider.requests.length === callsBeforeShots, 'H4b shots 幂等复用零二次 provider');

  // H5：shots 生成期间 source drift → commit fence SOURCE_STALE
  const shotRowsBefore = listShotsRows(projectId).length;
  const h5 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seqArtifactId2,
    requestId: 'req-shots-gen-drift-0001',
  });
  ok(h5.status === 202, 'H5a shots drift enqueue → 202');
  const shotBlockable = new BlockableProvider(JSON.stringify({shots: makeValidShots()}));
  shotBlockable.arm();
  const shotWorker = runNextDispatch(shotBlockable);
  await sleep(150);
  // 挂起期间漂移 sequences 行
  const origSeqContent = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(seqArtifactId2) as {content_json: string}).content_json;
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(
    JSON.stringify({...JSON.parse(origSeqContent), sequences: [JSON.parse(origSeqContent).sequences[0]]}),
    seqArtifactId2,
  );
  shotBlockable.release();
  await shotWorker;
  const shotDriftRun = runRow(projectId, 'm7_shots', 'req-shots-gen-drift-0001');
  ok(shotDriftRun?.status === 'failed' && shotDriftRun.error_code === 'SOURCE_STALE', 'H5b shots 生成期间漂移 → SOURCE_STALE', shotDriftRun);
  ok(listShotsRows(projectId).length === shotRowsBefore, 'H5c shots 漂移零 artifact（无 partial/duplicate）');
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(origSeqContent, seqArtifactId2);

  // ═══════ I. 不变量 ═══════
  console.log('── I. invariants');
  const projectRow = getDb().prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects WHERE id = ?').get(projectId) as {pipeline_version: string; m7_pipeline_snapshot_id: string | null};
  ok(projectRow.pipeline_version === 'm6' && projectRow.m7_pipeline_snapshot_id === null, 'I1 项目仍 m6 / snapshot NULL（全程无激活）');
  const snapshotCount = (getDb().prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'm7_pipeline_snapshot'`).get() as {c: number}).c;
  ok(snapshotCount === 0, 'I2 无 M7 pipeline snapshot');
  const seqGet = await getJson(seqGET, projectId);
  ok(seqGet.status === 200 && seqGet.json.candidateOnly === true, 'I3 sequences GET 200 candidateOnly');
  const shotGet = await getJson(shotGET, projectId);
  ok(shotGet.status === 200 && shotGet.json.candidateOnly === true, 'I4 shots GET 200 candidateOnly');
  ok(Array.isArray(seqGet.json.runs) && Array.isArray(shotGet.json.runs), 'I5 GET 含 runs 状态面');
  // 无非法 source 泄漏：GET candidates 全部有稳定 status
  const seqCandidates = seqGet.json.candidates as Array<{status: string}>;
  ok(seqCandidates.every((c) => ['current_candidate', 'stale_source', 'invalid_source', 'needs_review'].includes(c.status)), 'I6 sequences GET status 全为 M7.3B 分类枚举');
  ok(getVisualSequencesArtifact(projectId, 'no-such') === null && getShotsArtifact(projectId, 'no-such') === null, 'I7 exact 读取 fail-closed null');

  // ═══════ J. queued dispatch source conflict（M7.3B.R1 P0） ═══════
  console.log('── J. queued dispatch conflict');
  function dispatchCountFor(projectId: string, stage: string, requestId: string): number {
    return (getDb()
      .prepare('SELECT COUNT(*) AS c FROM generation_dispatch_jobs WHERE project_id = ? AND stage = ? AND request_id = ?')
      .get(projectId, stage, requestId) as {c: number}).c;
  }
  function dispatchSource(projectId: string, stage: string, requestId: string): string | null {
    const row = getDb()
      .prepare('SELECT source_artifact_id FROM generation_dispatch_jobs WHERE project_id = ? AND stage = ? AND request_id = ?')
      .get(projectId, stage, requestId) as {source_artifact_id: string} | undefined;
    return row?.source_artifact_id ?? null;
  }
  const seqSourceKeyA = composeSequencesSourceKey(beatsArtifactId, intentArtifactId);
  const seqSourceKeyB = composeSequencesSourceKey(beatsArtifactId, intentAltBuild.artifact.id);
  const callsBeforeJ = seqProvider.requests.length;
  const seqRowsAtJStart = listVisualSequencesRows(projectId).length;

  // A 组：sequences queued conflict
  // 1. POST source A → 202 queued（不执行 worker）
  const j1 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-queued-0001',
  });
  ok(j1.status === 202 && j1.json.status === 'queued', 'J1 POST source A → 202 queued（worker 未执行）', j1);
  // 2. 确认只有 queued dispatch、无 generation_run
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-queued-0001') === undefined, 'J2 无 generation_run（仅 queued dispatch）');
  ok(dispatchCountFor(projectId, 'm7_visual_sequences', 'req-seq-queued-0001') === 1, 'J3 dispatch count=1');
  // 3. POST source B / 同 requestId → 409 REQUEST_ID_CONFLICT
  const j4 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentAltBuild.artifact.id,
    requestId: 'req-seq-queued-0001',
  });
  ok(j4.status === 409 && j4.json.error === 'REQUEST_ID_CONFLICT', 'J4 POST source B 同 requestId → 409 REQUEST_ID_CONFLICT', j4);
  ok(dispatchCountFor(projectId, 'm7_visual_sequences', 'req-seq-queued-0001') === 1, 'J5 冲突后 dispatch count 仍为 1（不新增）');
  ok(dispatchSource(projectId, 'm7_visual_sequences', 'req-seq-queued-0001') === seqSourceKeyA, 'J6 原 dispatch source 未被覆盖（仍为 source A）', dispatchSource(projectId, 'm7_visual_sequences', 'req-seq-queued-0001'));
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-queued-0001') === undefined, 'J7 冲突后 generation_runs 仍为 0');
  ok(listVisualSequencesRows(projectId).length === seqRowsAtJStart, 'J8 冲突后无新增 artifacts（无 partial）');

  // C 组：同 source 重复（worker claim 前）→ 202 同 dispatchId、count 仍 1
  const j10 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-queued-0001',
  });
  ok(j10.status === 202 && j10.json.status === 'queued', 'J10 同 source 重复 → 202 queued', j10);
  ok(j10.json.dispatchId === j1.json.dispatchId, 'J11 同 source 重复返回同一 dispatchId', j10.json.dispatchId);
  ok(dispatchCountFor(projectId, 'm7_visual_sequences', 'req-seq-queued-0001') === 1, 'J12 同 source 重复 dispatch count 仍 1');

  // D 组：并发不同 source、同 requestId → 恰好一个 queued、一个 409、最终一个 immutable source
  const [d1, d2] = await Promise.all([
    postJson(seqPOST, projectId, {
      narrativeBeatsArtifactId: beatsArtifactId,
      visualIntentPlanArtifactId: intentArtifactId,
      requestId: 'req-seq-race-0001',
    }),
    postJson(seqPOST, projectId, {
      narrativeBeatsArtifactId: beatsArtifactId,
      visualIntentPlanArtifactId: intentAltBuild.artifact.id,
      requestId: 'req-seq-race-0001',
    }),
  ]);
  const raceStatuses = [d1.status, d2.status].sort((a, b) => a - b);
  ok(raceStatuses.join(',') === '202,409', 'J13 并发不同 source → 恰好一个 202 一个 409', raceStatuses);
  ok(dispatchCountFor(projectId, 'm7_visual_sequences', 'req-seq-race-0001') === 1, 'J14 并发后 dispatch count=1（单一 immutable source）');
  const raceSource = dispatchSource(projectId, 'm7_visual_sequences', 'req-seq-race-0001');
  ok(raceSource === seqSourceKeyA || raceSource === seqSourceKeyB, 'J15 最终 source 为 A 或 B（由事务顺序决定，不可变）', raceSource);
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-race-0001') === undefined, 'J16 并发后 generation_runs=0');

  // B 组：shots queued conflict（source 为两个不同 visualSequencesArtifactId）
  const j17 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seqArtifactId2,
    requestId: 'req-shots-queued-0001',
  });
  ok(j17.status === 202 && j17.json.status === 'queued', 'J17 shots POST source A → 202 queued', j17);
  ok(runRow(projectId, 'm7_shots', 'req-shots-queued-0001') === undefined, 'J18 shots 无 generation_run（仅 queued dispatch）');
  const j19 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seq2Build.artifact.id,
    requestId: 'req-shots-queued-0001',
  });
  ok(j19.status === 409 && j19.json.error === 'REQUEST_ID_CONFLICT', 'J19 shots source B 同 requestId → 409 REQUEST_ID_CONFLICT', j19);
  ok(dispatchCountFor(projectId, 'm7_shots', 'req-shots-queued-0001') === 1, 'J20 shots 冲突后 dispatch count 仍 1');
  ok(dispatchSource(projectId, 'm7_shots', 'req-shots-queued-0001') === seqArtifactId2, 'J21 shots 原 dispatch source 未被覆盖', dispatchSource(projectId, 'm7_shots', 'req-shots-queued-0001'));
  ok(runRow(projectId, 'm7_shots', 'req-shots-queued-0001') === undefined, 'J22 shots 冲突后 generation_runs 仍 0');

  // E 组：既有 stage 回归（generic enqueue + visual-intents route queued conflict fail-closed）
  const e1 = enqueueGenerationDispatch(getDb(), {
    projectId,
    stage: 'm7_narrative_beats',
    requestId: 'req-beats-e-0001',
    sourceArtifactId: 'src-e-a',
  });
  ok(e1.kind === 'queued', 'J23 generic enqueue queued');
  let eThrew = false;
  try {
    enqueueGenerationDispatch(getDb(), {
      projectId,
      stage: 'm7_narrative_beats',
      requestId: 'req-beats-e-0001',
      sourceArtifactId: 'src-e-b',
    });
  } catch (err) {
    eThrew = err instanceof RequestIdConflictError;
  }
  ok(eThrew, 'J24 generic enqueue queued 不同 source → RequestIdConflictError（fail-closed）');
  const e2 = enqueueGenerationDispatch(getDb(), {
    projectId,
    stage: 'm7_narrative_beats',
    requestId: 'req-beats-e-0001',
    sourceArtifactId: 'src-e-a',
  });
  const e1Queued = e1 as Extract<typeof e1, {kind: 'queued'}>;
  const e2Queued = e2 as Extract<typeof e2, {kind: 'queued'}>;
  ok(e2Queued.kind === 'queued' && e2Queued.dispatchId === e1Queued.dispatchId, 'J25 generic enqueue 同 source 幂等（同 dispatchId）');
  // visual-intents route：第二个 beats artifact（新 requestId 生成）
  const beats2Provider = new ScriptableProvider();
  beats2Provider.push({text: JSON.stringify({beats})});
  const beats2Build = await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: buildA.artifact.id, requestId: 'req-beats-alt-0001', provider: beats2Provider});
  if (beats2Build.kind !== 'succeeded') throw new Error('fixture: second beats build failed');
  const j26 = await postJson(visualPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: 'req-intent-queued-0001',
  });
  ok(j26.status === 202 && j26.json.status === 'queued', 'J26 visual-intents route queued');
  const j27 = await postJson(visualPOST, projectId, {
    narrativeBeatsArtifactId: beats2Build.artifact.id,
    requestId: 'req-intent-queued-0001',
  });
  ok(j27.status === 409 && j27.json.error === 'REQUEST_ID_CONFLICT', 'J27 visual-intents route queued 不同 source → 409（既有 stage 同样 fail-closed）', j27);
  ok(dispatchCountFor(projectId, 'm7_visual_intent', 'req-intent-queued-0001') === 1, 'J28 visual-intents 冲突后 dispatch count 仍 1');
  const j29 = await postJson(visualPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: 'req-intent-queued-0001',
  });
  ok(j29.status === 202 && j29.json.dispatchId === j26.json.dispatchId, 'J29 visual-intents 同 source 幂等（同 dispatchId）', j29.json.dispatchId);
  ok(seqProvider.requests.length === callsBeforeJ, 'J30 J 组全程 provider calls=0（无 worker 执行）', seqProvider.requests.length);
  void seqSourceKeyB;

  // ═══════ K. dispatch-only running window（M7.3B.R2 P1） ═══════
  console.log('── K. running window');
  // 使用真实 scheduler claim（claimNextAnyJob），不手工 UPDATE。
  // 先清理 J 组遗留的 queued dispatch（J 组断言已完成；全局 FIFO 否则会先捡到它们）。
  getDb().prepare(`DELETE FROM generation_dispatch_jobs WHERE project_id = ? AND status = 'queued'`).run(projectId);
  // K1-K8：sequences route
  const k1 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-running-0001',
  });
  ok(k1.status === 202 && k1.json.status === 'queued', 'K1 POST → 202 queued', k1);
  const kClaimed = claimNextAnyJob('worker-running-window');
  ok(kClaimed !== null && kClaimed.type === 'dispatch', 'K2 scheduler claim 到 dispatch', kClaimed?.type);
  if (kClaimed === null || kClaimed.type !== 'dispatch') throw new Error('fixture: K claim failed');
  const kDispatchRow = getDb().prepare('SELECT * FROM generation_dispatch_jobs WHERE id = ?').get(kClaimed.job.id) as {status: string; owner_token: string | null; source_artifact_id: string};
  ok(kDispatchRow.status === 'running', 'K3 dispatch.status=running（claim 后）', kDispatchRow.status);
  ok(kDispatchRow.owner_token !== null && kDispatchRow.owner_token.length > 0, 'K4 owner_token 非空');
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-running-0001') === undefined, 'K5 generation_run 尚未创建（dispatch-only running）');
  const callsBeforeK = seqProvider.requests.length;
  const seqRowsBeforeK = listVisualSequencesRows(projectId).length;
  const k6 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-running-0001',
  });
  ok(k6.status === 202 && k6.json.status === 'running', 'K6 同 source POST → 202 status=running（不再 queued）', k6);
  ok(k6.json.dispatchId === kClaimed.job.id, 'K7 dispatchId 与 claimed dispatch 一致', k6.json.dispatchId);
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-running-0001') === undefined, 'K8a generation_runs 仍为 0');
  ok(dispatchCountFor(projectId, 'm7_visual_sequences', 'req-seq-running-0001') === 1, 'K8b dispatch count=1（不新增）');
  ok(dispatchSource(projectId, 'm7_visual_sequences', 'req-seq-running-0001') === composeSequencesSourceKey(beatsArtifactId, intentArtifactId), 'K8c source 不变');
  ok(seqProvider.requests.length === callsBeforeK, 'K8d provider calls=0');
  ok(listVisualSequencesRows(projectId).length === seqRowsBeforeK, 'K8e artifact count 不变');
  // K 收尾：用 Mock provider 完成被 claim 的 dispatch（不留 running 残留）
  const kFinishProvider = new ScriptableProvider();
  kFinishProvider.push({text: JSON.stringify({sequences: makeValidSequences()})});
  await runDispatchJob(
    kClaimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider: kFinishProvider, heartbeatMs: 60_000},
  );
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-running-0001')?.status === 'succeeded', 'K9 被 claim 的 dispatch 正确收尾（run succeeded）');

  // K10-K13：shots route dispatch-only running
  const k10 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seqArtifactId2,
    requestId: 'req-shots-running-0001',
  });
  ok(k10.status === 202 && k10.json.status === 'queued', 'K10 shots POST → 202 queued', k10);
  const kShotsClaimed = claimNextAnyJob('worker-running-window-2');
  ok(kShotsClaimed !== null && kShotsClaimed.type === 'dispatch', 'K11 shots scheduler claim', kShotsClaimed?.type);
  if (kShotsClaimed === null || kShotsClaimed.type !== 'dispatch') throw new Error('fixture: K shots claim failed');
  ok(runRow(projectId, 'm7_shots', 'req-shots-running-0001') === undefined, 'K12 shots generation_run 尚未创建');
  const k13 = await postJson(shotPOST, projectId, {
    visualSequencesArtifactId: seqArtifactId2,
    requestId: 'req-shots-running-0001',
  });
  ok(k13.status === 202 && k13.json.status === 'running' && k13.json.dispatchId === kShotsClaimed.job.id, 'K13 shots 同 source POST → 202 running（同 dispatchId）', k13);
  const kShotsFinish = new ScriptableProvider();
  kShotsFinish.push({text: JSON.stringify({shots: makeValidShots()})});
  await runDispatchJob(
    kShotsClaimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider: kShotsFinish, heartbeatMs: 60_000},
  );
  ok(runRow(projectId, 'm7_shots', 'req-shots-running-0001')?.status === 'succeeded', 'K14 shots dispatch 收尾（run succeeded）');

  // K15-K17：既有 stage（visual-intents route）dispatch-only running
  const k15 = await postJson(visualPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: 'req-intent-running-0001',
  });
  ok(k15.status === 202 && k15.json.status === 'queued', 'K15 visual-intents POST → 202 queued', k15);
  const kIntentClaimed = claimNextAnyJob('worker-running-window-3');
  ok(kIntentClaimed !== null && kIntentClaimed.type === 'dispatch', 'K16 visual-intents scheduler claim', kIntentClaimed?.type);
  if (kIntentClaimed === null || kIntentClaimed.type !== 'dispatch') throw new Error('fixture: K intent claim failed');
  const k17 = await postJson(visualPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    requestId: 'req-intent-running-0001',
  });
  ok(k17.status === 202 && k17.json.status === 'running' && k17.json.dispatchId === kIntentClaimed.job.id, 'K17 visual-intents 同 source POST → 202 running（既有 stage 一致）', k17);
  const kIntentFinish = new ScriptableProvider();
  kIntentFinish.push({text: JSON.stringify({intents: makeValidIntents(plan)})});
  await runDispatchJob(
    kIntentClaimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider: kIntentFinish, heartbeatMs: 60_000},
  );
  ok(runRow(projectId, 'm7_visual_intent', 'req-intent-running-0001')?.status === 'succeeded', 'K18 visual-intents dispatch 收尾（run succeeded）');

  // K19-K22：dispatch-only running 时不同 source → 409、原 dispatch 仍 running、source 未覆盖
  const k19 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentArtifactId,
    requestId: 'req-seq-running-conflict-0001',
  });
  ok(k19.status === 202 && k19.json.status === 'queued', 'K19 conflict-window POST A → 202 queued', k19);
  const kConflictClaimed = claimNextAnyJob('worker-running-window-4');
  if (kConflictClaimed === null || kConflictClaimed.type !== 'dispatch') throw new Error('fixture: K conflict claim failed');
  const k20 = await postJson(seqPOST, projectId, {
    narrativeBeatsArtifactId: beatsArtifactId,
    visualIntentPlanArtifactId: intentAltBuild.artifact.id,
    requestId: 'req-seq-running-conflict-0001',
  });
  ok(k20.status === 409 && k20.json.error === 'REQUEST_ID_CONFLICT', 'K20 dispatch-only running 不同 source → 409', k20);
  const kConflictRow = getDb().prepare('SELECT status, source_artifact_id FROM generation_dispatch_jobs WHERE id = ?').get(kConflictClaimed.job.id) as {status: string; source_artifact_id: string};
  ok(kConflictRow.status === 'running', 'K21 原 dispatch 仍 running（未被修改）', kConflictRow.status);
  ok(kConflictRow.source_artifact_id === composeSequencesSourceKey(beatsArtifactId, intentArtifactId), 'K22 source 未覆盖（仍为 A）');
  ok(runRow(projectId, 'm7_visual_sequences', 'req-seq-running-conflict-0001') === undefined, 'K23 冲突后 generation_runs=0');
  // 收尾
  const kConflictFinish = new ScriptableProvider();
  kConflictFinish.push({text: JSON.stringify({sequences: makeValidSequences()})});
  await runDispatchJob(
    kConflictClaimed.job,
    {isShuttingDown: () => false, log: () => {}},
    {provider: kConflictFinish, heartbeatMs: 60_000},
  );

  // ═══════ L. run/dispatch source 矛盾 fail-closed（M7.3B.R2 P1） ═══════
  console.log('── L. source invariant');
  function insertRunRow(projectId: string, stage: string, requestId: string, source: string, status: string): void {
    getDb().prepare(
      `INSERT INTO generation_runs (id, project_id, stage, request_id, source_artifact_id, status, owner_token, lease_expires_at, result_artifact_id, error_code, error_message, created_at, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'tok', ?, NULL, NULL, NULL, ?, ?, NULL, ?)`,
    ).run(crypto.randomUUID(), projectId, stage, requestId, source, status, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  }
  function insertDispatchRow(projectId: string, stage: string, requestId: string, source: string, status: string): void {
    getDb().prepare(
      `INSERT INTO generation_dispatch_jobs (id, project_id, stage, request_id, source_artifact_id, status, owner_token, lease_expires_at, generation_run_id, result_artifact_id, error_code, error_message, created_at, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
    ).run(crypto.randomUUID(), projectId, stage, requestId, source, status, new Date().toISOString(), new Date().toISOString());
  }
  const expectConflictBothWays = undefined;
  void expectConflictBothWays;

  // L1：run succeeded (A) + dispatch succeeded (B) → 双向 fail-closed
  {
    insertRunRow(projectId, 'm7_visual_sequences', 'req-l1-0001', 'src-l1-a', 'succeeded');
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l1-0001', 'src-l1-b', 'succeeded');
    let a = false;
    let b = false;
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l1-0001', sourceArtifactId: 'src-l1-a'}); } catch (err) { a = err instanceof RequestIdConflictError; }
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l1-0001', sourceArtifactId: 'src-l1-b'}); } catch (err) { b = err instanceof RequestIdConflictError; }
    ok(a && b, 'L1 run succeeded(A)+dispatch succeeded(B) → input=A 与 input=B 均 fail-closed', {a, b});
    const l1Rows = getDb().prepare(`SELECT source_artifact_id, status FROM generation_runs WHERE request_id = 'req-l1-0001'`).all() as Array<{source_artifact_id: string; status: string}>;
    const l1Disps = getDb().prepare(`SELECT source_artifact_id, status FROM generation_dispatch_jobs WHERE request_id = 'req-l1-0001'`).all() as Array<{source_artifact_id: string; status: string}>;
    ok(l1Rows[0]!.source_artifact_id === 'src-l1-a' && l1Rows[0]!.status === 'succeeded', 'L1b run 行 source/status 完全不变');
    ok(l1Disps[0]!.source_artifact_id === 'src-l1-b' && l1Disps[0]!.status === 'succeeded', 'L1c dispatch 行 source/status 完全不变');
  }
  // L2：run failed (A) + dispatch failed (B) → 双向 fail-closed
  {
    insertRunRow(projectId, 'm7_visual_sequences', 'req-l2-0001', 'src-l2-a', 'failed');
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l2-0001', 'src-l2-b', 'failed');
    let a = false;
    let b = false;
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l2-0001', sourceArtifactId: 'src-l2-a'}); } catch (err) { a = err instanceof RequestIdConflictError; }
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l2-0001', sourceArtifactId: 'src-l2-b'}); } catch (err) { b = err instanceof RequestIdConflictError; }
    ok(a && b, 'L2 run failed(A)+dispatch failed(B) → 双向 fail-closed（不按先后返回 terminal）', {a, b});
    // L2 错误 message 必须说明双持久 source
    let msg = '';
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l2-0001', sourceArtifactId: 'src-l2-a'}); } catch (err) { msg = err instanceof Error ? err.message : ''; }
    ok(msg.includes('dispatch source=src-l2-b') && msg.includes('fail-closed'), 'L2b 错误 message 列出 persisted dispatch source 与 fail-closed 语义', msg);
  }
  // L3：run running (A) + dispatch running (B) → 双向 fail-closed
  {
    insertRunRow(projectId, 'm7_visual_sequences', 'req-l3-0001', 'src-l3-a', 'running');
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l3-0001', 'src-l3-b', 'running');
    let a = false;
    let b = false;
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l3-0001', sourceArtifactId: 'src-l3-a'}); } catch (err) { a = err instanceof RequestIdConflictError; }
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l3-0001', sourceArtifactId: 'src-l3-b'}); } catch (err) { b = err instanceof RequestIdConflictError; }
    ok(a && b, 'L3 run running(A)+dispatch running(B) → 双向 fail-closed（不返回 running）', {a, b});
  }
  // L4：dispatch cancelled（无 run）→ input 匹配 → terminal；input 不同 → 抛
  {
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l4-0001', 'src-l4-a', 'cancelled');
    const l4a = enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l4-0001', sourceArtifactId: 'src-l4-a'});
    ok(l4a.kind === 'terminal' && l4a.status === 'failed', 'L4a dispatch cancelled（同 source）→ terminal', l4a);
    let bThrew = false;
    try { enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l4-0001', sourceArtifactId: 'src-l4-b'}); } catch (err) { bThrew = err instanceof RequestIdConflictError; }
    ok(bThrew, 'L4b dispatch cancelled 不同 source → fail-closed');
  }
  // L5：正常一致 run+dispatch source-A → succeeded reused / failed terminal / running running
  {
    insertRunRow(projectId, 'm7_visual_sequences', 'req-l5a-0001', 'src-l5-a', 'succeeded');
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l5a-0001', 'src-l5-a', 'succeeded');
    const l5a = enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l5a-0001', sourceArtifactId: 'src-l5-a'});
    ok(l5a.kind === 'reused', 'L5a 一致 succeeded → reused', l5a);
    insertRunRow(projectId, 'm7_visual_sequences', 'req-l5b-0001', 'src-l5-a', 'failed');
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l5b-0001', 'src-l5-a', 'failed');
    const l5b = enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l5b-0001', sourceArtifactId: 'src-l5-a'});
    ok(l5b.kind === 'terminal' && l5b.status === 'failed', 'L5b 一致 failed → terminal', l5b);
    insertRunRow(projectId, 'm7_visual_sequences', 'req-l5c-0001', 'src-l5-a', 'running');
    insertDispatchRow(projectId, 'm7_visual_sequences', 'req-l5c-0001', 'src-l5-a', 'running');
    const l5c = enqueueGenerationDispatch(getDb(), {projectId, stage: 'm7_visual_sequences', requestId: 'req-l5c-0001', sourceArtifactId: 'src-l5-a'});
    ok(l5c.kind === 'running', 'L5c 一致 running → running', l5c);
  }

  console.log(`\n==== test-m73b-generation: ${pass} PASS / ${fail} FAIL ====`);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-generation'), {recursive: true, force: true});
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

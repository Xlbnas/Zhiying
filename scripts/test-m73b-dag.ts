/**
 * M7.3B M7 candidate DAG 测试（临时 DB + Mock provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m73b-dag.ts
 * 覆盖（11.5）：
 * - 图结构：无反向边、无环；
 * - visual_sequences 等待 Beats + Visual Intent（源缺失/失效 → blocked）；
 * - shots 等待 visual sequences；
 * - 节点状态机：not_generated → generation_running → ready / needs_review /
 *   generation_failed / blocked；
 * - 无关 TTS job 可与 llm_api dispatch 并行（不影响 m7 DAG 状态）；
 * - Voice/Performance 概念源变化不 stale Sequence/Shot（无关 stage 写入零影响）；
 * - Narration Plan 结构性 source 漂移经 Beats/Intent 传播 stale → 全链 blocked；
 * - unresolved 进入 needs_review；
 * - 全流程不触碰 projects.pipeline_version / m7_pipeline_snapshot_id（无 m7 激活）。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m73b-dag');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {buildNarrativeBeats} from '../src/lib/narrative-beats/plan';
import type {NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {buildVisualIntentPlan} from '../src/lib/visual-intent/plan';
import type {VisualIntentV1} from '../src/lib/visual-intent/schema';
import {buildVisualSequences} from '../src/lib/visual-sequences/plan';
import type {VisualSequenceV1} from '../src/lib/visual-sequences/schema';
import {buildShots} from '../src/lib/shots/plan';
import type {ShotV1} from '../src/lib/shots/schema';
import {listShotsRows} from '../src/lib/shots/classify';
import {listVisualSequencesCandidates, listVisualSequencesRows} from '../src/lib/visual-sequences/classify';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runDispatchJob} from '../src/worker/dispatch-executor';
import {
  detectM7DagCycles,
  detectM7DagReverseEdges,
  m7DownstreamOf,
  M7_DAG_NODES,
  type M7DagNodeId,
} from '../src/lib/m7-dag/dag';
import {computeM7DagNodeStates, isCandidateUsableForDownstream} from '../src/lib/m7-dag/readiness';
import {enqueueGenerationDispatch} from '../src/lib/llm-generation/dispatch';

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-dag'), {recursive: true, force: true});

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
  private queue: Array<{text?: string; finishReason?: string; error?: Error}> = [];

  push(resp: {text?: string; finishReason?: string; error?: Error}): void {
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

/** 每 beat 一个 SHOW_PERSON intent（合法矩阵，无 continuation/unresolved）。 */
function makeValidIntents(beats: NarrativeBeatV1[]): VisualIntentV1[] {
  return beats.map((beat, index) => ({
    visualIntentId: `V${String(index + 1).padStart(3, '0')}`,
    chapter: beat.chapter,
    beatIds: [beat.beatId],
    intent: 'SHOW_PERSON',
    strategy: 'portrait',
    authenticity: 'authentic_required',
    objective: 'o',
    subject: {kind: 'person', label: 'l', evidenceIds: []},
    continuationOfVisualIntentId: null,
    displayText: null,
  }));
}

function makeValidSequences(beats: NarrativeBeatV1[]): VisualSequenceV1[] {
  const ch1 = beats.filter((b) => b.chapter === 1);
  const ch2 = beats.filter((b) => b.chapter === 2);
  return [
    {sequenceId: 'Q001', chapter: 1, beatIds: ch1.map((b) => b.beatId), visualIntentIds: ch1.map((b) => `V${b.beatId.replace('B', '')}`)},
    {sequenceId: 'Q002', chapter: 2, beatIds: ch2.map((b) => b.beatId), visualIntentIds: ch2.map((b) => `V${b.beatId.replace('B', '')}`)},
  ];
}

function makeValidShots(sequences: VisualSequenceV1[], plan: NarrationPlanV2): ShotV1[] {
  const shots: ShotV1[] = [];
  let shotIndex = 1;
  sequences.forEach((seq, seqIdx) => {
    const unitIds: string[] = [];
    for (const beatId of seq.beatIds) {
      const beatIndex = Number(beatId.replace('B', '')) - 1;
      unitIds.push(plan.units[beatIndex]!.id);
    }
    unitIds.forEach((unitId, i) => {
      shots.push({
        shotId: `H${String(shotIndex++).padStart(3, '0')}`,
        sequenceId: seq.sequenceId,
        chapter: seq.chapter,
        unitIds: [unitId],
        visualIntentId: seq.visualIntentIds[Math.min(i, seq.visualIntentIds.length - 1)]!,
        transitionFromPrevious: i === 0 ? (seqIdx === 0 ? 'cut' : 'cut') : 'cut',
      });
    });
  });
  return shots;
}

async function buildChain(
  projectId: string,
  plan: NarrationPlanV2,
  beats: NarrativeBeatV1[],
  intents: VisualIntentV1[],
  narrationArtifactId: string,
): Promise<{beatsArtifactId: string; intentArtifactId: string; sequencesArtifactId: string; shotsArtifactId: string}> {
  const bp = new ScriptableProvider();
  bp.push({text: JSON.stringify({beats})});
  const bb = await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: narrationArtifactId, requestId: `req-dag-beats-${crypto.randomUUID().slice(0, 8)}`, provider: bp});
  if (bb.kind !== 'succeeded') throw new Error('dag fixture: beats build failed');
  const ip = new ScriptableProvider();
  ip.push({text: JSON.stringify({intents})});
  const ib = await buildVisualIntentPlan({projectId, narrativeBeatsArtifactId: bb.artifact.id, requestId: `req-dag-intent-${crypto.randomUUID().slice(0, 8)}`, provider: ip});
  if (ib.kind !== 'succeeded') throw new Error('dag fixture: intent build failed');
  const sp = new ScriptableProvider();
  sp.push({text: JSON.stringify({sequences: makeValidSequences(beats)})});
  const sb = await buildVisualSequences({projectId, narrativeBeatsArtifactId: bb.artifact.id, visualIntentPlanArtifactId: ib.artifact.id, requestId: `req-dag-seq-${crypto.randomUUID().slice(0, 8)}`, provider: sp});
  if (sb.kind !== 'succeeded') throw new Error('dag fixture: sequences build failed');
  const shp = new ScriptableProvider();
  shp.push({text: JSON.stringify({shots: makeValidShots(sb.visualSequences.sequences, plan)})});
  const shb = await buildShots({projectId, visualSequencesArtifactId: sb.artifact.id, requestId: `req-dag-shots-${crypto.randomUUID().slice(0, 8)}`, provider: shp});
  if (shb.kind !== 'succeeded') throw new Error('dag fixture: shots build failed');
  return {beatsArtifactId: bb.artifact.id, intentArtifactId: ib.artifact.id, sequencesArtifactId: sb.artifact.id, shotsArtifactId: shb.artifact.id};
}

function stateOf(projectId: string, node: M7DagNodeId): {status: string; detail: string | null} {
  return computeM7DagNodeStates(projectId)[node]!;
}

/** Worker-side dispatch：claim 下一个 dispatch 并以注入 provider 执行。 */
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

async function main(): Promise<void> {
  // ═══════ A. 图结构 ═══════
  console.log('── A. graph');
  ok(detectM7DagCycles() === null, 'A1 无环（DFS 检测）');
  ok(detectM7DagReverseEdges().length === 0, 'A2 无反向边');
  ok(M7_DAG_NODES.length === 5, 'A3 5 个节点（narration_plan_v2/beats/intent/sequences/shots）');
  const seqDeps = M7_DAG_NODES.find((n) => n.id === 'visual_sequences')!.dependencies;
  ok(seqDeps.join(',') === 'narrative_beats,visual_intent_plan', 'A4 visual_sequences 依赖 beats+intent（无 narration 反向）');
  const shotDeps = M7_DAG_NODES.find((n) => n.id === 'shots')!.dependencies;
  ok(
    shotDeps.includes('visual_sequences') && shotDeps.includes('narration_plan_v2'),
    'A5 shots 依赖 sequences+beats+intent+narration_plan_v2',
  );
  ok(!shotDeps.includes('shots') && !M7_DAG_NODES.some((n) => n.dependencies.includes('shots')), 'A6 Shots 不得成为任何节点的 source（无反向边）');
  ok(m7DownstreamOf('narrative_beats').join(',') === 'visual_sequences,shots', 'A7 beats 下游 = sequences,shots');
  ok(!m7DownstreamOf('visual_sequences').includes('narrative_beats'), 'A8 无反向可达（sequences 不是 beats 的下游）');

  // ═══════ B. 节点状态机 ═══════
  console.log('── B. states');
  const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');

  // B1：narration plan 已生成（M7.1 产物）→ ready；其余空 → not_generated
  const emptyStates = computeM7DagNodeStates(projectId);
  ok(emptyStates.narration_plan_v2!.status === 'not_generated', 'B1a 空项目 narration_plan_v2 not_generated', emptyStates.narration_plan_v2);
  const planA = buildNarrationPlanV2(projectId);
  const plan = planA.plan;
  const beats = makeValidBeats(plan);
  const intents = makeValidIntents(beats);
  const narrationArtifactId = planA.artifact.id;
  const statesAfterPlan = computeM7DagNodeStates(projectId);
  ok(statesAfterPlan.narration_plan_v2!.status === 'ready', 'B1b narration plan 生成后 ready');
  ok(statesAfterPlan.narrative_beats!.status === 'not_generated', 'B1c beats 无 candidate → not_generated');
  ok(statesAfterPlan.visual_intent_plan!.status === 'not_generated', 'B1d intent 无 candidate → not_generated');
  ok(statesAfterPlan.visual_sequences!.status === 'blocked', 'B1e sequences 依赖 beats/intent 缺失 → blocked', statesAfterPlan.visual_sequences);
  ok(statesAfterPlan.shots!.status === 'blocked', 'B1f shots 依赖链缺失 → blocked', statesAfterPlan.shots);

  // B2：只生成 beats → sequences blocked（intent 缺失）、shots blocked（sequences 缺失）
  const bp = new ScriptableProvider();
  bp.push({text: JSON.stringify({beats})});
  const bb = await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: narrationArtifactId, requestId: 'req-dag-beats-0001', provider: bp});
  if (bb.kind !== 'succeeded') throw new Error('fixture: beats build failed');
  const beatsArtifactId = bb.artifact.id;
  let states = computeM7DagNodeStates(projectId);
  ok(states.narrative_beats!.status === 'ready', 'B2a beats 生成后节点 ready', states.narrative_beats);
  ok(states.visual_sequences!.status === 'blocked', 'B2b sequences 依赖 intent 缺失 → blocked', states.visual_sequences);
  ok(states.shots!.status === 'blocked', 'B2c shots 依赖 sequences 缺失 → blocked', states.shots);

  // B3：intent 生成后 → sequences not_generated（可生成）
  const ip = new ScriptableProvider();
  ip.push({text: JSON.stringify({intents})});
  const ib = await buildVisualIntentPlan({projectId, narrativeBeatsArtifactId: beatsArtifactId, requestId: 'req-dag-intent-0001', provider: ip});
  if (ib.kind !== 'succeeded') throw new Error('fixture: intent build failed');
  const intentArtifactId = ib.artifact.id;
  states = computeM7DagNodeStates(projectId);
  ok(states.visual_intent_plan!.status === 'ready', 'B3a intent 节点 ready');
  ok(states.visual_sequences!.status === 'not_generated', 'B3b 源就绪但无 candidate → not_generated', states.visual_sequences);

  // B4：sequences dispatch queued → generation_running
  const enq = enqueueGenerationDispatch(getDb(), {
    projectId,
    stage: 'm7_visual_sequences',
    requestId: 'req-dag-seq-enq-0001',
    sourceArtifactId: `${beatsArtifactId}|${intentArtifactId}`,
  });
  ok(enq.kind === 'queued', 'B4a sequences dispatch 入队');
  states = computeM7DagNodeStates(projectId);
  ok(states.visual_sequences!.status === 'generation_running', 'B4b dispatch queued → generation_running', states.visual_sequences);

  // B5：worker 执行 dispatch 后 → ready；shots 源就绪 → not_generated
  const sp = new ScriptableProvider();
  sp.push({text: JSON.stringify({sequences: makeValidSequences(beats)})});
  await runNextDispatch(sp);
  const seqRow = listVisualSequencesRows(projectId)[0]!;
  const sequencesArtifactId = seqRow.id;
  states = computeM7DagNodeStates(projectId);
  ok(states.visual_sequences!.status === 'ready', 'B5a sequences candidate → ready', states.visual_sequences);
  ok(states.shots!.status === 'not_generated', 'B5b shots 源就绪但无 candidate → not_generated', states.shots);

  // B6：shots dispatch 执行后 → ready
  const enqShots = enqueueGenerationDispatch(getDb(), {
    projectId,
    stage: 'm7_shots',
    requestId: 'req-dag-shots-0001',
    sourceArtifactId: sequencesArtifactId,
  });
  ok(enqShots.kind === 'queued', 'B6a shots dispatch 入队');
  const parsedSeq = JSON.parse(seqRow.content_json) as {sequences: VisualSequenceV1[]};
  const shp = new ScriptableProvider();
  shp.push({text: JSON.stringify({shots: makeValidShots(parsedSeq.sequences, plan)})});
  await runNextDispatch(shp);
  const shotRow = listShotsRows(projectId)[0]!;
  states = computeM7DagNodeStates(projectId);
  ok(states.shots!.status === 'ready', 'B6b shots candidate → ready', states.shots);
  const shb = {artifact: {id: shotRow.id}};

  // ═══════ C. 并行性与 TTS 边界 ═══════
  console.log('── C. parallelism / TTS boundary');
  // C1：无关 TTS stage 的 generation run/dispatch 不影响 m7 DAG
  const ttsRunId = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO generation_runs (id, project_id, stage, request_id, source_artifact_id, status, owner_token, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, 'm7_tts_placeholder', 'req-tts-0001', 'src-tts', 'running', 'tok', ?, ?, ?)`,
  ).run(ttsRunId, projectId, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), new Date().toISOString());
  const beforeTts = computeM7DagNodeStates(projectId);
  ok(beforeTts.shots!.status === 'ready' && beforeTts.visual_sequences!.status === 'ready', 'C1 无关 TTS run 存在时 m7 DAG 状态不变', beforeTts);

  // C2：Voice/Performance 概念源变化不 stale（构造无关 stage 的 dispatch/artifact——状态不变）
  enqueueGenerationDispatch(getDb(), {
    projectId,
    stage: 'm7_voice_profile_placeholder',
    requestId: 'req-voice-0001',
    sourceArtifactId: 'src-voice',
  });
  const afterVoice = computeM7DagNodeStates(projectId);
  ok(afterVoice.shots!.status === 'ready' && afterVoice.visual_sequences!.status === 'ready', 'C2 Voice/Performance 概念源写入不影响 Sequence/Shot 状态', afterVoice);

  // ═══════ D. source drift 传播 ═══════
  console.log('── D. drift propagation');
  // D1：Narration Plan 结构性漂移 → beats stale → intent stale → sequences stale → shots blocked
  const originalNarrationContent = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(narrationArtifactId) as {content_json: string}).content_json;
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(
    JSON.stringify({...JSON.parse(originalNarrationContent), needsReview: ['drift-injected']}),
    narrationArtifactId,
  );
  states = computeM7DagNodeStates(projectId);
  ok(states.narrative_beats!.status === 'blocked', 'D1a narration 漂移 → beats 节点 blocked（source 失效）', states.narrative_beats);
  ok(states.visual_intent_plan!.status === 'blocked', 'D1b → intent 节点 blocked', states.visual_intent_plan);
  ok(states.visual_sequences!.status === 'blocked', 'D1c → sequences 节点 blocked（全部 candidate stale_source）', states.visual_sequences);
  ok(states.shots!.status === 'blocked', 'D1d → shots 节点 blocked（依赖链失效）', states.shots);
  // 恢复
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(originalNarrationContent, narrationArtifactId);
  states = computeM7DagNodeStates(projectId);
  ok(states.shots!.status === 'ready', 'D1e 恢复后全链回到 ready');

  // D2：精确 source ID 改变 → stale（构造指向不存在序列的 shots artifact）
  const driftShotsContent = (() => {
    const row = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(shb.artifact.id) as {content_json: string};
    const parsed = JSON.parse(row.content_json) as {source: Record<string, string>};
    parsed.source.visualSequencesArtifactId = 'no-such-sequences';
    return JSON.stringify(parsed);
  })();
  const driftShotsId = `shot-art-${crypto.randomUUID()}`;
  getDb().prepare(`INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at) VALUES (?, ?, 'shot_plan', (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id = ? AND kind = 'shot_plan'), ?, NULL, ?)`)
    .run(driftShotsId, projectId, projectId, driftShotsContent, new Date().toISOString());
  states = computeM7DagNodeStates(projectId);
  ok(states.shots!.status === 'ready', 'D2 存在合法 candidate 时节点仍 ready（stale candidate 不拖累）', states.shots);

  // ═══════ E. unresolved → needs_review ═══════
  console.log('── E. unresolved');
  const unresolvedIntents: VisualIntentV1[] = intents.map((i, idx) =>
    idx === 2
      ? {...i, intent: 'VISUAL_UNRESOLVED' as const, strategy: 'unresolved' as const, authenticity: 'not_applicable' as const, subject: {kind: 'none' as const, label: null, evidenceIds: []}}
      : i,
  );
  const unresolvedProject = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
  const planU = buildNarrationPlanV2(unresolvedProject);
  const beatsU = makeValidBeats(planU.plan);
  const uChain = await buildChain(unresolvedProject, planU.plan, beatsU, unresolvedIntents, planU.artifact.id);
  const uStates = computeM7DagNodeStates(unresolvedProject);
  ok(uStates.visual_sequences!.status === 'needs_review', 'E1 unresolved intent 链 → sequences 节点 needs_review', uStates.visual_sequences);
  ok(uStates.shots!.status === 'needs_review', 'E2 → shots 节点 needs_review（unresolved 传播）', uStates.shots);
  void uChain;

  // ═══════ F. 无 m7 激活 ═══════
  console.log('── F. no activation');
  const projectRows = getDb().prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects').all() as Array<{pipeline_version: string; m7_pipeline_snapshot_id: string | null}>;
  ok(projectRows.every((r) => r.pipeline_version === 'm6' && r.m7_pipeline_snapshot_id === null), 'F1 全部项目仍 m6 / snapshot NULL（无激活）');
  const snapshotCount = (getDb().prepare(`SELECT COUNT(*) AS c FROM artifacts WHERE kind = 'm7_pipeline_snapshot'`).get() as {c: number}).c;
  ok(snapshotCount === 0, 'F2 无 M7 pipeline snapshot');

  // ═══════ G. DAG usable-candidate 语义（M7.3B.R1 P1） ═══════
  console.log('── G. usable-candidate');
  function insertFailedRun(projectId: string, stage: string, requestId: string): void {
    getDb().prepare(
      `INSERT INTO generation_runs (id, project_id, stage, request_id, source_artifact_id, status, owner_token, lease_expires_at, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'src', 'failed', 'tok', ?, 'TEST_FAILED', ?, ?)`,
    ).run(crypto.randomUUID(), projectId, stage, requestId, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), new Date().toISOString());
  }

  // G1：Intent running——fixture 前置 eligible beats，无 intent candidate，intent dispatch queued。
  // 精确断言：blocker 只因 visual_intent_plan，不得同时因 beats 缺失。
  {
    const p = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const planP = buildNarrationPlanV2(p);
    const beatsP = makeValidBeats(planP.plan);
    const bp = new ScriptableProvider();
    bp.push({text: JSON.stringify({beats: beatsP})});
    const bb = await buildNarrativeBeats({projectId: p, narrationPlanV2ArtifactId: planP.artifact.id, requestId: 'req-g1-beats-0001', provider: bp});
    if (bb.kind !== 'succeeded') throw new Error('fixture: g1 beats build failed');
    enqueueGenerationDispatch(getDb(), {projectId: p, stage: 'm7_visual_intent', requestId: 'req-g1-intent-0001', sourceArtifactId: bb.artifact.id});
    const st = computeM7DagNodeStates(p);
    ok(st.narrative_beats!.status === 'ready', 'G1a beats ready（fixture 前置）', st.narrative_beats);
    ok(st.visual_intent_plan!.status === 'generation_running', 'G1b intent dispatch queued → intent=generation_running', st.visual_intent_plan);
    ok(st.visual_sequences!.status === 'blocked', 'G1c intent 无可用 candidate → sequences=blocked', st.visual_sequences);
    ok(
      st.visual_sequences!.detail?.includes('visual_intent_plan') === true &&
        st.visual_sequences!.detail?.includes('narrative_beats') === false,
      'G1d blocker detail 只含 visual_intent_plan（beats 已 ready，不因 beats 缺失）',
      st.visual_sequences!.detail,
    );
  }

  // G2：Intent failed——独立新项目：plan+beats ready、无 intent candidate、
  // 仅 failed run、无 queued/running intent dispatch。
  {
    const p = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const planP = buildNarrationPlanV2(p);
    const beatsP = makeValidBeats(planP.plan);
    const bp = new ScriptableProvider();
    bp.push({text: JSON.stringify({beats: beatsP})});
    const bb = await buildNarrativeBeats({projectId: p, narrationPlanV2ArtifactId: planP.artifact.id, requestId: 'req-g2-beats-0001', provider: bp});
    if (bb.kind !== 'succeeded') throw new Error('fixture: g2 beats build failed');
    insertFailedRun(p, 'm7_visual_intent', 'req-g2-intent-0001');
    const activeDispatch = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM generation_dispatch_jobs WHERE project_id = ? AND stage = 'm7_visual_intent' AND status IN ('queued','running')`)
      .get(p) as {c: number};
    ok(activeDispatch.c === 0, 'G2a 无 queued/running intent dispatch（fixture 隔离）');
    const st = computeM7DagNodeStates(p);
    ok(st.narrative_beats!.status === 'ready', 'G2b beats ready');
    ok(st.visual_intent_plan!.status === 'generation_failed', 'G2c intent generation_failed', st.visual_intent_plan);
    ok(st.visual_sequences!.status === 'blocked', 'G2d intent failed 且无 candidate → sequences=blocked', st.visual_sequences);
    ok(
      st.visual_sequences!.detail?.includes('visual_intent_plan') === true &&
        st.visual_sequences!.detail?.includes('narrative_beats') === false,
      'G2e dependency blocker 为 visual_intent_plan（不因 beats）',
      st.visual_sequences!.detail,
    );
  }

  // G3：Sequence running——plan/beats/intent 全部可用、无 sequence candidate、sequence dispatch queued。
  {
    const p = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const planP = buildNarrationPlanV2(p);
    const beatsP = makeValidBeats(planP.plan);
    const bp = new ScriptableProvider();
    bp.push({text: JSON.stringify({beats: beatsP})});
    const bb = await buildNarrativeBeats({projectId: p, narrationPlanV2ArtifactId: planP.artifact.id, requestId: 'req-g3-beats-0001', provider: bp});
    if (bb.kind !== 'succeeded') throw new Error('fixture: g3 beats build failed');
    const ip = new ScriptableProvider();
    ip.push({text: JSON.stringify({intents: makeValidIntents(beatsP)})});
    const ib = await buildVisualIntentPlan({projectId: p, narrativeBeatsArtifactId: bb.artifact.id, requestId: 'req-g3-intent-0001', provider: ip});
    if (ib.kind !== 'succeeded') throw new Error('fixture: g3 intent build failed');
    enqueueGenerationDispatch(getDb(), {projectId: p, stage: 'm7_visual_sequences', requestId: 'req-g3-seq-0001', sourceArtifactId: `${bb.artifact.id}|${ib.artifact.id}`});
    const st = computeM7DagNodeStates(p);
    ok(st.narrative_beats!.status === 'ready' && st.visual_intent_plan!.status === 'ready', 'G3a 上游全部可用（fixture 前置）');
    ok(st.visual_sequences!.status === 'generation_running', 'G3b sequences dispatch queued → running', st.visual_sequences);
    ok(st.shots!.status === 'blocked', 'G3c sequences 无可用 candidate → shots=blocked', st.shots);
    ok(st.shots!.detail?.includes('visual_sequences') === true, 'G3d shots blocker 因 sequences 缺 candidate', st.shots!.detail);
  }

  // G4：Sequence failed——独立新项目（与 G3 完全隔离，无 queued/running sequence dispatch）。
  {
    const p = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const planP = buildNarrationPlanV2(p);
    const beatsP = makeValidBeats(planP.plan);
    const bp = new ScriptableProvider();
    bp.push({text: JSON.stringify({beats: beatsP})});
    const bb = await buildNarrativeBeats({projectId: p, narrationPlanV2ArtifactId: planP.artifact.id, requestId: 'req-g4-beats-0001', provider: bp});
    if (bb.kind !== 'succeeded') throw new Error('fixture: g4 beats build failed');
    const ip = new ScriptableProvider();
    ip.push({text: JSON.stringify({intents: makeValidIntents(beatsP)})});
    const ib = await buildVisualIntentPlan({projectId: p, narrativeBeatsArtifactId: bb.artifact.id, requestId: 'req-g4-intent-0001', provider: ip});
    if (ib.kind !== 'succeeded') throw new Error('fixture: g4 intent build failed');
    insertFailedRun(p, 'm7_visual_sequences', 'req-g4-seq-0001');
    const activeDispatch = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM generation_dispatch_jobs WHERE project_id = ? AND stage = 'm7_visual_sequences' AND status IN ('queued','running')`)
      .get(p) as {c: number};
    ok(activeDispatch.c === 0, 'G4a 无 queued/running sequence dispatch（与 G3 隔离，不被 G3 信封污染）');
    const st = computeM7DagNodeStates(p);
    ok(st.visual_sequences!.status === 'generation_failed', 'G4b sequences generation_failed', st.visual_sequences);
    ok(st.shots!.status === 'blocked', 'G4c sequences failed 且无 candidate → shots=blocked', st.shots);
    ok(st.shots!.detail?.includes('visual_sequences') === true, 'G4d shots blocker 因 sequences', st.shots!.detail);
  }

  // G5：old valid candidate + regeneration running——精确断言（主项目完整链：sequences+shots 均 ready）。
  {
    const p = projectId;
    enqueueGenerationDispatch(getDb(), {projectId: p, stage: 'm7_visual_sequences', requestId: 'req-g5-regenerate-0001', sourceArtifactId: `${beatsArtifactId}|${intentArtifactId}`});
    const st = computeM7DagNodeStates(p);
    ok(st.visual_sequences!.status === 'generation_running', 'G5a regenerate running（旧 candidate 仍存在）', st.visual_sequences);
    const seqCands = listVisualSequencesCandidates(p);
    ok(seqCands.some((c) => c.status === 'current_candidate'), 'G5b 原合法 Sequence candidate 仍 usable（current_candidate 存在）');
    ok(st.visual_sequences!.currentCandidateCount >= 1, 'G5c 节点 currentCandidateCount ≥ 1', st.visual_sequences);
    ok(st.shots!.status === 'ready', 'G5d 已有合法 Shot → shots 保持 ready（不受上游 running 影响，精确断言）', st.shots);
  }

  // G6/G7：needs_review 真实链（保留）——见下方 G6a-G7b。

  // G8：usable 纯判定 truth table（isCandidateUsableForDownstream）。
  ok(isCandidateUsableForDownstream('narration_plan_v2', 'eligible_candidate', 'shots') === true, 'G8a narration eligible → usable for shots');
  ok(isCandidateUsableForDownstream('narration_plan_v2', 'needs_review', 'shots') === false, 'G8b narration needs_review → 不可用');
  ok(isCandidateUsableForDownstream('visual_intent_plan', 'needs_review', 'visual_sequences') === true, 'G8c intent needs_review → usable for sequences');
  ok(isCandidateUsableForDownstream('visual_intent_plan', 'needs_review', 'shots') === true, 'G8d intent needs_review → usable for shots');
  ok(isCandidateUsableForDownstream('visual_sequences', 'needs_review', 'shots') === true, 'G8e sequences needs_review → usable for shots');
  ok(isCandidateUsableForDownstream('visual_sequences', 'stale_source', 'shots') === false, 'G8f stale → 不可用');
  ok(isCandidateUsableForDownstream('visual_intent_plan', 'invalid_source', 'visual_sequences') === false, 'G8g invalid → 不可用');
  ok(isCandidateUsableForDownstream('visual_sequences', 'eligible_candidate', 'visual_intent_plan') === false, 'G8h 不相关 downstream → false');
  ok(isCandidateUsableForDownstream('visual_intent_plan', 'eligible_candidate', 'shots') === true, 'G8i intent current → usable for shots');

  // G6：Visual Intent needs_review → sequences 允许 not_generated（不误判不可用）
  {
    const p = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const planP = buildNarrationPlanV2(p);
    const beatsP = makeValidBeats(planP.plan);
    const bp = new ScriptableProvider();
    bp.push({text: JSON.stringify({beats: beatsP})});
    const bb = await buildNarrativeBeats({projectId: p, narrationPlanV2ArtifactId: planP.artifact.id, requestId: 'req-g6-beats-0001', provider: bp});
    if (bb.kind !== 'succeeded') throw new Error('fixture: g6 beats build failed');
    const unresolvedIntentsG6: VisualIntentV1[] = makeValidIntents(beatsP).map((i, idx) =>
      idx === 2
        ? {...i, intent: 'VISUAL_UNRESOLVED' as const, strategy: 'unresolved' as const, authenticity: 'not_applicable' as const, subject: {kind: 'none' as const, label: null, evidenceIds: []}}
        : i,
    );
    const ip = new ScriptableProvider();
    ip.push({text: JSON.stringify({intents: unresolvedIntentsG6})});
    const ib = await buildVisualIntentPlan({projectId: p, narrativeBeatsArtifactId: bb.artifact.id, requestId: 'req-g6-intent-0001', provider: ip});
    if (ib.kind !== 'succeeded') throw new Error('fixture: g6 intent build failed');
    const st = computeM7DagNodeStates(p);
    ok(st.visual_intent_plan!.status === 'needs_review', 'G6a intent needs_review', st.visual_intent_plan);
    ok(st.visual_sequences!.status === 'not_generated', 'G6b intent needs_review 对 sequences 可用 → not_generated（可生成，不误判 blocked）', st.visual_sequences);
  }


  // G7：Visual Sequences needs_review → shots 允许 not_generated
  {
    const p = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const planP = buildNarrationPlanV2(p);
    const beatsP = makeValidBeats(planP.plan);
    const bp = new ScriptableProvider();
    bp.push({text: JSON.stringify({beats: beatsP})});
    const bb = await buildNarrativeBeats({projectId: p, narrationPlanV2ArtifactId: planP.artifact.id, requestId: 'req-g7-beats-0001', provider: bp});
    if (bb.kind !== 'succeeded') throw new Error('fixture: g7 beats build failed');
    const unresolvedIntentsG7: VisualIntentV1[] = makeValidIntents(beatsP).map((i, idx) =>
      idx === 2
        ? {...i, intent: 'VISUAL_UNRESOLVED' as const, strategy: 'unresolved' as const, authenticity: 'not_applicable' as const, subject: {kind: 'none' as const, label: null, evidenceIds: []}}
        : i,
    );
    const ip = new ScriptableProvider();
    ip.push({text: JSON.stringify({intents: unresolvedIntentsG7})});
    const ib = await buildVisualIntentPlan({projectId: p, narrativeBeatsArtifactId: bb.artifact.id, requestId: 'req-g7-intent-0001', provider: ip});
    if (ib.kind !== 'succeeded') throw new Error('fixture: g7 intent build failed');
    const sp = new ScriptableProvider();
    sp.push({text: JSON.stringify({sequences: makeValidSequences(beatsP)})});
    const sb = await buildVisualSequences({projectId: p, narrativeBeatsArtifactId: bb.artifact.id, visualIntentPlanArtifactId: ib.artifact.id, requestId: 'req-g7-seq-0001', provider: sp});
    if (sb.kind !== 'succeeded') throw new Error('fixture: g7 sequences build failed');
    const st = computeM7DagNodeStates(p);
    ok(st.visual_sequences!.status === 'needs_review', 'G7a sequences needs_review', st.visual_sequences);
    ok(st.shots!.status === 'not_generated', 'G7b sequences needs_review 对 shots 可用 → not_generated（可生成，不误判 blocked）', st.shots);
  }


  console.log(`\n==== test-m73b-dag: ${pass} PASS / ${fail} FAIL ====`);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m73b-dag'), {recursive: true, force: true});
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

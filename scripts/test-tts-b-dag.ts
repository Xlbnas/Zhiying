/**
 * TTS-B.R1 — DAG 测试（设计文档 §8 / §十：F1-F13，双依赖语义）。
 *
 * 每条使用独立项目（或明确清除前一条活动数据），避免 fixture 污染。
 * 真实 drift：lock 新 Script V2 不改旧 plan artifact content_json。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join('data', 'test-tts-b-dag-r1');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {createVoiceProfile, setVoiceProfileStatus} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment, classifyProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {
  buildNarrationPerformancePlan,
  classifyNarrationPerformancePlan,
  type PerformanceArtifactRow,
} from '../src/lib/tts-b/performance';
import {
  computeTtsBDagNodeStates,
  detectTtsBDagCycles,
  detectTtsBDagReverseEdges,
  deriveTtsBDagEdges,
  deriveTtsBDagTopologicalOrder,
  TTS_B_DAG_EDGES,
  TTS_B_DAG_NODES,
  validateTtsBDag,
  type TtsBDagNodeDef,
  type TtsBDagNodeId,
} from '../src/lib/tts-b/dag';
import {computeM7DagNodeStates} from '../src/lib/m7-dag/readiness';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 500));
  }
}

const MOCK_DEPS: VoiceLibraryExecDeps = {
  ffprobeImpl: async () => ({durationMs: 2000, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, hasVideo: false}),
  ffmpegImpl: async (args: string[]) => {
    const inputPath = args[args.indexOf('-i') + 1];
    const outPath = args[args.length - 1];
    const h = crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
    fs.writeFileSync(outPath, Buffer.from(`FAKE-CANONICAL:${h}`));
  },
};

class MockProvider implements LLMProvider {
  readonly name = 'mock-llm';
  generate(request: LLMRequest): Promise<LLMResponse> {
    const planMatch = request.user.match(/SpeechUnits:\n([\s\S]*)/);
    const ids = planMatch ? [...planMatch[1].matchAll(/^- (N\d{3}):/gm)].map((m) => m[1]) : [];
    return Promise.resolve({
      text: JSON.stringify({
        items: ids.map((unitId) => ({unitId, deliveryOverride: null, pace: 'normal', energy: 'normal', emotion: {mode: 'none'}})),
      }),
      requestId: `mock-${crypto.randomUUID()}`,
      model: request.model,
      finishReason: 'stop',
      usage: {promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5},
    });
  }
}

const UPSTREAM: WorkflowStage[] = ['project_definition', 'research', 'evidence', 'argument_tree', 'script_v1'];

function makeWav(freq: number): Buffer {
  const sr = 48000;
  const frames = Math.floor((sr * 1500) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sr)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function makeVoiceRevision(freq: number): Promise<{profileId: string; revisionId: string}> {
  const profile = createVoiceProfile({displayName: `dag-v-${freq}`});
  const result = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `dag-rv-${freq}-${crypto.randomUUID()}`, audioBuffer: makeWav(freq)},
    MOCK_DEPS,
  );
  return {profileId: profile.id, revisionId: result.revision.id};
}

/** 项目 + locked script V2 + narration plan（eligible 或 needs_review 或 none）。 */
function setupProject(opts: {plan?: 'eligible' | 'needs_review' | 'none'}): {projectId: string; planBuild: ReturnType<typeof buildNarrationPlanV2> | null} {
  const projectId = createProjectWithWorkflow({topic: `dag-r1-${crypto.randomUUID().slice(0, 8)}`, coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  if (opts.plan === 'none') return {projectId, planBuild: null};
  if (opts.plan === 'needs_review') {
    // legacy 输入模式（无 promptVersion）：@silence 未被 strict 识别 → unknown_directive review
    generateVersion({
      projectId, stage: 'script_v2',
      content: `# Script V2\n\n## 第 1 章 开场（00:00–01:00）\n\n第一句。\n\n@silence 500ms reason=pause\n\n第二句。\n`,
      contentType: 'markdown', source: 'manual_edit',
    });
    lockStage(projectId, 'script_v2');
    return {projectId, planBuild: buildNarrationPlanV2(projectId)};
  }
  const content = `# Script V2\n\n## 第 1 章 开场（00:00–01:00）\n\n第一句。第二句。\n`;
  generateVersion({projectId, stage: 'script_v2', content, contentType: 'markdown', source: 'manual_edit', promptVersion: 'script-v2@2.0'});
  lockStage(projectId, 'script_v2');
  return {projectId, planBuild: buildNarrationPlanV2(projectId)};
}

async function createAssignment(projectId: string, freq = 440): Promise<{profileId: string; revisionId: string; artifactId: string}> {
  const {profileId, revisionId} = await makeVoiceRevision(freq);
  const r = await buildProjectVoiceAssignment({
    projectId,
    voiceProfileId: profileId,
    voiceProfileRevisionId: revisionId,
    requestId: `dag-assign-${crypto.randomUUID()}`,
  });
  return {profileId, revisionId, artifactId: r.artifact.id};
}

async function createPerformance(projectId: string, planArtifactId: string, assignmentArtifactId: string, requestId: string) {
  return buildNarrationPerformancePlan({
    projectId,
    narrationPlanArtifactId: planArtifactId,
    projectVoiceAssignmentArtifactId: assignmentArtifactId,
    requestId,
    provider: new MockProvider(),
  });
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();

  // F1: 无 Plan / 无 Assignment → blocked，detail 两个依赖
  {
    const {projectId} = setupProject({plan: 'none'});
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      s.narration_performance_plan.status === 'blocked' &&
        (s.narration_performance_plan.detail?.includes('narration_plan_v2') ?? false) &&
        (s.narration_performance_plan.detail?.includes('project_voice_assignment') ?? false),
      '[F1] 无 Plan/无 Assignment → blocked（detail 精确列出两个缺失依赖）',
      {detail: s.narration_performance_plan.detail},
    );
  }

  // F2: Assignment ready、Plan missing → blocked，仅缺 narration_plan_v2
  {
    const {projectId} = setupProject({plan: 'none'});
    await createAssignment(projectId, 441);
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      s.project_voice_assignment.status === 'ready' &&
        s.narration_performance_plan.status === 'blocked' &&
        (s.narration_performance_plan.detail?.includes('narration_plan_v2') ?? false) &&
        !(s.narration_performance_plan.detail?.includes('project_voice_assignment') ?? false),
      '[F2] Assignment ready + Plan missing → blocked（仅缺 narration_plan_v2）',
      {detail: s.narration_performance_plan.detail},
    );
  }

  // F3: eligible Plan、Assignment missing → blocked，仅缺 project_voice_assignment
  {
    const {projectId} = setupProject({plan: 'eligible'});
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      s.narration_plan_v2.status === 'ready' &&
        s.narration_performance_plan.status === 'blocked' &&
        (s.narration_performance_plan.detail?.includes('project_voice_assignment') ?? false) &&
        !(s.narration_performance_plan.detail?.includes('narration_plan_v2') ?? false),
      '[F3] eligible Plan + Assignment missing → blocked（仅缺 project_voice_assignment）',
      {detail: s.narration_performance_plan.detail},
    );
  }

  // F4: Plan needs_review + Assignment ready → blocked
  {
    const {projectId, planBuild} = setupProject({plan: 'needs_review'});
    const planCand = planBuild?.plan.needsReview ?? [];
    ok((planCand?.length ?? 0) > 0, '[F4-pre] needs_review plan 构造成功', {needsReview: planCand?.length});
    await createAssignment(projectId, 442);
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      s.narration_plan_v2.status === 'needs_review' && s.narration_performance_plan.status === 'blocked',
      '[F4] Plan needs_review + Assignment ready → performance blocked',
      {plan: s.narration_plan_v2.status, perf: s.narration_performance_plan.status},
    );
  }

  // F5: eligible Plan + Assignment ready → not_generated
  {
    const {projectId, planBuild} = setupProject({plan: 'eligible'});
    await createAssignment(projectId, 443);
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      s.narration_plan_v2.status === 'ready' && s.project_voice_assignment.status === 'ready' &&
        s.narration_performance_plan.status === 'not_generated',
      '[F5] eligible Plan + Assignment ready → performance not_generated',
      {perf: s.narration_performance_plan.status},
    );
    void planBuild;
  }

  // F6: 生成 current Performance → ready
  {
    const {projectId, planBuild} = setupProject({plan: 'eligible'});
    const a = await createAssignment(projectId, 444);
    const r = await createPerformance(projectId, planBuild!.artifact.id, a.artifactId, 'req-dag-r1-f6-0001');
    ok(r.kind === 'succeeded', '[F6-pre] performance 生成成功');
    const s = await computeTtsBDagNodeStates(projectId);
    ok(s.narration_performance_plan.status === 'ready', '[F6] 已有 current Performance → ready');
  }

  // F7: lock 新 Script V2（不改旧 plan artifact）→ Performance stale_source
  {
    const {projectId, planBuild} = setupProject({plan: 'eligible'});
    const a = await createAssignment(projectId, 445);
    const r = await createPerformance(projectId, planBuild!.artifact.id, a.artifactId, 'req-dag-r1-f7-0001');
    ok(r.kind === 'succeeded', '[F7-pre] performance 生成成功');
    const planContentBefore = (getDb()
      .prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(planBuild!.artifact.id) as {content_json: string}).content_json;
    // 生成并 lock Script V2 version B（真实 drift，不 UPDATE 旧 plan artifact）
    generateVersion({projectId, stage: 'script_v2', content: `# Script V2\n\n## 第 1 章 新章（00:00–01:00）\n\n新第一句。新第二句。\n`, contentType: 'markdown', source: 'manual_edit', promptVersion: 'script-v2@2.0'});
    lockStage(projectId, 'script_v2');
    const planContentAfter = (getDb()
      .prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(planBuild!.artifact.id) as {content_json: string}).content_json;
    ok(planContentBefore === planContentAfter, '[F7a] 旧 plan artifact content_json 前后完全一致（未伪造 drift）');
    const perfRef = getDb()
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = 'narration_performance_plan' ORDER BY version DESC LIMIT 1")
      .get(projectId) as PerformanceArtifactRow;
    const perfCand = await classifyNarrationPerformancePlan(projectId, perfRef);
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      perfCand.status === 'stale_source' && s.narration_performance_plan.status === 'stale_source',
      '[F7b] lock 新 Script V2 → 旧 Performance stale_source（不改 artifact 内容）',
      {perf: perfCand.status, node: s.narration_performance_plan.status},
    );
  }

  // F8: Assignment voice 文件损坏 → Assignment invalid + Performance invalid/blocked
  {
    const {projectId, planBuild} = setupProject({plan: 'eligible'});
    const {profileId, revisionId, artifactId} = await createAssignment(projectId, 446);
    const r = await createPerformance(projectId, planBuild!.artifact.id, artifactId, 'req-dag-r1-f8-0001');
    ok(r.kind === 'succeeded', '[F8-pre] performance 生成成功');
    const row = getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?').get(revisionId) as {p: string};
    fs.rmSync(path.join(process.cwd(), 'data', 'test-tts-b-dag-r1', 'voice-library', row.p.slice('voice-library/'.length)));
    const s = await computeTtsBDagNodeStates(projectId);
    ok(
      s.project_voice_assignment.status === 'invalid_source' &&
        (s.narration_performance_plan.status === 'invalid_source' || s.narration_performance_plan.status === 'blocked'),
      '[F8] voice 文件损坏 → Assignment invalid + Performance invalid/blocked',
      {a: s.project_voice_assignment.status, p: s.narration_performance_plan.status},
    );
    void profileId;
  }

  // F9: 新 revision 不 stale exact Assignment/Performance
  {
    const {projectId, planBuild} = setupProject({plan: 'eligible'});
    const {profileId, revisionId, artifactId} = await createAssignment(projectId, 447);
    const r = await createPerformance(projectId, planBuild!.artifact.id, artifactId, 'req-dag-r1-f9-0001');
    ok(r.kind === 'succeeded', '[F9-pre] performance 生成成功');
    await ingestVoiceProfileRevision(
      {voiceProfileId: profileId, requestId: `dag-rv2-${crypto.randomUUID()}`, audioBuffer: makeWav(548)},
      MOCK_DEPS,
    );
    const aCand = await classifyProjectVoiceAssignment(projectId, {id: artifactId, project_id: projectId, kind: 'project_voice_assignment', version: 1, content_json: (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(artifactId) as {content_json: string}).content_json, created_at: ''});
    const perfRef = getDb()
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = 'narration_performance_plan' ORDER BY version DESC LIMIT 1")
      .get(projectId) as PerformanceArtifactRow;
    const perfCand = await classifyNarrationPerformancePlan(projectId, perfRef);
    ok(
      aCand.status === 'current_candidate' && perfCand.status === 'current_candidate',
      '[F9] 新 revision 上传不 stale exact Assignment/Performance',
      {a: aCand.status, p: perfCand.status},
    );
    void revisionId;
  }

  // F10: archive 不 stale historical exact Assignment/Performance
  {
    const {projectId, planBuild} = setupProject({plan: 'eligible'});
    const {profileId, artifactId} = await createAssignment(projectId, 449);
    const r = await createPerformance(projectId, planBuild!.artifact.id, artifactId, 'req-dag-r1-f10-0001');
    ok(r.kind === 'succeeded', '[F10-pre] performance 生成成功');
    setVoiceProfileStatus(profileId, 'archived');
    const aCand = await classifyProjectVoiceAssignment(projectId, {id: artifactId, project_id: projectId, kind: 'project_voice_assignment', version: 1, content_json: (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(artifactId) as {content_json: string}).content_json, created_at: ''});
    const perfRef = getDb()
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = 'narration_performance_plan' ORDER BY version DESC LIMIT 1")
      .get(projectId) as PerformanceArtifactRow;
    const perfCand = await classifyNarrationPerformancePlan(projectId, perfRef);
    ok(
      aCand.status === 'current_candidate' && perfCand.status === 'current_candidate',
      '[F10] archive 不 stale historical exact Assignment/Performance',
      {a: aCand.status, p: perfCand.status},
    );
  }

  // F11/F12: TTS-B graph 无 cycle / 无反向边
  {
    ok((detectTtsBDagCycles() ?? []).length === 0, '[F11] TTS-B graph 无 cycle');
    ok((detectTtsBDagReverseEdges() ?? []).length === 0, '[F12] TTS-B graph 无反向边');
  }

  // ---------- G: graph detector 故障注入（TTS-B.R2 §七） ----------
  {
    const node = (id: string, deps: string[]): TtsBDagNodeDef => ({
      id: id as TtsBDagNodeId,
      label: id,
      dependencies: deps as TtsBDagNodeId[],
    });
    // G1：canonical graph 合法——validate 无 issue、edges 由 nodes 派生、拓扑序可派生、
    //     无 cycle、无 reverse edge
    ok(
      validateTtsBDag(TTS_B_DAG_NODES).length === 0 &&
        TTS_B_DAG_EDGES.length === 2 &&
        deriveTtsBDagTopologicalOrder(TTS_B_DAG_NODES) !== null &&
        (detectTtsBDagCycles() ?? []).length === 0 &&
        (detectTtsBDagReverseEdges() ?? []).length === 0,
      '[G1] canonical graph：validate 干净、edges 派生、拓扑序可派生、无 cycle、无 reverse edge',
      {edges: TTS_B_DAG_EDGES},
    );
    // G2：node id 重复 → validate issue
    ok(
      validateTtsBDag([node('a', []), node('a', [])]).some((i) => i.includes('node id 重复')),
      '[G2] node id 重复 → 结构校验失败',
    );
    // G3：重复 edge（同一 (dep → id) 出现两次，由重复 node 产生）→ validate issue
    ok(
      validateTtsBDag([node('a', ['b']), node('a', ['b'])]).some((i) => i.includes('重复 edge')),
      '[G3] 重复 edge → 结构校验失败',
    );
    // G4：注入 cycle（narration→performance 且 performance→narration）→ cycle 被检测、
    //     拓扑序不可派生
    const cycleGraph = [
      node('narration_plan_v2', ['narration_performance_plan']),
      node('project_voice_assignment', []),
      node('narration_performance_plan', ['narration_plan_v2', 'project_voice_assignment']),
    ];
    ok(
      (detectTtsBDagCycles(cycleGraph) ?? []).length > 0 &&
        deriveTtsBDagTopologicalOrder(cycleGraph) === null,
      '[G4] 注入 cycle → cycle 被检测、拓扑序派生失败',
      {cycle: detectTtsBDagCycles(cycleGraph)},
    );
    // G5：注入单向 reverse edge（performance→narration，无 cycle）→ reverse edge 被检测
    const reverseGraph = [
      node('narration_plan_v2', ['narration_performance_plan']),
      node('project_voice_assignment', []),
      node('narration_performance_plan', ['project_voice_assignment']),
    ];
    ok(
      (detectTtsBDagCycles(reverseGraph) ?? []).length === 0 &&
        detectTtsBDagReverseEdges(reverseGraph).length > 0,
      '[G5] 注入单向 reverse edge（performance→narration）→ 按规定（canonical）拓扑序检测到 reverse edge（无 cycle）',
      {reverse: detectTtsBDagReverseEdges(reverseGraph)},
    );
    // G6：unknown endpoint → validate issue
    ok(
      validateTtsBDag([node('a', ['unknown_node'])]).some((i) => i.includes('未知端点')),
      '[G6] unknown endpoint → 结构校验失败',
    );
    // G7：TTS-B edges 只允许 narration/assignment → performance（不允许 performance → 上游）
    ok(
      TTS_B_DAG_EDGES.every((e) => e.to === 'narration_performance_plan' && e.from !== 'narration_performance_plan'),
      '[G7] TTS-B edges 仅 narration/assignment → performance（无性能 → 上游反向边）',
      {edges: TTS_B_DAG_EDGES},
    );
  }

  // F13: M7.3B Sequence/Shot 状态不受 TTS-B 影响
  {
    const {projectId} = setupProject({plan: 'none'});
    const before = computeM7DagNodeStates(projectId);
    await createAssignment(projectId, 450);
    const after = computeM7DagNodeStates(projectId);
    ok(
      before.visual_sequences.status === after.visual_sequences.status &&
        before.shots.status === after.shots.status &&
        before.narration_plan_v2.status === after.narration_plan_v2.status,
      '[F13] M7.3B Sequence/Shot 状态不受 TTS-B 影响（创建 TTS-B artifact 前后不变）',
      {seqBefore: before.visual_sequences.status, seqAfter: after.visual_sequences.status},
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-B.R1 dag 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-B.R1 DAG 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

/**
 * TTS-B — Narration Performance Plan generation 测试（设计文档 §7；E 覆盖）。
 *
 * E. Performance generation：Web only enqueue（API 层）；Worker Mock LLM；
 *    same requestId same sources reuse；different source 409；并发 single-flight；
 *    repair（attemptCount=2）；attempt 达上限 failed；source drift during generation
 *    → SOURCE_STALE（零 artifact）；voice unusable before commit → VOICE_SOURCE_INVALID；
 *    无 partial artifact；无 TTS job；无额外 provider call。
 *
 * 用法：npx tsx scripts/test-tts-b-performance-generation.ts
 * 使用临时数据目录（data/test-tts-b-performance），结束后清理。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join('data', 'test-tts-b-performance');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {
  buildNarrationPlanV2,
  classifyNarrationPlanV2Candidate,
  getNarrationPlanV2Artifact,
} from '../src/lib/narration/plan-v2';
import {
  buildNarrationPerformancePlan,
  classifyNarrationPerformancePlan,
  getNarrationPerformancePlan,
  listNarrationPerformancePlanCandidates,
  PerformanceError,
} from '../src/lib/tts-b/performance';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../src/lib/voice-library/revisions';
import {
  buildProjectVoiceAssignment,
  listProjectVoiceAssignmentCandidates,
} from '../src/lib/tts-b/assignment';

import {buildPerformanceInputIdentity} from '../src/lib/tts-b/identity';
import {NARRATION_PERFORMANCE_PLAN_KIND} from '../src/lib/tts-b/constants';

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

class ScriptableProvider implements LLMProvider {
  readonly name = 'scriptable-mock';
  readonly requests: LLMRequest[] = [];
  private queue: Array<{text?: string; finishReason?: string; error?: Error; before?: () => void}> = [];

  push(resp: {text?: string; finishReason?: string; error?: Error; before?: () => void}): void {
    this.queue.push(resp);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error('scriptable provider: 无预置响应'));
    if (next.before) next.before();
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

const UPSTREAM: WorkflowStage[] = ['project_definition', 'research', 'evidence', 'argument_tree', 'script_v1'];

const SCRIPT = `# Script V2

## 第 1 章 开场

第一句。第二句。

@silence 500ms reason=pause

第三句。

## 第 2 章 展开

第四句。第五句。
`;

function itemsFor(plan: {units: Array<{id: string; kind: string}>}): unknown[] {
  return plan.units
    .filter((u) => u.kind === 'speech')
    .map((u) => ({unitId: u.id, deliveryOverride: null, pace: 'normal', energy: 'normal', emotion: {mode: 'none'}}));
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

function performanceCount(projectId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?')
    .get(projectId, NARRATION_PERFORMANCE_PLAN_KIND) as {c: number}).c;
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const projectId = createProjectWithWorkflow({topic: 'tts-b-perf', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({projectId, stage: 'script_v2', content: SCRIPT, contentType: 'markdown', source: 'manual_edit', promptVersion: 'script-v2@2.0'});
  lockStage(projectId, 'script_v2');
  const planBuild = buildNarrationPlanV2(projectId);
  const plan = planBuild.plan;
  const speechIds = plan.units.filter((u) => u.kind === 'speech').map((u) => u.id);

  // voice + assignment
  const profile = createVoiceProfile({displayName: 'perf voice'});
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${crypto.randomUUID()}`, audioBuffer: (() => {
      const sr = 48000;
      const frames = Math.floor((sr * 1500) / 1000);
      const data = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / sr)), i * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
      h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
      h.write('data', 36); h.writeUInt32LE(data.length, 40);
      return Buffer.concat([h, data]);
    })()},
    MOCK_DEPS,
  );
  const assignment = await buildProjectVoiceAssignment({
    projectId,
    voiceProfileId: profile.id,
    voiceProfileRevisionId: rev.revision.id,
    requestId: 'req-assign-perf-0001',
  });
  const assignArtifactId = assignment.artifact.id;

  // ---------- E1: valid generation ----------
  {
    const provider = new ScriptableProvider();
    provider.push({text: JSON.stringify({items: itemsFor(plan)})});
    const r = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-perf-e1-0001',
      provider,
    });
    ok(r.kind === 'succeeded' && r.performance.items.length === speechIds.length, '[E1] 合法生成 → succeeded、items 覆盖全部 SpeechUnit', {items: r.kind === 'succeeded' ? r.performance.items.map((i) => i.unitId) : null});
    const cand = (await listNarrationPerformancePlanCandidates(projectId)).find((c) => r.kind === 'succeeded' && c.artifact.id === r.artifact.id);
    ok(cand?.status === 'current_candidate', '[E2] 生成后分类 current_candidate');
    ok(provider.requests.length === 1, '[E3] 首次生成恰好 1 次 LLM 请求', {requests: provider.requests.length});
  }

  // ---------- E2: same requestId same sources → reused ----------
  {
    const r2 = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-perf-e1-0001',
      provider: new ScriptableProvider(),
    });
    ok(r2.kind === 'succeeded' && r2.reused === true, '[E4] 同 requestId + 同 source → reused');
    ok(performanceCount(projectId) === 1, '[E5] reused 不新增 artifact', {count: performanceCount(projectId)});
  }

  // ---------- E3: different source → 409 ----------
  {
    const otherAssignment = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: profile.id,
      voiceProfileRevisionId: rev.revision.id,
      requestId: 'req-assign-perf-0002',
    });
    let err: unknown = null;
    try {
      await buildNarrationPerformancePlan({
        projectId,
        narrationPlanArtifactId: planBuild.artifact.id,
        projectVoiceAssignmentArtifactId: otherAssignment.artifact.id,
        requestId: 'req-perf-e1-0001',
        provider: new ScriptableProvider(),
      });
    } catch (e) {
      err = e;
    }
    ok(
      err instanceof PerformanceError && err.code === 'REQUEST_ID_CONFLICT',
      '[E6] 同 requestId + 不同 assignment source → 409 REQUEST_ID_CONFLICT',
    );
  }

  // ---------- E4: concurrent single-flight ----------
  {
    const results = await Promise.all(
      Array.from({length: 5}, (_, i) => {
        const provider = new ScriptableProvider();
        provider.push({text: JSON.stringify({items: itemsFor(plan)})});
        return buildNarrationPerformancePlan({
          projectId,
          narrationPlanArtifactId: planBuild.artifact.id,
          projectVoiceAssignmentArtifactId: assignArtifactId,
          requestId: 'req-perf-conc-0001',
          provider,
        });
      }),
    );
    const succeeded = results.filter((r) => r.kind === 'succeeded');
    const inProgress = results.filter((r) => r.kind === 'in_progress');
    ok(
      succeeded.length === 1 && inProgress.length === 4 && performanceCount(projectId) === 2,
      '[E7] 并发 5× 同 requestId → 恰好 1 succeeded（其余 in_progress/reused），artifact 仅 1 新增',
      {succeeded: succeeded.length, inProgress: inProgress.length, count: performanceCount(projectId)},
    );
  }

  // ---------- E5: repair（首次 invalid → repair → 成功，attemptCount=2） ----------
  {
    const provider = new ScriptableProvider();
    provider.push({text: JSON.stringify({items: itemsFor(plan).slice(0, speechIds.length - 1)})}); // 缺一个 → coverage gap
    provider.push({text: JSON.stringify({items: itemsFor(plan)})});
    const r = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-perf-e5-0001',
      provider,
    });
    ok(
      r.kind === 'succeeded' && r.generation?.attemptCount === 2 && provider.requests.length === 2,
      '[E8] repair：首次缺 unit → 带精确 issues 重试 → attemptCount=2',
      {attemptCount: r.kind === 'succeeded' ? r.generation?.attemptCount : null, requests: provider.requests.length},
    );
  }

  // ---------- E6: attempt 达上限 → failed 终态，零 artifact ----------
  {
    const before = performanceCount(projectId);
    const provider = new ScriptableProvider();
    provider.push({text: JSON.stringify({items: []})});
    provider.push({text: JSON.stringify({items: []})});
    provider.push({text: JSON.stringify({items: []})});
    const r = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-perf-e6-0001',
      provider,
    });
    ok(
      r.kind === 'terminal' && r.status === 'failed' && provider.requests.length === 3 &&
        performanceCount(projectId) === before,
      '[E9] 连续 3 次 invalid（含 2 次 repair）→ terminal failed、零 artifact',
      {requests: provider.requests.length, count: performanceCount(projectId)},
    );
  }

  // E14（在 E7/E8 污染 source 之前）：恰好 3 个 current_candidate（E1/E4/E5）
  {
    const candidates = await listNarrationPerformancePlanCandidates(projectId);
    ok(
      candidates.filter((c) => c.status === 'current_candidate').length === 3,
      '[E14] 恰好 3 个 current_candidate（E1/E4/E5）',
      {current: candidates.filter((c) => c.status === 'current_candidate').length},
    );
  }

  // ---------- E7: source drift during generation → SOURCE_STALE ----------
  {
    const before = performanceCount(projectId);
    const provider = new ScriptableProvider();
    provider.push({
      text: JSON.stringify({items: itemsFor(plan)}),
      before: () => {
        // 生成期间修改 narration plan 行内容 → commit fence hash 漂移
        const row = getDb()
          .prepare("SELECT content_json FROM artifacts WHERE id = ? AND project_id = ? AND kind = 'narration_plan_v2'")
          .get(planBuild.artifact.id, projectId) as {content_json: string};
        const mutated = JSON.parse(row.content_json);
        mutated.units = mutated.units.map((u: {id: string}) => ({...u, id: u.id === 'N001' ? 'N001' : u.id}));
        mutated.marker = 'drift';
        getDb()
          .prepare("UPDATE artifacts SET content_json = ? WHERE id = ? AND project_id = ? AND kind = 'narration_plan_v2'")
          .run(JSON.stringify(mutated), planBuild.artifact.id, projectId);
      },
    });
    const r = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-perf-e7-0001',
      provider,
    });
    ok(
      r.kind === 'terminal' && r.errorCode === 'SOURCE_STALE' && performanceCount(projectId) === before,
      '[E10] 生成期间 narration plan 漂移 → commit fence SOURCE_STALE、零 artifact',
      {errorCode: r.kind === 'terminal' ? r.errorCode : null},
    );
  }

  // ---------- E8: voice unusable before commit → VOICE_SOURCE_INVALID ----------
  {
    const before = performanceCount(projectId);
    const provider = new ScriptableProvider();
    provider.push({
      text: JSON.stringify({items: itemsFor(plan)}),
      before: () => {
        const row = getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?').get(rev.revision.id) as {p: string};
        const abs = path.join(process.cwd(), 'data', 'test-tts-b-performance', 'voice-library', row.p.slice('voice-library/'.length));
        fs.rmSync(abs);
      },
    });
    const r = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-perf-e8-0001',
      provider,
    });
    ok(
      r.kind === 'terminal' && r.errorCode === 'VOICE_SOURCE_INVALID' && performanceCount(projectId) === before,
      '[E11] commit 前 exact voice 文件删除 → VOICE_SOURCE_INVALID、零 artifact',
      {errorCode: r.kind === 'terminal' ? r.errorCode : null},
    );
  }

  // ---------- E9: TTS boundary ----------
  {
    const ttsJobs = (getDb().prepare('SELECT COUNT(*) AS c FROM tts_jobs').get() as {c: number}).c;
    ok(ttsJobs === 0, '[E12] 全程未创建 TTS job（tts_jobs=0）', {ttsJobs});
    const runs = getDb()
      .prepare("SELECT COUNT(*) AS c FROM generation_runs WHERE stage = 'm7_narration_performance_plan' AND status = 'succeeded'")
      .get() as {c: number};
    ok(runs.c >= 1, '[E13] performance generation_runs 落库（succeeded ≥1）', {runs: runs.c});
  }

  // ---------- E16-E18：locked Script V2 drift + succeeded 重放 fail-closed ----------
  let eAssignArtifactId = '';
  let e16PerfArtifactId = '';
  let e18PerfArtifactId = '';
  {
    // E8 已删除共享 voice 的 reference 文件——本段用全新 voice + assignment
    const eProfile = createVoiceProfile({displayName: 'e16 voice'});
    const eRev = await ingestVoiceProfileRevision(
      {voiceProfileId: eProfile.id, requestId: `e16-rev-${crypto.randomUUID()}`, audioBuffer: (() => {
        const sr = 48000;
        const frames = Math.floor((sr * 1500) / 1000);
        const data = Buffer.alloc(frames * 2);
        for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 560 * i) / sr)), i * 2);
        const h = Buffer.alloc(44);
        h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
        h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
        h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
        h.write('data', 36); h.writeUInt32LE(data.length, 40);
        return Buffer.concat([h, data]);
      })()},
      MOCK_DEPS,
    );
    const eAssign = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: eProfile.id,
      voiceProfileRevisionId: eRev.revision.id,
      requestId: `e16-assign-${crypto.randomUUID()}`,
    });
    eAssignArtifactId = eAssign.artifact.id;

    // 在 lock 新 Script V2 之前：构建 perf-E16 与 perf-E18（同 fresh plan）
    const p16 = new ScriptableProvider();
    p16.push({text: JSON.stringify({items: itemsFor(plan)})});
    const r16 = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: eAssignArtifactId,
      requestId: 'req-perf-e16-0001',
      provider: p16,
    });
    ok(r16.kind === 'succeeded', '[E16-pre] perf-E16 生成成功');
    e16PerfArtifactId = r16.kind === 'succeeded' ? r16.artifact.id : '';

    const p18 = new ScriptableProvider();
    p18.push({text: JSON.stringify({items: itemsFor(plan)})});
    const r18 = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: eAssignArtifactId,
      requestId: 'req-perf-e18-0001',
      provider: p18,
    });
    ok(r18.kind === 'succeeded', '[E18-pre] perf-E18 生成成功');
    e18PerfArtifactId = r18.kind === 'succeeded' ? r18.artifact.id : '';

    // E18：篡改 perf-E18 的 source（schema 仍可 parse）→ classify invalid（PERFORMANCE_SOURCE_MISMATCH）
    const row18 = (getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?').get(e18PerfArtifactId) as {content_json: string});
    const mutated = JSON.parse(row18.content_json) as Record<string, unknown>;
    (mutated.source as Record<string, unknown>).canonicalAudioSha256 = 'e'.repeat(64);
    getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(mutated), e18PerfArtifactId);
    const cand18 = await classifyNarrationPerformancePlan(projectId, {
      id: e18PerfArtifactId, project_id: projectId, kind: NARRATION_PERFORMANCE_PLAN_KIND, version: 1,
      content_json: JSON.stringify(mutated), created_at: '',
    });
    ok(
      cand18.status === 'invalid_source' && (cand18.statusReason?.includes('PERFORMANCE_SOURCE_MISMATCH') ?? false),
      '[E18] performance source.canonicalAudioSha256 改错 → invalid_source（PERFORMANCE_SOURCE_MISMATCH）',
      {status: cand18.status, reason: cand18.statusReason},
    );

    // E18b：篡改后同 requestId 重放（plan 仍 eligible → precheck 过 → claim succeeded →
    // classify tampered → RESULT_ARTIFACT_INVALID，provider calls=0、不新建 run）
    const beforeRuns18 = (getDb().prepare("SELECT COUNT(*) AS c FROM generation_runs WHERE stage = 'm7_narration_performance_plan'").get() as {c: number}).c;
    const p18b = new ScriptableProvider();
    const r18b = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: eAssignArtifactId,
      requestId: 'req-perf-e18-0001',
      provider: p18b,
    });
    ok(
      r18b.kind === 'terminal' && r18b.errorCode === 'RESULT_ARTIFACT_INVALID' &&
        p18b.requests.length === 0 &&
        (getDb().prepare("SELECT COUNT(*) AS c FROM generation_runs WHERE stage = 'm7_narration_performance_plan'").get() as {c: number}).c === beforeRuns18,
      '[E18b] tampered artifact 同 requestId 重放 → RESULT_ARTIFACT_INVALID（不返回 200、provider calls=0、不新建 run）',
      {kind: r18b.kind, errorCode: r18b.kind === 'terminal' ? r18b.errorCode : null},
    );

    // lock 新 Script V2（真实 drift，不改旧 plan artifact）
    const planContentBefore = (getDb()
      .prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(planBuild.artifact.id) as {content_json: string}).content_json;
    generateVersion({projectId, stage: 'script_v2', content: `# Script V2\n\n## 第 1 章 新章（00:00–01:00）\n\n新第一句。新第二句。\n`, contentType: 'markdown', source: 'manual_edit', promptVersion: 'script-v2@2.0'});
    lockStage(projectId, 'script_v2');
    const planContentAfter = (getDb()
      .prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(planBuild.artifact.id) as {content_json: string}).content_json;
    ok(planContentBefore === planContentAfter, '[E16a] 旧 plan artifact content_json 前后一致（真实 drift，非伪造）');

    // E16：lock 后 classify perf-E16 → stale_source（NARRATION_PLAN_STALE）
    const perfRef16 = getNarrationPerformancePlan(projectId, e16PerfArtifactId);
    const perfCand16 = await classifyNarrationPerformancePlan(projectId, perfRef16!.artifact);
    ok(
      perfCand16.status === 'stale_source' && (perfCand16.statusReason?.includes('NARRATION_PLAN_STALE') ?? false),
      '[E16b] lock 新 Script V2 → 旧 Performance stale_source（NARRATION_PLAN_STALE）',
      {status: perfCand16.status, reason: perfCand16.statusReason},
    );

    // E17a：lock 后同 requestId 重放（run 已 succeeded、plan 已 stale）→ precheck fail-closed
    const beforeRuns = (getDb().prepare("SELECT COUNT(*) AS c FROM generation_runs WHERE stage = 'm7_narration_performance_plan'").get() as {c: number}).c;
    const p17 = new ScriptableProvider();
    let err17: unknown = null;
    try {
      await buildNarrationPerformancePlan({
        projectId,
        narrationPlanArtifactId: planBuild.artifact.id,
        projectVoiceAssignmentArtifactId: eAssignArtifactId,
        requestId: 'req-perf-e16-0001',
        provider: p17,
      });
    } catch (e) {
      err17 = e;
    }
    ok(
      err17 instanceof PerformanceError && err17.code === 'NARRATION_PLAN_NOT_ELIGIBLE' &&
        p17.requests.length === 0 &&
        (getDb().prepare("SELECT COUNT(*) AS c FROM generation_runs WHERE stage = 'm7_narration_performance_plan'").get() as {c: number}).c === beforeRuns,
      '[E17] stale succeeded 重放 → NARRATION_PLAN_NOT_ELIGIBLE（不返回 200、provider calls=0、run 数不变）',
      {code: err17 instanceof Error ? (err17 as PerformanceError).code : String(err17)},
    );
  }

  // ---------- E10: buildPerformanceInputIdentity ----------
  {
    const i1 = buildPerformanceInputIdentity({
      narrationPlanArtifactId: 'p1',
      narrationPlanContentHash: 'sha256:' + 'a'.repeat(64),
      unitId: 'N001',
      assignmentArtifactId: 'a1',
      assignmentContentHash: 'sha256:' + 'b'.repeat(64),
      performancePlanArtifactId: 'pf1',
      performancePlanContentHash: 'sha256:' + 'c'.repeat(64),
    });
    const i2 = buildPerformanceInputIdentity({
      narrationPlanArtifactId: 'p1',
      narrationPlanContentHash: 'sha256:' + 'a'.repeat(64),
      unitId: 'N001',
      assignmentArtifactId: 'a1',
      assignmentContentHash: 'sha256:' + 'b'.repeat(64),
      performancePlanArtifactId: 'pf1',
      performancePlanContentHash: 'sha256:' + 'c'.repeat(64),
    });
    const i3 = buildPerformanceInputIdentity({...{narrationPlanArtifactId: 'p1', narrationPlanContentHash: 'sha256:' + 'a'.repeat(64), unitId: 'N001', assignmentArtifactId: 'a1', assignmentContentHash: 'sha256:' + 'b'.repeat(64), performancePlanArtifactId: 'pf1', performancePlanContentHash: 'sha256:' + 'c'.repeat(64)}, unitId: 'N002'});
    ok(
      i1 === i2 && i1.startsWith('sha256:') && i1 !== i3,
      '[E15] buildPerformanceInputIdentity 确定性 + unitId 敏感（非最终 ttsInputFingerprint）',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-B performance generation 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-B Narration Performance Plan generation 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

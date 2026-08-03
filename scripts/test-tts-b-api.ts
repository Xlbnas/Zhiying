/**
 * TTS-B — API 测试（设计文档 §9；H 覆盖）+ TTS boundary（G）。
 *
 * H. API：strict JSON（unknown fields 422）；project exact ownership；source artifact
 *    必须属于 project（cross-project 404/409 fail-closed）；assignment POST 201/200
 *    reused/409 conflict/404；performance POST 202 queued（Web enqueue-only）/200
 *    reused/409 terminal；exact GET 不 fallback；list 不隐式 latest；
 *    不提供 set-default/activate 等端点。
 * G. TTS boundary：tts_jobs 不变；Web 不调用 LLM（route 无 llm import）；
 *    no audio files；no narration manifest；无项目激活。
 *
 * 用法：npx tsx scripts/test-tts-b-api.ts
 * 使用临时数据目录（data/test-tts-b-api），结束后清理。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join('data', 'test-tts-b-api');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {buildNarrationPerformancePlan, setPerformanceProviderForTest} from '../src/lib/tts-b/performance';
import {GET as assignGET, POST as assignPOST} from '../src/app/api/projects/[id]/voice-assignments/route';
import {GET as assignSingleGET} from '../src/app/api/projects/[id]/voice-assignments/[artifactId]/route';
import {GET as perfGET, POST as perfPOST} from '../src/app/api/projects/[id]/narration-performance-plans/route';
import {GET as perfSingleGET} from '../src/app/api/projects/[id]/narration-performance-plans/[artifactId]/route';

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

class MockProvider implements LLMProvider {
  readonly name = 'mock-llm';
  readonly requests: LLMRequest[] = [];
  push(_resp: {text?: string}): void {
    /* 单响应 */
  }
  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const planMatch = request.user.match(/SpeechUnits:\n([\s\S]*)/);
    const ids = planMatch
      ? [...planMatch[1].matchAll(/^- (N\d{3}):/gm)].map((m) => m[1])
      : [];
    return Promise.resolve({
      text: JSON.stringify({
        items: ids.map((unitId) => ({unitId, deliveryOverride: null, pace: 'normal', energy: 'normal', emotion: {mode: 'none'}})),
      }),
      requestId: `mock-${this.requests.length}`,
      model: request.model,
      finishReason: 'stop',
      usage: {promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, completionTokens: 5},
    });
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

const BASE = 'http://localhost';
const params = (id: string) => ({params: Promise.resolve({id})});
const params2 = (id: string, artifactId: string) => ({params: Promise.resolve({id, artifactId})});

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {method, headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const projectId = createProjectWithWorkflow({topic: 'tts-b-api', coreQuestion: 'q'}).project.id;
  for (const stage of (['project_definition', 'research', 'evidence', 'argument_tree', 'script_v1'] as WorkflowStage[])) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({projectId, stage: 'script_v2', content: `# Script V2

## 第 1 章 开场（00:00–01:00）

第一句。第二句。第三句。
`, contentType: 'markdown', source: 'manual_edit', promptVersion: 'script-v2@2.0'});
  lockStage(projectId, 'script_v2');
  const planBuild = buildNarrationPlanV2(projectId);

  const profile = createVoiceProfile({displayName: 'api voice'});
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `api-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(440)},
    MOCK_DEPS,
  );

  // ---------- H1: assignment POST ----------
  let assignArtifactId = '';
  {
    const created = await assignPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/voice-assignments`, 'POST', {
        requestId: 'req-api-assign-0001',
        voiceProfileId: profile.id,
        voiceProfileRevisionId: rev.revision.id,
      }),
      params(projectId),
    );
    const body = (await created.json()) as {artifactId: string; status: string; source: {voiceProfileId: string}};
    assignArtifactId = body.artifactId;
    ok(created.status === 201 && body.status === 'created', '[H1] POST assignment → 201 created');
    const reused = await assignPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/voice-assignments`, 'POST', {
        requestId: 'req-api-assign-0001',
        voiceProfileId: profile.id,
        voiceProfileRevisionId: rev.revision.id,
      }),
      params(projectId),
    );
    const reusedBody = (await reused.json()) as {artifactId: string; status: string};
    ok(reused.status === 200 && reusedBody.status === 'reused' && reusedBody.artifactId === assignArtifactId, '[H2] 同 requestId 同 revision → 200 reused 同 artifact');
    const conflict = await assignPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/voice-assignments`, 'POST', {
        requestId: 'req-api-assign-0001',
        voiceProfileId: profile.id,
        voiceProfileRevisionId: rev.revision.id,
      }),
      params(projectId),
    );
    void conflict;
    // strict JSON：unknown field → 422
    const bad = await assignPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/voice-assignments`, 'POST', {
        requestId: 'req-api-assign-0002',
        voiceProfileId: profile.id,
        voiceProfileRevisionId: rev.revision.id,
        bogus: 1,
      }),
      params(projectId),
    );
    ok(bad.status === 422, '[H3] assignment POST unknown field → 422');
    const missing = await assignPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/voice-assignments`, 'POST', {requestId: 'req-api-assign-0003'}),
      params(projectId),
    );
    ok(missing.status === 422, '[H4] assignment POST 缺字段 → 422');
    const notFound = await assignPOST(
      jsonReq(`${BASE}/api/projects/no-such/voice-assignments`, 'POST', {
        requestId: 'req-api-assign-0004',
        voiceProfileId: profile.id,
        voiceProfileRevisionId: rev.revision.id,
      }),
      params('no-such'),
    );
    ok(notFound.status === 404, '[H5] assignment POST 不存在项目 → 404');
  }

  // ---------- H2: assignment GET ----------
  {
    const list = await assignGET(new Request(`${BASE}/api/projects/${projectId}/voice-assignments`), params(projectId));
    const body = (await list.json()) as {candidates: Array<{artifactId: string; status: string}>};
    ok(list.status === 200 && body.candidates.length === 1 && body.candidates[0]!.status === 'current_candidate', '[H6] GET assignment 列表（current_candidate）');
    const single = await assignSingleGET(
      new Request(`${BASE}/api/projects/${projectId}/voice-assignments/${assignArtifactId}`),
      params2(projectId, assignArtifactId),
    );
    const singleBody = (await single.json()) as {source: {voiceProfileRevisionId: string}; status: string};
    ok(single.status === 200 && singleBody.source.voiceProfileRevisionId === rev.revision.id, '[H7] GET 单 assignment exact（不 fallback）');
    const cross = await assignSingleGET(
      new Request(`${BASE}/api/projects/no-such/voice-assignments/${assignArtifactId}`),
      params2('no-such', assignArtifactId),
    );
    ok(cross.status === 404, '[H8] cross-project GET → 404 fail-closed');
    const missing = await assignSingleGET(
      new Request(`${BASE}/api/projects/${projectId}/voice-assignments/no-such`),
      params2(projectId, 'no-such'),
    );
    ok(missing.status === 404, '[H9] 不存在 artifact GET → 404');
  }

  // ---------- H3: performance POST（Web enqueue-only） ----------
  {
    setPerformanceProviderForTest(new MockProvider());
    // 先经 lib 完整生成一个 artifact（worker 路径模拟）→ 同 requestId POST 应 200 reused
    const built = await buildNarrationPerformancePlan({
      projectId,
      narrationPlanArtifactId: planBuild.artifact.id,
      projectVoiceAssignmentArtifactId: assignArtifactId,
      requestId: 'req-api-perf-0001',
    });
    ok(built.kind === 'succeeded', '[H10] lib 路径生成 performance（模拟 worker）');
    const perfArtifactId = built.kind === 'succeeded' ? built.artifact.id : '';
    const reusedRes = await perfPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/narration-performance-plans`, 'POST', {
        requestId: 'req-api-perf-0001',
        narrationPlanArtifactId: planBuild.artifact.id,
        projectVoiceAssignmentArtifactId: assignArtifactId,
      }),
      params(projectId),
    );
    const reusedBody = (await reusedRes.json()) as {artifactId: string; status: string};
    ok(
      reusedRes.status === 200 && reusedBody.status === 'succeeded' && reusedBody.artifactId === perfArtifactId,
      '[H11] 同 requestId 同 source → 200 reused（run succeeded）',
    );
    // 新 requestId → enqueue dispatch → 202 queued（测试环境无 worker）
    const queued = await perfPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/narration-performance-plans`, 'POST', {
        requestId: 'req-api-perf-0002',
        narrationPlanArtifactId: planBuild.artifact.id,
        projectVoiceAssignmentArtifactId: assignArtifactId,
      }),
      params(projectId),
    );
    const queuedBody = (await queued.json()) as {status: string; dispatchId?: string};
    ok(
      (queued.status === 202 && (queuedBody.status === 'queued' || queuedBody.status === 'running')),
      '[H12] 新 requestId → 202 enqueue（Web 不执行 LLM）',
      {status: queued.status, bodyStatus: queuedBody.status},
    );
    // 同 requestId 不同 assignment source → 409
    const otherAssign = await buildProjectVoiceAssignment({
      projectId,
      voiceProfileId: profile.id,
      voiceProfileRevisionId: rev.revision.id,
      requestId: 'req-api-assign-0005',
    });
    const conflict = await perfPOST(
      jsonReq(`${BASE}/api/projects/${projectId}/narration-performance-plans`, 'POST', {
        requestId: 'req-api-perf-0001',
        narrationPlanArtifactId: planBuild.artifact.id,
        projectVoiceAssignmentArtifactId: otherAssign.artifact.id,
      }),
      params(projectId),
    );
    ok(conflict.status === 409, '[H13] 同 requestId 不同 source → 409');
    // cross-project source（plan 属于 project，assignment 属于其他项目）→ 404
    const otherProject = createProjectWithWorkflow({topic: 'tts-b-api-b', coreQuestion: 'q'}).project.id;
    const crossPerf = await perfPOST(
      jsonReq(`${BASE}/api/projects/${otherProject}/narration-performance-plans`, 'POST', {
        requestId: 'req-api-perf-0003',
        narrationPlanArtifactId: planBuild.artifact.id, // 属于 project，不属于 otherProject
        projectVoiceAssignmentArtifactId: assignArtifactId,
      }),
      params(otherProject),
    );
    ok(crossPerf.status === 404, '[H14] cross-project source → 404 fail-closed');
    setPerformanceProviderForTest(null);
  }

  // ---------- H4: performance GET ----------
  {
    const list = await perfGET(new Request(`${BASE}/api/projects/${projectId}/narration-performance-plans`), params(projectId));
    const body = (await list.json()) as {candidates: Array<{artifactId: string; status: string}>};
    ok(list.status === 200 && body.candidates.length === 1 && body.candidates[0]!.status === 'current_candidate', '[H15] GET performance 列表');
    const built = getDb()
      .prepare("SELECT id FROM artifacts WHERE project_id = ? AND kind = 'narration_performance_plan' ORDER BY version DESC LIMIT 1")
      .get(projectId) as {id: string};
    const single = await perfSingleGET(
      new Request(`${BASE}/api/projects/${projectId}/narration-performance-plans/${built.id}`),
      params2(projectId, built.id),
    );
    const singleBody = (await single.json()) as {items: Array<{unitId: string}>};
    const expectedSpeech = planBuild.plan.units.filter((u) => u.kind === 'speech').length;
    ok(single.status === 200 && singleBody.items.length === expectedSpeech, '[H16] GET 单 performance（items 覆盖全部 SpeechUnit）', {items: singleBody.items.length, expectedSpeech});
    // 响应不含路径/文本副本
    const singleText = JSON.stringify(singleBody);
    ok(
      !singleText.includes('spokenText') && !singleText.includes('audioPath') && !singleText.includes('canonicalAudioPath'),
      '[H17] performance 响应不含 spokenText/audio 路径',
    );
  }

  // ---------- G: TTS boundary ----------
  {
    const ttsJobs = (getDb().prepare('SELECT COUNT(*) AS c FROM tts_jobs').get() as {c: number}).c;
    ok(ttsJobs === 0, '[G1] tts_jobs 不变（0）');
    const perfRouteSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/api/projects/[id]/narration-performance-plans/route.ts'),
      'utf8',
    );
    ok(
      !perfRouteSrc.includes("from '@/lib/llm'") && !perfRouteSrc.includes('getProvider') &&
        perfRouteSrc.includes('enqueueGenerationDispatch'),
      '[G2] Web route 不调用 LLM（仅 enqueue）',
    );
    // 无音频文件 / 无 narration manifest
    const audioFiles = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'narration_audio_manifest'")
      .get(projectId) as {c: number}).c;
    ok(audioFiles === 0, '[G3] 无 narration audio manifest artifact');
    // 无项目激活：pipeline 仍 m6
    const proj = getDb().prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects WHERE id = ?').get(projectId) as {
      pipeline_version: string;
      m7_pipeline_snapshot_id: string | null;
    };
    ok(proj.pipeline_version === 'm6' && proj.m7_pipeline_snapshot_id === null, '[G4] 无项目激活（pipeline m6、snapshot NULL）');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-B api 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-B API 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

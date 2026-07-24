/**
 * M3-B TTS 管线测试（Mock provider + mock HTTP sidecar，零真实 GPU/API 成本）。
 *
 * 用法：npx tsx scripts/test-m3b-tts.ts
 * 使用临时数据目录（data/test-m3b），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3b');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {
  enqueueNarrationAudioJobs,
  getNarrationAudioOverview,
  NarrationAudioError,
  tryFinalizeNarrationAudio,
  NARRATION_AUDIO_ARTIFACT_KIND,
  narrationAudioManifestSchema,
} from '../src/lib/narration/audio';
import {compileNarrationPlan} from '../src/lib/narration/compiler';
import type {NarrationPlan} from '../src/lib/narration/schema';
import {
  enqueueWorkflowStageJob,
  getLlmJob,
  LlmJobError,
} from '../src/lib/llm-jobs';
import {buildMockWav, MockTtsProvider} from '../src/lib/tts/mock';
import {IndexTts2Provider} from '../src/lib/tts/indextts2';
import {TtsError} from '../src/lib/tts/types';
import {
  getTtsJob,
  recoverStaleTtsJobs,
  requestCancelTtsJob,
  requeueTtsJob,
  type TtsJobRow,
} from '../src/lib/tts-jobs';
import {enqueueRenderJob} from '../src/lib/jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';
import {runLlmJob} from '../src/worker/llm-executor';
import {runTtsJob} from '../src/worker/tts-executor';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';
import {execFileSync} from 'node:child_process';

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

const SCRIPT_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–02:00）

那条消息你看到了。（停顿 1s）

你没有回。为什么偏偏是这一条？

[画面留白]

## 第 2 章 追问（02:00–05:00）

弗洛伊德怀疑过这种忘记。（放慢）他说，有些遗忘背后藏着不情愿。<!-- E01 -->
`;

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

function claimAny() {
  return claimNextAnyJob('w-m3b');
}

async function runStageOnce(pid: string, stage: WorkflowStage): Promise<void> {
  const job = enqueueWorkflowStageJob(pid, stage);
  const claimed = claimAny();
  if (!claimed || claimed.type !== 'llm' || claimed.job.id !== job.id) {
    throw new Error(`claim 失败 ${stage}`);
  }
  await runLlmJob(claimed.job, CTX);
  if (getLlmJob(job.id)!.status !== 'succeeded') throw new Error(`${stage} 未成功`);
}

async function lockThroughScriptV2(pid: string): Promise<void> {
  for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
    await runStageOnce(pid, stage);
    lockStage(pid, stage);
  }
}

/** 用真实含 directives 的 Script V2 替换锁定内容并重新锁定。 */
function setScriptV2(pid: string, content: string): void {
  editVersion({
    projectId: pid, stage: 'script_v2',
    content, contentType: 'markdown', source: 'manual_edit',
  }, {confirmStale: true});
  lockStage(pid, 'script_v2');
}

function claimTts(): {type: 'tts'; job: TtsJobRow} | null {
  const claimed = claimAny();
  return claimed && claimed.type === 'tts' ? claimed : null;
}

async function runAllTtsJobs(pid: string, provider?: InstanceType<typeof MockTtsProvider>): Promise<void> {
  for (;;) {
    const claimed = claimTts();
    if (!claimed) break;
    if (claimed.job.project_id !== pid) throw new Error('意外拿到其他项目 tts job');
    await runTtsJob(claimed.job, CTX, provider ? {provider} : {});
  }
}

function planWithAllKinds(): NarrationPlan {
  return compileNarrationPlan({
    scriptV2Markdown: SCRIPT_V2,
    scriptV2Version: 1,
    promptVersion: 'script-v2@1.0',
  });
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m3b'), {recursive: true, force: true});
  const db = getDb();

  // ============ P. Provider（1–7） ============
  {
    const a = buildMockWav('测试句子一', 'N001');
    const b = buildMockWav('测试句子一', 'N001');
    const c = buildMockWav('测试句子一，加长版本', 'N001');
    const d = buildMockWav('测试句子一', 'N002');
    ok(a.equals(b) && !a.equals(c) && !a.equals(d), '[P1] mock 同输入同字节，异输入异字节');
  }
  {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(new Uint8Array(buildMockWav('x', 'N001')), {
        status: 200,
        headers: {'content-type': 'audio/wav'},
      });
    }) as unknown as typeof fetch;
    const healthFetch = fetchImpl;
    const provider = new IndexTts2Provider({baseUrl: 'http://fake-sidecar', fetchImpl: healthFetch});
    // health 也需可用：第一次调用是 health，第二次是 synthesize
    const healthJson = JSON.stringify({ready: true, provider: 'indextts2', model: 'IndexTTS-2', repoCommit: 'abc1234', fp16: true});
    let call = 0;
    const fetchSeq = (async (_url: string, init?: RequestInit) => {
      call++;
      if (call === 1) {
        return new Response(healthJson, {status: 200, headers: {'content-type': 'application/json'}});
      }
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array(buildMockWav('x', 'N001')), {status: 200, headers: {'content-type': 'audio/wav'}});
    }) as unknown as typeof fetch;
    const p2 = new IndexTts2Provider({baseUrl: 'http://fake-sidecar', fetchImpl: fetchSeq});
    const result = await p2.synthesize({
      text: '朗读正文',
      voiceProfile: {id: 'default', revision: '1'},
      unitId: 'N001',
    });
    ok(
      capturedBody.text === '朗读正文' &&
        capturedBody.voiceProfile === 'default' &&
        capturedBody.voiceRevision === '1' &&
        capturedBody.useRandom === false &&
        capturedBody.emotion === 'none',
      '[P2] IndexTTS2 请求 payload 正确（text/voice/revision/useRandom=false/emotion=none）',
      capturedBody,
    );
    ok(result.providerCommit === 'abc1234' && result.model === 'IndexTTS-2', '[P2] providerCommit/model 来自 health');
  }
  {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ready: false}), {status: 200, headers: {'content-type': 'application/json'}})) as unknown as typeof fetch;
    const provider = new IndexTts2Provider({baseUrl: 'http://fake', fetchImpl});
    let threw: string | null = null;
    try {
      await provider.synthesize({text: 'x', voiceProfile: {id: 'd', revision: '1'}, unitId: 'N001'});
    } catch (err) {
      threw = err instanceof TtsError ? err.code : String(err);
    }
    ok(threw === 'PROVIDER_UNAVAILABLE', '[P3] health not ready → PROVIDER_UNAVAILABLE', threw);
  }
  {
    // health 快速返回 ready；synthesize 挂起直至 provider 自身 50ms timeout
    const healthOk = JSON.stringify({ready: true, provider: 'indextts2', model: 'IndexTTS-2'});
    let call = 0;
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        call++;
        if (call === 1) {
          resolve(new Response(healthOk, {status: 200, headers: {'content-type': 'application/json'}}));
          return;
        }
        // 保持 event loop 存活；provider 内部 50ms timeout 会先触发 abort
        const timer = setTimeout(() => {
          const err = new Error('fake hang');
          err.name = 'AbortError';
          reject(err);
        }, 5000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          {once: true},
        );
      })) as unknown as typeof fetch;
    const provider = new IndexTts2Provider({baseUrl: 'http://fake', timeoutMs: 50, fetchImpl});
    let threw: string | null = null;
    try {
      await provider.synthesize({text: 'x', voiceProfile: {id: 'd', revision: '1'}, unitId: 'N001'});
    } catch (err) {
      threw = err instanceof TtsError ? err.code : String(err);
    }
    ok(threw === 'PROVIDER_TIMEOUT', '[P4] timeout → PROVIDER_TIMEOUT', threw);
  }
  {
    const healthOk = JSON.stringify({ready: true, provider: 'indextts2', model: 'IndexTTS-2'});
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return call === 1
        ? new Response(healthOk, {status: 200, headers: {'content-type': 'application/json'}})
        : new Response('server error', {status: 500});
    }) as unknown as typeof fetch;
    const provider = new IndexTts2Provider({baseUrl: 'http://fake', fetchImpl});
    let threw: string | null = null;
    try {
      await provider.synthesize({text: 'x', voiceProfile: {id: 'd', revision: '1'}, unitId: 'N001'});
    } catch (err) {
      threw = err instanceof TtsError ? err.code : String(err);
    }
    ok(threw === 'PROVIDER_HTTP_ERROR', '[P5] HTTP 500 → PROVIDER_HTTP_ERROR', threw);
  }
  {
    const healthOk = JSON.stringify({ready: true, provider: 'indextts2', model: 'IndexTTS-2'});
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return call === 1
        ? new Response(healthOk, {status: 200, headers: {'content-type': 'application/json'}})
        : new Response('{"error":"bad"}', {status: 200, headers: {'content-type': 'application/json'}});
    }) as unknown as typeof fetch;
    const provider = new IndexTts2Provider({baseUrl: 'http://fake', fetchImpl});
    let threw: string | null = null;
    try {
      await provider.synthesize({text: 'x', voiceProfile: {id: 'd', revision: '1'}, unitId: 'N001'});
    } catch (err) {
      threw = err instanceof TtsError ? err.code : String(err);
    }
    ok(threw === 'PROVIDER_INVALID_RESPONSE', '[P6] 非音频 content-type → PROVIDER_INVALID_RESPONSE', threw);
  }
  {
    const controller = new AbortController();
    controller.abort();
    let threw: string | null = null;
    try {
      await new MockTtsProvider().synthesize(
        {text: 'x', voiceProfile: {id: 'd', revision: '1'}, unitId: 'N001'},
        controller.signal,
      );
    } catch (err) {
      threw = err instanceof TtsError ? err.code : String(err);
    }
    ok(threw === 'CANCELLED', '[P7] 预 abort → CANCELLED', threw);
  }

  // ============ E. Enqueue（8–14）+ Snapshot（15–18） ============
  {
    const pid = newProject();
    let threw: string | null = null;
    try {
      enqueueNarrationAudioJobs(pid);
    } catch (err) {
      threw = err instanceof NarrationAudioError ? err.code : String(err);
    }
    ok(threw === 'NARRATION_PLAN_NOT_CURRENT', '[E8] 无 Narration Plan → 拒绝入队', threw);

    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    const {plan, artifact} = buildNarrationPlan(pid);
    const speechCount = plan.units.filter((u) => u.kind === 'speech').length;
    ok(speechCount === 4, '[E10] fixture 含 4 个 speech unit');
    const r1 = enqueueNarrationAudioJobs(pid);
    ok(
      r1.enqueued === 4 && r1.reused === 0 && r1.planArtifactId === artifact.id,
      '[E10] plan ready → 4 个 speech 入队',
      r1,
    );
    const jobKinds = db
      .prepare('SELECT unit_id FROM tts_jobs WHERE project_id = ?')
      .all(pid) as Array<{unit_id: string}>;
    ok(
      jobKinds.length === 4 && jobKinds.every((j) => ['N001', 'N003', 'N005', 'N007'].includes(j.unit_id)),
      '[E11-13] pause/visual_breath/prosody 不入队（N002/N004/放慢无 job）',
      jobKinds,
    );
    const r2 = enqueueNarrationAudioJobs(pid);
    ok(
      r2.enqueued === 0 && r2.reused === 4,
      '[E14] 重复入队幂等（不产生 duplicate active jobs）',
      r2,
    );
    // snapshot payload 正确
    const job = db.prepare('SELECT * FROM tts_jobs WHERE project_id = ? ORDER BY unit_id LIMIT 1').get(pid) as TtsJobRow;
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    ok(
      payload.narrationPlanArtifactId === artifact.id &&
        payload.narrationPlanArtifactVersion === 1 &&
        payload.scriptV2Version === 2 &&
        payload.compilerVersion === '1.1' &&
        payload.unitId === 'N001',
      '[E15] job payload source artifact 快照正确',
      payload,
    );
    // script_v2 后续变化不影响已入队 payload（immutable snapshot）
    const textBefore = payload.unitText;
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: SCRIPT_V2 + '\n\n新加一句。', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'script_v2');
    const payloadAfter = JSON.parse(
      (db.prepare('SELECT payload_json FROM tts_jobs WHERE id = ?').get(job.id) as {payload_json: string}).payload_json,
    ) as Record<string, unknown>;
    ok(
      payloadAfter.unitText === textBefore && payloadAfter.scriptV2Version === 2,
      '[E16] script_v2 变化后已入队 payload 不变（immutable snapshot）',
    );
    // stale 后禁止新 jobs
    let threw2: string | null = null;
    try {
      enqueueNarrationAudioJobs(pid);
    } catch (err) {
      threw2 = err instanceof NarrationAudioError ? err.code : String(err);
    }
    ok(threw2 === 'NARRATION_PLAN_NOT_CURRENT', '[E17] plan stale 后禁止新 jobs', threw2);
    // 旧 job 可继续完成
    await runAllTtsJobs(pid);
    const done = db.prepare("SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ? AND status = 'succeeded'").get(pid) as {c: number};
    ok(done.c === 4, '[E18] stale 后旧 job 仍可继续完成（4 succeeded）');
    // 但 finalize 不应发生（plan 已 stale）→ overview.stale
    ok(getNarrationAudioOverview(pid).status === 'stale', '[E18] plan stale 时 audio overview = stale');
  }

  // ============ W. Worker（19–29） ============
  {
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts();
    ok(claimed !== null && claimed.job.status === 'running', '[W19] scheduler 可 claim TTS job');
    await runTtsJob(claimed!.job, CTX);
    const job = getTtsJob(claimed!.job.id)!;
    ok(job.status === 'succeeded' && job.output_path !== null, '[W24] TTS job succeeded + output_path');
    const abs = path.join(getDataDir(), job.output_path!);
    ok(
      fs.existsSync(abs) && fs.readFileSync(abs).subarray(0, 4).toString('ascii') === 'RIFF',
      '[W21] 输出 WAV 真实存在且为 RIFF',
    );
    ok(
      job.duration_ms !== null && job.duration_ms > 0 && job.audio_sha256 !== null,
      '[W22] ffprobe duration > 0 已记录',
    );
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', abs,
    ], {encoding: 'utf8'})) as {streams: Array<{codec_name: string; sample_rate: string; channels: number}>};
    ok(
      probe.streams[0]?.codec_name === 'pcm_s16le' &&
        probe.streams[0].sample_rate === '48000' &&
        probe.streams[0].channels === 1,
      '[W22] 音频元数据 pcm_s16le/48kHz/mono',
    );
    const {createHash} = await import('node:crypto');
    const sha = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    ok(job.audio_sha256 === sha, '[W23] sha256 与文件一致');
    ok(
      !fs.existsSync(path.join(getDataDir(), 'bundle-cache')),
      '[W20] TTS 执行不触发 Remotion bundle（无 bundle-cache）',
    );
    await runAllTtsJobs(pid);
  }
  {
    // retry：provider 错误 → queued，再跑成功
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    const errProvider = new MockTtsProvider();
    errProvider.synthesize = () => Promise.reject(new TtsError('PROVIDER_HTTP_ERROR', '模拟 500'));
    await runTtsJob(claimed.job, CTX, {provider: errProvider});
    const afterFirst = getTtsJob(claimed.job.id)!;
    ok(
      afterFirst.status === 'queued' && afterFirst.attempt === 1 && afterFirst.error_code === 'PROVIDER_HTTP_ERROR',
      '[W25] provider 错误 → queued retry（attempt=1）',
    );
    const claimed2 = claimTts()!;
    await runTtsJob(claimed2.job, CTX);
    ok(getTtsJob(claimed.job.id)!.status === 'succeeded', '[W25] retry 后 succeeded');
    await runAllTtsJobs(pid);
  }
  {
    // cancel running：长任务 + requestCancel → cancelled，无输出文件
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    const slow = new MockTtsProvider({delayMs: 300});
    const running = runTtsJob(claimed.job, CTX, {provider: slow, heartbeatMs: 30});
    await sleep(60);
    requestCancelTtsJob(claimed.job.id);
    await running;
    const after = getTtsJob(claimed.job.id)!;
    ok(after.status === 'cancelled', '[W26] running cancel → cancelled', after.status);
    ok(after.output_path === null, '[W26] 取消不写输出文件');
    db.prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE project_id = ?").run(pid);
  }
  {
    // shutdown：统一 controller abort → requeue（不 cancelled、不写输出）
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    const slow = new MockTtsProvider({delayMs: 300});
    let shutting = false;
    const workerCtl = new AbortController();
    const running = runTtsJob(
      claimed.job,
      {isShuttingDown: () => shutting, log: () => {}, shutdownSignal: workerCtl.signal},
      {provider: slow},
    );
    await sleep(60);
    shutting = true;
    workerCtl.abort();
    await running;
    const after = getTtsJob(claimed.job.id)!;
    ok(after.status === 'queued', '[W27] shutdown → requeue（不 cancelled/failed）', after.status);
    db.prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE project_id = ?").run(pid);
  }
  {
    // stale recovery + cancel 优先
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    db.prepare("UPDATE tts_jobs SET heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(claimed.job.id);
    const rec = recoverStaleTtsJobs(60_000);
    ok(
      rec.requeued === 1 && rec.cancelled === 0 && getTtsJob(claimed.job.id)!.status === 'queued',
      '[W28] stale running → queued',
    );
    requestCancelTtsJob(claimed.job.id);
    db.prepare("UPDATE tts_jobs SET heartbeat_at = '2020-01-01T00:00:00.000Z', status = 'running' WHERE id = ?").run(claimed.job.id);
    const rec2 = recoverStaleTtsJobs(60_000);
    ok(
      rec2.cancelled === 1 && getTtsJob(claimed.job.id)!.status === 'cancelled',
      '[W29] stale + cancel_requested → cancelled（不复活）',
    );
    db.prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE project_id = ?").run(pid);
  }

  // ============ S. Scheduler（30–32） ============
  {
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    const renderJob = enqueueRenderJob(
      pid,
      'fullcut',
      zhiyingFullCutPropsSchema.parse({
        data: {project: {title: 't', durationSec: 1, durationInFrames: 30}, chapterTiming: [], scenes: []},
        audio: {narration: null, bgm: null, sfx: null},
      }),
    );
    const llmJob = enqueueWorkflowStageJob(pid, 'narration_beat_map');
    enqueueNarrationAudioJobs(pid);
    db.prepare("UPDATE render_jobs SET queued_at = '2026-01-01T00:00:03.000Z' WHERE id = ?").run(renderJob.id);
    db.prepare("UPDATE llm_jobs SET queued_at = '2026-01-01T00:00:01.000Z' WHERE id = ?").run(llmJob.id);
    db.prepare("UPDATE tts_jobs SET queued_at = '2026-01-01T00:00:02.000Z' WHERE project_id = ?").run(pid);
    const c1 = claimAny();
    const c2 = claimAny();
    const c3 = claimAny();
    const c4 = claimAny();
    const c5 = claimAny();
    const c6 = claimAny();
    ok(
      c1?.type === 'llm' && c2?.type === 'tts' && c3?.type === 'tts' &&
        c4?.type === 'tts' && c5?.type === 'tts' && c6?.type === 'render',
      '[S30] render+llm+tts 全局 FIFO（queued_at 顺序，4 个 tts 相邻）',
      [c1?.type, c2?.type, c3?.type, c4?.type, c5?.type, c6?.type],
    );
    ok(claimAny() === null, '[S32] 单 Worker 逐 claim，队列空后 null');
    db.prepare("UPDATE render_jobs SET status = 'cancelled'").run();
    db.prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
    db.prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
    // tie-break：相同 queued_at → type 字母序（llm < render < tts）确定性
    const pid2 = newProject();
    await lockThroughScriptV2(pid2);
    setScriptV2(pid2, SCRIPT_V2);
    buildNarrationPlan(pid2);
    const rj = enqueueRenderJob(
      pid2,
      'fullcut',
      zhiyingFullCutPropsSchema.parse({
        data: {project: {title: 't', durationSec: 1, durationInFrames: 30}, chapterTiming: [], scenes: []},
        audio: {narration: null, bgm: null, sfx: null},
      }),
    );
    const lj = enqueueWorkflowStageJob(pid2, 'evidence', {confirmStale: true});
    enqueueNarrationAudioJobs(pid2);
    db.prepare("UPDATE render_jobs SET queued_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(rj.id);
    db.prepare("UPDATE llm_jobs SET queued_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(lj.id);
    db.prepare("UPDATE tts_jobs SET queued_at = '2026-01-02T00:00:00.000Z' WHERE project_id = ?").run(pid2);
    const t1 = claimAny();
    const t2 = claimAny();
    const t3 = claimAny();
    ok(
      t1?.type === 'llm' && t2?.type === 'render' && t3?.type === 'tts',
      '[S31] 同 queued_at：type+id 稳定 tie-break（确定性）',
      [t1?.type, t2?.type, t3?.type],
    );
    db.prepare("UPDATE render_jobs SET status = 'cancelled'").run();
    db.prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
    db.prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE status IN ('queued','running')").run();
  }

  // ============ M. Manifest（33–43）+ Master（44–50） ============
  {
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    const {plan, artifact} = buildNarrationPlan(pid);
    // 全部完成前 finalize → null
    ok(tryFinalizeNarrationAudio(pid) === null, '[M34] 缺 speech 输出时 finalize = null');
    const early = getNarrationAudioOverview(pid);
    ok(early.status === 'missing' && early.speechComplete === 0, '[M34] 未生成时 overview = missing');
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const manifest = tryFinalizeNarrationAudio(pid);
    ok(manifest !== null, '[M33] 全部 speech succeeded → manifest ready');
    ok(
      narrationAudioManifestSchema.safeParse(manifest).success,
      '[M33] manifest 通过 narration-audio@1.0 schema 复验',
    );
    const m = manifest!;
    ok(
      m.source.narrationPlanArtifactId === artifact.id &&
        m.source.narrationPlanArtifactVersion === artifact.version &&
        m.source.scriptV2Version === plan.source.version &&
        m.source.compilerVersion === '1.1',
      '[M36] manifest source trace 正确',
    );
    ok(
      m.provider.name === 'mock' && m.provider.voiceProfile.id === 'default' &&
        m.provider.voiceProfile.revision === '1' && m.provider.useRandom === false,
      '[M37] voice profile/revision trace 正确',
    );
    ok('providerCommit' in m.provider, '[M38] providerCommit 字段存在（可空记录）');
    const speechUnits = m.units.filter((u) => u.kind === 'speech');
    ok(
      speechUnits.length === 4 && speechUnits.every((u) => u.durationMs > 0 && u.sha256.length === 64 && u.ttsJobId.length > 0),
      '[M39] speech duration 来自实际 WAV（ffprobe），sha256/jobId 记录',
    );
    const pause = m.units.find((u) => u.kind === 'pause');
    ok(
      pause !== undefined && pause.kind === 'pause' && pause.durationMs === 1000 && pause.resolved === true,
      '[M40] 显式停顿 pauseMs=1000 保留',
    );
    const breath = m.units.find((u) => u.kind === 'visual_breath');
    ok(
      breath !== undefined && breath.kind === 'visual_breath' && breath.durationMs === null && breath.resolved === false,
      '[M42] visual_breath unresolved',
    );
    const prosody = m.units.find((u) => u.kind === 'prosody');
    ok(
      prosody !== undefined && prosody.kind === 'prosody' && prosody.appliedToTts === false && prosody.directive === '放慢',
      '[M43] prosody appliedToTts=false（不改变音频）',
    );
    // master
    const masterAbs = path.join(getDataDir(), m.master.filePath);
    ok(fs.existsSync(masterAbs) && fs.statSync(masterAbs).size > 44, '[M44] master WAV 真实存在');
    const masterProbe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', masterAbs,
    ], {encoding: 'utf8'})) as {streams: Array<{codec_name: string; sample_rate: string; channels: number}>; format: {duration: string}};
    ok(
      masterProbe.streams[0]?.codec_name === 'pcm_s16le' &&
        masterProbe.streams[0].sample_rate === '48000' &&
        masterProbe.streams[0].channels === 1,
      '[M47] master 统一为 pcm_s16le/48kHz/mono',
    );
    const expectedMs = speechUnits.reduce((sum, u) => sum + u.durationMs, 0) + 1000;
    const masterMs = Math.round(Number(masterProbe.format.duration) * 1000);
    ok(
      Math.abs(masterMs - expectedMs) < 100 && m.master.durationMs === masterMs,
      '[M45/48] master 时长 ≈ speech + 显式 pause（容差 100ms，unresolved 不计时）',
      {masterMs, expectedMs},
    );
    const {createHash} = await import('node:crypto');
    const masterSha = createHash('sha256').update(fs.readFileSync(masterAbs)).digest('hex');
    ok(m.master.sha256 === masterSha, '[M49] master sha256 与文件一致');
    // unit 顺序：master 第一段时长 = N001 的实测时长（顺序严格按 plan）
    const n001 = speechUnits.find((u) => u.unitId === 'N001')!;
    const n003 = speechUnits.find((u) => u.unitId === 'N003')!;
    ok(
      m.units[0]!.kind === 'speech' && m.units[0]!.unitId === 'N001' &&
        m.units[1]!.kind === 'pause' && m.units[2]!.unitId === 'N003',
      '[M44] manifest units 顺序严格按 Narration Plan',
    );
    ok(n001.durationMs !== n003.durationMs || n001.filePath !== n003.filePath, '[M44] 每个 speech 独立音频文件');
    // artifact 落库
    const artifactRow = db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1")
      .get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {version: number} | undefined;
    ok(artifactRow !== undefined && artifactRow.version === 1, '[M50] narration_audio_manifest artifact 落库');
    // overview ready
    const overview = getNarrationAudioOverview(pid);
    ok(
      overview.status === 'ready' && overview.master !== null && overview.speechComplete === 4,
      '[M33] overview = ready（master 可见）',
    );
    // 幂等：再次 finalize 复用同一 artifact
    const again = tryFinalizeNarrationAudio(pid);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?").get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {c: number}).c;
    ok(again !== null && count === 1, '[M50] 重复 finalize 幂等（不产生重复 manifest）');
  }
  {
    // failed 状态
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    const errProvider = new MockTtsProvider();
    errProvider.synthesize = () => Promise.reject(new TtsError('INVALID_AUDIO', '坏音频'));
    await runTtsJob(claimed.job, CTX, {provider: errProvider});
    const after = getTtsJob(claimed.job.id)!;
    ok(after.status === 'failed' && after.error_code === 'INVALID_AUDIO', '[M35] INVALID_AUDIO 一次即 failed（不 retry）');
    ok(getNarrationAudioOverview(pid).status === 'failed', '[M35] overview = failed');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m3b'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M3-B 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M3-B TTS 管线测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

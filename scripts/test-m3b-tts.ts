/**
 * M3-B TTS 管线测试（Mock provider + mock HTTP sidecar，零真实 GPU/API 成本）。
 *
 * 用法：npx tsx scripts/test-m3b-tts.ts
 * 使用临时数据目录（data/test-m3b），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3b');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {releaseResourceLeaseForJob, releaseExpiredLeases} from '../src/lib/resources/leases';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {
  NARRATION_AUDIO_REPAIR_HEADROOM_DB,
  analyzeS16PcmHardClipping,
  analyzeS16WavHardClipping,
  assembleNarrationAudioMicroRepairParent,
  enqueueNarrationAudioJobs,
  enqueueNarrationAudioMicroRepairJobs,
  enqueueNarrationAudioQcReplacementJobs,
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
import {resetTtsProviderForTest} from '../src/lib/tts';
import {TtsError, type TtsProvider, type TtsRequest, type TtsResult} from '../src/lib/tts/types';
import type {TtsExecutorContext} from '../src/worker/tts-executor';
import {
  getTtsJob,
  recoverStaleTtsJobs,
  requestCancelTtsJob,
  requeueTtsJob,
  ttsJobResultSchema,
  type TtsJobResult,
  type TtsJobRow,
} from '../src/lib/tts-jobs';
import {enqueueRenderJob} from '../src/lib/jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';
import {runLlmJob} from '../src/worker/llm-executor';
import {probeAudio, runTtsJob, type AudioProbe} from '../src/worker/tts-executor';
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

async function runAllTtsJobs(pid: string, providers?: Record<string, TtsProvider>): Promise<void> {
  for (;;) {
    const claimed = claimTts();
    if (!claimed) break;
    if (claimed.job.project_id !== pid) throw new Error('意外拿到其他项目 tts job');
    await runTtsJobWithRunner(claimed, CTX, providers ? {providers} : {});
  }
}

/**
 * M7.3A.3：模拟 job-runner 生命周期（scheduler claim 后执行 + finally 释放 lease）。
 * executor 自身不再执行 normal lease release；直接调用 executor 的测试必须经本 wrapper。
 */
async function runTtsJobWithRunner(
  claimed: {job: TtsJobRow; resourceLease?: {group: 'production_gpu'; ownerToken: string}},
  ctx: TtsExecutorContext = CTX,
  deps?: {providers?: Record<string, TtsProvider>; heartbeatMs?: number; ffprobeImpl?: (filePath: string) => AudioProbe},
): Promise<void> {
  const lease = claimed.resourceLease;
  try {
    await runTtsJob(
      claimed.job,
      lease ? {...ctx, resourceLease: {group: lease.group, ownerToken: lease.ownerToken}} : ctx,
      deps,
    );
  } finally {
    if (lease) {
      releaseResourceLeaseForJob('production_gpu', 'tts', claimed.job.id);
    }
  }
}

/** 可定制返回快照的 fake Provider（Hardening 测试：commit/model/voice/useRandom 变异）。 */
function fakeProvider(overrides: {
  name?: string;
  resultProvider?: string;
  commit?: string | null;
  model?: string;
  voiceId?: string;
  voiceRevision?: string;
  useRandom?: boolean;
} = {}): TtsProvider {
  const name = overrides.name ?? 'mock';
  return {
    name,
    synthesize: (req: TtsRequest): Promise<TtsResult> =>
      Promise.resolve({
        audio: buildMockWav(req.text, req.unitId),
        format: 'wav',
        provider: overrides.resultProvider ?? name,
        model: overrides.model ?? 'mock-tone-v1',
        providerCommit:
          overrides.commit === undefined ? 'mock-deterministic' : (overrides.commit ?? undefined),
        settings: {
          voiceProfileId: overrides.voiceId ?? req.voiceProfile.id,
          voiceProfileRevision: overrides.voiceRevision ?? req.voiceProfile.revision,
          useRandom: overrides.useRandom ?? false,
        },
      }),
  };
}

/** 清理项目未完结 tts jobs（避免污染后续 claimTts 的全局 FIFO）。 */
function cancelOpenTtsJobs(pid: string): void {
  getDb()
    .prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE project_id = ? AND status IN ('queued','running')")
    .run(pid);
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
  let db = getDb();

  // ============ D. DB Migration（M3-B Hardening §四：result_json 幂等迁移） ============
  {
    const cols = db.prepare('PRAGMA table_info(tts_jobs)').all() as Array<{name: string}>;
    ok(cols.some((c) => c.name === 'result_json'), '[D1] fresh DB tts_jobs 含 result_json 列');
  }
  {
    // 模拟旧库：无 result_json 的 tts_jobs → 启动自动 ALTER；二次启动幂等
    const legacyDir = path.resolve(process.cwd(), 'data', 'test-m3b-legacy');
    fs.rmSync(legacyDir, {recursive: true, force: true});
    fs.mkdirSync(legacyDir, {recursive: true});
    const raw = new Database(path.join(legacyDir, 'zhiying.db'));
    raw.exec(`
      CREATE TABLE tts_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        narration_plan_artifact_id TEXT NOT NULL,
        narration_plan_version INTEGER NOT NULL,
        unit_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        voice_profile_id TEXT NOT NULL,
        voice_profile_revision TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        payload_json TEXT NOT NULL,
        output_path TEXT, duration_ms INTEGER, audio_sha256 TEXT,
        queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        claimed_by TEXT, claimed_at TEXT, heartbeat_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
        progress REAL DEFAULT 0,
        error_code TEXT, error_message TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO tts_jobs (id, project_id, narration_plan_artifact_id, narration_plan_version,
        unit_id, provider, voice_profile_id, voice_profile_revision, status, payload_json, queued_at)
      VALUES ('legacy-job-1', 'legacy-project', 'a1', 1, 'N001', 'mock', 'default', '1', 'succeeded',
        '{}', '2026-01-01T00:00:00.000Z');
    `);
    raw.close();
    closeDb();
    process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3b-legacy');
    const legacyDb = getDb();
    const cols2 = legacyDb.prepare('PRAGMA table_info(tts_jobs)').all() as Array<{name: string}>;
    const row = legacyDb.prepare('SELECT * FROM tts_jobs WHERE id = ?').get('legacy-job-1') as
      | TtsJobRow
      | undefined;
    ok(
      cols2.some((c) => c.name === 'result_json') && row !== undefined && row.status === 'succeeded',
      '[D2] 旧 tts_jobs（无 result_json）启动后自动 ALTER，历史行保留',
    );
    closeDb();
    let reopened = true;
    try {
      getDb(); // 二次启动：列已存在，不再 ALTER（幂等）
    } catch {
      reopened = false;
    }
    ok(reopened, '[D3] 二次启动幂等（重复 migration 无错误）');
    closeDb();
    process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3b');
    fs.rmSync(legacyDir, {recursive: true, force: true});
    db = getDb(); // 恢复 test-m3b 实例（旧句柄已关闭）
  }

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
        payload.compilerVersion === '1.2' &&
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
    await runTtsJobWithRunner(claimed!);
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
    await runTtsJobWithRunner(claimed, CTX, {providers: {mock: errProvider}});
    const afterFirst = getTtsJob(claimed.job.id)!;
    ok(
      afterFirst.status === 'queued' && afterFirst.attempt === 1 && afterFirst.error_code === 'PROVIDER_HTTP_ERROR',
      '[W25] provider 错误 → queued retry（attempt=1）',
    );
    const claimed2 = claimTts()!;
    await runTtsJobWithRunner(claimed2);
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
    const running = runTtsJobWithRunner(claimed, CTX, {providers: {mock: slow}, heartbeatMs: 30});
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
    const running = runTtsJobWithRunner(
      claimed,
      {isShuttingDown: () => shutting, log: () => {}, shutdownSignal: workerCtl.signal},
      {providers: {mock: slow}},
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
    // 清理前面 W 段可能残留的 production_gpu lease（如 recovery 未释放）
    releaseExpiredLeases(0);
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
    // 释放 c2 的 GPU lease 以便后续 TTS 可 claim
    if (c2?.type === 'tts') releaseResourceLeaseForJob('production_gpu', 'tts', c2.job.id);
    const c3 = claimAny();
    if (c3?.type === 'tts') releaseResourceLeaseForJob('production_gpu', 'tts', c3.job.id);
    const c4 = claimAny();
    if (c4?.type === 'tts') releaseResourceLeaseForJob('production_gpu', 'tts', c4.job.id);
    const c5 = claimAny();
    if (c5?.type === 'tts') releaseResourceLeaseForJob('production_gpu', 'tts', c5.job.id);
    const c6 = claimAny();
    if (c6?.type === 'render') releaseResourceLeaseForJob('production_gpu', 'render', c6.job.id);
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
    // 确保没有残留 production_gpu lease 影响后续测试
    releaseExpiredLeases(0);
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
    if (t2?.type === 'render') releaseResourceLeaseForJob('production_gpu', 'render', t2.job.id);
    const t3 = claimAny();
    if (t3?.type === 'tts') releaseResourceLeaseForJob('production_gpu', 'tts', t3.job.id);
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
        m.source.compilerVersion === '1.2',
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
    await runTtsJobWithRunner(claimed, CTX, {providers: {mock: errProvider}});
    const after = getTtsJob(claimed.job.id)!;
    ok(after.status === 'failed' && after.error_code === 'INVALID_AUDIO', '[M35] INVALID_AUDIO 一次即 failed（不 retry）');
    ok(getNarrationAudioOverview(pid).status === 'failed', '[M35] overview = failed');
    cancelOpenTtsJobs(pid); // 清理剩余 queued，避免污染后续 Hardening 段的全局 FIFO
  }

  // ============ H. M3-B Hardening（Provider 快照 / Registry / finish-line race / manifest 溯源） ============
  {
    // H51 result_json zod 契约
    const good = ttsJobResultSchema.safeParse({
      provider: 'mock', model: 'mock-tone-v1', providerVersion: null, providerCommit: 'x',
      settings: {voiceProfileId: 'default', voiceProfileRevision: '1', useRandom: false},
      audio: {codec: 'pcm_s16le', sampleRate: 48000, channels: 1},
    });
    const bad1 = ttsJobResultSchema.safeParse({provider: 'mock'});
    const bad2 = ttsJobResultSchema.safeParse({
      provider: 'mock', model: 'm', providerVersion: null, providerCommit: null,
      settings: {voiceProfileId: 'd', voiceProfileRevision: '1', useRandom: 'no'},
      audio: {codec: 'c', sampleRate: 48000, channels: 1},
    });
    ok(good.success && !bad1.success && !bad2.success, '[H51] ttsJobResultSchema zod：合法通过 / 非法拒绝');
  }
  {
    // H52–H54：executor 持久化真实 Provider 快照；manifest 来自 result_json
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const fake = (): TtsProvider => fakeProvider({commit: 'commit-test-1', model: 'Model-X'});
    const claimed = claimTts()!;
    await runTtsJobWithRunner(claimed, CTX, {providers: {mock: fake()}});
    const job = getTtsJob(claimed.job.id)!;
    ok(job.status === 'succeeded' && job.result_json !== null, '[H52] 成功 job 持久化 result_json');
    const r = JSON.parse(job.result_json!) as TtsJobResult;
    ok(
      r.provider === 'mock' && r.model === 'Model-X' && r.providerCommit === 'commit-test-1' &&
        r.providerVersion === null && r.settings.voiceProfileId === 'default' &&
        r.settings.voiceProfileRevision === '1' && r.settings.useRandom === false,
      '[H52] result_json 记录真实 model/providerCommit/providerVersion/voice（非推断）',
      r,
    );
    const abs = path.join(getDataDir(), job.output_path!);
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', abs,
    ], {encoding: 'utf8'})) as {streams: Array<{codec_name: string; sample_rate: string; channels: number}>};
    ok(
      r.audio.codec === probe.streams[0]!.codec_name &&
        r.audio.sampleRate === Number(probe.streams[0]!.sample_rate) &&
        r.audio.channels === probe.streams[0]!.channels,
      '[H53] result_json.audio 与 ffprobe 实测一致（pcm_s16le/48k/mono）',
    );
    await runAllTtsJobs(pid, {mock: fake()});
    const manifest = tryFinalizeNarrationAudio(pid);
    ok(
      manifest !== null && manifest.provider.name === 'mock' && manifest.provider.model === 'Model-X' &&
        manifest.provider.providerCommit === 'commit-test-1' && manifest.provider.providerVersion === null &&
        manifest.provider.voiceProfile.id === 'default' && manifest.provider.voiceProfile.revision === '1',
      '[H54] manifest provider metadata 来自 job.result_json（无硬编码 model/commit）',
      manifest?.provider,
    );
    const su = manifest!.units.find((u) => u.kind === 'speech')!;
    ok(
      su.kind === 'speech' && su.sampleRate === 48000 && su.channels === 1,
      '[H54] manifest speech unit 元数据来自 result_json.audio',
    );
    const ov = getNarrationAudioOverview(pid);
    ok(
      ov.providerDetail?.model === 'Model-X' && ov.providerDetail.providerCommit === 'commit-test-1',
      '[H54] overview 透出真实 providerDetail（API 契约可见）',
    );
  }
  {
    // H55 Case A：enqueue=mock 后改默认 indextts2 → executor 仍按 job.provider=mock 执行
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid); // TTS_PROVIDER=mock → job.provider=mock
    const envBefore = process.env.TTS_PROVIDER;
    try {
      process.env.TTS_PROVIDER = 'indextts2'; // 入队后改变默认 provider
      process.env.INDEXTTS2_BASE_URL = 'http://127.0.0.1:9'; // 不可达——若误路由必失败
      resetTtsProviderForTest();
      const claimed = claimTts()!;
      ok(claimed.job.provider === 'mock', '[H55] 入队后改变 TTS_PROVIDER 不改写已入队 job.provider');
      await runTtsJobWithRunner(claimed, CTX); // 无注入 → Registry 按 job.provider=mock 解析
      const job = getTtsJob(claimed.job.id)!;
      ok(
        job.status === 'succeeded' && (JSON.parse(job.result_json!) as TtsJobResult).provider === 'mock',
        '[H55] executor 按 job.provider=mock 执行（无视当前环境 indextts2）',
        job.status,
      );
    } finally {
      process.env.TTS_PROVIDER = envBefore;
      delete process.env.INDEXTTS2_BASE_URL;
      resetTtsProviderForTest();
    }
    cancelOpenTtsJobs(pid);
  }
  {
    // H56 Case B：job.provider=indextts2，当前环境 default=mock → 仍调用 indextts2
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    const envBefore = process.env.TTS_PROVIDER;
    try {
      process.env.TTS_PROVIDER = 'indextts2';
      process.env.INDEXTTS2_BASE_URL = 'http://fake-sidecar';
      resetTtsProviderForTest();
      enqueueNarrationAudioJobs(pid); // job.provider=indextts2
    } finally {
      process.env.TTS_PROVIDER = envBefore;
      delete process.env.INDEXTTS2_BASE_URL;
      resetTtsProviderForTest();
    }
    const claimed = claimTts()!;
    ok(claimed.job.provider === 'indextts2', '[H56] 入队快照 provider=indextts2');
    const fakeSidecar = fakeProvider({name: 'indextts2', resultProvider: 'indextts2', model: 'IndexTTS-2', commit: 'abc1234'});
    await runTtsJobWithRunner(claimed, CTX, {providers: {indextts2: fakeSidecar}});
    const job = getTtsJob(claimed.job.id)!;
    const r = JSON.parse(job.result_json!) as TtsJobResult;
    ok(
      job.status === 'succeeded' && r.provider === 'indextts2' && r.model === 'IndexTTS-2' &&
        r.providerCommit === 'abc1234',
      '[H56] 当前环境 default=mock 时 executor 仍调用 indextts2（job.provider 优先）',
      {status: job.status, commit: r.providerCommit},
    );
    cancelOpenTtsJobs(pid);
  }
  {
    // H57 Case C：未知 provider → CONFIG_ERROR（不 silent fallback）
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const row = db.prepare('SELECT * FROM tts_jobs WHERE project_id = ? LIMIT 1').get(pid) as TtsJobRow;
    const fakeId = 'unknown-provider-job';
    db.prepare(
      `INSERT INTO tts_jobs (id, project_id, narration_plan_artifact_id, narration_plan_version,
         unit_id, provider, voice_profile_id, voice_profile_revision, status, payload_json, queued_at,
         attempt, max_attempts)
       VALUES (?, ?, ?, ?, ?, 'unknown-tts', ?, ?, 'queued', ?, ?, 0, 2)`,
    ).run(
      fakeId, pid, row.narration_plan_artifact_id, row.narration_plan_version, 'N099',
      row.voice_profile_id, row.voice_profile_revision, row.payload_json, row.queued_at,
    );
    db.prepare("UPDATE tts_jobs SET status = 'cancelled' WHERE project_id = ? AND status = 'queued' AND id != ?").run(pid, fakeId);
    const claimed = claimTts()!;
    ok(claimed.job.provider === 'unknown-tts', '[H57] claim 到 unknown provider job');
    await runTtsJobWithRunner(claimed, CTX);
    const job = getTtsJob(fakeId)!;
    ok(
      job.status === 'failed' && job.error_code === 'CONFIG_ERROR',
      '[H57] 未知 provider → CONFIG_ERROR failed（不 silent fallback）',
      {status: job.status, error: job.error_code},
    );
  }
  {
    // H58：返回 provider 名与 job 不一致 → 拒绝提交成功
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    await runTtsJobWithRunner(claimed, CTX, {providers: {mock: fakeProvider({resultProvider: 'evil'})}});
    const job = getTtsJob(claimed.job.id)!;
    ok(
      job.status === 'failed' && job.error_code === 'PROVIDER_INVALID_RESPONSE',
      '[H58] 返回 provider 名不一致 → PROVIDER_INVALID_RESPONSE（不提交成功）',
      {status: job.status, error: job.error_code},
    );
    cancelOpenTtsJobs(pid);
  }
  {
    // H59：voice profile / useRandom 不一致 → 拒绝
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const c1 = claimTts()!;
    await runTtsJobWithRunner(c1, CTX, {providers: {mock: fakeProvider({voiceId: 'other'})}});
    const j1 = getTtsJob(c1.job.id)!;
    ok(
      j1.status === 'failed' && j1.error_code === 'PROVIDER_INVALID_RESPONSE',
      '[H59] voice profile 不一致 → PROVIDER_INVALID_RESPONSE',
      {status: j1.status, error: j1.error_code},
    );
    const c2 = claimTts()!;
    await runTtsJobWithRunner(c2, CTX, {providers: {mock: fakeProvider({useRandom: true})}});
    const j2 = getTtsJob(c2.job.id)!;
    ok(
      j2.status === 'failed' && j2.error_code === 'PROVIDER_INVALID_RESPONSE',
      '[H59] useRandom=true → PROVIDER_INVALID_RESPONSE',
      {status: j2.status, error: j2.error_code},
    );
    cancelOpenTtsJobs(pid);
  }
  {
    // H60/H62：finish-line race —— cancel 在 fence 之后、最终事务之前到达 → cancel 赢且不留文件
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    const jobId = claimed.job.id;
    const unitId = claimed.job.unit_id;
    await runTtsJobWithRunner(claimed, CTX, {
      ffprobeImpl: (p) => {
        requestCancelTtsJob(jobId); // fence 已过、finalize 未至——精确落在 finish-line
        return probeAudio(p);
      },
    });
    const job = getTtsJob(jobId)!;
    ok(
      job.status === 'cancelled' && job.output_path === null && job.result_json === null,
      '[H60] finish-line race：cancel 先进入最终事务 → cancelled（output/result 均空）',
      {status: job.status, output: job.output_path},
    );
    const unitsDir = path.join(getDataDir(), 'projects', pid, 'audio', 'units', '1');
    const leftovers = fs.existsSync(unitsDir)
      ? fs.readdirSync(unitsDir).filter((f) => f.includes(unitId))
      : [];
    ok(leftovers.length === 0, '[H62] cancel 赢家不留 final WAV / tmp（DB 与文件系统一致）', leftovers);
    cancelOpenTtsJobs(pid);
  }
  {
    // H61：finish-line race —— success 先提交后，cancel 不再生效
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const claimed = claimTts()!;
    await runTtsJobWithRunner(claimed, CTX);
    ok(getTtsJob(claimed.job.id)!.status === 'succeeded', '[H61] success 先提交 → succeeded');
    const cancelRes = requestCancelTtsJob(claimed.job.id);
    ok(
      cancelRes === false && getTtsJob(claimed.job.id)!.status === 'succeeded',
      '[H61] 成功后再 cancel 不生效（finish-line success wins）',
    );
    cancelOpenTtsJobs(pid);
  }
  {
    // H63：mixed provider snapshot → 阻止 manifest（模拟生成过程中 sidecar 被升级）
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    for (let i = 0; i < 4; i++) {
      const c = claimTts()!;
      const commit = c.job.unit_id === 'N003' ? 'commit-B' : 'commit-A';
      await runTtsJobWithRunner(c, CTX, {providers: {mock: fakeProvider({commit})}});
    }
    let threw: string | null = null;
    try {
      tryFinalizeNarrationAudio(pid);
    } catch (err) {
      threw = err instanceof NarrationAudioError ? err.code : String(err);
    }
    ok(threw === 'PROVIDER_SNAPSHOT_MISMATCH', '[H63] mixed provider commit → 阻止 manifest', threw);
    const cnt = db
      .prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?')
      .get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {c: number};
    ok(cnt.c === 0, '[H63] mismatch 时不产生 manifest artifact');
    ok(
      getNarrationAudioOverview(pid).status === 'not_ready',
      '[H63] overview = not_ready（finalize 被阻止，不 500）',
    );
  }
  {
    // H64/H65：同一 snapshot → manifest ready；重复 finalize 幂等且无 tmp 残留
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid, {mock: fakeProvider({commit: 'commit-A', model: 'Model-Y'})});
    const manifest = tryFinalizeNarrationAudio(pid);
    ok(
      manifest !== null && manifest.provider.providerCommit === 'commit-A' && manifest.provider.model === 'Model-Y',
      '[H64] 同一 provider snapshot → manifest ready（commit 真实记录）',
    );
    const again = tryFinalizeNarrationAudio(pid);
    const rows = db
      .prepare('SELECT id FROM artifacts WHERE project_id = ? AND kind = ?')
      .all(pid, NARRATION_AUDIO_ARTIFACT_KIND) as Array<{id: string}>;
    ok(again !== null && rows.length === 1, '[H65] 重复 finalize 幂等（仅一个 current artifact）');
    const audioDir = path.join(getDataDir(), 'projects', pid, 'audio');
    const tmpLeft = fs.existsSync(audioDir)
      ? fs.readdirSync(audioDir).filter((f) => f.endsWith('.tmp'))
      : [];
    ok(tmpLeft.length === 0, '[H65] master 唯一 tmp 流程无残留', tmpLeft);
  }
  {
    // H66：result_json 缺失/非法 → 不允许 finalize（不 crash、不硬猜 metadata）
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    db.prepare('UPDATE tts_jobs SET result_json = NULL WHERE project_id = ?').run(pid);
    let threw1 = false;
    let m1: unknown = 'unset';
    try {
      m1 = tryFinalizeNarrationAudio(pid);
    } catch {
      threw1 = true;
    }
    ok(!threw1 && m1 === null, '[H66] result_json 缺失 → finalize=null（不 crash）');
    db.prepare("UPDATE tts_jobs SET result_json = 'not-json' WHERE project_id = ?").run(pid);
    let threw2 = false;
    let m2: unknown = 'unset';
    try {
      m2 = tryFinalizeNarrationAudio(pid);
    } catch {
      threw2 = true;
    }
    ok(!threw2 && m2 === null, '[H66] result_json 非 JSON → finalize=null');
    db.prepare("UPDATE tts_jobs SET result_json = '{}' WHERE project_id = ?").run(pid);
    let threw3 = false;
    let m3: unknown = 'unset';
    try {
      m3 = tryFinalizeNarrationAudio(pid);
    } catch {
      threw3 = true;
    }
    ok(!threw3 && m3 === null, '[H66] result_json schema 非法 → finalize=null');
  }

  // ============ FC. Final File Commit Hardening（master/manifest 原子提交，fault injection） ============
  {
    // FC70-A：winner rename 失败 → DB 无 artifact、final 不存在、tmp 清理、overview != ready
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const relMaster = path.posix.join('projects', pid, 'audio', 'narration-master-v1-mock-default@1.wav');
    const absMaster = path.join(getDataDir(), relMaster);
    let threwA = false;
    try {
      tryFinalizeNarrationAudio(pid, {
        renameImpl: () => {
          throw new Error('EACCES 模拟 rename 失败');
        },
      });
    } catch {
      threwA = true;
    }
    const cntA = (
      db.prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?').get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {c: number}
    ).c;
    ok(
      threwA && cntA === 0 && !fs.existsSync(absMaster),
      '[FC70] rename 失败 → 抛出且 DB 无 artifact、final 不存在',
      {threwA, cntA},
    );
    const audioDirA = path.join(getDataDir(), 'projects', pid, 'audio');
    const tmpA = fs.existsSync(audioDirA) ? fs.readdirSync(audioDirA).filter((f) => f.endsWith('.tmp')) : [];
    ok(tmpA.length === 0, '[FC70] rename 失败 → tmp 已清理');
    ok(getNarrationAudioOverview(pid).status === 'not_ready', '[FC70] rename 失败 → overview != ready');
    // FC72-C：故障移除后同 project 正常成功（tmp→rename→INSERT→commit）
    const manifestC = tryFinalizeNarrationAudio(pid);
    const tmpC = fs.readdirSync(audioDirA).filter((f) => f.endsWith('.tmp'));
    ok(
      manifestC !== null && fs.existsSync(absMaster) && tmpC.length === 0 &&
        getNarrationAudioOverview(pid).status === 'ready',
      '[FC72] normal success：final 存在、tmp=0、artifact=1、overview=ready',
    );
  }
  {
    // FC71-B：rename 成功后 INSERT 失败 → 事务回滚 + 补偿删除 final
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const relMaster = path.posix.join('projects', pid, 'audio', 'narration-master-v1-mock-default@1.wav');
    const absMaster = path.join(getDataDir(), relMaster);
    let threwB = false;
    try {
      tryFinalizeNarrationAudio(pid, {
        insertArtifactImpl: () => {
          throw new Error('模拟 INSERT 失败');
        },
      });
    } catch {
      threwB = true;
    }
    const cntB = (
      db.prepare('SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = ?').get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {c: number}
    ).c;
    const audioDirB = path.join(getDataDir(), 'projects', pid, 'audio');
    const tmpB = fs.existsSync(audioDirB) ? fs.readdirSync(audioDirB).filter((f) => f.endsWith('.tmp')) : [];
    ok(
      threwB && cntB === 0 && !fs.existsSync(absMaster) && tmpB.length === 0,
      '[FC71] INSERT 失败 → 事务回滚 artifact=0，final 补偿删除，tmp 无残留',
      {threwB, cntB, finalExists: fs.existsSync(absMaster)},
    );
    ok(getNarrationAudioOverview(pid).status === 'not_ready', '[FC71] INSERT 失败 → overview != ready');
  }
  {
    // FC74-E：合法 manifest artifact 但 master 缺失 → 不认 current → finalize 重新生成（旧坏 artifact 保留）
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const first = tryFinalizeNarrationAudio(pid)!;
    fs.rmSync(path.join(getDataDir(), first.master.filePath)); // 制造 master 缺失（artifact JSON 仍合法）
    ok(
      getNarrationAudioOverview(pid).status === 'not_ready',
      '[FC74] valid manifest + master missing → overview != ready（不认 current）',
    );
    const rebuilt = tryFinalizeNarrationAudio(pid);
    const rows = db
      .prepare('SELECT version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version')
      .all(pid, NARRATION_AUDIO_ARTIFACT_KIND) as Array<{version: number}>;
    ok(
      rebuilt !== null && rows.length === 2 && rows[1]!.version === 2 &&
        fs.existsSync(path.join(getDataDir(), rebuilt.master.filePath)) &&
        getNarrationAudioOverview(pid).status === 'ready',
      '[FC74] finalize 重新生成 master + 新 artifact v2（旧坏 artifact 保留历史）',
      {versions: rows.map((r) => r.version)},
    );
  }
  {
    // FC75-F：orphan final path（DB 无引用）→ 安全删除并替换
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const relMaster = path.posix.join('projects', pid, 'audio', 'narration-master-v1-mock-default@1.wav');
    const absMaster = path.join(getDataDir(), relMaster);
    fs.mkdirSync(path.dirname(absMaster), {recursive: true});
    fs.writeFileSync(absMaster, Buffer.from('orphan-残留文件'));
    const manifest = tryFinalizeNarrationAudio(pid);
    const {createHash} = await import('node:crypto');
    const shaNow = createHash('sha256').update(fs.readFileSync(absMaster)).digest('hex');
    ok(
      manifest !== null && manifest.master.sha256 === shaNow && fs.statSync(absMaster).size > 44,
      '[FC75] orphan final path（无 artifact 引用）→ 安全替换为新 master',
    );
  }
  {
    // FC76-G：final 被历史 artifact 引用但非 current → MASTER_PATH_CONFLICT（拒绝覆盖历史文件）
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const first = tryFinalizeNarrationAudio(pid)!;
    const absMaster = path.join(getDataDir(), first.master.filePath);
    const {createHash} = await import('node:crypto');
    const shaBefore = createHash('sha256').update(fs.readFileSync(absMaster)).digest('hex');
    // 把该 artifact 的 source 改为非 current（但仍引用同一 master 路径）
    const artifactRow = db
      .prepare('SELECT id, content_json FROM artifacts WHERE project_id = ? AND kind = ?')
      .get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {id: string; content_json: string};
    const tampered = JSON.parse(artifactRow.content_json) as {source: {narrationPlanArtifactId: string}};
    tampered.source.narrationPlanArtifactId = 'other-plan-artifact';
    db.prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(tampered), artifactRow.id);
    let threwG: string | null = null;
    try {
      tryFinalizeNarrationAudio(pid);
    } catch (err) {
      threwG = err instanceof NarrationAudioError ? err.code : String(err);
    }
    const shaAfter = createHash('sha256').update(fs.readFileSync(absMaster)).digest('hex');
    ok(
      threwG === 'MASTER_PATH_CONFLICT' && shaBefore === shaAfter,
      '[FC76] final 被历史 artifact 引用（非 current）→ MASTER_PATH_CONFLICT，不覆盖历史文件',
      threwG,
    );
  }

  // ============ QC clipping repair（append-only replacement + pre-resample headroom） ============
  {
    const clipped = Buffer.alloc(12);
    [0, 32767, 32767, 0, -32768, 0].forEach((value, index) => clipped.writeInt16LE(value, index * 2));
    const metrics = analyzeS16PcmHardClipping(clipped);
    ok(
      metrics.fullScaleSamples === 3 && metrics.saturationRuns === 2 &&
        metrics.hardPlateauRuns === 1 && metrics.longestSaturationRun === 2,
      '[QC1] hard clipping detector counts full-scale samples and plateau runs',
      metrics,
    );
  }
  {
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const originalManifest = tryFinalizeNarrationAudio(pid)!;
    const originalArtifact = db.prepare(
      'SELECT id, version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1',
    ).get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {id: string; version: number};
    const originalMaster = path.join(getDataDir(), originalManifest.master.filePath);
    const originalMasterBytes = fs.readFileSync(originalMaster);
    const originalSpeech = originalManifest.units.filter((unit) => unit.kind === 'speech');
    const target = originalSpeech[0]!;
    const originalJob = getTtsJob(target.ttsJobId)!;
    const queued = enqueueNarrationAudioQcReplacementJobs(pid, [{
      unitId: target.unitId,
      supersedesJobId: target.ttsJobId,
    }], {
      expectedPlan: {
        artifactId: originalJob.narration_plan_artifact_id,
        version: originalJob.narration_plan_version,
      },
      voiceProfile: {id: originalJob.voice_profile_id, revision: originalJob.voice_profile_revision},
    });
    await runAllTtsJobs(pid);
    const replacement = getTtsJob(queued.jobs[0]!.jobId)!;
    const replacementPayload = JSON.parse(replacement.payload_json) as {
      qcReplacement?: {reason: string; supersedesJobId: string; candidateNumber: number};
    };
    ok(
      replacement.status === 'succeeded' && replacement.id !== originalJob.id &&
        replacementPayload.qcReplacement?.reason === 'AUDIO_QC_CLIPPING' &&
        replacementPayload.qcReplacement.supersedesJobId === originalJob.id &&
        replacementPayload.qcReplacement.candidateNumber === 1 &&
        fs.existsSync(path.join(getDataDir(), originalJob.output_path!)),
      '[QC2] QC replacement is append-only and preserves original succeeded WAV',
    );
    const second = enqueueNarrationAudioQcReplacementJobs(pid, [{
      unitId: target.unitId,
      supersedesJobId: target.ttsJobId,
    }], {
      expectedPlan: {
        artifactId: originalJob.narration_plan_artifact_id,
        version: originalJob.narration_plan_version,
      },
      voiceProfile: {id: originalJob.voice_profile_id, revision: originalJob.voice_profile_revision},
    });
    await runAllTtsJobs(pid);
    let replacementLimit: string | null = null;
    try {
      enqueueNarrationAudioQcReplacementJobs(pid, [{
        unitId: target.unitId,
        supersedesJobId: target.ttsJobId,
      }], {
        expectedPlan: {
          artifactId: originalJob.narration_plan_artifact_id,
          version: originalJob.narration_plan_version,
        },
        voiceProfile: {id: originalJob.voice_profile_id, revision: originalJob.voice_profile_revision},
      });
    } catch (err) {
      replacementLimit = err instanceof NarrationAudioError ? err.code : String(err);
    }
    ok(
      getTtsJob(second.jobs[0]!.jobId)?.status === 'succeeded' && replacementLimit === 'QC_REPLACEMENT_LIMIT',
      '[QC2b] one original permits at most two append-only replacement candidates',
      replacementLimit,
    );
    const selectedTtsJobIds = Object.fromEntries(
      originalSpeech.map((unit) => [unit.unitId, unit.unitId === target.unitId ? replacement.id : unit.ttsJobId]),
    );
    const repaired = tryFinalizeNarrationAudio(pid, {
      expectedPlan: {
        artifactId: originalJob.narration_plan_artifact_id,
        version: originalJob.narration_plan_version,
      },
      voiceProfile: {id: originalJob.voice_profile_id, revision: originalJob.voice_profile_revision},
      repair: {
        reason: 'AUDIO_QC_CLIPPING',
        supersedes: originalArtifact,
        preResampleHeadroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB,
        selectedTtsJobIds,
        replacedSegments: [target.unitId],
      },
    })!;
    const artifacts = db.prepare(
      'SELECT id, version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version',
    ).all(pid, NARRATION_AUDIO_ARTIFACT_KIND) as Array<{id: string; version: number}>;
    const repairedMaster = path.join(getDataDir(), repaired.master.filePath);
    const repairedTarget = repaired.units.find((unit) => unit.unitId === target.unitId);
    ok(
      artifacts.length === 2 && artifacts[0]!.id === originalArtifact.id && artifacts[1]!.version === 2 &&
        repaired.master.filePath !== originalManifest.master.filePath &&
        fs.readFileSync(originalMaster).equals(originalMasterBytes),
      '[QC3] repaired audio is revision 2 and original artifact/master remain unchanged',
      {artifacts, repairedPath: repaired.master.filePath},
    );
    ok(
      repaired.repair?.reason === 'AUDIO_QC_CLIPPING' &&
        repaired.repair.supersedes.id === originalArtifact.id &&
        repaired.repair.preResampleHeadroomDb === NARRATION_AUDIO_REPAIR_HEADROOM_DB &&
        repaired.repair.replacedSegments.length === 1 &&
        repaired.repair.reusedSegments.length === originalSpeech.length - 1 &&
        repairedTarget?.kind === 'speech' && repairedTarget.ttsJobId === replacement.id,
      '[QC4] repair provenance pins exact replacement and reused originals',
      repaired.repair,
    );
    const repairedClipping = analyzeS16WavHardClipping(repairedMaster);
    ok(
      repairedClipping.fullScaleSamples === 0 && repairedClipping.saturationRuns === 0,
      '[QC5] repaired finalize applies measured headroom and emits no hard clipping',
      repairedClipping,
    );
    const repairedWithSecondCandidate = tryFinalizeNarrationAudio(pid, {
      expectedPlan: {
        artifactId: originalJob.narration_plan_artifact_id,
        version: originalJob.narration_plan_version,
      },
      voiceProfile: {id: originalJob.voice_profile_id, revision: originalJob.voice_profile_revision},
      repair: {
        reason: 'AUDIO_QC_CLIPPING',
        supersedes: originalArtifact,
        preResampleHeadroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB,
        selectedTtsJobIds: {
          ...selectedTtsJobIds,
          [target.unitId]: second.jobs[0]!.jobId,
        },
        replacedSegments: [target.unitId],
      },
    })!;
    const secondCandidateTarget = repairedWithSecondCandidate.units.find((unit) => unit.unitId === target.unitId);
    ok(
      repairedWithSecondCandidate.master.filePath !== repaired.master.filePath &&
        secondCandidateTarget?.kind === 'speech' && secondCandidateTarget.ttsJobId === second.jobs[0]!.jobId,
      '[QC6] idempotent reuse requires the exact selected replacement job identity',
      {first: repaired.master.filePath, second: repairedWithSecondCandidate.master.filePath},
    );
  }
  {
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, `# Script V2

## 第 1 章 Micro Repair

理解利率，不是把人生变成财务公式，而是承认时间会改变价格。既然时间交易有价格，吃苦和坚持也不能只看还能不能扛。`);
    const planArtifact = buildNarrationPlan(pid).artifact;
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    const originalManifest = tryFinalizeNarrationAudio(pid)!;
    const originalArtifact = db.prepare(
      'SELECT id, version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1',
    ).get(pid, NARRATION_AUDIO_ARTIFACT_KIND) as {id: string; version: number};
    const originalMaster = path.join(getDataDir(), originalManifest.master.filePath);
    const originalMasterBytes = fs.readFileSync(originalMaster);
    const speech = originalManifest.units.filter((unit) => unit.kind === 'speech');
    const target = speech[0]!;
    const children = target.text.match(/[^。！？；]+[。！？；]|[^。！？；]+$/gu) ?? [];
    const queued = enqueueNarrationAudioMicroRepairJobs(pid, [{
      parentUnitId: target.unitId,
      supersedesJobId: target.ttsJobId,
      splitPlan: 1,
      children,
    }], {
      expectedPlan: {artifactId: planArtifact.id, version: planArtifact.version},
      voiceProfile: {id: 'default', revision: '1'},
    });
    await runAllTtsJobs(pid);
    const childJobs = queued.jobs.map(({jobId}) => getTtsJob(jobId)!);
    const childPayloads = childJobs.map((job) => JSON.parse(job.payload_json) as {
      unitText: string;
      qcMicroSegment: {parentUnitId: string; childIndex: number; childCount: number};
    });
    ok(
      queued.jobs.length === 2 && childJobs.every((job) => job.max_attempts === 1) &&
        childPayloads.map((payload) => payload.unitText).join('') === target.text &&
        childPayloads.every((payload, index) =>
          payload.qcMicroSegment.parentUnitId === target.unitId &&
          payload.qcMicroSegment.childIndex === index + 1 && payload.qcMicroSegment.childCount === 2),
      '[QC7] exact-text micro children reconstruct the locked logical parent',
      childPayloads,
    );
    const targetedRetry = enqueueNarrationAudioMicroRepairJobs(pid, [{
      parentUnitId: target.unitId,
      supersedesJobId: target.ttsJobId,
      splitPlan: 1,
      children,
      childIndexes: [1],
    }], {
      expectedPlan: {artifactId: planArtifact.id, version: planArtifact.version},
      voiceProfile: {id: 'default', revision: '1'},
    });
    ok(
      targetedRetry.jobs.length === 1 && targetedRetry.jobs[0]!.childIndex === 1 &&
        targetedRetry.jobs[0]!.candidateNumber === 2,
      '[QC8] micro retry creates only the explicitly failed child candidate',
      targetedRetry.jobs,
    );
    const composite = assembleNarrationAudioMicroRepairParent(pid, {
      parentUnitId: target.unitId,
      supersedesJobId: target.ttsJobId,
      splitPlan: 1,
      selectedChildJobIds: childJobs.map((job) => job.id),
    }, {
      expectedPlan: {artifactId: planArtifact.id, version: planArtifact.version},
      voiceProfile: {id: 'default', revision: '1'},
    });
    const compositePayload = JSON.parse(composite.job.payload_json) as {
      unitText: string;
      qcReplacement: {method: string; microComposite: {childJobIds: string[]}};
    };
    ok(
      composite.job.status === 'succeeded' && compositePayload.unitText === target.text &&
        compositePayload.qcReplacement.method === 'EXACT_TEXT_MICRO_SEGMENT' &&
        compositePayload.qcReplacement.microComposite.childJobIds.length === 2 &&
        composite.clipping.fullScaleSamples === 0 && composite.clipping.saturationRuns === 0,
      '[QC9] clean micro children assemble append-only into one logical parent replacement',
      compositePayload,
    );
    const selectedTtsJobIds = Object.fromEntries(
      speech.map((unit) => [unit.unitId, unit.unitId === target.unitId ? composite.job.id : unit.ttsJobId]),
    );
    const repaired = tryFinalizeNarrationAudio(pid, {
      expectedPlan: {artifactId: planArtifact.id, version: planArtifact.version},
      voiceProfile: {id: 'default', revision: '1'},
      repair: {
        reason: 'AUDIO_QC_CLIPPING',
        supersedes: originalArtifact,
        preResampleHeadroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB,
        selectedTtsJobIds,
        replacedSegments: [target.unitId],
      },
    })!;
    const repairedTarget = repaired.units.find((unit) => unit.kind === 'speech' && unit.unitId === target.unitId);
    ok(
      repairedTarget?.kind === 'speech' && repairedTarget.ttsJobId === composite.job.id &&
        analyzeS16WavHardClipping(path.join(getDataDir(), repaired.master.filePath)).fullScaleSamples === 0 &&
        fs.readFileSync(originalMaster).equals(originalMasterBytes),
      '[QC10] micro parent flows through repair-only finalize without overwriting original master',
      repaired.repair,
    );
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

/**
 * M3-F Real IndexTTS2 全链验收（release gate）。
 *
 * 用法：RUN_REAL_INDEXTTS2_SMOKE=1 npx tsx scripts/test-m3f-real-tts.ts
 * 前置：adapter 已在 127.0.0.1:9880 运行（ADAPTER_UPSTREAM 可达真实 8002）。
 * 未设置环境变量或 adapter 不可达时 SKIP。
 *
 * 真实链：10 stages（Mock LLM）→ Narration Plan → **真实 IndexTTS2**（正式
 * TTS_PROVIDER=indextts2 + 正式 Worker runTtsJob）→ Master → Subtitle →
 * Scenes → Reconciliation → Final Render → MP4。
 * 禁止手工插 succeeded tts_job / 复制 direct-smoke WAV 伪装 Provider output。
 */

import {execFileSync, spawn, spawnSync, type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ADAPTER_URL = process.env.INDEXTTS2_BASE_URL ?? 'http://127.0.0.1:9880';

if (process.env.RUN_REAL_INDEXTTS2_SMOKE !== '1') {
  console.log('[m3f-real] SKIP：设置 RUN_REAL_INDEXTTS2_SMOKE=1 运行真实全链验收');
  process.exit(0);
}

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3f-real');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'indextts2';
process.env.INDEXTTS2_BASE_URL = ADAPTER_URL;

import {closeDb, getDb} from '../src/lib/db';
import {enqueueFinalRender} from '../src/lib/final-render/bridge';
import {FINAL_RENDER_SOURCE_ARTIFACT_KIND, type FinalRenderSource} from '../src/lib/final-render/schema';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {
  enqueueNarrationAudioJobs,
  getCurrentNarrationAudioArtifact,
  getNarrationAudioOverview,
  tryFinalizeNarrationAudio,
} from '../src/lib/narration/audio';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {buildTimingReconciliation, getCurrentTimingReconciliation} from '../src/lib/reconciliation/timing';
import {buildSubtitleTiming, getCurrentSubtitleTiming} from '../src/lib/subtitles/timing';
import {getTtsJob, ttsJobResultSchema, type TtsJobRow} from '../src/lib/tts-jobs';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'test-m3f-real');
const JOB_TIMEOUT_MS = 180_000;
const RENDER_TIMEOUT_MS = 600_000;

/** 短 Script：3 个 speech unit + 1 explicit pause（控制真实 GPU 成本）。 */
const SCRIPT_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–00:30）

你注意到没有。（停顿 1s）有些话听起来很简单。其实藏着别的意思。
`;

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

async function waitFor(label: string, fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(2000);
  }
  console.log(`[wait] 超时: ${label}`);
  return false;
}

function sha256File(abs: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function ffprobeJson(f: string): Record<string, unknown> {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f,
  ], {encoding: 'utf8'});
  return JSON.parse(out) as Record<string, unknown>;
}

function ffprobeDurationMs(f: string): number {
  const probe = ffprobeJson(f) as {format: {duration: string}};
  return Math.round(Number(probe.format.duration) * 1000);
}

function ffprobeFrameCount(mp4: string): number | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'default=noprint_wrappers=1:nokey=1', mp4,
    ], {encoding: 'utf8'});
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function gpuSample(label: string): void {
  const res = spawnSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'feiniu',
    'nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader; nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader',
  ], {encoding: 'utf8', timeout: 20_000});
  console.log(`[gpu ${label}]\n${res.stdout?.trim() ?? '(unavailable)'}`);
}

async function main(): Promise<void> {
  // 前置：adapter 可达且 ready
  {
    const res = await fetch(`${ADAPTER_URL}/health`, {signal: AbortSignal.timeout(10_000)});
    const json = (await res.json()) as {ready?: boolean};
    if (!res.ok || json.ready !== true) {
      console.log('[m3f-real] SKIP：adapter 未 ready（请先启动 services/indextts2-api-adapter）');
      process.exit(0);
    }
    console.log('[m3f-real] adapter ready');
  }

  fs.rmSync(DATA_DIR, {recursive: true, force: true});

  const worker: ChildProcess = spawn('pnpm', ['worker'], {
    env: {
      ...process.env,
      LLM_PROVIDER: 'mock',
      TTS_PROVIDER: 'indextts2',
      INDEXTTS2_BASE_URL: ADAPTER_URL,
      ZHIYING_DATA_DIR: path.join('data', 'test-m3f-real'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const workerLog: string[] = [];
  worker.stdout!.on('data', (d) => workerLog.push(String(d)));
  worker.stderr!.on('data', (d) => workerLog.push(String(d)));
  const workerReady = await waitFor('worker starting', () => workerLog.join('').includes('starting'), 30_000);
  if (!workerReady) {
    console.error('[m3f-real] Worker 启动失败\n', workerLog.join('').slice(-1000));
    process.exit(1);
  }
  console.log('[m3f-real] Worker 已启动（TTS_PROVIDER=indextts2）');

  const stopWorker = async (): Promise<void> => {
    worker.kill('SIGTERM');
    await waitFor('worker exit', () => workerLog.join('').includes('bye.'), 15_000);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  };

  try {
    // ---- 1. 工作流前六阶段（Mock LLM）+ 短 Script V2 ----
    const pid = createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'}).project.id;
    for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
      const job = enqueueWorkflowStageJob(pid, stage);
      const done = await waitFor(`llm ${stage}`, () => {
        const j = getLlmJob(job.id);
        return j?.status === 'succeeded' || j?.status === 'failed';
      }, JOB_TIMEOUT_MS);
      ok(done && getLlmJob(job.id)!.status === 'succeeded', `[1] ${stage} succeeded`);
      lockStage(pid, stage);
    }
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: SCRIPT_V2, contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'script_v2');

    // ---- 2. Narration Plan + 真实 IndexTTS2 TTS jobs ----
    buildNarrationPlan(pid);
    const enq = enqueueNarrationAudioJobs(pid);
    ok(enq.enqueued === 2, '[2] 2 个 speech unit 入队真实 TTS', enq);
    gpuSample('TTS 前');
    const ttsStart = Date.now();
    let gpuSampled = false;
    const ttsDone = await waitFor('real tts jobs', () => {
      const ov = getNarrationAudioOverview(pid);
      if (!gpuSampled && ov.units.some((u) => u.jobStatus === 'running')) {
        gpuSampled = true;
        gpuSample('TTS 推理中');
      }
      return ov.speechTotal > 0 && ov.speechComplete === ov.speechTotal;
    }, 600_000);
    const ttsElapsedSec = (Date.now() - ttsStart) / 1000;
    ok(ttsDone, '[2] 全部真实 IndexTTS2 jobs succeeded');

    // ---- 3. TTS job 级验证（provider/output/ffprobe/result_json）----
    const jobs = getDb().prepare(
      `SELECT * FROM tts_jobs WHERE project_id = ? ORDER BY queued_at ASC`,
    ).all(pid) as TtsJobRow[];
    let allJobMeta = true;
    let allFfprobe = true;
    let totalAudioSec = 0;
    for (const job of jobs) {
      if (job.status !== 'succeeded' || job.provider !== 'indextts2') allJobMeta = false;
      if (!job.output_path || job.duration_ms === null || !job.audio_sha256 || !job.result_json) allJobMeta = false;
      if (job.voice_profile_id !== 'default' || job.voice_profile_revision !== '1') allJobMeta = false;
      if (!job.output_path) continue;
      const abs = path.join(DATA_DIR, job.output_path);
      if (!fs.existsSync(abs) || fs.readFileSync(abs).subarray(0, 4).toString() !== 'RIFF') allFfprobe = false;
      const measured = ffprobeDurationMs(abs);
      if (Math.abs(measured - job.duration_ms!) > 100) allFfprobe = false;
      totalAudioSec += measured / 1000;
      const result = ttsJobResultSchema.safeParse(JSON.parse(job.result_json!));
      if (!result.success) allJobMeta = false;
      else {
        if (result.data.provider !== 'indextts2' || result.data.model !== 'IndexTTS-2') allJobMeta = false;
        if (result.data.providerVersion !== null || result.data.providerCommit !== null) allJobMeta = false;
        if (result.data.settings.voiceProfileId !== 'default' ||
            result.data.settings.voiceProfileRevision !== '1' ||
            result.data.settings.useRandom !== false) allJobMeta = false;
      }
      console.log(`[job ${job.unit_id}] duration_ms=${job.duration_ms} ffprobe=${measured} sha=${job.audio_sha256?.slice(0, 12)}`);
    }
    ok(allJobMeta, '[3] tts_jobs provider/model/voice/useRandom/result_json 全部真实合法（无伪造 metadata）');
    ok(allFfprobe, '[3] unit WAV RIFF + ffprobe 实测 == duration_ms（±100ms）');
    console.log(`[perf] 2 units 真实语音 ${totalAudioSec.toFixed(1)}s，TTS 墙钟 ${ttsElapsedSec.toFixed(0)}s，RTF≈${(ttsElapsedSec / totalAudioSec).toFixed(2)}`);

    // ---- 4. Master finalize ----
    const manifest = tryFinalizeNarrationAudio(pid);
    ok(manifest !== null, '[4] tryFinalizeNarrationAudio 成功');
    const audio = getCurrentNarrationAudioArtifact(pid)!;
    const m = audio.manifest;
    ok(
      m.provider.name === 'indextts2' && m.provider.model === 'IndexTTS-2' &&
        m.provider.voiceProfile.id === 'default' && m.provider.voiceProfile.revision === '1' &&
        m.provider.useRandom === false,
      '[4] manifest provider snapshot（indextts2/IndexTTS-2/default@1（frozen DEFAULT_VOICE_PROFILE）/useRandom=false）',
    );
    const masterAbs = path.join(DATA_DIR, m.master.filePath);
    const masterProbe = ffprobeJson(masterAbs) as {streams: Array<Record<string, unknown>>; format: {duration: string}};
    ok(
      masterProbe.streams[0]!.codec_name === 'pcm_s16le' &&
        Number(masterProbe.streams[0]!.sample_rate) === 48000 &&
        masterProbe.streams[0]!.channels === 1,
      '[4] Master 48kHz/mono/pcm_s16le',
    );
    const masterSha = sha256File(masterAbs);
    ok(masterSha === m.master.sha256, '[4] Master SHA 与 manifest 一致');
    const expectedMs = jobs.reduce((s, j) => s + (j.duration_ms ?? 0), 0) + 1000;
    ok(
      Math.abs(m.master.durationMs - expectedMs) <= 100,
      '[4] master duration ≈ Σ speech + 1s pause',
      {master: m.master.durationMs, expectedMs},
    );

    // ---- 5. M3-C / M3-D ----
    buildSubtitleTiming(pid);
    const subtitle = getCurrentSubtitleTiming(pid)!;
    ok(subtitle.timing.cues.length > 0, '[5] Subtitle Timing ready', {cues: subtitle.timing.cues.length});
    for (const stage of WORKFLOW_STAGES.slice(6)) {
      const job = enqueueWorkflowStageJob(pid, stage);
      const done = await waitFor(`llm ${stage}`, () => {
        const j = getLlmJob(job.id);
        return j?.status === 'succeeded' || j?.status === 'failed';
      }, JOB_TIMEOUT_MS);
      ok(done && getLlmJob(job.id)!.status === 'succeeded', `[5] ${stage} succeeded`);
      lockStage(pid, stage);
    }
    buildTimingReconciliation(pid);
    const rec = getCurrentTimingReconciliation(pid)!;
    ok(
      rec.reconciliation.target.totalFrames > 0 &&
        Math.abs(rec.reconciliation.target.frameResidualMs) <= 17,
      '[5] Reconciliation ready',
      {
        targetFrames: rec.reconciliation.target.totalFrames,
        residualMs: rec.reconciliation.target.frameResidualMs,
        masterMs: m.master.durationMs,
      },
    );

    // ---- 6. M3-E Final Render ----
    const {job: renderJob, sourceArtifact} = enqueueFinalRender(pid);
    const sourceRow = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(sourceArtifact.id) as {content_json: string};
    const finalSource = JSON.parse(sourceRow.content_json) as FinalRenderSource;
    ok(finalSource.source.masterSha256 === masterSha, '[6] final source master sha == master sha');
    const renderDone = await waitFor('final render', () => {
      const j = getDb().prepare('SELECT status FROM render_jobs WHERE id = ?').get(renderJob.id) as {status: string} | undefined;
      return j?.status === 'succeeded' || j?.status === 'failed' || j?.status === 'cancelled';
    }, RENDER_TIMEOUT_MS);
    const finalJob = getDb().prepare('SELECT * FROM render_jobs WHERE id = ?').get(renderJob.id) as
      {status: string; output_path: string | null; error_message: string | null};
    if (finalJob.status !== 'succeeded') {
      console.log('[worker log tail]', workerLog.join('').slice(-2000));
    }
    ok(renderDone && finalJob.status === 'succeeded', '[6] Final Render succeeded（真实 renderMedia）', finalJob.error_message ?? undefined);
    const mp4 = path.join(DATA_DIR, finalJob.output_path!);

    const probe = ffprobeJson(mp4);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const video = streams.find((s) => s.codec_type === 'video')!;
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    ok(String(video.codec_name) === 'h264' && video.width === 1920 && video.height === 1080, '[6] MP4 h264 1920×1080');
    const fpsParts = String(video.avg_frame_rate).split('/');
    ok(Math.abs(Number(fpsParts[0]) / Number(fpsParts[1] ?? 1) - 30) < 0.01, '[6] 30fps');
    ok(audioStream !== undefined, '[6] audio stream 存在（真实 IndexTTS2 narration）');
    const frames = ffprobeFrameCount(mp4);
    ok(frames === rec.reconciliation.target.totalFrames, '[6] nb_read_frames == targetTotalFrames',
      {frames, target: rec.reconciliation.target.totalFrames});

    // ---- 7. SHA 链：Master == FinalSource == staged ----
    const stagedAbs = path.join(
      DATA_DIR, 'bundle-cache', 'freud-mg-v1.0', 'public',
      'runtime-audio', pid, `${audio.artifact.id}.wav`,
    );
    const stagedSha = fs.existsSync(stagedAbs) ? sha256File(stagedAbs) : 'missing';
    ok(
      fs.existsSync(stagedAbs) && stagedSha === masterSha && finalSource.source.masterSha256 === masterSha,
      '[7] Master SHA == Final Source SHA == staged WAV SHA（真实 IndexTTS2 provenance 闭环）',
      {master: masterSha.slice(0, 16), staged: stagedSha.slice(0, 16)},
    );
    ok(m.provider.name === 'indextts2', '[7] manifest provider.name = indextts2（非 mock）');
    gpuSample('render 后（adapter 应无 GPU）');
  } finally {
    await stopWorker();
    closeDb();
  }

  console.log(`\nM3-F REAL: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[m3f-real] 异常终止:', err);
  process.exitCode = 1;
});

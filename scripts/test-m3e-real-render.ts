/**
 * M3-E 真实渲染验收（REAL_RENDER release gate）。
 *
 * 用法：RUN_REAL_REMOTION_SMOKE=1 npx tsx scripts/test-m3e-real-render.ts
 * 未设置环境变量时 SKIP。
 *
 * 真实链路：10 stages locked（Mock LLM）→ Narration Plan → Mock TTS →
 * Audio Manifest/master → Subtitle Timing → Timing Reconciliation →
 * Final Render enqueue → 正式 Worker（runtime narration staging +
 * selectComposition + renderMedia）→ MP4 → ffprobe/sha 校验。
 */

import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.RUN_REAL_REMOTION_SMOKE !== '1') {
  console.log('[m3e-real-render] SKIP：设置 RUN_REAL_REMOTION_SMOKE=1 运行真实渲染验收');
  process.exit(0);
}

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3e-real-render');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {enqueueFinalRender} from '../src/lib/final-render/bridge';
import {FINAL_RENDER_SOURCE_ARTIFACT_KIND, type FinalRenderSource} from '../src/lib/final-render/schema';
import {getLlmJob, enqueueWorkflowStageJob} from '../src/lib/llm-jobs';
import {
  enqueueNarrationAudioJobs,
  getNarrationAudioOverview,
  getCurrentNarrationAudioArtifact,
  tryFinalizeNarrationAudio,
} from '../src/lib/narration/audio';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {buildTimingReconciliation, getCurrentTimingReconciliation} from '../src/lib/reconciliation/timing';
import {buildSubtitleTiming} from '../src/lib/subtitles/timing';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'test-m3e-real-render');
const RENDER_TIMEOUT_MS = 600_000;
const JOB_TIMEOUT_MS = 120_000;

const SCRIPT_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–02:00）

那条消息你看到了。（停顿 1s）

你没有回。为什么偏偏是这一条？

[画面留白]

## 第 2 章 追问（02:00–05:00）

弗洛伊德怀疑过这种忘记。（放慢）他说，有些遗忘背后藏着不情愿。<!-- E01 -->
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
    await sleep(1000);
  }
  console.log(`[wait] 超时: ${label}`);
  return false;
}

function sha256File(abs: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function ffprobeJson(mp4: string): Record<string, unknown> {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', mp4,
  ], {encoding: 'utf8'});
  return JSON.parse(out) as Record<string, unknown>;
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

async function main(): Promise<void> {
  fs.rmSync(DATA_DIR, {recursive: true, force: true});

  const worker: ChildProcess = spawn('pnpm', ['worker'], {
    env: {...process.env, LLM_PROVIDER: 'mock', TTS_PROVIDER: 'mock', ZHIYING_DATA_DIR: path.join('data', 'test-m3e-real-render')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const workerLog: string[] = [];
  worker.stdout!.on('data', (d) => workerLog.push(String(d)));
  worker.stderr!.on('data', (d) => workerLog.push(String(d)));
  const workerReady = await waitFor('worker starting', () => workerLog.join('').includes('starting'), 30_000);
  if (!workerReady) {
    console.error('[m3e-real-render] Worker 启动失败\n', workerLog.join('').slice(-1000));
    process.exit(1);
  }
  console.log('[m3e-real-render] Worker 已启动');

  const stopWorker = async (): Promise<void> => {
    worker.kill('SIGTERM');
    await waitFor('worker exit', () => workerLog.join('').includes('bye.'), 15_000);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  };

  try {
    // ---- 1. 全链：10 stages + Narration + Subtitle + Reconciliation ----
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

    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    const ttsDone = await waitFor('tts jobs', () => {
      const ov = getNarrationAudioOverview(pid);
      return ov.speechTotal > 0 && ov.speechComplete === ov.speechTotal;
    }, JOB_TIMEOUT_MS);
    ok(ttsDone, '[1] 全部 speech TTS 完成（Mock Provider + 正式 Worker）');
    ok(tryFinalizeNarrationAudio(pid) !== null, '[1] Narration Master finalized');
    buildSubtitleTiming(pid);

    for (const stage of WORKFLOW_STAGES.slice(6)) {
      const job = enqueueWorkflowStageJob(pid, stage);
      const done = await waitFor(`llm ${stage}`, () => {
        const j = getLlmJob(job.id);
        return j?.status === 'succeeded' || j?.status === 'failed';
      }, JOB_TIMEOUT_MS);
      ok(done && getLlmJob(job.id)!.status === 'succeeded', `[1] ${stage} succeeded`);
      lockStage(pid, stage);
    }
    buildTimingReconciliation(pid);
    const rec = getCurrentTimingReconciliation(pid)!;
    const targetFrames = rec.reconciliation.target.totalFrames;
    const audio = getCurrentNarrationAudioArtifact(pid)!;
    const masterAbs = path.join(DATA_DIR, audio.manifest.master.filePath);
    const masterSha = sha256File(masterAbs);
    ok(masterSha === audio.manifest.master.sha256, '[1] master 文件 sha 与 manifest 一致');

    // ---- 2. Final Render enqueue → 正式 Worker → MP4 ----
    const {job, sourceArtifact} = enqueueFinalRender(pid);
    const sourceRow = getDb().prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(sourceArtifact.id) as {content_json: string};
    const finalSource = JSON.parse(sourceRow.content_json) as FinalRenderSource;
    ok(finalSource.source.masterSha256 === masterSha, '[2] final source snapshot master sha == master sha');

    const renderDone = await waitFor('final render', () => {
      const j = getDb().prepare('SELECT status FROM render_jobs WHERE id = ?').get(job.id) as {status: string} | undefined;
      return j?.status === 'succeeded' || j?.status === 'failed' || j?.status === 'cancelled';
    }, RENDER_TIMEOUT_MS);
    const finalJob = getDb().prepare('SELECT * FROM render_jobs WHERE id = ?').get(job.id) as
      {status: string; output_path: string | null; error_code: string | null; error_message: string | null};
    if (finalJob.status !== 'succeeded') {
      console.log('[worker log tail]', workerLog.join('').slice(-2000));
    }
    ok(renderDone && finalJob.status === 'succeeded', '[2] Final Render job succeeded（真实 renderMedia）',
      finalJob.error_message ?? finalJob.error_code ?? undefined);
    const mp4 = path.join(DATA_DIR, finalJob.output_path!);
    ok(fs.existsSync(mp4) && fs.statSync(mp4).size > 0, '[2] MP4 存在且 size>0', finalJob.output_path);

    // ---- 3. staged WAV 实证（runtime asset exposure 闭环）----
    const stagedAbs = path.join(
      DATA_DIR, 'bundle-cache', 'freud-mg-v1.0', 'public',
      'runtime-audio', pid, `${audio.artifact.id}.wav`,
    );
    ok(fs.existsSync(stagedAbs), '[3] staged WAV 存在于 bundled public root', stagedAbs);
    ok(
      fs.existsSync(stagedAbs) && sha256File(stagedAbs) === masterSha,
      '[3] staged WAV sha == master sha == final source sha',
    );

    // ---- 4. ffprobe ----
    const probe = ffprobeJson(mp4);
    const streams = probe.streams as Array<Record<string, unknown>>;
    const videoStream = streams.find((s) => s.codec_type === 'video')!;
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    ok(String(videoStream.codec_name) === 'h264', '[4] video codec = h264', videoStream.codec_name);
    ok(videoStream.width === 1920 && videoStream.height === 1080, '[4] 1920×1080');
    const fpsParts = String(videoStream.avg_frame_rate).split('/');
    const fps = Number(fpsParts[0]) / Number(fpsParts[1] ?? 1);
    ok(Math.abs(fps - 30) < 0.01, '[4] 30fps', fps);
    ok(audioStream !== undefined, '[4] audio stream 存在（M3-E 硬门槛）',
      streams.map((s) => s.codec_type));
    const durationSec = Number((probe.format as {duration?: string}).duration);
    const expectedSec = targetFrames / 30;
    const frames = ffprobeFrameCount(mp4);
    if (frames !== null) {
      ok(frames === targetFrames, '[4] nb_read_frames == reconciliation.target.totalFrames',
        {frames, targetFrames});
    } else {
      ok(Math.abs(durationSec - expectedSec) < 0.2, '[4] container duration ≈ target/fps（fallback）',
        {durationSec, expectedSec});
    }

    // ---- 5. 字幕画面 smoke：同场景 cue 活跃帧 vs 无 cue 帧 ----
    const frameCue = path.join(DATA_DIR, 'frame-cue.png');
    const frameNoCue = path.join(DATA_DIR, 'frame-nocue.png');
    // cue#1 活跃 0–1.32s；1.32–2.32s 为 explicit pause（无 cue）；S001 跨 0–6.5s 同一场景
    execFileSync('ffmpeg', ['-y', '-ss', '0.5', '-i', mp4, '-frames:v', '1', frameCue], {stdio: 'pipe'});
    execFileSync('ffmpeg', ['-y', '-ss', '1.8', '-i', mp4, '-frames:v', '1', frameNoCue], {stdio: 'pipe'});
    const md5 = (f: string): string => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
    ok(
      fs.existsSync(frameCue) && fs.existsSync(frameNoCue) && md5(frameCue) !== md5(frameNoCue),
      '[5] cue 活跃帧与无 cue 帧画面不同（字幕轨参与渲染）',
    );
    console.log(`[5] frame-cue: ${frameCue}`);
    console.log(`[5] frame-nocue: ${frameNoCue}`);

    // ---- 6. attempt/source/output 溯源 ----
    const attempt = getDb().prepare(
      "SELECT content_json FROM artifacts WHERE project_id = ? AND kind = 'final_render_attempt' ORDER BY version DESC LIMIT 1",
    ).get(pid) as {content_json: string};
    const attemptJson = JSON.parse(attempt.content_json) as {jobId: string; finalRenderSourceArtifactId: string};
    ok(
      attemptJson.jobId === job.id && attemptJson.finalRenderSourceArtifactId === sourceArtifact.id,
      '[6] final_render_attempt 绑定 job → exact source',
    );
    const renderOutput = getDb().prepare(
      "SELECT * FROM artifacts WHERE project_id = ? AND kind = 'render_output' ORDER BY version DESC LIMIT 1",
    ).get(pid) as {file_path: string | null} | undefined;
    ok(renderOutput !== undefined && renderOutput.file_path === finalJob.output_path, '[6] render_output artifact 已产生');
  } finally {
    await stopWorker();
    closeDb();
  }

  console.log(`\nM3-E REAL_RENDER: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
  // 保留 DATA_DIR 供人工核验抽帧/MP4；不入 git（data/ 已忽略）
}

main().catch((err) => {
  console.error('[m3e-real-render] 异常终止:', err);
  process.exit(1);
});

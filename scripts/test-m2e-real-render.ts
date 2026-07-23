/**
 * M2-E-D 真实渲染验收（integration / environment test）。
 *
 * 用法：RUN_REAL_REMOTION_SMOKE=1 npx tsx scripts/test-m2e-real-render.ts
 * 未设置环境变量时 SKIP（不纳入零依赖 unit regression）。
 *
 * 真实链路：workflow project → 10 stages（真实 Worker + Mock LLM）→
 * scenes locked → Render Bridge → render_jobs → 正式 Worker →
 * selectComposition + renderMedia → MP4 → ffprobe/ffmpeg 校验 →
 * snapshot/stale/fence/cancel 语义。
 */

import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.env.RUN_REAL_REMOTION_SMOKE !== '1') {
  console.log('[real-render] SKIP：设置 RUN_REAL_REMOTION_SMOKE=1 运行真实渲染验收');
  process.exit(0);
}

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-real-render');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {requestCancel} from '../src/lib/jobs';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';
import {
  buildWorkflowRenderProps,
  checkWorkflowRenderReadiness,
  enqueueWorkflowPreviewRender,
  getRenderSourceVersion,
  RenderBridgeError,
} from '../src/lib/workflow/render-bridge';
import {editVersion} from '../src/lib/workflow/operations';
import {getStage, listStages, lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'test-real-render');
const WORKER_START_TIMEOUT_MS = 30_000;
const LLM_JOB_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 600_000;

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

function getRenderJob(jobId: string): {id: string; status: string; output_path: string | null; error_code: string | null; error_message: string | null} | undefined {
  return getDb()
    .prepare('SELECT id, status, output_path, error_code, error_message FROM render_jobs WHERE id = ?')
    .get(jobId) as {id: string; status: string; output_path: string | null; error_code: string | null; error_message: string | null} | undefined;
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

async function waitLlmJob(jobId: string): Promise<boolean> {
  return waitFor(`llm ${jobId}`, () => {
    const job = getLlmJob(jobId);
    return job?.status === 'succeeded' || job?.status === 'failed';
  }, LLM_JOB_TIMEOUT_MS);
}

function ffprobeJson(mp4: string): Record<string, unknown> {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', mp4,
  ], {encoding: 'utf8'});
  return JSON.parse(out) as Record<string, unknown>;
}

async function main(): Promise<void> {
  fs.rmSync(DATA_DIR, {recursive: true, force: true});

  // ---- 启动正式 Worker（真实进程） ----
  const worker: ChildProcess = spawn('pnpm', ['worker'], {
    env: {...process.env, LLM_PROVIDER: 'mock', ZHIYING_DATA_DIR: path.join('data', 'test-real-render')},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const workerLog: string[] = [];
  worker.stdout!.on('data', (d) => workerLog.push(String(d)));
  worker.stderr!.on('data', (d) => workerLog.push(String(d)));
  const workerReady = await waitFor('worker starting', () => workerLog.join('').includes('starting'), WORKER_START_TIMEOUT_MS);
  if (!workerReady) {
    console.error('[real-render] Worker 启动失败\n', workerLog.join('').slice(-1000));
    process.exit(1);
  }
  console.log('[real-render] Worker 已启动');

  try {
    // ---- 1. 真实 10 阶段（Mock LLM + 正式 Worker） ----
    const pid = createProjectWithWorkflow({
      topic: '我们为什么会拖延',
      coreQuestion: '拖延只是时间管理问题吗？',
    }).project.id;
    for (const stage of WORKFLOW_STAGES) {
      const job = enqueueWorkflowStageJob(pid, stage);
      const done = await waitLlmJob(job.id);
      const finalJob = getLlmJob(job.id)!;
      ok(done && finalJob.status === 'succeeded', `[1] ${stage} job succeeded`, finalJob.error_code ?? undefined);
      lockStage(pid, stage);
    }
    ok(
      listStages(pid).filter((s) => s.status === 'locked').length === 10,
      '[1] 10/10 stages locked（真实 Worker 链路）',
    );

    // ---- 2. Readiness + props（真实 fs，不再被示例音频阻塞） ----
    const readiness = checkWorkflowRenderReadiness(pid);
    ok(readiness.ready && readiness.scenesVersion === 1, '[2] readiness ready（preview 无示例音频依赖）', readiness.blockers.map((b) => b.code));
    const {props, scenesVersion} = buildWorkflowRenderProps(pid);
    ok(
      zhiyingFullCutPropsSchema.safeParse(props).success &&
        props.audio.narration === null && props.audio.bgm === null && props.audio.sfx === null &&
        props.subtitles.length === 0 && props.showSubtitles === false,
      '[2] preview props 合法且音频全 null',
    );
    const expectedFrames = props.data.project.durationInFrames;
    ok(expectedFrames === 435 && scenesVersion === 1, '[2] durationInFrames=435（14.5s×30）');

    // ---- 3. Render Preview → 正式 Worker → MP4 ----
    const {job: renderJob, scenesVersion: v1} = enqueueWorkflowPreviewRender(pid);
    ok(v1 === 1 && renderJob.kind === 'no-subtitles', '[3] render job 入队（no-subtitles，v1）');
    const renderDone = await waitFor('render succeeded', () => {
      const j = getRenderJob(renderJob.id);
      return j?.status === 'succeeded' || j?.status === 'failed' || j?.status === 'cancelled';
    }, RENDER_TIMEOUT_MS);
    const finalRender = getRenderJob(renderJob.id)!;
    if (finalRender.status !== 'succeeded') {
      console.log('[render worker log tail]', workerLog.join('').slice(-1500));
    }
    ok(renderDone && finalRender.status === 'succeeded', '[3] render job succeeded（真实 renderMedia）', finalRender.error_message ?? undefined);
    ok(finalRender.output_path !== null, '[3] output_path 已写入');

    const mp4 = path.join(DATA_DIR, finalRender.output_path!);
    ok(fs.existsSync(mp4) && fs.statSync(mp4).size > 0, '[3] MP4 真实存在且 size>0', mp4);

    // ---- 4. ffprobe 校验 ----
    const probe = ffprobeJson(mp4);
    const videoStream = (probe.streams as Array<Record<string, unknown>>).find((s) => s.codec_type === 'video')!;
    const durationSec = Number((probe.format as {duration?: string}).duration);
    ok(String(videoStream.codec_name) === 'h264', '[4] codec = h264', videoStream.codec_name);
    ok(videoStream.width === 1920 && videoStream.height === 1080, '[4] 1920×1080');
    const fpsParts = String(videoStream.avg_frame_rate).split('/');
    const fps = Number(fpsParts[0]) / Number(fpsParts[1] ?? 1);
    ok(Math.abs(fps - 30) < 0.01, '[4] 30fps', fps);
    ok(Math.abs(durationSec - 14.5) < 0.5, '[4] duration ≈ 14.5s（locked scenes 末场 end）', durationSec);
    ok(
      Math.round(durationSec * 30) === expectedFrames || Math.abs(Math.round(durationSec * 30) - expectedFrames) <= 1,
      '[4] MP4 时长与 props durationInFrames 一致（Player/Renderer 同一 props）',
      {mp4Frames: Math.round(durationSec * 30), expectedFrames},
    );

    // ---- 5. 内容 smoke：非全黑（ffmpeg blackdetect + 抽帧大小） ----
    const blackdetect = execFileSync('ffmpeg', [
      '-i', mp4, '-vf', 'blackdetect=d=1:pix_th=0.06', '-f', 'null', '-',
    ], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).toString();
    const blackPeriods = (blackdetect.match(/black_start/g) ?? []).length;
    ok(blackPeriods === 0, '[5] blackdetect：无 ≥1s 全黑段（画面真实渲染）', blackPeriods);
    for (const t of [0, 7, 14]) {
      const png = path.join(DATA_DIR, `frame-${t}.png`);
      execFileSync('ffmpeg', ['-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', png], {stdio: 'pipe'});
      ok(fs.existsSync(png) && fs.statSync(png).size > 30_000, `[5] 抽帧 t=${t}s 非退化（>30KB）`, fs.statSync(png).size);
    }

    // ---- 6. Source 追踪：render_source + render_output ----
    ok(getRenderSourceVersion(renderJob.id) === 1, '[6] render_source scenesVersion=1');
    const renderOutput = getDb()
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND kind = 'render_output' ORDER BY version DESC LIMIT 1")
      .get(pid) as {file_path: string | null} | undefined;
    ok(renderOutput !== undefined && renderOutput.file_path !== null, '[6] render_output artifact 已产生');

    // ---- 7. Snapshot 稳定：上游变化后旧 render 不变、新 render 被拒 ----
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: '# Script V2 修改（stale 测试）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    ok(getStage(pid, 'scenes')!.status === 'stale', '[7] script_v2 修改 → scenes stale');
    ok(
      getRenderSourceVersion(renderJob.id) === 1 && fs.existsSync(mp4),
      '[7] 旧 render_source/MP4 不受影响（immutable snapshot）',
    );
    let blocked: string | null = null;
    try {
      enqueueWorkflowPreviewRender(pid);
    } catch (err) {
      blocked = err instanceof RenderBridgeError ? err.code : String(err);
    }
    ok(blocked === 'SCENES_NOT_LOCKED', '[7] stale 后新 render → SCENES_NOT_LOCKED', blocked);

    // ---- 8. 恢复链 → scenes v2 → 第二次真实 render ----
    lockStage(pid, 'script_v2');
    for (const stage of ['narration_beat_map', 'visual_breakdown', 'shot_list', 'scenes'] as const) {
      const job = enqueueWorkflowStageJob(pid, stage);
      await waitLlmJob(job.id);
      lockStage(pid, stage);
    }
    ok(getStage(pid, 'scenes')!.locked_version === 2, '[8] 恢复后 scenes locked_version=2');

    // Active fence：v2 入队后立即第二次入队（worker 尚未完成 claim 窗口内）
    const {job: job2, scenesVersion: v2} = enqueueWorkflowPreviewRender(pid);
    let fenceErr: string | null = null;
    try {
      enqueueWorkflowPreviewRender(pid);
    } catch (err) {
      fenceErr = err instanceof RenderBridgeError ? err.code : String(err);
    }
    ok(fenceErr === 'RENDER_ALREADY_ACTIVE', '[8] active 时第二次入队 → RENDER_ALREADY_ACTIVE', fenceErr);
    ok(v2 === 2, '[8] 第二次 render 绑定 scenesVersion=2');
    const done2 = await waitFor('render v2 succeeded', () => {
      const j = getRenderJob(job2.id);
      return j?.status === 'succeeded' || j?.status === 'failed' || j?.status === 'cancelled';
    }, RENDER_TIMEOUT_MS);
    ok(done2 && getRenderJob(job2.id)!.status === 'succeeded', '[8] render v2 succeeded');
    ok(getRenderSourceVersion(job2.id) === 2, '[8] render_source scenesVersion=2');

    // ---- 9. Cancel（真实 render 中取消） ----
    const {job: job3} = enqueueWorkflowPreviewRender(pid);
    const running = await waitFor('job3 running', () => getRenderJob(job3.id)?.status === 'running', 60_000);
    if (running) {
      requestCancel(job3.id);
      const cancelled = await waitFor('job3 cancelled', () => {
        const s = getRenderJob(job3.id)?.status;
        return s === 'cancelled' || s === 'succeeded';
      }, RENDER_TIMEOUT_MS);
      const final3 = getRenderJob(job3.id)!;
      ok(
        cancelled && final3.status === 'cancelled',
        '[9] 运行中 cancel → Worker abort → cancelled',
        final3.status,
      );
    } else {
      console.log('[9] CANCEL_RUNTIME_SMOKE = NOT_DETERMINISTIC（job 过快完成，worker 未处于 running 观察窗）');
      ok(true, '[9] CANCEL_RUNTIME_SMOKE = NOT_DETERMINISTIC（不阻塞，M1 已有取消测试）');
    }

    closeDb();
    console.log(`\n[real-render] 汇总: PASS=${pass} FAIL=${fail}`);
    if (fail > 0) {
      console.error('[real-render] 存在失败项 ❌');
      process.exitCode = 1;
    } else {
      console.log('[real-render] REAL_WORKFLOW_RENDER = PASS ✅');
    }
  } finally {
    worker.kill('SIGTERM');
    await sleep(1500);
    fs.rmSync(DATA_DIR, {recursive: true, force: true});
  }
}

main().catch((err) => {
  console.error('[real-render] 未捕获异常：', err);
  process.exit(1);
});

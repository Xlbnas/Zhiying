import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {getDataDir} from '@/lib/db';
import {
  completeJob,
  failJob,
  heartbeat,
  isCancelRequested,
  markCancelled,
  recoverStaleJobs,
  requeueJob,
  type RenderJobRow,
} from '@/lib/jobs';
import {recoverStaleLlmJobs} from '@/lib/llm-jobs';
import {buildStageDetail, detailFromRemotionProgress} from '@/lib/render/progress-detail';
import {describeRenderPerfConfig, loadRenderPerfConfig} from '@/lib/render/render-config';
import {claimNextAnyJob} from '@/lib/scheduler';
import {recoverStaleTtsJobs} from '@/lib/tts-jobs';
import {
  COMPOSITION_ID,
  COMPOSITION_ID_NO_SUBTITLES,
  TEMPLATE_VERSION,
  zhiyingFullCutPropsSchema,
  type ZhiyingFullCutProps,
} from '@/lib/scene-schema';
import {runLlmJob} from './llm-executor';
import {RuntimeAudioError, stageRuntimeNarrationAudio} from './runtime-audio';
import {runTtsJob} from './tts-executor';

/**
 * Final Render 性能配置（M5-PERF）：见 src/lib/render/render-config.ts。
 * REMOTION_CONCURRENCY 显式并发（缺失/非法 → Remotion 默认）；
 * REMOTION_GPU_ENABLED=true → ANGLE/EGL 硬件 GL（software path 可一键回退）。
 */
const PERF_CONFIG = loadRenderPerfConfig();

/**
 * 知影渲染 Worker（CONTRACT §4，M2-C 扩展双队列）
 * - 单调度器：claimNextAnyJob 对 render_jobs + llm_jobs 全局 FIFO，
 *   任何时刻只跑一个任务（不引入并发、不拆双 scheduler）
 * - bundle 缓存：data/bundle-cache/{templateVersion}/；
 *   M2-C 起改为 lazy ensureBundle——只有真正 claim 到 render job 才打包，
 *   LLM job 不依赖 Remotion bundle / Chrome / public 运行素材
 * - 渲染：selectComposition + renderMedia（h264 / crf 18）
 * - onProgress 节流（≥2s）写 heartbeat + progress，并检查 isCancelRequested
 * - SIGTERM/SIGINT 优雅退出：当前任务回 queued
 * - WORKER_ROLE 预留（M1 只实现 'all'）
 */

const POLL_INTERVAL_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 2000;
const STALE_TIMEOUT_MS = 2 * 60 * 1000; // recoverStaleJobs(2min)

const WORKER_ID = `worker-${os.hostname()}-${process.pid}`;

/**
 * 渲染用静态服务端口：每个 job 在 runJob 内随机生成（4000+随机）。
 * - 显式指定而非自动选口：renderer 自动选口从 3000 起，Windows 上 IPv4/IPv6
 *   混绑会误判 3000 可用，导致页面实际打到 Next dev（"foreign page" 错误）。
 * - 不复用模块级常量：渲染失败后 Remotion 静态服务端口未必释放，
 *   同进程内 retry/后续 job 复用同一端口必撞（实测 RENDER_ERROR: port not available）。
 */
function randomRenderPort(): number {
  return 4000 + Math.floor(Math.random() * 10000);
}

/** 优雅退出状态（模块级，信号处理器与主循环共享）。 */
let shuttingDown = false;
let currentController: AbortController | null = null;

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [${WORKER_ID}]`, ...args);
}

function requestShutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`received ${signal}, shutting down gracefully…`);
  // 统一当前任务取消句柄（M2-C Hardening §一）：render 与 llm 共用同一
  // AbortController——renderMedia 立即中止；LLM 请求经 signal 得到
  // CANCELLED，runLlmJob 的 catch 检测 shuttingDown 后 requeue（不回 queued 失败、
  // 不标 cancelled、不产生 project_version）。
  currentController?.abort();
}

/**
 * 确保 Remotion bundle 存在。
 * 缓存目录：data/bundle-cache/{templateVersion}/，以 index.html 作为完整标记；
 * 缺失/不完整时清空后用 @remotion/bundler 重新打包（打包结果自带 public/ 静态资源拷贝）。
 */
async function ensureBundle(): Promise<string> {
  const cacheDir = path.join(getDataDir(), 'bundle-cache', TEMPLATE_VERSION);
  const marker = path.join(cacheDir, 'index.html');
  if (fs.existsSync(marker)) {
    log(`bundle cache hit: ${cacheDir}`);
    return cacheDir;
  }
  const entryPoint = path.resolve(process.cwd(), 'src/remotion/index.ts');
  if (!fs.existsSync(entryPoint)) {
    throw new Error(
      `Remotion entry not found: ${entryPoint}（Template agent 负责，等待其交付后再启动 worker）`,
    );
  }
  log(`bundle cache miss, bundling ${entryPoint} → ${cacheDir} …`);
  fs.rmSync(cacheDir, {recursive: true, force: true});
  fs.mkdirSync(cacheDir, {recursive: true});
  let lastLog = 0;
  const location = await bundle({
    entryPoint,
    outDir: cacheDir,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        // Remotion bundler 不读 tsconfig paths，显式注册 '@/*' → './src/*' alias
        alias: {
          ...(config.resolve?.alias ?? {}),
          '@': path.resolve(process.cwd(), 'src'),
        },
      },
      module: {
        ...config.module,
        // tsconfig.json 的 jsx:'preserve' 会被 esbuild-loader 经 tsconfigRaw 传给
        // esbuild，输出 classic React.createElement 且模块内无 React 导入，
        // headless Chrome 执行即抛 "React is not defined"。
        // 此处对 esbuild-loader 强制 jsx:'automatic'（显式选项优先于 tsconfigRaw）。
        rules: (config.module?.rules ?? []).map((rule) => {
          if (!rule || typeof rule !== 'object' || !('use' in rule)) {
            return rule;
          }
          const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
          const patched = uses.map((u) => {
            if (
              u &&
              typeof u === 'object' &&
              'loader' in u &&
              typeof u.loader === 'string' &&
              u.loader.includes('esbuild-loader')
            ) {
              // webpack 类型中 options 可为 string | object；esbuild-loader 恒为对象
              const baseOptions =
                u.options && typeof u.options === 'object' ? u.options : {};
              return {
                ...u,
                options: {...baseOptions, jsx: 'automatic'},
              };
            }
            return u;
          });
          return {...rule, use: patched};
        }),
      },
    }),
    onProgress: (progress: number) => {
      const nowMs = Date.now();
      if (nowMs - lastLog >= 5000) {
        lastLog = nowMs;
        log(`bundling… ${Math.round(progress)}%`);
      }
    },
  });
  log(`bundle ready: ${location}`);
  return location;
}

/**
 * Lazy bundle（M2-C §十）：只有真正 claim 到 render job 才初始化 Remotion；
 * 进程级缓存 Promise（打包一次）。失败时清空缓存让下次 render 重试。
 * LLM job 全程不触碰本函数。
 */
let bundlePromise: Promise<string> | null = null;

function ensureBundleLazy(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = ensureBundle().catch((err: unknown) => {
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}

/** 渲染单个任务（已被 claim，status=running；controller 由主循环统一创建）。 */
async function runJob(
  job: RenderJobRow,
  bundleLocation: string,
  controller: AbortController,
): Promise<void> {
  // 每个 job 独立随机端口：失败后 retry / 下一个 job 不复用旧端口（见上文说明）
  const renderPort = randomRenderPort();
  try {
    // 排队期间被请求取消：直接标记 cancelled，不进入渲染
    if (isCancelRequested(job.id)) {
      markCancelled(job.id);
      log(`job ${job.id} cancelled before start`);
      return;
    }

    // payload 解析 + zod 校验（契约：payload_json = ZhiyingFullCutProps JSON）
    heartbeat(job.id, 0, JSON.stringify(buildStageDetail('prepare')));
    let payloadRaw: unknown;
    try {
      payloadRaw = JSON.parse(job.payload_json);
    } catch {
      failJob(job.id, 'PAYLOAD_INVALID', 'payload_json is not valid JSON');
      return;
    }
    const parsed = zhiyingFullCutPropsSchema.safeParse(payloadRaw);
    if (!parsed.success) {
      failJob(
        job.id,
        'PAYLOAD_INVALID',
        `payload failed schema validation: ${parsed.error.message}`,
      );
      return;
    }
    const inputProps: ZhiyingFullCutProps = {
      ...parsed.data,
      // kind 决定字幕开关与 composition，强制对齐，不信任 payload 里的 showSubtitles
      showSubtitles: job.kind !== 'no-subtitles',
    };
    const compositionId =
      job.kind === 'no-subtitles'
        ? COMPOSITION_ID_NO_SUBTITLES
        : COMPOSITION_ID;

    // M3-E：仅 Final Render（runtime-audio/... narration）进入 staging——
    // attempt→source→exact historical audio 解析 + WAV stage 到 bundled public root；
    // Legacy（full/audio/...）与 Preview（null）不匹配 pattern，行为零变化。
    // 必须先于 selectComposition，保证 staticFile(logicalPath) 可被 Renderer 获取。
    heartbeat(job.id, 0, JSON.stringify(buildStageDetail('staging')));
    try {
      stageRuntimeNarrationAudio(job, parsed.data, bundleLocation);
    } catch (err) {
      if (err instanceof RuntimeAudioError) {
        failJob(job.id, err.code, err.message);
        log(`job ${job.id} runtime narration staging failed: [${err.code}] ${err.message}`);
        return;
      }
      throw err;
    }

    heartbeat(job.id, 0, JSON.stringify(buildStageDetail('compose')));
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: compositionId,
      inputProps,
      port: renderPort,
      ...(PERF_CONFIG.chromiumOptions ? {chromiumOptions: PERF_CONFIG.chromiumOptions} : {}),
    });

    // 输出：data/projects/{projectId}/renders/{jobId}.mp4
    // output_path 存数据目录相对路径（API 侧用 getDataDir() 拼接还原）
    const outputRel = path.posix.join(
      'projects',
      job.project_id,
      'renders',
      `${job.id}.mp4`,
    );
    const outputAbs = path.join(getDataDir(), outputRel);
    fs.mkdirSync(path.dirname(outputAbs), {recursive: true});

    log(
      `job ${job.id} start: project=${job.project_id} kind=${job.kind} ` +
        `composition=${compositionId} ${composition.width}x${composition.height}@${composition.fps} ` +
        `${composition.durationInFrames}f → ${outputRel}`,
    );

    let lastBeat = 0;
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      crf: 18,
      outputLocation: outputAbs,
      inputProps,
      port: renderPort,
      // M5-PERF：显式并发（env 可配；null = Remotion 默认）
      concurrency: PERF_CONFIG.concurrency,
      // M5-PERF：GPU 硬件后端实验（REMOTION_GPU_ENABLED=true 时启用，可回退）
      ...(PERF_CONFIG.chromiumOptions ? {chromiumOptions: PERF_CONFIG.chromiumOptions} : {}),
      // Remotion 的 CancelSignal 是回调注册函数，不是 DOM AbortSignal；在此适配
      cancelSignal: (callback) => {
        if (controller.signal.aborted) {
          callback();
          return;
        }
        controller.signal.addEventListener('abort', callback, {once: true});
      },
      onProgress: (mediaProgress: {
        progress: number;
        renderedFrames: number;
        encodedFrames: number;
        stitchStage: 'encoding' | 'muxing';
        renderEstimatedTime: number | null;
      }) => {
        const nowMs = Date.now();
        if (nowMs - lastBeat < HEARTBEAT_INTERVAL_MS) {
          return;
        }
        lastBeat = nowMs;
        // M5：帧级步骤明细随心跳落库（渲染画面/编码/封装 + 预计剩余）
        const detail = detailFromRemotionProgress(mediaProgress, composition.durationInFrames);
        heartbeat(
          job.id,
          Math.round(mediaProgress.progress * 1000) / 10,
          JSON.stringify({...detail, updatedAt: new Date().toISOString()}),
        );
        // 每轮检查取消请求 → 中止 renderMedia
        if (isCancelRequested(job.id)) {
          controller.abort();
        }
      },
    });

    if (isCancelRequested(job.id)) {
      markCancelled(job.id);
      log(`job ${job.id} cancelled at finish line`);
      return;
    }
    completeJob(job.id, outputRel);
    log(`job ${job.id} succeeded → ${outputRel}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shuttingDown) {
      // 优雅退出：当前任务回 queued，交给下一个 worker / 下次启动
      requeueJob(job.id);
      log(`job ${job.id} requeued due to shutdown`);
      return;
    }
    if (isCancelRequested(job.id)) {
      markCancelled(job.id);
      log(`job ${job.id} cancelled (render aborted)`);
      return;
    }
    failJob(job.id, 'RENDER_ERROR', message);
    log(`job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const role = process.env.WORKER_ROLE ?? 'all';
  if (role !== 'all') {
    log(`WARN: WORKER_ROLE='${role}' 尚未实现（M1 只支持 'all'），按 'all' 运行`);
  }
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));

  log(`starting, data dir: ${getDataDir()}, role: ${role}`);
  log(
    describeRenderPerfConfig(PERF_CONFIG),
  );

  // 1. 启动：回收僵尸任务（render + llm + tts，heartbeat 超过 2min 未更新）
  const recovered = recoverStaleJobs(STALE_TIMEOUT_MS);
  if (recovered > 0) {
    log(`recovered ${recovered} stale render job(s) → queued`);
  }
  const recoveredLlm = recoverStaleLlmJobs(STALE_TIMEOUT_MS);
  if (recoveredLlm.requeued > 0) {
    log(`recovered ${recoveredLlm.requeued} stale llm job(s) → queued`);
  }
  if (recoveredLlm.cancelled > 0) {
    log(`finalized ${recoveredLlm.cancelled} cancelled stale llm job(s)`);
  }
  const recoveredTts = recoverStaleTtsJobs(STALE_TIMEOUT_MS);
  if (recoveredTts.requeued > 0) {
    log(`recovered ${recoveredTts.requeued} stale tts job(s) → queued`);
  }
  if (recoveredTts.cancelled > 0) {
    log(`finalized ${recoveredTts.cancelled} cancelled stale tts job(s)`);
  }

  // 2. 单调度循环：render + llm + tts 全局 FIFO，任何时刻只跑一个；
  //    Remotion bundle 延后到首个 render job 才初始化（LLM/TTS job 零依赖）。
  //    每个被 claim 的任务由主循环创建统一 AbortController（currentController），
  //    SIGTERM/SIGINT 经 requestShutdown 同时覆盖三类任务。
  while (!shuttingDown) {
    const claimed = claimNextAnyJob(WORKER_ID);
    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const controller = new AbortController();
    currentController = controller;
    try {
      if (claimed.type === 'llm') {
        await runLlmJob(claimed.job, {
          isShuttingDown: () => shuttingDown,
          log,
          shutdownSignal: controller.signal,
        });
        continue;
      }
      if (claimed.type === 'tts') {
        await runTtsJob(claimed.job, {
          isShuttingDown: () => shuttingDown,
          log,
          shutdownSignal: controller.signal,
        });
        continue;
      }
      let bundleLocation: string;
      try {
        // M5：bundle 阶段写入步骤明细（首次打包可能数分钟，用户可见而非黑窗）
        heartbeat(claimed.job.id, 0, JSON.stringify(buildStageDetail('bundle')));
        bundleLocation = await ensureBundleLazy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failJob(claimed.job.id, 'BUNDLE_ERROR', message);
        log(`render job ${claimed.job.id} bundle init failed: ${message}`);
        continue;
      }
      await runJob(claimed.job, bundleLocation, controller);
    } finally {
      currentController = null;
    }
  }

  log('bye.');
}

main().catch((err: unknown) => {
  console.error(
    `[${new Date().toISOString()}] [${WORKER_ID}] fatal:`,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {getDataDir, getDb} from '@/lib/db';
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
import {recoverStaleDispatchJobs} from '@/lib/llm-generation/dispatch';
import {buildStageDetail, detailFromRemotionProgress, round1} from '@/lib/render/progress-detail';
import {classifyBundleExit} from '@/lib/render/bundle-classify';
import {runBundlePhase, runWithCleanup} from './render-bundle-phase';
import {describeRenderPerfConfig, loadRenderPerfConfig} from '@/lib/render/render-config';
import {probeNvencSupport} from '@/lib/render/nvenc';
import {recoverStaleTtsJobs} from '@/lib/tts-jobs';
import {MaterializationRecoveryController} from '@/lib/tts-c/recovery-controller';
import {RegistryRecoveryController} from '@/lib/tts-c/registry-recovery-controller';
import {AdapterClient} from '@/lib/tts-c/adapter-client';
import type {ActiveRegistryPaths} from '@/lib/tts-c/registry-activation';
import {recordJobComputeUsage, snapshotComputeStart} from '@/lib/usage/compute';
import {recoverStaleAssetGenerationJobs} from '@/lib/assets/generation-jobs';
import {releaseExpiredLeases} from '@/lib/resources/leases';
import {createResourceLeaseHeartbeat, type ResourceLeaseHeartbeatHandle} from '@/lib/resources/lease-heartbeat';
import {
  COMPOSITION_ID,
  COMPOSITION_ID_NO_SUBTITLES,
  TEMPLATE_VERSION,
  zhiyingFullCutPropsSchema,
  type ZhiyingFullCutProps,
} from '@/lib/scene-schema';
import {
  createParallelLoop,
  executeClaimedJob,
  type JobRunnerContext,
  type ParallelLoop,
} from './job-runner';
import {RuntimeAudioError, stageRuntimeNarrationAudio} from './runtime-audio';
import {RuntimeAssetError, stageRuntimeAssets} from './runtime-assets';
import {bundleCacheKey} from './bundle-key';
import {
  persistRenderArtifact,
  sha256File,
  sha256Text,
  validateRenderOutput,
} from '@/lib/render/artifact';
import {measureLoudness, runTwoPassLoudnorm, LOUDNESS_TARGET} from '@/lib/render/loudness';
import {auditFinalVisuals, validateFinalVisualProps} from '@/lib/render/visual-gate';
import {RUNTIME_NARRATION_PATTERN} from '@/lib/final-render/schema';

/**
 * Final Render 性能配置（M5-PERF）：见 src/lib/render/render-config.ts。
 * REMOTION_CONCURRENCY 显式并发（缺失/非法 → Remotion 默认）；
 * REMOTION_GPU_ENABLED=true → ANGLE/EGL 硬件 GL（software path 可一键回退）。
 */
const PERF_CONFIG = loadRenderPerfConfig();

/**
 * 知影渲染 Worker（CONTRACT §4，M2-C 扩展双队列，M7 资源感知并行化）
 * - 单调度器：claimNextAnyJob 对 render/llm/tts/dispatch 全局 FIFO；
 *   M7 起主循环为资源感知并行（src/worker/job-runner.ts）——
 *   资源兼容的任务并发执行（如 TTS 跑 GPU 时 LLM API 任务不被堵死），
 *   GPU 互斥组（tts/render/local_image）同时只跑一个
 * - bundle 缓存：data/bundle-cache/{templateVersion}-{rendererSourceHash}/（M6.3.11
 *   起键含源码内容 hash，renderer 变化必触发重建，杜绝陈旧 bundle 复用）；
 *   M2-C 起改为 lazy ensureBundle——只有真正 claim 到 render job 才打包，
 *   LLM job 不依赖 Remotion bundle / Chrome / public 运行素材
 * - 渲染：selectComposition + renderMedia（h264；REMOTION_NVENC=true 且探测
 *   通过时 h264_nvenc + videoBitrate，否则 libx264 / crf 18，见 M6.3.10）
 * - M6.3.10：render/tts job 的 CPU（cgroup delta）/GPU（NVENC attempt wall 秒）
 *   写入 project_usage_events；wall time 由 summary 侧 jobs 表幂等回填
 * - onProgress 节流（≥2s）写 heartbeat + progress，并检查 isCancelRequested
 * - SIGTERM/SIGINT 优雅退出：abort 全部 running 任务并等 settle，任务回 queued
 * - WORKER_ROLE 预留（M1 只实现 'all'）
 */

const POLL_INTERVAL_MS = 2000;
/** 有任务在跑时的 tick 间隔（reap/补位更及时；空闲仍按 POLL_INTERVAL_MS 轮询）。 */
const ACTIVE_TICK_MS = 250;
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
/** 并行调度循环句柄（main 内创建；信号处理器经它 abort 全部 running 任务）。 */
let activeLoop: ParallelLoop | null = null;
let activeRecoveryController: MaterializationRecoveryController | null = null;
let activeRegistryRecoveryController: RegistryRecoveryController | null = null;

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [${WORKER_ID}]`, ...args);
}

function requestShutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log(`received ${signal}, shutting down gracefully…`);
  // 统一取消句柄（M2-C Hardening §一 → M7 并行）：abort 全部 running 任务的
  // 独立 AbortController——renderMedia 立即中止；LLM/TTS 请求经 signal 得到
  // CANCELLED，各 executor 检测 shuttingDown 后 requeue（不回 queued 失败、
  // 不标 cancelled、不产生 project_version）。
  activeLoop?.abortAll();
}

/**
 * 确保 Remotion bundle 存在。
 * 缓存目录：data/bundle-cache/{bundleCacheKey}/，键 = TEMPLATE_VERSION + renderer
 * 源码内容 hash（M6.3.11 P0：旧键仅 TEMPLATE_VERSION，源码演进不触发重建，
 * M1 陈旧 bundle 被复用导致 Final Render 产出旧 Demo 视觉）；
 * 以 index.html 作为完整标记，缺失/不完整时清空后用 @remotion/bundler 重新打包
 * （打包结果自带 public/ 静态资源拷贝）。
 */
async function ensureBundle(): Promise<string> {
  const cacheKey = bundleCacheKey(TEMPLATE_VERSION, process.cwd());
  const cacheDir = path.join(getDataDir(), 'bundle-cache', cacheKey);
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
  renderLease?: {lost: () => boolean},
): Promise<void> {
  // 每个 job 独立随机端口：失败后 retry / 下一个 job 不复用旧端口（见上文说明）
  const renderPort = randomRenderPort();
  // M7.3A.3.1：lease 生命周期由 runRenderJob 统一管理（claim 后、bundle 前启动，
  // 覆盖 bundle + render 全程）；本函数只消费 lost 信号（fail-closed）。
  // M6.3.10：compute usage 采集（cgroup cpu delta 归属本 attempt；
  // 仅渲染主路径记录——payload/staging 等前置失败的 CPU 可忽略，不记）。
  const computeSnapshot = snapshotComputeStart();
  let encoder: 'h264_nvenc' | 'libx264' = 'libx264';
  let encoderFallbackReason: string | null = null;
  const recordCompute = (status: 'succeeded' | 'failed' | 'cancelled'): void => {
    try {
      recordJobComputeUsage({
        kind: 'render',
        jobId: job.id,
        projectId: job.project_id,
        attempt: job.attempt,
        snapshot: computeSnapshot,
        status,
        gpuAccelerated: encoder === 'h264_nvenc',
        metadata: {
          renderJobKind: job.kind,
          encoder,
          ...(encoderFallbackReason ? {fallbackReason: encoderFallbackReason} : {}),
        },
      });
    } catch (err) {
      log(`job ${job.id} compute usage 记录失败（不影响渲染结果）: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
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
    // M6.3.11 P0 绊线：workflow 渲染不得携带 M1 demo 残留标记。
    // zhiyingFullCutDefaultProps 内置 showPilotIntro=true + 静态 demo 场景；
    // 若该标记出现在 payload 中，说明 props 链路串入 demo defaultProps，
    // fail-closed 拒绝渲染，绝不产出旧 Demo 视觉。
    if (parsed.data.data.project.showPilotIntro === true) {
      failJob(
        job.id,
        'PAYLOAD_DEMO_PROPS',
        'payload 携带 showPilotIntro=true（M1 demo defaultProps 标记），拒绝渲染',
      );
      return;
    }
    const isFinalRender =
      typeof parsed.data.audio.narration === 'string' &&
      RUNTIME_NARRATION_PATTERN.test(parsed.data.audio.narration);
    const inputProps: ZhiyingFullCutProps = {
      ...parsed.data,
      // kind 决定字幕开关与 composition，强制对齐，不信任 payload 里的 showSubtitles
      showSubtitles: job.kind !== 'no-subtitles',
      // M6.3.12：Final Render 显式 final 模式——ProductionPlaceholder 直接 throw，
      // 占位画面绝不进入最终视频；preview/no-subtitles 链路保持 preview 行为。
      renderMode: isFinalRender ? 'final' : 'preview',
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

    // M6.3.12：Final Render 双保险（与 bridge enqueue 同口径）——
    // render-input gate 以最终 props 为准；素材 staging 把 assetMap 文件复制进
    // bundle public（bundle 打包后新增素材不在缓存里，缺失即 fail-closed）。
    let visualAuditJson: string | null = null;
    if (isFinalRender) {
      const gate = validateFinalVisualProps(parsed.data, {
        assetFileExists: (publicPath) => {
          try {
            const abs = path.join(process.cwd(), 'public', publicPath);
            return fs.statSync(abs).isFile() && fs.statSync(abs).size > 0;
          } catch {
            return false;
          }
        },
      });
      if (!gate.ok) {
        const first = gate.issues[0]!;
        failJob(
          job.id,
          'FINAL_VISUAL_INCOMPLETE',
          `Final renderer 视觉输入未解析（${gate.issues.length} 处）：${first.sceneId} ${first.reason}`,
        );
        log(`job ${job.id} final visual gate failed: ${JSON.stringify(gate.issues)}`);
        return;
      }
      try {
        const staged = stageRuntimeAssets(parsed.data, bundleLocation);
        if (staged.staged > 0) log(`job ${job.id} staged ${staged.staged} visual asset(s) into bundle public`);
      } catch (err) {
        if (err instanceof RuntimeAssetError) {
          failJob(job.id, err.code, err.message);
          log(`job ${job.id} runtime asset staging failed: [${err.code}] ${err.message}`);
          return;
        }
        throw err;
      }
      visualAuditJson = JSON.stringify(auditFinalVisuals(parsed.data));
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
    // M6.3.11：先渲染到 {jobId}.tmp.mp4，校验通过 + manifest 落库后原子改名
    // 正式发布路径——succeeded 状态的 output 绝不指向未验证文件。
    const outputRel = path.posix.join(
      'projects',
      job.project_id,
      'renders',
      `${job.id}.mp4`,
    );
    const outputAbs = path.join(getDataDir(), outputRel);
    const outputAbsTmp = outputAbs.replace(/\.mp4$/, '.tmp.mp4');
    fs.mkdirSync(path.dirname(outputAbs), {recursive: true});

    log(
      `job ${job.id} start: project=${job.project_id} kind=${job.kind} ` +
        `composition=${compositionId} ${composition.width}x${composition.height}@${composition.fps} ` +
        `${composition.durationInFrames}f → ${outputRel}`,
    );

    // M6.3.10：NVENC 优先（REMOTION_NVENC=true 且真实编码探测通过）；
    // 探测失败 → libx264 crf 18 回退，fallbackReason 落 usage metadata + log。
    if (PERF_CONFIG.nvencEnabled) {
      const probe = await probeNvencSupport();
      if (probe.ok) {
        encoder = 'h264_nvenc';
      } else {
        encoderFallbackReason = probe.reason ?? 'nvenc_probe_failed';
        log(`job ${job.id} NVENC 不可用，回退 libx264：${encoderFallbackReason}`);
      }
    }
    log(
      `job ${job.id} encoder: ${encoder}` +
        (encoder === 'h264_nvenc' ? ` bitrate=${PERF_CONFIG.nvencBitrate}` : ' crf=18'),
    );

    let lastBeat = 0;
    let lastBeatFrames = 0;
    let lastStitchStage: string | null = null;
    let phaseStartedAt: string | null = null;
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      // NVENC 与 crf 互斥（hw 路径以 bitrate 控质量）；输出分辨率/帧率/封装不变
      ...(encoder === 'h264_nvenc'
        ? {hardwareAcceleration: 'required' as const, videoBitrate: PERF_CONFIG.nvencBitrate}
        : {crf: 18 as const}),
      outputLocation: outputAbsTmp,
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
        // M6.3.13：fps = 相邻两次心跳 renderedFrames 增量 ÷ 实际间隔秒；
        // 首次心跳（lastBeat=0）fps=null。stitchStage 切换时记录一次 phaseStartedAt。
        const fps =
          lastBeat > 0
            ? round1((mediaProgress.renderedFrames - lastBeatFrames) / ((nowMs - lastBeat) / 1000))
            : null;
        lastBeat = nowMs;
        lastBeatFrames = mediaProgress.renderedFrames;
        if (mediaProgress.stitchStage !== lastStitchStage) {
          lastStitchStage = mediaProgress.stitchStage;
          phaseStartedAt = new Date().toISOString();
        }
        // M5：帧级步骤明细随心跳落库（渲染画面/编码/封装 + 预计剩余）
        const detail = detailFromRemotionProgress(mediaProgress, composition.durationInFrames);
        heartbeat(
          job.id,
          Math.round(mediaProgress.progress * 1000) / 10,
          JSON.stringify({...detail, fps, phaseStartedAt, updatedAt: new Date().toISOString()}),
        );
        // 每轮检查取消请求 → 中止 renderMedia
        if (isCancelRequested(job.id)) {
          controller.abort();
        }
      },
    });

    if (isCancelRequested(job.id)) {
      markCancelled(job.id);
      recordCompute('cancelled');
      log(`job ${job.id} cancelled at finish line`);
      return;
    }
    // M6.3.12：Final Master 响度归一化（两通 loudnorm；视频流 copy 不重编码），
    // 归一化产物才进入质量门——最终视频 integrated ≈ -16 LUFS / TP ≤ -1.5 dBTP。
    let finalTmp = outputAbsTmp;
    let loudnessJson: string | null = null;
    if (isFinalRender) {
      // M6.3.13：loudnorm 阶段无 Remotion onProgress，进入前补一次心跳——
      // UI 显示「响度归一化」而非停在 ~100% 的假完成窗口
      heartbeat(job.id, 100, JSON.stringify(buildStageDetail('finalize', {percent: 100})));
      const loudTmp = outputAbsTmp.replace(/\.tmp\.mp4$/, '.loud.tmp.mp4');
      try {
        const {measured} = await runTwoPassLoudnorm(outputAbsTmp, loudTmp);
        let post: Awaited<ReturnType<typeof measureLoudness>> | null = null;
        try {
          post = await measureLoudness(loudTmp);
        } catch (err) {
          log(`job ${job.id} 归一化后响度测量失败（不阻断，记 null）: ${err instanceof Error ? err.message : String(err)}`);
        }
        loudnessJson = JSON.stringify({target: LOUDNESS_TARGET, input: measured, output: post});
      } catch (err) {
        fs.rmSync(loudTmp, {force: true});
        failJob(job.id, 'LOUDNESS_ERROR', `响度归一化失败：${err instanceof Error ? err.message : String(err)}`);
        recordCompute('failed');
        log(`job ${job.id} loudness normalization failed`);
        return;
      }
      fs.rmSync(outputAbsTmp, {force: true});
      finalTmp = loudTmp;
    }
    // M7.3A.3：lease-lost fence —— 渲染期间 production_gpu lease 丢失
    // （onLost 已 abort controller；若 renderMedia 仍返回则拒绝提交 final success）。
    if (renderLease?.lost() ?? false) {
      failJob(job.id, 'RESOURCE_LEASE_LOST', '渲染期间 production_gpu lease 丢失，不提交 final success');
      recordCompute('failed');
      log(`job ${job.id} failed: RESOURCE_LEASE_LOST（不提交 final success）`);
      return;
    }
    // M6.3.11 succeeded gate：ffprobe 校验 + SHA256 + manifest 落库 + 原子改名，
    // 全部通过才允许 status=succeeded；任何一步失败 → failed，不展示「下载视频」。
    // M6.3.12 质量门扩展：Final 必须含音轨且时长与 composition 偏差 ≤1s。
    const validation = await validateRenderOutput(
      finalTmp,
      undefined,
      isFinalRender
        ? {requireAudio: true, expectDurationSec: composition.durationInFrames / composition.fps}
        : undefined,
    );
    if (!validation.ok) {
      failJob(job.id, 'OUTPUT_INVALID', `产物校验失败：${validation.reason}`);
      recordCompute('failed');
      if (finalTmp !== outputAbsTmp) fs.rmSync(finalTmp, {force: true});
      log(`job ${job.id} output validation failed: ${validation.reason}`);
      return;
    }
    const outputSha256 = await sha256File(finalTmp);
    const outputSize = fs.statSync(finalTmp).size;
    fs.renameSync(finalTmp, outputAbs);
    persistRenderArtifact({
      job_id: job.id,
      project_id: job.project_id,
      output_path: outputRel,
      output_sha256: outputSha256,
      output_size: outputSize,
      duration_sec: validation.info.durationSec,
      frame_count: composition.durationInFrames,
      encoder,
      payload_sha256: sha256Text(job.payload_json),
      bundle_key: path.basename(bundleLocation),
      audit_json: visualAuditJson,
      loudness_json: loudnessJson,
    });
    completeJob(job.id, outputRel);
    recordCompute('succeeded');
    log(`job ${job.id} succeeded → ${outputRel} (sha256 ${outputSha256.slice(0, 12)}…)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shuttingDown) {
      // 优雅退出：当前任务回 queued，交给下一个 worker / 下次启动
      // （不记 compute usage：attempt 保留，最终执行会完整记录）
      requeueJob(job.id);
      log(`job ${job.id} requeued due to shutdown`);
      return;
    }
    if (renderLease?.lost() ?? false) {
      // M7.3A.3：lease 丢失（onLost 已 abort controller）→ fail-closed，
      // 不提交 final success，不标记 cancelled（不是用户取消）。
      failJob(job.id, 'RESOURCE_LEASE_LOST', message || '渲染期间 production_gpu lease 丢失');
      recordCompute('failed');
      log(`job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): RESOURCE_LEASE_LOST`);
      return;
    }
    if (isCancelRequested(job.id)) {
      markCancelled(job.id);
      recordCompute('cancelled');
      log(`job ${job.id} cancelled (render aborted)`);
      return;
    }
    failJob(job.id, 'RENDER_ERROR', message);
    recordCompute('failed');
    log(`job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): ${message}`);
  } finally {
    // lease heartbeat 由 runRenderJob 统一管理（dispose 在其 finally）
  }
}

/**
 * render 分支（M7 抽到 job-runner 调用的 hook，语义与原主循环内联一致）：
 * bundle 阶段心跳 → lazy ensureBundle（失败 → BUNDLE_ERROR 终态）→ runJob。
 * controller 为调度循环为本任务创建的独立 AbortController。
 */
async function runRenderJob(
  job: RenderJobRow,
  controller: AbortController,
  leaseMeta?: {group: 'production_gpu'; ownerToken: string},
): Promise<void> {
  // M7.3A.3.1：lease heartbeat 从 claim 后、bundle 开始前启动，覆盖 bundle + render
  // 全程（bundle 超过 lease TTL 不得丢失 lease）；lost → abort + 停止后续 render。
  // M7.3A.3.2：heartbeat 统一在 finally dispose——bundle success/failure/lost、
  // render success/failure/cancel/shutdown 全部路径都必须清理 timer。
  let renderLeaseLost = false;
  let renderLeaseHeartbeat: ResourceLeaseHeartbeatHandle | null = null;
  if (leaseMeta?.group === 'production_gpu') {
    renderLeaseHeartbeat = createResourceLeaseHeartbeat({
      group: 'production_gpu',
      ownerToken: leaseMeta.ownerToken,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      onLost: () => {
        renderLeaseLost = true;
        controller.abort();
      },
    });
  }
  // M7.3A.3.3R2：live state reader（实时 closure）——bundle 执行期间发生的
  // lease lost / shutdown / cancel 必须被 catch 与 post-bundle fence 看到。
  const liveState = (): {leaseLost: boolean; shuttingDown: boolean; cancelRequested: boolean} => ({
    leaseLost: renderLeaseLost,
    shuttingDown,
    cancelRequested: isCancelRequested(job.id),
  });

  // M7.3A.3.3R2：cleanup（heartbeat dispose）位于 runWithCleanup 的真正 finally——
  // 单一 owner，reject/resolve/异常路径均恰好一次，无双重 dispose。
  await runWithCleanup(async () => {
    let bundleLocation: string;
    const proceed = await runBundlePhase({
      bundle: async () => {
        // M5：bundle 阶段写入步骤明细（首次打包可能数分钟，用户可见而非黑窗）
        heartbeat(job.id, 0, JSON.stringify(buildStageDetail('bundle')));
        bundleLocation = await ensureBundleLazy();
      },
      getState: liveState,
      callbacks: {
        onLeaseLost: () => {
          failJob(job.id, 'RESOURCE_LEASE_LOST', 'bundle 期间 production_gpu lease 丢失，不进入 renderMedia');
          log(`render job ${job.id} failed: RESOURCE_LEASE_LOST（bundle 阶段）`);
        },
        onShutdown: () => {
          requeueJob(job.id);
          log(`render job ${job.id} requeued due to shutdown（bundle 阶段）`);
        },
        onCancelled: () => {
          markCancelled(job.id);
          log(`render job ${job.id} cancelled（bundle 阶段）`);
        },
        onBundleError: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          failJob(job.id, 'BUNDLE_ERROR', message);
        },
      },
    });
    if (!proceed) {
      return;
    }
    await runJob(job, bundleLocation!, controller, {lost: () => renderLeaseLost});
  }, () => {
    renderLeaseHeartbeat?.dispose();
  });
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
  // generation dispatch 信封：run 仍 running（租约有效）→ requeue 等待；
  // 无有效 running run → failed(WORKER_CRASH)，不自动重试可能已计费的请求。
  const recoveredDispatch = recoverStaleDispatchJobs(getDb());
  if (recoveredDispatch.requeued > 0) {
    log(`recovered ${recoveredDispatch.requeued} stale dispatch job(s) → queued`);
  }
  if (recoveredDispatch.failed > 0) {
    log(`finalized ${recoveredDispatch.failed} stale dispatch job(s) → failed(WORKER_CRASH)`);
  }
  // M7.3A.2：回收 stale asset generation jobs 与过期 resource leases
  const recoveredAssetGen = recoverStaleAssetGenerationJobs(STALE_TIMEOUT_MS);
  if (recoveredAssetGen.indeterminate > 0) {
    log(`finalized ${recoveredAssetGen.indeterminate} stale asset generation job(s) → indeterminate`);
  }
  // TTS-C.1A.R2：周期 recovery controller（启动即 sweep + 固定 cadence 持续 sweep；
  // inFlight 不重入；单 job 异常隔离；shutdown 停 timer 并等待 settle）
  const recoveryController = new MaterializationRecoveryController({
    intervalMs: Number(process.env.ZHIYING_MATERIALIZATION_RECOVERY_INTERVAL_MS ?? 10000),
    limit: Number(process.env.ZHIYING_MATERIALIZATION_RECOVERY_LIMIT ?? 10),
    log,
  });
  recoveryController.start();
  activeRecoveryController = recoveryController;

  // TTS-C.1B.3：registry publication recovery controller（配置 contract——本轮不修改
  // production compose/env；未配置时 disabled 零副作用）：
  //   ZHIYING_ACTIVE_REGISTRY_PATH / ZHIYING_ACTIVE_REGISTRY_ROOT（active registry 文件与目录）
  //   ZHIYING_LEGACY_VOICE_ROOT_DIR（legacy reference 本机 root）
  //   ZHIYING_EMIT_VOICE_ROOT_PATH（registry 文档 referenceAssetPath 前缀，默认 /voices）
  //   ADAPTER_BASE_URL（默认复用 INDEXTTS2_BASE_URL）
  const activeRegistryPath = process.env.ZHIYING_ACTIVE_REGISTRY_PATH;
  const activeRegistryRoot = process.env.ZHIYING_ACTIVE_REGISTRY_ROOT;
  const legacyVoiceRootDir = process.env.ZHIYING_LEGACY_VOICE_ROOT_DIR;
  const adapterBaseUrl = process.env.ADAPTER_BASE_URL ?? process.env.INDEXTTS2_BASE_URL;
  if (activeRegistryPath && activeRegistryRoot && legacyVoiceRootDir && adapterBaseUrl) {
    const registryPaths: ActiveRegistryPaths = {activeRegistryPath, activeRegistryRoot};
    const adapter = new AdapterClient({baseUrl: adapterBaseUrl});
    const registryRecoveryController = new RegistryRecoveryController(
      {
        db: getDb(),
        paths: registryPaths,
        adapter,
        build: {
          legacyVoiceRootDir,
          materializationRootDir: path.join(getDataDir(), 'voice-materializations'),
          emitVoiceRootPath: process.env.ZHIYING_EMIT_VOICE_ROOT_PATH ?? '/voices',
        },
      },
      {
        intervalMs: Number(process.env.ZHIYING_REGISTRY_RECOVERY_INTERVAL_MS ?? 10000),
        limit: Number(process.env.ZHIYING_REGISTRY_RECOVERY_LIMIT ?? 10),
        log,
      },
    );
    registryRecoveryController.start();
    activeRegistryRecoveryController = registryRecoveryController;
    log('tts-c1b3 registry recovery controller started');
  } else {
    log('tts-c1b3 registry recovery controller disabled（缺少 ZHIYING_ACTIVE_REGISTRY_PATH / ROOT / LEGACY_VOICE_ROOT_DIR / ADAPTER_BASE_URL 配置）');
  }
  const expiredLeases = releaseExpiredLeases(STALE_TIMEOUT_MS);
  if (expiredLeases > 0) {
    log(`released ${expiredLeases} expired resource lease(s)`);
  }

  // 2. 并行调度循环（M7.3A.2）：render + llm + tts + dispatch + asset_generation 全局 FIFO claim，
  //    资源兼容的任务并发执行（GPU 互斥组同时只跑一个）；
  //    Remotion bundle 延后到首个 render job 才初始化（LLM/TTS/dispatch 零依赖）。
  //    每个被 claim 的任务获得独立 AbortController，SIGTERM/SIGINT 经
  //    requestShutdown → abortAll 覆盖全部 running 任务。
  const loop = createParallelLoop({
    workerId: WORKER_ID,
    log,
    isShuttingDown: () => shuttingDown,
    execute: (claimed, controller) => {
      const ctx: JobRunnerContext = {
        isShuttingDown: () => shuttingDown,
        log,
        shutdownSignal: controller.signal,
      };
      return executeClaimedJob(claimed, ctx, {
        runRenderJob: (job, leaseMeta) => runRenderJob(job, controller, leaseMeta),
      });
    },
  });
  activeLoop = loop;
  while (!shuttingDown) {
    loop.tick();
    await sleep(loop.size() > 0 ? ACTIVE_TICK_MS : POLL_INTERVAL_MS);
  }
  activeLoop = null;
  // TTS-C.1A.R2：停止 recovery timer 并等待 in-flight sweep settle
  if (activeRecoveryController) {
    await activeRecoveryController.stop();
    activeRecoveryController = null;
  }
  // TTS-C.1B.3：停止 registry recovery timer 并等待 in-flight sweep settle
  if (activeRegistryRecoveryController) {
    await activeRegistryRecoveryController.stop();
    activeRegistryRecoveryController = null;
  }
  // 优雅退出：abort 已在 requestShutdown 发出，等全部 running 任务 settle
  await loop.settle();

  log('bye.');
}

main().catch((err: unknown) => {
  console.error(
    `[${new Date().toISOString()}] [${WORKER_ID}] fatal:`,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});

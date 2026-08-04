import type {RenderJobRow} from '@/lib/jobs';
import {claimNextAnyJob, type ClaimedJob, type ClaimOptions} from '@/lib/scheduler';
import {getTtsJob} from '@/lib/tts-jobs';
import {recordJobComputeUsage, snapshotComputeStart} from '@/lib/usage/compute';
import {
  getResourceLimits,
  GPU_EXCLUSIVE_GROUP,
  isGpuExclusive,
  type ResourceClass,
} from '@/lib/workflow/resource-classes';
import {releaseResourceLease} from '@/lib/resources/leases';
import {runDispatchJob} from './dispatch-executor';
import {runLlmJob} from './llm-executor';
import {runTtsJob} from './tts-executor';
import {runAssetGenerationJob} from './asset-generation-executor';
import {runMaterializationJob} from './materialization-executor';

/**
 * 并行 Worker 的 per-job 运行器 + 调度循环（M7 依赖/资源感知并行化）。
 *
 * 从原 executeLoop 抽出的两部分：
 * - executeClaimedJob：单个已 claim 任务的完整执行语义（dispatch/llm/tts/render
 *   分支、TTS compute usage 记账、shutdown/cancel/requeue 语义全部保留——
 *   这些语义本就在各 executor 内部，本模块只做分支与记账）；
 * - createParallelLoop：主循环调度核心。维护 running map
 *   （jobKey → {controller, resourceClass, promise}），每 tick 先按忙碌
 *   资源类别计算排除集（GPU 互斥组见 resource-classes.ts），再在容量内
 *   循环 claim 新任务启动；每个任务独立的 AbortController，SIGTERM/SIGINT
 *   经 abortAll 覆盖全部 running 任务（保留原优雅退出语义：各 executor
 *   检测 shutdown 后 requeue）。
 */

export interface JobRunnerContext {
  isShuttingDown: () => boolean;
  log: (...args: unknown[]) => void;
  /** 本任务独立的 shutdown/cancel 句柄（主循环为每个任务创建一个 AbortController）。 */
  shutdownSignal: AbortSignal;
}

export interface JobRunnerHooks {
  /**
   * render 任务执行（index.ts 注入：bundle 心跳 + ensureBundleLazy + runJob）。
   * AbortController 由注入方闭包捕获（调度循环为任务创建），保持 render 的
   * cancel/shutdown 语义。leaseMeta：scheduler claim 时取得的 production_gpu
   * lease（render 期间心跳续约，lease 丢失 → abort + 不提交 final success）。
   */
  runRenderJob: (
    job: RenderJobRow,
    leaseMeta?: {group: 'production_gpu'; ownerToken: string},
  ) => Promise<void>;
}

/** 执行单个已 claim 任务（status=running；controller 由调度循环统一创建）。 */
export async function executeClaimedJob(
  claimed: ClaimedJob,
  ctx: JobRunnerContext,
  hooks: JobRunnerHooks,
): Promise<void> {
  const {log} = ctx;
  if (claimed.type === 'dispatch') {
    // generation dispatch 信封：Worker 持有 LLM 凭据执行 build
    // （durable single-flight 由 generation_runs 兜底，重复执行零重复计费）
    await runDispatchJob(claimed.job, ctx);
    return;
  }
  if (claimed.type === 'llm') {
    await runLlmJob(claimed.job, ctx);
    return;
  }
  if (claimed.type === 'tts') {
    // M6.3.10：TTS compute usage（cpu only；IndexTTS2 是外部服务，
    // 其 GPU 消耗不计入本地 GPU 口径）。终态从 DB 读回。
    const ttsSnapshot = snapshotComputeStart();
    const leaseMeta = (claimed as unknown as {resourceLease?: {group: 'production_gpu'; ownerToken: string}}).resourceLease;
    await runTtsJob(
      claimed.job,
      leaseMeta ? {...ctx, resourceLease: {group: leaseMeta.group, ownerToken: leaseMeta.ownerToken}} : ctx,
    );
    try {
      const final = getTtsJob(claimed.job.id);
      const status = final?.status === 'succeeded'
        ? 'succeeded'
        : final?.status === 'cancelled'
          ? 'cancelled'
          : final?.status === 'failed'
            ? 'failed'
            : null;
      // queued（retry/shutdown requeue）→ 本 attempt 未定稿，不记
      if (status) {
        recordJobComputeUsage({
          kind: 'tts',
          jobId: claimed.job.id,
          projectId: claimed.job.project_id,
          attempt: claimed.job.attempt,
          snapshot: ttsSnapshot,
          status,
          metadata: {provider: claimed.job.provider, unitId: claimed.job.unit_id},
        });
      }
    } catch (err) {
      log(`tts job ${claimed.job.id} compute usage 记录失败（不影响任务结果）: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  if (claimed.type === 'asset_generation') {
    const leaseMeta = (claimed as unknown as {resourceLease?: {group: 'production_gpu'; ownerToken: string}}).resourceLease;
    await runAssetGenerationJob(
      claimed.job,
      ctx,
      leaseMeta ? {group: leaseMeta.group, ownerToken: leaseMeta.ownerToken} : undefined,
    );
    return;
  }
  if (claimed.type === 'voice_materialization') {
    // TTS-C.1A：durable materialization（非 GPU/LLM；不占用任何资源 lease；
    // 不调用 IndexTTS2；不创建 TTS job）。P0-2：使用 claim 返回的 exact execution handle。
    const handle = claimed.handle;
    await runMaterializationJob(handle, ctx);
    return;
  }
  // render（默认分支）：M7.3A.3 透传 scheduler claim 的 production_gpu lease，
  // 渲染期间心跳续约；lease 丢失 → abort + 不提交 final success。
  const renderLeaseMeta = (claimed as unknown as {resourceLease?: {group: 'production_gpu'; ownerToken: string}}).resourceLease;
  await hooks.runRenderJob(claimed.job, renderLeaseMeta);
}

// ---------- 并行调度循环 ----------

interface RunningEntry {
  key: string;
  resourceClass: ResourceClass;
  controller: AbortController;
  promise: Promise<void>;
  startedAt: string;
}

export interface ParallelLoopDeps {
  workerId: string;
  log: (...args: unknown[]) => void;
  isShuttingDown: () => boolean;
  /** 单任务执行入口（生产 = executeClaimedJob 封装；测试可注入慢任务）。 */
  execute: (claimed: ClaimedJob, controller: AbortController) => Promise<void>;
  /** claim 注入点（生产 = claimNextAnyJob）。 */
  claim?: (workerId: string, opts?: ClaimOptions) => ClaimedJob | null;
}

export interface ParallelLoop {
  /** reap 已完成任务 + 在资源容量内 claim 启动新任务；返回当前 running 数。 */
  tick: () => number;
  /** 等待全部 running 任务 settle（graceful shutdown 用）。 */
  settle: () => Promise<void>;
  /** abort 全部 running 任务的 controller（SIGTERM/SIGINT）。 */
  abortAll: () => void;
  /** 当前 running 任务数。 */
  size: () => number;
  /** 当前 running 任务快照（activity/调试用）。 */
  runningJobs: () => Array<{key: string; resourceClass: ResourceClass; startedAt: string}>;
}

export function createParallelLoop(deps: ParallelLoopDeps): ParallelLoop {
  const claimFn = deps.claim ?? claimNextAnyJob;
  const running = new Map<string, RunningEntry>();

  const tick = (): number => {
    // 完成的任务经 promise.finally 自行移出 running map（reap），无需轮询。
    if (deps.isShuttingDown()) {
      return running.size;
    }
    for (;;) {
      // 忙碌资源类别与计数（含本 tick 内刚 claim 的）
      const runningCounts: Partial<Record<ResourceClass, number>> = {};
      let gpuBusy = false;
      for (const entry of running.values()) {
        runningCounts[entry.resourceClass] = (runningCounts[entry.resourceClass] ?? 0) + 1;
        if (isGpuExclusive(entry.resourceClass)) {
          gpuBusy = true;
        }
      }
      // GPU 互斥组：组内已有任务 → 整组不再 claim（tts/render/local_image 互斥）
      const excludeResourceClasses = gpuBusy ? [...GPU_EXCLUSIVE_GROUP] : undefined;
      const claimed = claimFn(deps.workerId, {excludeResourceClasses, runningCounts});
      if (!claimed) {
        break;
      }
      const limits = getResourceLimits();
      if ((runningCounts[claimed.resourceClass] ?? 0) >= limits[claimed.resourceClass]) {
        // 防御：claim 已按上限过滤，理论不可达；若发生说明配置漂移，停止本 tick
        deps.log(`WARN: claim 超出资源上限（${claimed.resourceClass}），停止本 tick`);
        break;
      }
      const controller = new AbortController();
      const key = `${claimed.type}:${claimed.job.id}`;
      const entry: RunningEntry = {
        key,
        resourceClass: claimed.resourceClass,
        controller,
        startedAt: new Date().toISOString(),
        promise: Promise.resolve()
          .then(() => deps.execute(claimed, controller))
          .catch((err: unknown) => {
            // executor 内部已兜底终态；此处只防未预期异常拖垮主循环
            deps.log(
              `job ${key} 未预期异常（任务终态以 DB 为准）: ` +
                `${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
            );
          })
          .finally(() => {
            running.delete(key);
            // M7.3A.2：按 exact ownerToken 释放 production_gpu lease
            const leaseMeta = (claimed as {resourceLease?: {group: 'production_gpu'; ownerToken: string}}).resourceLease;
            if (leaseMeta?.group === 'production_gpu') {
              try {
                releaseResourceLease('production_gpu', leaseMeta.ownerToken);
              } catch {
                // ignore
              }
            }
          }),
      };
      running.set(key, entry);
      deps.log(`claimed ${key}（resourceClass=${claimed.resourceClass}，并发 running=${running.size}）`);
    }
    return running.size;
  };

  const settle = async (): Promise<void> => {
    await Promise.allSettled([...running.values()].map((e) => e.promise));
  };

  const abortAll = (): void => {
    for (const entry of running.values()) {
      entry.controller.abort();
    }
  };

  return {
    tick,
    settle,
    abortAll,
    size: () => running.size,
    runningJobs: () =>
      [...running.values()].map((e) => ({
        key: e.key,
        resourceClass: e.resourceClass,
        startedAt: e.startedAt,
      })),
  };
}

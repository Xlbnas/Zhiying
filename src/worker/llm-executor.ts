import {getDb} from '@/lib/db';
import {executeStageGeneration} from '@/lib/llm/executor';
import {getProvider} from '@/lib/llm';
import {clipText, LLMError, type LLMProvider} from '@/lib/llm/types';
import {
  commitLlmJobResult,
  completeLlmJob,
  failLlmJob,
  getVersionByJobId,
  heartbeatLlmJob,
  isLlmCancelRequested,
  llmJobPayloadSchema,
  markLlmCancelled,
  requeueLlmJob,
  type LlmJobRow,
} from '@/lib/llm-jobs';
import {toStagePromptInput} from '@/lib/project-inputs';

/**
 * LLM 任务执行器（M2-C §十一/十二/十三/十四/十五）。
 *
 * 流程：payload 校验 → crash idempotency → cancel 检查 → AbortController +
 * heartbeat timer → executeStageGeneration（M2-B）→ generateVersion（M2-A）
 * → completeLlmJob。
 *
 * 边界：
 * - 业务结果只经 M2-A operations.generateVersion 落库，禁止手写
 *   INSERT project_versions / UPDATE project_stages。
 * - 取消不 fail、不 retry、不产生 project_version；已产生的 usage 保留。
 * - VALIDATION_FAILED / CONFIG_ERROR / OUTPUT_TRUNCATED non-retryable；
 *   网络/timeout 等 retryable 但受 max_attempts 上限约束。
 */

const HEARTBEAT_INTERVAL_MS = 5000;
const NON_RETRYABLE_CODES = new Set(['VALIDATION_FAILED', 'CONFIG_ERROR', 'OUTPUT_TRUNCATED']);

export interface LlmExecutorContext {
  isShuttingDown: () => boolean;
  log: (...args: unknown[]) => void;
  /**
   * Worker 统一的当前任务取消句柄（Hardening §一）：SIGTERM/SIGINT 触发。
   * 与 cancel 轮询共用内部 controller——shutdown 与 cancel 都能真正中止
   * 进行中的 Provider 请求，但语义不同（shutdown→requeue / cancel→cancelled）。
   */
  shutdownSignal?: AbortSignal;
}

/** 测试注入点（生产全部走默认值）。 */
export interface LlmExecutorDeps {
  provider?: LLMProvider;
  heartbeatMs?: number;
}

export async function runLlmJob(
  job: LlmJobRow,
  ctx: LlmExecutorContext,
  deps: LlmExecutorDeps = {},
): Promise<void> {
  const {log} = ctx;

  // 排队期间被请求取消：直接 cancelled，不进入执行
  if (isLlmCancelRequested(job.id)) {
    markLlmCancelled(job.id);
    log(`llm job ${job.id} cancelled before start`);
    return;
  }

  // payload 快照解析 + zod 校验（Worker 不重读 UI state）
  let payload: ReturnType<typeof llmJobPayloadSchema.parse>;
  try {
    payload = llmJobPayloadSchema.parse(JSON.parse(job.payload_json));
  } catch (err) {
    failLlmJob(
      job.id,
      'PAYLOAD_INVALID',
      `payload_json 校验失败：${err instanceof Error ? clipText(err.message, 300) : String(err)}`,
      {retryable: false},
    );
    return;
  }

  // Crash idempotency（§十二）：版本已落库但 job 未 complete → 不得重新调用 LLM
  const existing = getVersionByJobId(job.id);
  if (existing) {
    completeLlmJob(job.id);
    log(
      `llm job ${job.id} recovered completed result by job_id ` +
        `(version v${existing.version} 已存在，跳过 Provider 调用)`,
    );
    return;
  }

  // Provider（CONFIG_ERROR：如 production 缺 Key——non-retryable）
  let provider: LLMProvider;
  try {
    provider = deps.provider ?? getProvider();
  } catch (err) {
    if (err instanceof LLMError) {
      failLlmJob(job.id, err.code, clipText(err.message, 500), {retryable: false});
      return;
    }
    throw err;
  }

  const controller = new AbortController();
  // 统一 shutdown 通道：Worker 收到 SIGTERM/SIGINT 时同样中止 Provider 请求
  const onShutdownAbort = (): void => controller.abort();
  ctx.shutdownSignal?.addEventListener('abort', onShutdownAbort, {once: true});
  // 心跳 + 取消轮询 timer（§十三/十四）：LLM 请求可能持续几十秒，
  // 不等 Provider 返回才 heartbeat；取消请求经 AbortSignal 中断 fetch。
  const timer = setInterval(() => {
    heartbeatLlmJob(job.id);
    if (isLlmCancelRequested(job.id)) {
      controller.abort();
    }
  }, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);

  try {
    log(`llm job ${job.id} start: project=${job.project_id} stage=${payload.stage} provider=${provider.name}`);
    const result = await executeStageGeneration({
      db: getDb(),
      provider,
      stage: payload.stage,
      input: toStagePromptInput(payload.promptInput),
      projectId: job.project_id,
      jobId: job.id,
      signal: controller.signal,
    });

    // Commit Fence（Hardening §二）：executeStageGeneration 成功返回后、
    // generateVersion 提交前，必须做最终 shutdown/cancel 检查——
    // 通过 fence 才允许写业务结果，保证 cancel_requested=true 时不进入 generateVersion。
    if (ctx.isShuttingDown()) {
      requeueLlmJob(job.id);
      log(`llm job ${job.id} requeued due to shutdown（fence，未提交版本）`);
      return;
    }
    if (isLlmCancelRequested(job.id)) {
      markLlmCancelled(job.id);
      log(`llm job ${job.id} cancelled（fence，未提交版本）`);
      return;
    }

    // 业务结果 + job 终态：单个 BEGIN IMMEDIATE 原子提交（Hardening §二/九），
    // 正常路径不再「先 generateVersion 再 completeLlmJob」。
    const committed = commitLlmJobResult({
      jobId: job.id,
      projectId: job.project_id,
      stage: payload.stage,
      content: result.content,
      contentType: result.contentType,
      source: result.versionSource,
      promptVersion: result.promptVersion,
      model: result.model,
    });
    switch (committed.code) {
      case 'COMMITTED':
        log(
          `llm job ${job.id} succeeded: ${payload.stage} v${committed.version.version} ` +
            `(${result.contentType}, repair=${result.repairCount}, requests=${result.requestIds.length})`,
        );
        return;
      case 'CANCELLED':
        // 取消意图已在同一事务内原子终结为 cancelled，无需再 markLlmCancelled
        log(`llm job ${job.id} cancelled（commit 事务内原子终结）`);
        return;
      case 'JOB_NOT_RUNNING':
        log(`llm job ${job.id} commit 跳过：任务已不在 running（可能已被并发终结）`);
        return;
      case 'JOB_NOT_FOUND':
        log(`llm job ${job.id} commit 跳过：任务行不存在`);
        return;
      case 'JOB_MISMATCH':
        // payload 与 job 行不一致（数据 bug）：显式失败，不反复重试
        failLlmJob(job.id, 'JOB_MISMATCH', 'commit 时 job 的 project/stage 与执行上下文不一致', {
          retryable: false,
        });
        return;
    }
  } catch (err) {
    if (ctx.isShuttingDown()) {
      // 优雅退出：回 queued 交给下次启动（crash idempotency 防重复生成）
      requeueLlmJob(job.id);
      log(`llm job ${job.id} requeued due to shutdown`);
      return;
    }
    if ((err instanceof LLMError && err.code === 'CANCELLED') || isLlmCancelRequested(job.id)) {
      markLlmCancelled(job.id);
      log(`llm job ${job.id} cancelled`);
      return;
    }
    if (err instanceof LLMError) {
      const retryable = !NON_RETRYABLE_CODES.has(err.code);
      const finalized = failLlmJob(job.id, err.code, clipText(err.message, 500), {retryable});
      log(
        `llm job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}, ` +
          `${retryable ? 'retryable' : 'non-retryable'}): ${err.code} → ${finalized}`,
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const finalized = failLlmJob(job.id, 'LLM_ERROR', clipText(message, 500), {retryable: true});
    log(
      `llm job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): ${message} → ${finalized}`,
    );
  } finally {
    clearInterval(timer);
    ctx.shutdownSignal?.removeEventListener('abort', onShutdownAbort);
  }
}

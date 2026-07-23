import {getDb} from '@/lib/db';
import {executeStageGeneration} from '@/lib/llm/executor';
import {getProvider} from '@/lib/llm';
import {clipText, LLMError, type LLMProvider} from '@/lib/llm/types';
import {
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
import {generateVersion} from '@/lib/workflow/operations';

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

    // 业务结果落库：M2-A 原子操作（版本 + active_version + status + stale 传播）
    const version = generateVersion({
      projectId: job.project_id,
      stage: payload.stage,
      content: result.content,
      contentType: result.contentType,
      source: result.versionSource,
      promptVersion: result.promptVersion,
      model: result.model,
      jobId: job.id,
    });
    completeLlmJob(job.id);
    log(
      `llm job ${job.id} succeeded: ${payload.stage} v${version.version} ` +
        `(${result.contentType}, repair=${result.repairCount}, requests=${result.requestIds.length})`,
    );
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
      failLlmJob(job.id, err.code, clipText(err.message, 500), {retryable});
      log(
        `llm job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}, ` +
          `${retryable ? 'retryable' : 'non-retryable'}): ${err.code}`,
      );
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    failLlmJob(job.id, 'LLM_ERROR', clipText(message, 500), {retryable: true});
    log(`llm job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): ${message}`);
  } finally {
    clearInterval(timer);
  }
}

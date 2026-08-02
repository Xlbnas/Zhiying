import {getDb} from '@/lib/db';
import type {LLMProvider} from '@/lib/llm/types';
import {BEATS_USAGE_STAGE} from '@/lib/narrative-beats/generate';
import {
  buildNarrativeBeats,
  NarrativeBeatsError,
  type BuildNarrativeBeatsResult,
} from '@/lib/narrative-beats/plan';
import {SHOTS_USAGE_STAGE} from '@/lib/shots/generate';
import {buildShots, ShotsError, type BuildShotsResult} from '@/lib/shots/plan';
import {VISUAL_INTENT_USAGE_STAGE} from '@/lib/visual-intent/generate';
import {
  buildVisualIntentPlan,
  VisualIntentError,
  type BuildVisualIntentResult,
} from '@/lib/visual-intent/plan';
import {SEQUENCES_USAGE_STAGE} from '@/lib/visual-sequences/generate';
import {
  buildVisualSequences,
  parseSequencesSourceKey,
  VisualSequencesError,
  type BuildVisualSequencesResult,
} from '@/lib/visual-sequences/plan';
import {
  completeDispatchFailed,
  completeDispatchSucceeded,
  heartbeatDispatchLease,
  requeueDispatch,
  type DispatchJobRow,
} from '@/lib/llm-generation/dispatch';

/**
 * Generation Dispatch 执行器（Worker-side LLM Dispatch）。
 *
 * 按 dispatch.stage 调 buildNarrativeBeats / buildVisualIntentPlan /
 * buildVisualSequences / buildShots（同 requestId/sourceArtifactId；
 * sequences 的 source_artifact_id 是 `${beatsId}|${intentId}` 复合键）。
 * durable single-flight 在 generation_runs：
 * 即使 worker 重复执行同一 dispatch，build 内部的 BEGIN IMMEDIATE claim
 * 保证绝不重复调用 provider。
 *
 * 结果映射：
 * - succeeded → completeDispatchSucceeded（generation_run_id + result_artifact_id）；
 * - terminal（failed/indeterminate）→ completeDispatchFailed（errorCode/message）；
 * - in_progress（run 被其他持有者 claim）→ 信封回 queued 等待；
 * - precheck throw（source 失效等，未创建 run、未调用 provider）→
 *   completeDispatchFailed（无 runId）；
 * - 优雅退出（shutdown）→ 信封回 queued，交给下次启动。
 *
 * 租约：claim 时设置（scheduler）；执行期间每 5s 刷新；完成即终态。
 */

const HEARTBEAT_INTERVAL_MS = 5000;

export interface DispatchExecutorContext {
  isShuttingDown: () => boolean;
  log: (...args: unknown[]) => void;
  /** Worker 统一的当前任务取消句柄：SIGTERM/SIGINT 触发，传入 build 中止 provider 请求。 */
  shutdownSignal?: AbortSignal;
}

/** 测试注入点（生产全部走默认值；与 LlmExecutorDeps 同风格）。 */
export interface DispatchExecutorDeps {
  provider?: LLMProvider;
  heartbeatMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDispatchJob(
  job: DispatchJobRow,
  ctx: DispatchExecutorContext,
  deps: DispatchExecutorDeps = {},
): Promise<void> {
  const {log} = ctx;
  const db = getDb();
  const ownerToken = job.owner_token;
  if (!ownerToken) {
    log(`dispatch job ${job.id} 缺少 owner_token（内部错误），跳过`);
    return;
  }

  const timer = setInterval(() => {
    heartbeatDispatchLease(db, job.id, ownerToken);
  }, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);

  try {
    log(
      `dispatch job ${job.id} start: project=${job.project_id} stage=${job.stage} ` +
        `requestId=${job.request_id} source=${job.source_artifact_id.slice(0, 8)}`,
    );
    let result: BuildNarrativeBeatsResult | BuildVisualIntentResult | BuildVisualSequencesResult | BuildShotsResult;
    if (job.stage === BEATS_USAGE_STAGE) {
      result = await buildNarrativeBeats({
        projectId: job.project_id,
        narrationPlanV2ArtifactId: job.source_artifact_id,
        requestId: job.request_id,
        provider: deps.provider,
        signal: ctx.shutdownSignal,
      });
    } else if (job.stage === VISUAL_INTENT_USAGE_STAGE) {
      result = await buildVisualIntentPlan({
        projectId: job.project_id,
        narrativeBeatsArtifactId: job.source_artifact_id,
        requestId: job.request_id,
        provider: deps.provider,
        signal: ctx.shutdownSignal,
      });
    } else if (job.stage === SEQUENCES_USAGE_STAGE) {
      // source_artifact_id 为 `${beatsId}|${intentId}` 复合键（UUID 不含 '|'）。
      let source: {narrativeBeatsArtifactId: string; visualIntentPlanArtifactId: string};
      try {
        source = parseSequencesSourceKey(job.source_artifact_id);
      } catch {
        completeDispatchFailed(db, {
          dispatchId: job.id,
          ownerToken,
          runId: null,
          errorCode: 'SOURCE_ARTIFACT_MALFORMED',
          errorMessage: `sequences dispatch source_artifact_id 复合键格式非法: ${job.source_artifact_id}`,
        });
        log(`dispatch job ${job.id} failed: SOURCE_ARTIFACT_MALFORMED`);
        return;
      }
      result = await buildVisualSequences({
        projectId: job.project_id,
        narrativeBeatsArtifactId: source.narrativeBeatsArtifactId,
        visualIntentPlanArtifactId: source.visualIntentPlanArtifactId,
        requestId: job.request_id,
        provider: deps.provider,
        signal: ctx.shutdownSignal,
      });
    } else if (job.stage === SHOTS_USAGE_STAGE) {
      result = await buildShots({
        projectId: job.project_id,
        visualSequencesArtifactId: job.source_artifact_id,
        requestId: job.request_id,
        provider: deps.provider,
        signal: ctx.shutdownSignal,
      });
    } else {
      completeDispatchFailed(db, {
        dispatchId: job.id,
        ownerToken,
        runId: null,
        errorCode: 'UNKNOWN_STAGE',
        errorMessage: `未知 dispatch stage: ${job.stage}`,
      });
      log(`dispatch job ${job.id} failed: UNKNOWN_STAGE ${job.stage}`);
      return;
    }

    if (result.kind === 'succeeded') {
      completeDispatchSucceeded(db, {
        dispatchId: job.id,
        ownerToken,
        runId: result.runId,
        resultArtifactId: result.artifact.id,
      });
      log(
        `dispatch job ${job.id} succeeded: artifact=${result.artifact.id.slice(0, 8)} ` +
          `(reused=${result.reused} run=${result.runId?.slice(0, 8) ?? 'legacy'})`,
      );
      return;
    }
    if (result.kind === 'in_progress') {
      // run 被其他持有者 claim（租约有效）——信封回 queued 等待；重执行经
      // durable claim 短路，零重复 provider 调用。短暂退让避免空转。
      requeueDispatch(db, job.id, ownerToken);
      log(`dispatch job ${job.id} requeued: generation run ${result.runId.slice(0, 8)} in_progress`);
      await sleep(result.retryAfterMs);
      return;
    }
    // terminal：generation run 的 failed/indeterminate 终态稳定映射。
    completeDispatchFailed(db, {
      dispatchId: job.id,
      ownerToken,
      runId: result.runId,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
    log(
      `dispatch job ${job.id} failed: run=${result.runId.slice(0, 8)} ` +
        `${result.status} [${result.errorCode}]`,
    );
  } catch (err) {
    if (ctx.isShuttingDown()) {
      // 优雅退出：信封回 queued，交给下次启动（durable single-flight 防重复生成）
      requeueDispatch(db, job.id, ownerToken);
      log(`dispatch job ${job.id} requeued due to shutdown`);
      return;
    }
    // precheck throw（NarrativeBeatsError/VisualIntentError/VisualSequencesError/ShotsError）：
    // source 失效/请求非法，发生在 run claim 之前——零 run、零 provider 调用，直接终态。
    const errorCode =
      err instanceof NarrativeBeatsError ||
      err instanceof VisualIntentError ||
      err instanceof VisualSequencesError ||
      err instanceof ShotsError
        ? err.code
        : 'INTERNAL_ERROR';
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      completeDispatchFailed(db, {
        dispatchId: job.id,
        ownerToken,
        runId: null,
        errorCode,
        errorMessage,
      });
      log(`dispatch job ${job.id} failed: [${errorCode}] ${errorMessage}`);
    } catch (completeErr) {
      log(
        `dispatch job ${job.id} 终态写入失败（内部错误）: ` +
          `${completeErr instanceof Error ? completeErr.message : String(completeErr)}`,
      );
    }
  } finally {
    clearInterval(timer);
  }
}

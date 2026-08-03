/**
 * GET  /api/projects/[id]/narration-performance-plans — Performance Plan candidate 列表
 *      + runs/dispatch 状态面（UI 轮询）
 * POST /api/projects/[id]/narration-performance-plans — enqueue generation dispatch
 *      （Worker-side LLM Dispatch；Web 不持有 LLM secret）
 *      body: { requestId, narrationPlanArtifactId, projectVoiceAssignmentArtifactId }
 *
 * 边界：candidate only。source 必须精确（narrationPlanArtifactId +
 * projectVoiceAssignmentArtifactId，禁止 latest/current 解析）；同 requestId +
 * 同 source 幂等（generation_runs + dispatch envelope 双持久状态 fail-closed）；
 * 不同 source → 409。不 enqueue TTS。
 */
import {z, ZodError} from 'zod';
import {listNarrationPlanV2Candidates} from '@/lib/narration/plan-v2';
import {
  precheckPerformancePlanSource,
  PerformanceError,
} from '@/lib/tts-b/performance';
import {
  classifyNarrationPerformancePlan,
  getNarrationPerformancePlan,
  listNarrationPerformancePlanCandidates,
} from '@/lib/tts-b/performance';
import {composePerformanceSourceKey} from '@/lib/tts-b/performance';
import {PERFORMANCE_USAGE_STAGE} from '@/lib/tts-b/constants';
import {enqueueGenerationDispatch, listDispatchJobs} from '@/lib/llm-generation/dispatch';
import {
  GENERATION_IN_PROGRESS_RETRY_AFTER_MS,
  listGenerationRunSummaries,
  RequestIdConflictError,
} from '@/lib/llm-generation/runs';
import {getDb} from '@/lib/db';
import {getProject, jsonError} from '../../../_lib/shared';

export const runtime = 'nodejs';

const buildBodySchema = z
  .object({
    requestId: z.string().min(1),
    narrationPlanArtifactId: z.string().min(1),
    projectVoiceAssignmentArtifactId: z.string().min(1),
  })
  .strict();

function performanceErrorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return jsonError(422, 'invalid_request', {message: err.message});
  }
  if (err instanceof RequestIdConflictError) {
    return jsonError(409, 'REQUEST_ID_CONFLICT', {message: err.message});
  }
  if (err instanceof PerformanceError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' ||
      err.code === 'NARRATION_PLAN_NOT_FOUND' ||
      err.code === 'ASSIGNMENT_NOT_FOUND'
        ? 404
        : err.code === 'REQUEST_ID_REQUIRED'
          ? 400
          : err.code === 'REQUEST_ID_INVALID'
            ? 422
            : 409;
    return jsonError(status, err.code, {message: err.message});
  }
  throw err;
}

function candidateSummary(candidate: Awaited<ReturnType<typeof listNarrationPerformancePlanCandidates>>[number]) {
  const performance = candidate.performance;
  return {
    artifactId: candidate.artifact.id,
    version: candidate.artifact.version,
    status: candidate.status,
    statusReason: candidate.statusReason,
    createdAt: candidate.artifact.created_at,
    itemCount: performance?.items.length ?? null,
    sourceNarrationPlanArtifactId: performance?.source.narrationPlanArtifactId ?? null,
    sourceAssignmentArtifactId: performance?.source.projectVoiceAssignmentArtifactId ?? null,
    sourceVoiceProfileId: performance?.source.voiceProfileId ?? null,
    sourceVoiceProfileRevisionId: performance?.source.voiceProfileRevisionId ?? null,
    provider: performance?.generation.provider ?? null,
    model: performance?.generation.model ?? null,
    promptVersion: performance?.promptVersion ?? null,
    compilerVersion: performance?.compilerVersion ?? null,
    attemptCount: performance?.generation.attemptCount ?? null,
    requestId: performance?.generation.requestId ?? null,
  };
}

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');
  const candidates = await listNarrationPerformancePlanCandidates(id);
  const runs = listGenerationRunSummaries(getDb(), id, PERFORMANCE_USAGE_STAGE);
  // 供 UI 人工选择 exact Narration Plan（非 current/latest 语义，仅建议）
  const narrationPlanCandidates = listNarrationPlanV2Candidates(id).map((c) => ({
    artifactId: c.artifact.id,
    version: c.artifact.version,
    status: c.status,
    statusReason: c.statusReason,
    unitCount: c.plan?.units.length ?? null,
    speechUnitCount: c.plan?.units.filter((u) => u.kind === 'speech').length ?? null,
    createdAt: c.artifact.created_at,
  }));
  return Response.json({
    candidateOnly: true,
    narrationPlanCandidates,
    candidates: candidates.map(candidateSummary),
    runs,
    dispatchJobs: listDispatchJobs(getDb(), id, PERFORMANCE_USAGE_STAGE),
  });
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', {message: '请求体不是合法 JSON'});
  }
  try {
    const input = buildBodySchema.parse(body);
    // exact source 前置检查（与 worker build 同一 precheck；fail-closed）
    const {requestId} = await precheckPerformancePlanSource({
      projectId: id,
      narrationPlanArtifactId: input.narrationPlanArtifactId,
      projectVoiceAssignmentArtifactId: input.projectVoiceAssignmentArtifactId,
      requestId: input.requestId,
    });

    const result = enqueueGenerationDispatch(getDb(), {
      projectId: id,
      stage: PERFORMANCE_USAGE_STAGE,
      requestId,
      sourceArtifactId: composePerformanceSourceKey(
        input.narrationPlanArtifactId,
        input.projectVoiceAssignmentArtifactId,
      ),
    });
    if (result.kind === 'reused') {
      const ref = result.resultArtifactId
        ? getNarrationPerformancePlan(id, result.resultArtifactId)
        : null;
      if (!ref) {
        return Response.json(
          {
            runId: result.runId,
            status: 'failed',
            errorCode: 'RESULT_ARTIFACT_MISSING',
            message: `run ${result.runId} 已 succeeded 但 result artifact ${result.resultArtifactId ?? '(null)'} 不可读`,
            candidateOnly: true,
          },
          {status: 409},
        );
      }
      // TTS-B.R1：reused 前 classify——stale/invalid 不得返回 200
      const candidate = await classifyNarrationPerformancePlan(id, ref.artifact);
      if (candidate.status !== 'current_candidate') {
        const errorCode =
          candidate.status === 'invalid_source' ? 'RESULT_ARTIFACT_INVALID' : 'RESULT_ARTIFACT_STALE';
        return Response.json(
          {
            runId: result.runId,
            status: 'failed',
            errorCode,
            message: `result artifact 已 ${candidate.status}（${candidate.statusReason ?? ''}）——请用新 requestId + 新 exact source`,
            candidateOnly: true,
          },
          {status: 409},
        );
      }
      return Response.json(
        {
          artifactId: ref.artifact.id,
          artifactVersion: ref.artifact.version,
          reused: true,
          runId: result.runId,
          status: 'succeeded',
          candidateOnly: true,
          itemCount: ref.performance.items.length,
          generation: ref.performance.generation,
        },
        {status: 200},
      );
    }
    if (result.kind === 'running') {
      return Response.json(
        {
          dispatchId: result.dispatchId,
          runId: result.runId,
          status: 'running',
          retryAfterMs: GENERATION_IN_PROGRESS_RETRY_AFTER_MS,
          candidateOnly: true,
        },
        {status: 202},
      );
    }
    if (result.kind === 'terminal') {
      return Response.json(
        {
          runId: result.runId,
          status: result.status,
          errorCode: result.errorCode,
          message: result.errorMessage,
          candidateOnly: true,
        },
        {status: 409},
      );
    }
    return Response.json(
      {
        dispatchId: result.dispatchId,
        requestId,
        status: result.dispatchStatus,
        candidateOnly: true,
      },
      {status: 202},
    );
  } catch (err) {
    return performanceErrorResponse(err);
  }
}

/**
 * GET  /api/projects/[id]/narrative-beats — Narrative Beats candidate 列表 + source 建议（M7.2）
 *      + dispatch jobs 状态面（UI 轮询）
 * POST /api/projects/[id]/narrative-beats — enqueue generation dispatch（Worker-side LLM Dispatch）
 *      body: { narrationPlanV2ArtifactId, requestId }
 *
 * 边界：candidate only——不写 current/lock，不切 pipelineVersion，不触发下游。
 * build 必须显式传 exact narrationPlanV2ArtifactId（禁止 latest/current 解析）；
 * GET 中的 latestEligibleSuggestion 仅供 UI 人工选择建议。
 *
 * Production 安全边界：Web 进程不持有 LLM secret（DEEPSEEK_API_KEY/LLM_PROVIDER
 * 只注入 worker 容器）——本 route 绝不调用 getProvider/build，只做 validation +
 * exact source precheck + 幂等复用查询 + enqueue + 状态查询；Worker 持有凭据
 * 执行 build（durable single-flight 由 generation_runs 兜底）。
 *
 * POST 语义：
 * - artifact 内容 requestId 命中（legacy 复用）→ 200 {reused:true, status:'succeeded'}；
 * - generation_run succeeded → 200 reused；running（租约有效）→ 202 {status:'running'}；
 *   failed/indeterminate → 409 {status, errorCode}；
 * - 否则 enqueue dispatch → 202 {dispatchId, requestId, status:'queued', candidateOnly:true}。
 */
import {z, ZodError} from 'zod';
import {
  findNarrativeBeatsByRequestId,
  getNarrativeBeatsArtifact,
  listNarrativeBeatsCandidates,
  NarrativeBeatsError,
  precheckNarrativeBeatsSource,
} from '@/lib/narrative-beats/plan';
import {BEATS_USAGE_STAGE} from '@/lib/narrative-beats/generate';
import {enqueueGenerationDispatch, listDispatchJobs} from '@/lib/llm-generation/dispatch';
import {
  findGenerationRun,
  GENERATION_IN_PROGRESS_RETRY_AFTER_MS,
  listGenerationRunSummaries,
  RequestIdConflictError,
} from '@/lib/llm-generation/runs';
import {getDb} from '@/lib/db';
import {
  getLatestEligibleNarrationPlanV2Candidate,
  listNarrationPlanV2Candidates,
} from '@/lib/narration/plan-v2';
import {getM7PipelineSnapshotId, getPipelineVersion} from '@/lib/pipeline-version';
import {getProject, jsonError} from '../../../_lib/shared';

export const runtime = 'nodejs';

const buildBodySchema = z
  .object({
    narrationPlanV2ArtifactId: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

function beatsErrorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return jsonError(422, 'invalid_request', {message: err.message});
  }
  if (err instanceof RequestIdConflictError) {
    return jsonError(409, 'REQUEST_ID_CONFLICT', {message: err.message});
  }
  if (err instanceof NarrativeBeatsError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' || err.code === 'NARRATION_PLAN_NOT_FOUND'
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

function candidateSummary(candidate: ReturnType<typeof listNarrativeBeatsCandidates>[number]) {
  return {
    artifactId: candidate.artifact.id,
    version: candidate.artifact.version,
    status: candidate.status,
    statusReason: candidate.statusReason,
    createdAt: candidate.artifact.created_at,
    beatCount: candidate.beats?.beats.length ?? null,
    sourceNarrationPlanV2ArtifactId: candidate.beats?.source.narrationPlanV2ArtifactId ?? null,
    provider: candidate.beats?.generation.provider ?? null,
    model: candidate.beats?.generation.model ?? null,
    promptVersion: candidate.beats?.promptVersion ?? null,
    compilerVersion: candidate.beats?.compilerVersion ?? null,
    attemptCount: candidate.beats?.generation.attemptCount ?? null,
    requestId: candidate.beats?.generation.requestId ?? null,
  };
}

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  const narrationCandidates = listNarrationPlanV2Candidates(id).map((c) => ({
    artifactId: c.artifact.id,
    version: c.artifact.version,
    status: c.status,
    statusReason: c.statusReason,
    unitCount: c.plan?.units.length ?? null,
    createdAt: c.artifact.created_at,
  }));
  // 仅供 UI 人工选择建议——不是 current/selected/active。
  const suggestion = getLatestEligibleNarrationPlanV2Candidate(id);
  const candidates = listNarrativeBeatsCandidates(id);
  const runs = listGenerationRunSummaries(getDb(), id, BEATS_USAGE_STAGE);
  const runRequestIds = new Set(runs.map((r) => r.requestId));
  return Response.json({
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    candidateOnly: true,
    narrationCandidates,
    latestEligibleSuggestionArtifactId: suggestion?.artifact.id ?? null,
    candidates: candidates.map((c) => ({
      ...candidateSummary(c),
      // M7.2.1 之前的 candidate 没有 generation run/journal——按 artifact 内
      // requestId 幂等复用，绝不伪造 journal。
      legacyRunMetadataUnavailable:
        c.beats != null && !runRequestIds.has(c.beats.generation.requestId),
    })),
    runs,
    dispatchJobs: listDispatchJobs(getDb(), id, BEATS_USAGE_STAGE),
  });
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', {message: '请求体不是合法 JSON'});
  }
  try {
    const input = buildBodySchema.parse(body);
    // exact source 前置检查（与 worker build 同一 precheck；fail-closed）
    const {requestId} = precheckNarrativeBeatsSource({
      projectId: id,
      narrationPlanV2ArtifactId: input.narrationPlanV2ArtifactId,
      requestId: input.requestId,
    });

    // legacy/幂等复用：artifact 内容 requestId 命中 → 零 dispatch、零 run、零 provider。
    const existing = findNarrativeBeatsByRequestId(id, requestId);
    if (existing) {
      if (existing.content.source.narrationPlanV2ArtifactId !== input.narrationPlanV2ArtifactId) {
        throw new NarrativeBeatsError(
          'REQUEST_ID_CONFLICT',
          `requestId ${requestId} 已用于 source ${existing.content.source.narrationPlanV2ArtifactId}，不得复用于其他 source`,
        );
      }
      const run = findGenerationRun(getDb(), id, BEATS_USAGE_STAGE, requestId);
      return Response.json(
        {
          artifactId: existing.row.id,
          artifactVersion: existing.row.version,
          reused: true,
          legacy: !run,
          runId: run?.id ?? null,
          status: 'succeeded',
          candidateOnly: true,
          pipelineVersion: getPipelineVersion(id),
          beatCount: existing.content.beats.length,
          generation: existing.content.generation,
          beats: existing.content.beats,
        },
        {status: 200},
      );
    }

    const result = enqueueGenerationDispatch(getDb(), {
      projectId: id,
      stage: BEATS_USAGE_STAGE,
      requestId,
      sourceArtifactId: input.narrationPlanV2ArtifactId,
    });
    if (result.kind === 'reused') {
      // generation_run succeeded：复用 result artifact（不可读 → fail-closed 409，不重新生成）。
      const ref = result.resultArtifactId ? getNarrativeBeatsArtifact(id, result.resultArtifactId) : null;
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
      return Response.json(
        {
          artifactId: ref.artifact.id,
          artifactVersion: ref.artifact.version,
          reused: true,
          legacy: false,
          runId: result.runId,
          status: 'succeeded',
          candidateOnly: true,
          pipelineVersion: getPipelineVersion(id),
          beatCount: ref.beats.beats.length,
          generation: ref.beats.generation,
          beats: ref.beats.beats,
        },
        {status: 200},
      );
    }
    if (result.kind === 'running') {
      // 同 requestId 的 run 正在运行（worker 持有 claim）——本请求零成本。
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
      // 同 requestId 的终态永远稳定返回；显式 regenerate 必须使用新 requestId。
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
    // queued：Worker 持有凭据执行 build；Web 全程零 secret、零 provider。
    return Response.json(
      {
        dispatchId: result.dispatchId,
        requestId,
        status: 'queued',
        candidateOnly: true,
      },
      {status: 202},
    );
  } catch (err) {
    return beatsErrorResponse(err);
  }
}

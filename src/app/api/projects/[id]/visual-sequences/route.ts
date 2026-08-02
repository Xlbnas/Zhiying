/**
 * GET  /api/projects/[id]/visual-sequences — Visual Sequence candidate 列表 + source 建议（M7.3B）
 *      + dispatch jobs 状态面（UI 轮询）
 * POST /api/projects/[id]/visual-sequences — enqueue generation dispatch（Worker-side LLM Dispatch）
 *      body: { narrativeBeatsArtifactId, visualIntentPlanArtifactId, requestId }
 *
 * 边界：candidate only——不写 current/lock，不切 pipelineVersion，不触发下游。
 * build 必须显式传 exact narrativeBeatsArtifactId + visualIntentPlanArtifactId
 * （禁止 latest/current 解析；双源 transitive chain 必须一致）；
 * GET 中的 suggestion artifact IDs 仅供 UI 人工选择建议。
 *
 * Production 安全边界：Web 进程不持有 LLM secret——本 route 绝不调用
 * getProvider/build，只做 validation + exact source precheck + 幂等复用查询 +
 * enqueue + 状态查询；Worker 持有凭据执行 build。
 *
 * POST 语义：
 * - artifact 内容 requestId 命中（legacy 复用）→ 200 {reused:true, status:'succeeded'}；
 * - generation_run succeeded → 200 reused；running（租约有效）→ 202 {status:'running'}；
 *   failed/indeterminate → 409 {status, errorCode}；
 * - 否则 enqueue dispatch → 202 {dispatchId, requestId, status:'queued', candidateOnly:true}。
 */
import {z, ZodError} from 'zod';
import {
  findVisualSequencesByRequestId,
  precheckVisualSequencesSource,
  VisualSequencesError,
} from '@/lib/visual-sequences/plan';
import {
  composeSequencesSourceKey,
} from '@/lib/visual-sequences/plan';
import {getVisualSequencesArtifact, listVisualSequencesCandidates} from '@/lib/visual-sequences/classify';
import {SEQUENCES_USAGE_STAGE} from '@/lib/visual-sequences/generate';
import {enqueueGenerationDispatch, listDispatchJobs} from '@/lib/llm-generation/dispatch';
import {
  findGenerationRun,
  GENERATION_IN_PROGRESS_RETRY_AFTER_MS,
  listGenerationRunSummaries,
  RequestIdConflictError,
} from '@/lib/llm-generation/runs';
import {listNarrativeBeatsCandidates} from '@/lib/narrative-beats/plan';
import {listVisualIntentCandidates} from '@/lib/visual-intent/plan';
import {getDb} from '@/lib/db';
import {getM7PipelineSnapshotId, getPipelineVersion} from '@/lib/pipeline-version';
import {getProject, jsonError} from '../../../_lib/shared';

export const runtime = 'nodejs';

const buildBodySchema = z
  .object({
    narrativeBeatsArtifactId: z.string().min(1),
    visualIntentPlanArtifactId: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

function visualSequencesErrorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return jsonError(422, 'invalid_request', {message: err.message});
  }
  if (err instanceof RequestIdConflictError) {
    return jsonError(409, 'REQUEST_ID_CONFLICT', {message: err.message});
  }
  if (err instanceof VisualSequencesError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' || err.code === 'BEATS_NOT_FOUND' || err.code === 'INTENT_NOT_FOUND'
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

function candidateSummary(candidate: ReturnType<typeof listVisualSequencesCandidates>[number]) {
  const sequences = candidate.visualSequences?.sequences ?? null;
  return {
    artifactId: candidate.artifact.id,
    version: candidate.artifact.version,
    status: candidate.status,
    statusReason: candidate.statusReason,
    createdAt: candidate.artifact.created_at,
    sequenceCount: sequences?.length ?? null,
    needsReview: candidate.status === 'needs_review',
    sourceNarrativeBeatsArtifactId: candidate.visualSequences?.source.narrativeBeatsArtifactId ?? null,
    sourceVisualIntentPlanArtifactId: candidate.visualSequences?.source.visualIntentPlanArtifactId ?? null,
    sourceNarrationPlanV2ArtifactId: candidate.visualSequences?.source.narrationPlanV2ArtifactId ?? null,
    provider: candidate.visualSequences?.generation.provider ?? null,
    model: candidate.visualSequences?.generation.model ?? null,
    promptVersion: candidate.visualSequences?.promptVersion ?? null,
    compilerVersion: candidate.visualSequences?.compilerVersion ?? null,
    attemptCount: candidate.visualSequences?.generation.attemptCount ?? null,
    requestId: candidate.visualSequences?.generation.requestId ?? null,
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
  const beatsCandidates = listNarrativeBeatsCandidates(id).map((c) => ({
    artifactId: c.artifact.id,
    version: c.artifact.version,
    status: c.status,
    statusReason: c.statusReason,
    beatCount: c.beats?.beats.length ?? null,
    createdAt: c.artifact.created_at,
  }));
  const intentCandidates = listVisualIntentCandidates(id).map((c) => ({
    artifactId: c.artifact.id,
    version: c.artifact.version,
    status: c.status,
    statusReason: c.statusReason,
    intentCount: c.visualIntent?.intents.length ?? null,
    unresolvedCount: c.visualIntent?.intents.filter((i) => i.intent === 'VISUAL_UNRESOLVED').length ?? null,
    createdAt: c.artifact.created_at,
  }));
  // 仅供 UI 人工选择建议——不是 current/selected/active。
  const beatsSuggestion = beatsCandidates.find((c) => c.status === 'eligible_candidate') ?? null;
  const intentSuggestion = intentCandidates.find(
    (c) => c.status === 'eligible_candidate' || c.status === 'needs_review',
  ) ?? null;
  const candidates = listVisualSequencesCandidates(id);
  const runs = listGenerationRunSummaries(getDb(), id, SEQUENCES_USAGE_STAGE);
  const runRequestIds = new Set(runs.map((r) => r.requestId));
  return Response.json({
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    candidateOnly: true,
    beatsCandidates,
    intentCandidates,
    latestEligibleBeatsSuggestionArtifactId: beatsSuggestion?.artifactId ?? null,
    latestEligibleIntentSuggestionArtifactId: intentSuggestion?.artifactId ?? null,
    candidates: candidates.map((c) => ({
      ...candidateSummary(c),
      // 无 generation run/journal 的 candidate——按 artifact 内
      // requestId 幂等复用，绝不伪造 journal。
      legacyRunMetadataUnavailable:
        c.visualSequences != null && !runRequestIds.has(c.visualSequences.generation.requestId),
    })),
    runs,
    dispatchJobs: listDispatchJobs(getDb(), id, SEQUENCES_USAGE_STAGE),
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
    const {requestId} = precheckVisualSequencesSource({
      projectId: id,
      narrativeBeatsArtifactId: input.narrativeBeatsArtifactId,
      visualIntentPlanArtifactId: input.visualIntentPlanArtifactId,
      requestId: input.requestId,
    });

    // legacy/幂等复用：artifact 内容 requestId 命中 → 零 dispatch、零 run、零 provider。
    const existing = findVisualSequencesByRequestId(id, requestId);
    if (existing) {
      const key = composeSequencesSourceKey(input.narrativeBeatsArtifactId, input.visualIntentPlanArtifactId);
      const existingKey = composeSequencesSourceKey(
        existing.content.source.narrativeBeatsArtifactId,
        existing.content.source.visualIntentPlanArtifactId,
      );
      if (existingKey !== key) {
        throw new VisualSequencesError(
          'REQUEST_ID_CONFLICT',
          `requestId ${requestId} 已用于 source ${existingKey}，不得复用于其他 source 组合`,
        );
      }
      const run = findGenerationRun(getDb(), id, SEQUENCES_USAGE_STAGE, requestId);
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
          sequenceCount: existing.content.sequences.length,
          generation: existing.content.generation,
          sequences: existing.content.sequences,
        },
        {status: 200},
      );
    }

    const result = enqueueGenerationDispatch(getDb(), {
      projectId: id,
      stage: SEQUENCES_USAGE_STAGE,
      requestId,
      sourceArtifactId: composeSequencesSourceKey(
        input.narrativeBeatsArtifactId,
        input.visualIntentPlanArtifactId,
      ),
    });
    if (result.kind === 'reused') {
      // generation_run succeeded：复用 result artifact（不可读 → fail-closed 409，不重新生成）。
      const ref = result.resultArtifactId ? getVisualSequencesArtifact(id, result.resultArtifactId) : null;
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
          sequenceCount: ref.visualSequences.sequences.length,
          generation: ref.visualSequences.generation,
          sequences: ref.visualSequences.sequences,
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
    return visualSequencesErrorResponse(err);
  }
}

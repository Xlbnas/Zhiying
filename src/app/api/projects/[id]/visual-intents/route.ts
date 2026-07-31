/**
 * GET  /api/projects/[id]/visual-intents — Visual Intent candidate 列表 + source 建议（M7.3A）
 * POST /api/projects/[id]/visual-intents — 构建/复用 candidate
 *      body: { narrativeBeatsArtifactId, requestId }
 *
 * 边界：candidate only——不写 current/lock，不切 pipelineVersion，不触发下游。
 * build 必须显式传 exact narrativeBeatsArtifactId（禁止 latest/current 解析）；
 * GET 中的 latestEligibleBeatsSuggestionArtifactId 仅供 UI 人工选择建议。
 */
import {z, ZodError} from 'zod';
import {
  buildVisualIntentPlan,
  getVisualIntentArtifact,
  listVisualIntentCandidates,
  VisualIntentError,
} from '@/lib/visual-intent/plan';
import {VISUAL_INTENT_USAGE_STAGE} from '@/lib/visual-intent/generate';
import {listGenerationRunSummaries} from '@/lib/llm-generation/runs';
import {listNarrativeBeatsCandidates} from '@/lib/narrative-beats/plan';
import {getDb} from '@/lib/db';
import {getM7PipelineSnapshotId, getPipelineVersion} from '@/lib/pipeline-version';
import {getProject, jsonError} from '../../../_lib/shared';

export const runtime = 'nodejs';

const buildBodySchema = z
  .object({
    narrativeBeatsArtifactId: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();

function visualIntentErrorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return jsonError(422, 'invalid_request', {message: err.message});
  }
  if (err instanceof VisualIntentError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' || err.code === 'BEATS_NOT_FOUND'
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

function candidateSummary(candidate: ReturnType<typeof listVisualIntentCandidates>[number]) {
  const intents = candidate.visualIntent?.intents ?? null;
  return {
    artifactId: candidate.artifact.id,
    version: candidate.artifact.version,
    status: candidate.status,
    statusReason: candidate.statusReason,
    createdAt: candidate.artifact.created_at,
    intentCount: intents?.length ?? null,
    unresolvedCount: intents?.filter((i) => i.intent === 'VISUAL_UNRESOLVED').length ?? null,
    titleCardCount: intents?.filter((i) => i.intent === 'EMPHASIZE_TEXT').length ?? null,
    continuationCount:
      intents?.filter((i) => i.intent === 'CONTINUE_PREVIOUS_VISUAL' || i.intent === 'NO_VISUAL_CHANGE')
        .length ?? null,
    sourceNarrativeBeatsArtifactId: candidate.visualIntent?.source.narrativeBeatsArtifactId ?? null,
    sourceNarrationPlanV2ArtifactId: candidate.visualIntent?.source.narrationPlanV2ArtifactId ?? null,
    provider: candidate.visualIntent?.generation.provider ?? null,
    model: candidate.visualIntent?.generation.model ?? null,
    promptVersion: candidate.visualIntent?.promptVersion ?? null,
    compilerVersion: candidate.visualIntent?.compilerVersion ?? null,
    attemptCount: candidate.visualIntent?.generation.attemptCount ?? null,
    requestId: candidate.visualIntent?.generation.requestId ?? null,
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
  // 仅供 UI 人工选择建议——不是 current/selected/active。
  const suggestion = beatsCandidates.find((c) => c.status === 'eligible_candidate') ?? null;
  const candidates = listVisualIntentCandidates(id);
  const runs = listGenerationRunSummaries(getDb(), id, VISUAL_INTENT_USAGE_STAGE);
  const runRequestIds = new Set(runs.map((r) => r.requestId));
  return Response.json({
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    candidateOnly: true,
    beatsCandidates,
    latestEligibleBeatsSuggestionArtifactId: suggestion?.artifactId ?? null,
    candidates: candidates.map((c) => ({
      ...candidateSummary(c),
      // 无 generation run/journal 的 candidate——按 artifact 内
      // requestId 幂等复用，绝不伪造 journal。
      legacyRunMetadataUnavailable:
        c.visualIntent != null && !runRequestIds.has(c.visualIntent.generation.requestId),
    })),
    runs,
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
    const result = await buildVisualIntentPlan({
      projectId: id,
      narrativeBeatsArtifactId: input.narrativeBeatsArtifactId,
      requestId: input.requestId,
    });
    if (result.kind === 'in_progress') {
      // 同 requestId 的 run 正在运行——本请求未调用 provider，零成本。
      return Response.json(
        {runId: result.runId, status: 'running', retryAfterMs: result.retryAfterMs, candidateOnly: true},
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
    const ref = getVisualIntentArtifact(id, result.artifact.id);
    return Response.json(
      {
        artifactId: result.artifact.id,
        artifactVersion: result.artifact.version,
        reused: result.reused,
        legacy: result.legacy,
        runId: result.runId,
        candidateOnly: true,
        pipelineVersion: getPipelineVersion(id),
        intentCount: result.visualIntent.intents.length,
        generation: result.visualIntent.generation,
        intents: ref?.visualIntent.intents ?? [],
      },
      {status: result.reused ? 200 : 201},
    );
  } catch (err) {
    return visualIntentErrorResponse(err);
  }
}

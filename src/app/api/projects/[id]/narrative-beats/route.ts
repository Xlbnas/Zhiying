/**
 * GET  /api/projects/[id]/narrative-beats — Narrative Beats candidate 列表 + source 建议（M7.2）
 * POST /api/projects/[id]/narrative-beats — 构建/复用 candidate
 *      body: { narrationPlanV2ArtifactId, requestId }
 *
 * 边界：candidate only——不写 current/lock，不切 pipelineVersion，不触发下游。
 * build 必须显式传 exact narrationPlanV2ArtifactId（禁止 latest/current 解析）；
 * GET 中的 latestEligibleSuggestion 仅供 UI 人工选择建议。
 */
import {z, ZodError} from 'zod';
import {
  buildNarrativeBeats,
  getNarrativeBeatsArtifact,
  listNarrativeBeatsCandidates,
  NarrativeBeatsError,
} from '@/lib/narrative-beats/plan';
import {
  getLatestEligibleNarrationPlanV2Candidate,
  listNarrationPlanV2Candidates,
} from '@/lib/narration/plan-v2';
import {getM7PipelineSnapshotId, getPipelineVersion} from '@/lib/pipeline-version';
import {LLMError} from '@/lib/llm/types';
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
  if (err instanceof NarrativeBeatsError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' || err.code === 'NARRATION_PLAN_NOT_FOUND'
        ? 404
        : err.code === 'REQUEST_ID_REQUIRED'
          ? 400
          : 409;
    return jsonError(status, err.code, {message: err.message});
  }
  if (err instanceof LLMError) {
    return jsonError(502, err.code, {message: err.message});
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
  return Response.json({
    pipelineVersion: getPipelineVersion(id),
    m7PipelineSnapshotId: getM7PipelineSnapshotId(id),
    candidateOnly: true,
    narrationCandidates,
    latestEligibleSuggestionArtifactId: suggestion?.artifact.id ?? null,
    candidates: listNarrativeBeatsCandidates(id).map(candidateSummary),
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
    const result = await buildNarrativeBeats({
      projectId: id,
      narrationPlanV2ArtifactId: input.narrationPlanV2ArtifactId,
      requestId: input.requestId,
    });
    const ref = getNarrativeBeatsArtifact(id, result.artifact.id);
    return Response.json(
      {
        artifactId: result.artifact.id,
        artifactVersion: result.artifact.version,
        reused: result.reused,
        candidateOnly: true,
        pipelineVersion: getPipelineVersion(id),
        beatCount: result.beats.beats.length,
        generation: result.beats.generation,
        beats: ref?.beats.beats ?? [],
      },
      {status: result.reused ? 200 : 201},
    );
  } catch (err) {
    return beatsErrorResponse(err);
  }
}

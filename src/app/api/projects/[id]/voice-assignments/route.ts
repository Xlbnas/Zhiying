/**
 * GET  /api/projects/[id]/voice-assignments — Project Voice Assignment candidate 列表
 * POST /api/projects/[id]/voice-assignments — 创建 assignment（同步 deterministic）
 *      body: { requestId, voiceProfileId, voiceProfileRevisionId }
 *
 * 边界：candidate only——不 current/active/locked/default，不更新 projects 指针，
 * 不建 snapshot。创建前经 TTS-A exact validator（Profile active + Revision usable +
 * provider/adapter/hash 一致）。幂等（最小 request envelope，UNIQUE(project_id,
 * request_id) + 单事务）：同 requestId + 同 exact revision → 200 reused；
 * 不同 revision → 409 REQUEST_ID_CONFLICT。Web 不调用 LLM、不 enqueue TTS。
 */
import {z, ZodError} from 'zod';
import {
  buildProjectVoiceAssignment,
  AssignmentError,
  listProjectVoiceAssignmentCandidates,
} from '@/lib/tts-b/assignment';
import {voiceUuidSchema} from '@/lib/tts-b/assignment-schema';
import {getProject, jsonError} from '../../../_lib/shared';

export const runtime = 'nodejs';

const assignBodySchema = z
  .object({
    requestId: z.string().min(1),
    // ID schema（TTS-B.R1 §八）：malformed → 422 invalid_request（ZodError）
    voiceProfileId: voiceUuidSchema,
    voiceProfileRevisionId: voiceUuidSchema,
  })
  .strict();

function assignmentErrorResponse(err: unknown): Response {
  if (err instanceof ZodError) {
    return jsonError(422, 'invalid_request', {message: err.message});
  }
  if (err instanceof AssignmentError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' ||
      err.code === 'PROFILE_NOT_FOUND' ||
      err.code === 'REVISION_NOT_FOUND'
        ? 404
        : err.code === 'REQUEST_ID_REQUIRED' || err.code === 'INVALID_PROFILE_ID' || err.code === 'INVALID_REVISION_ID'
          ? 400
          : err.code === 'REQUEST_ID_INVALID'
            ? 422
            : 409; // PROFILE_ARCHIVED / VOICE_UNUSABLE / REQUEST_ID_CONFLICT / REQUEST_STATE_INCONSISTENT / ASSIGNMENT_SOURCE_MISMATCH / ASSIGNMENT_UNUSABLE
    return jsonError(status, err.code, {message: err.message});
  }
  throw err;
}

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');
  const candidates = await listProjectVoiceAssignmentCandidates(id);
  return Response.json({
    candidateOnly: true,
    candidates: candidates.map((c) => ({
      artifactId: c.artifact.id,
      version: c.artifact.version,
      status: c.status,
      statusReason: c.statusReason,
      createdAt: c.artifact.created_at,
      sourceVoiceProfileId: c.assignment?.source.voiceProfileId ?? null,
      sourceVoiceProfileRevisionId: c.assignment?.source.voiceProfileRevisionId ?? null,
      canonicalAudioSha256: c.assignment?.source.canonicalAudioSha256 ?? null,
    })),
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
    const input = assignBodySchema.parse(body);
    const result = await buildProjectVoiceAssignment({
      projectId: id,
      voiceProfileId: input.voiceProfileId,
      voiceProfileRevisionId: input.voiceProfileRevisionId,
      requestId: input.requestId,
    });
    return Response.json(
      {
        artifactId: result.artifact.id,
        artifactVersion: result.artifact.version,
        status: result.reused ? 'reused' : 'created',
        candidateOnly: true,
        source: result.assignment.source,
      },
      {status: result.reused ? 200 : 201},
    );
  } catch (err) {
    return assignmentErrorResponse(err);
  }
}

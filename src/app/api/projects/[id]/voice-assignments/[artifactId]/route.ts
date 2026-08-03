/**
 * GET /api/projects/[id]/voice-assignments/[artifactId] — 单 assignment exact 读取。
 * exact GET 不 fallback；跨项目/不存在 → 404；分类状态 current_candidate/
 * stale_source/invalid_source 附 statusReason。不返回任何路径字段。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {
  classifyProjectVoiceAssignment,
  getProjectVoiceAssignment,
} from '@/lib/tts-b/assignment';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string; artifactId: string}>},
): Promise<Response> {
  const {id, artifactId} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');
  const ref = getProjectVoiceAssignment(id, artifactId);
  if (!ref) return jsonError(404, 'voice_assignment_not_found');
  const candidate = await classifyProjectVoiceAssignment(id, ref.artifact);
  return Response.json({
    artifactId: ref.artifact.id,
    version: ref.artifact.version,
    createdAt: ref.artifact.created_at,
    candidateOnly: true,
    status: candidate.status,
    statusReason: candidate.statusReason,
    schemaVersion: ref.assignment.schemaVersion,
    compilerVersion: ref.assignment.compilerVersion,
    projectId: ref.assignment.projectId,
    source: ref.assignment.source,
  });
}

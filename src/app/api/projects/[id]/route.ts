/** 删除模式：默认允许，?force=true 跳过 cors 预检（仅 DELETE 幂等，无安全差异）。 */
import { getDb } from '@/lib/db';
import { getProject, jsonError } from '../../_lib/shared';
import { deleteProject, ProjectDeleteError } from '@/lib/projects';

export const runtime = 'nodejs';

interface ArtifactMeta {
  id: string;
  kind: string;
  version: number;
  file_path: string | null;
  content_bytes: number | null;
  created_at: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  const artifacts = getDb()
    .prepare(
      `SELECT id, kind, version, file_path,
              LENGTH(content_json) AS content_bytes,
              created_at
       FROM artifacts
       WHERE project_id = ?
       ORDER BY kind ASC, version DESC`,
    )
    .all(id) as ArtifactMeta[];

  return Response.json({ project, artifacts });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    deleteProject(id);
    return Response.json({ deleted: true, projectId: id });
  } catch (err) {
    if (err instanceof ProjectDeleteError) {
      const status = err.code === 'PROJECT_NOT_FOUND' ? 404 : 409;
      return jsonError(status, err.code, { message: err.message });
    }
    return jsonError(500, 'delete_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

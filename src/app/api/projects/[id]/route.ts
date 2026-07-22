/**
 * GET /api/projects/[id] — 项目详情 + artifact 版本信息。
 * CONTRACT §5。artifact 不返回 content_json 正文，只给元信息 + 字节数。
 */
import { getDb } from '@/lib/db';
import { getProject, jsonError } from '../../_lib/shared';

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

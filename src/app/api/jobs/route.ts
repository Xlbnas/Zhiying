/**
 * GET /api/jobs — 全部 render job，按 queued_at 倒序。
 * 可选 query: ?project_id=xxx 过滤（便于项目页内查询，契约外增量，向后兼容）。
 * CONTRACT §5。
 */
import { getDb } from '@/lib/db';
import type { RenderJobRow } from '../_lib/shared';

export const runtime = 'nodejs';

export function GET(req: Request): Response {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('project_id');

  const db = getDb();
  const jobs = (
    projectId
      ? db
          .prepare(
            `SELECT * FROM render_jobs
             WHERE project_id = ?
             ORDER BY queued_at DESC`,
          )
          .all(projectId)
      : db
          .prepare('SELECT * FROM render_jobs ORDER BY queued_at DESC')
          .all()
  ) as RenderJobRow[];

  return Response.json({ jobs });
}

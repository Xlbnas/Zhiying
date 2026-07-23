/**
 * GET /api/projects — 项目列表（含每项目 render job 统计）。
 * POST /api/projects — M2-C 新建项目（projects + project_inputs + 10 stages 原子创建）。
 * CONTRACT §5。
 */
import { createProjectWithWorkflow } from '@/lib/projects';
import { getDb } from '@/lib/db';
import { jsonError, workflowErrorResponse } from '../_lib/shared';
import type { ProjectRow } from '../_lib/shared';

export const runtime = 'nodejs';

interface ProjectListRow extends ProjectRow {
  jobs_total: number;
  jobs_queued: number;
  jobs_running: number;
  jobs_succeeded: number;
  jobs_failed: number;
  jobs_cancelled: number;
  last_job_status: string | null;
  last_job_at: string | null;
  scene_count: number | null;
  duration_sec: number | null;
}

export function GET(): Response {
  const db = getDb();
  // scene_count / duration_sec 从最新 scenes artifact 的 JSON 中提取
  //（projects 表按契约不加列；scenes artifact 是唯一数据真相）
  const rows = db
    .prepare(
      `SELECT
         p.*,
         COUNT(j.id)                                                AS jobs_total,
         SUM(CASE WHEN j.status = 'queued'    THEN 1 ELSE 0 END)    AS jobs_queued,
         SUM(CASE WHEN j.status = 'running'   THEN 1 ELSE 0 END)    AS jobs_running,
         SUM(CASE WHEN j.status = 'succeeded' THEN 1 ELSE 0 END)    AS jobs_succeeded,
         SUM(CASE WHEN j.status = 'failed'    THEN 1 ELSE 0 END)    AS jobs_failed,
         SUM(CASE WHEN j.status = 'cancelled' THEN 1 ELSE 0 END)    AS jobs_cancelled,
         (
           SELECT j2.status FROM render_jobs j2
           WHERE j2.project_id = p.id
           ORDER BY j2.queued_at DESC LIMIT 1
         )                                                          AS last_job_status,
         MAX(j.queued_at)                                           AS last_job_at,
         json_extract(sa.content_json, '$.project.sceneCount')      AS scene_count,
         json_extract(sa.content_json, '$.project.durationSec')     AS duration_sec
       FROM projects p
       LEFT JOIN render_jobs j ON j.project_id = p.id
       LEFT JOIN artifacts sa ON sa.id = (
         SELECT a.id FROM artifacts a
         WHERE a.project_id = p.id AND a.kind = 'scenes'
         ORDER BY a.version DESC LIMIT 1
       )
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
    )
    .all() as ProjectListRow[];

  return Response.json({ projects: rows });
}

/**
 * POST /api/projects — 新建项目（M2-C）。
 * body: projectInputSchema（topic/coreQuestion 必填，其余高级字段有默认值）。
 * projects + project_inputs + 10 个 project_stages 单事务原子创建，
 * 返回 { project, inputs, stages }。
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', { message: '请求体不是合法 JSON' });
  }
  try {
    const result = createProjectWithWorkflow(body);
    return Response.json(result, { status: 201 });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    return jsonError(500, 'create_project_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

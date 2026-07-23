/**
 * GET /api/jobs — render jobs + llm jobs（M2-D §三十一），均按 queued_at 倒序。
 * 可选 query: ?project_id=xxx 过滤（契约外增量，向后兼容）。
 * llmJobs 附带最近一次 llm_usage 的 provider/model（能取得则显示）。
 * CONTRACT §5。
 */
import { getDb } from '@/lib/db';
import type { RenderJobRow } from '../_lib/shared';

export const runtime = 'nodejs';

interface LlmJobListRow {
  id: string;
  project_id: string;
  stage: string;
  status: string;
  attempt: number;
  max_attempts: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  provider: string | null;
  model: string | null;
}

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

  const llmJobs = (
    projectId
      ? db
          .prepare(
            `SELECT j.*,
               (SELECT u.provider FROM llm_usage u WHERE u.job_id = j.id ORDER BY u.created_at DESC LIMIT 1) AS provider,
               (SELECT u.model FROM llm_usage u WHERE u.job_id = j.id ORDER BY u.created_at DESC LIMIT 1) AS model
             FROM llm_jobs j
             WHERE j.project_id = ?
             ORDER BY j.queued_at DESC`,
          )
          .all(projectId)
      : db
          .prepare(
            `SELECT j.*,
               (SELECT u.provider FROM llm_usage u WHERE u.job_id = j.id ORDER BY u.created_at DESC LIMIT 1) AS provider,
               (SELECT u.model FROM llm_usage u WHERE u.job_id = j.id ORDER BY u.created_at DESC LIMIT 1) AS model
             FROM llm_jobs j
             ORDER BY j.queued_at DESC`,
          )
          .all()
  ) as LlmJobListRow[];

  return Response.json({ jobs, llmJobs });
}

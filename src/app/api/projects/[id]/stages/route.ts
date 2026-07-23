/**
 * GET /api/projects/[id]/stages — 10 阶段状态 + active/locked version +
 * 每阶段最近 llm_job + 项目输入 + legacy M1 判定（M2-C §十六）。
 */
import { getDb } from '@/lib/db';
import { getProjectInput } from '@/lib/project-inputs';
import { isLegacyM1Project } from '@/lib/projects';
import { listStages } from '@/lib/workflow/stages';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

interface LlmJobSummary {
  id: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempt: number;
  queued_at: string;
  finished_at: string | null;
}

export function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handle(params);
}

async function handle(params: Promise<{ id: string }>): Promise<Response> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  const legacy = isLegacyM1Project(id);
  const db = getDb();
  const stages = listStages(id).map((row) => {
    const latest = db
      .prepare(
        `SELECT id, status, error_code, error_message, attempt, queued_at, finished_at
         FROM llm_jobs WHERE project_id = ? AND stage = ?
         ORDER BY queued_at DESC LIMIT 1`,
      )
      .get(id, row.stage) as LlmJobSummary | undefined;
    const active = db
      .prepare(
        `SELECT id, status FROM llm_jobs
         WHERE project_id = ? AND stage = ? AND status IN ('queued', 'running')
         ORDER BY queued_at ASC LIMIT 1`,
      )
      .get(id, row.stage) as { id: string; status: string } | undefined;
    return { ...row, latestJob: latest ?? null, activeJob: active ?? null };
  });

  let inputs = null;
  try {
    inputs = getProjectInput(id);
  } catch {
    // project_inputs 损坏时不拖垮整个页面：按缺失返回（问题在读取时已显式抛错记录）
    inputs = null;
  }

  const scenesArtifact = db
    .prepare(
      `SELECT id FROM artifacts WHERE project_id = ? AND kind = 'scenes'
       ORDER BY version DESC LIMIT 1`,
    )
    .get(id) as { id: string } | undefined;

  return Response.json({
    project,
    stages,
    inputs,
    legacy,
    hasScenesArtifact: scenesArtifact !== undefined,
  });
}

/**
 * GET  /api/projects/[id]/narration-plan — Narration readiness + 当前 plan
 * POST /api/projects/[id]/narration-plan — 构建/复用 Narration Plan（M3-A §二十二）
 */
import {
  buildNarrationPlan,
  checkNarrationReadiness,
  NarrationPlanError,
} from '@/lib/narration/plan';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

function narrationErrorResponse(err: unknown): Response {
  if (err instanceof NarrationPlanError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' || err.code === 'SCRIPT_V2_VERSION_NOT_FOUND'
        ? 404
        : err.code === 'SCRIPT_V2_INVALID' || err.code === 'NARRATION_PLAN_INVALID'
          ? 422
          : 409;
    return jsonError(status, err.code, { message: err.message });
  }
  throw err;
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
  const readiness = checkNarrationReadiness(id);
  return Response.json(readiness);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  try {
    const { plan, artifact, reused } = await Promise.resolve().then(() =>
      buildNarrationPlan(id),
    );
    return Response.json(
      {
        plan,
        artifactVersion: artifact.version,
        reused,
      },
      { status: reused ? 200 : 201 },
    );
  } catch (err) {
    return narrationErrorResponse(err);
  }
}

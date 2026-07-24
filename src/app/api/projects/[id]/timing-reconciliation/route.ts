/**
 * GET  /api/projects/[id]/timing-reconciliation — readiness（not_ready/missing/ready/stale）
 * POST /api/projects/[id]/timing-reconciliation — 同步 deterministic build / 幂等 reuse
 *
 * M3-D：source 三件套（locked Scenes + current Narration Audio + current
 * Subtitle Timing）全部 current 才允许 build；纯 CPU，无 Worker、无 job queue。
 */
import {
  buildTimingReconciliation,
  checkTimingReconciliationReadiness,
  TimingReconciliationError,
} from '@/lib/reconciliation/timing';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

function reconciliationErrorResponse(err: unknown): Response {
  if (err instanceof TimingReconciliationError) {
    const status = err.code === 'PROJECT_NOT_FOUND' ? 404 : 409;
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
  return Response.json(checkTimingReconciliationReadiness(id));
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
    const result = buildTimingReconciliation(id);
    return Response.json(
      { ...result, readiness: checkTimingReconciliationReadiness(id) },
      { status: result.reused ? 200 : 201 },
    );
  } catch (err) {
    return reconciliationErrorResponse(err);
  }
}

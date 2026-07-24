/**
 * GET  /api/projects/[id]/final-render — Final Render readiness + playerPreviewProps
 * POST /api/projects/[id]/final-render — 原子 enqueue Final Render（M3-E）
 *
 * playerPreviewProps.audio.narration 恒为 null（browser Player 无法访问
 * worker bundle runtime 资产），仅供 UI 预览，不是 render source canonical props。
 */
import {
  checkFinalRenderReadiness,
  enqueueFinalRender,
  FinalRenderError,
} from '@/lib/final-render/bridge';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

function finalRenderErrorResponse(err: unknown): Response {
  if (err instanceof FinalRenderError) {
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
  return Response.json(checkFinalRenderReadiness(id));
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
    const result = enqueueFinalRender(id);
    return Response.json(
      {
        job: result.job,
        sourceArtifact: result.sourceArtifact,
        sourceReused: result.sourceReused,
        readiness: checkFinalRenderReadiness(id),
      },
      { status: 201 },
    );
  } catch (err) {
    return finalRenderErrorResponse(err);
  }
}

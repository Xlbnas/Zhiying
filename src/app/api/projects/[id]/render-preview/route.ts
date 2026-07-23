/**
 * GET  /api/projects/[id]/render-preview — Workflow Visual Preview readiness + props
 * POST /api/projects/[id]/render-preview — 人工触发 Visual Preview Render（M2-E-C）
 *
 * 只服务 workflow 项目；Legacy M1 项目继续走 /api/projects/[id]/render 原链路。
 * Visual Preview：audio=null、subtitles=[]、showSubtitles=false（kind='no-subtitles'）。
 * 不自动 render；POST 的 readiness 在单事务内重新校验（authoritative fence）。
 */
import {
  buildWorkflowRenderProps,
  checkWorkflowRenderReadiness,
  enqueueWorkflowPreviewRender,
  RenderBridgeError,
} from '@/lib/workflow/render-bridge';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

function bridgeErrorResponse(err: unknown): Response {
  if (err instanceof RenderBridgeError) {
    const status =
      err.code === 'PROJECT_NOT_FOUND' || err.code === 'SCENES_VERSION_NOT_FOUND'
        ? 404
        : err.code === 'RENDER_SOURCE_INVALID' ||
            err.code === 'UNSUPPORTED_TEMPLATE' ||
            err.code === 'ASSET_FILE_MISSING'
          ? 422
          : 409;
    return jsonError(status, err.code, { message: err.message, ...(err.detail ?? {}) });
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
  try {
    const readiness = checkWorkflowRenderReadiness(id);
    if (!readiness.ready) {
      return Response.json({
        ready: false,
        blockers: readiness.blockers,
        scenesVersion: readiness.scenesVersion,
        props: null,
      });
    }
    const { props, scenesVersion } = buildWorkflowRenderProps(id);
    return Response.json({
      ready: true,
      blockers: [],
      scenesVersion,
      props,
    });
  } catch (err) {
    return bridgeErrorResponse(err);
  }
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
    const { job, scenesVersion } = enqueueWorkflowPreviewRender(id);
    return Response.json({ job, source: { scenesVersion } }, { status: 201 });
  } catch (err) {
    return bridgeErrorResponse(err);
  }
}

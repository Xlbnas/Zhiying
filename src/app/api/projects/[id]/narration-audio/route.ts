/**
 * GET  /api/projects/[id]/narration-audio — Narration Audio overview（含 lazy finalize）
 * POST /api/projects/[id]/narration-audio — 为当前 Narration Plan 全部 speech units 入队
 *
 * Plan 必须 current（ready）；重复 POST 幂等（同 plan+unit+provider+voice 去重）。
 * Route 不同步调用 TTS Provider——实际合成由 Worker 执行。
 */
import {
  enqueueNarrationAudioJobs,
  getNarrationAudioOverview,
  NarrationAudioError,
  tryFinalizeNarrationAudio,
} from '@/lib/narration/audio';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

function audioErrorResponse(err: unknown): Response {
  if (err instanceof NarrationAudioError) {
    const status = err.code === 'PROJECT_NOT_FOUND' ? 404 : 409;
    return jsonError(status, err.code, { message: err.message });
  }
  throw err;
}

/** lazy finalize 的安全包装：snapshot 冲突等契约错误 → 409，不 500。 */
function tryFinalizeSafely(id: string): Response | null {
  try {
    tryFinalizeNarrationAudio(id);
    return null;
  } catch (err) {
    return audioErrorResponse(err);
  }
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
  // lazy finalize：全部 speech 完成但 manifest 未生成时补齐
  const overview = getNarrationAudioOverview(id);
  if (overview.status === 'not_ready') {
    const errRes = tryFinalizeSafely(id);
    if (errRes) return errRes;
    return Response.json(getNarrationAudioOverview(id));
  }
  return Response.json(overview);
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
    const result = enqueueNarrationAudioJobs(id);
    // 全部已复用且已完成时尝试 finalize（无新 job 需要跑的情况）
    if (result.enqueued === 0) {
      const errRes = tryFinalizeSafely(id);
      if (errRes) return errRes;
    }
    return Response.json(
      { ...result, overview: getNarrationAudioOverview(id) },
      { status: 202 },
    );
  } catch (err) {
    return audioErrorResponse(err);
  }
}

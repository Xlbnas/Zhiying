/**
 * GET  /api/projects/[id]/subtitle-timing — Subtitle Timing readiness（missing/not_ready/ready/stale）
 * POST /api/projects/[id]/subtitle-timing — 同步 deterministic build / 幂等 reuse
 *
 * M3-C：source 只允许 current Narration Audio Manifest；不调用 Worker、无 job queue。
 * GET ?format=srt 返回 SRT 派生文本（非 source of truth，不落库）。
 */
import {formatSubtitleTimingAsSrt} from '@/lib/subtitles/renderer';
import {
  buildSubtitleTiming,
  checkSubtitleTimingReadiness,
  SubtitleTimingError,
} from '@/lib/subtitles/timing';
import { getProject, jsonError } from '../../../_lib/shared';

export const runtime = 'nodejs';

function subtitleErrorResponse(err: unknown): Response {
  if (err instanceof SubtitleTimingError) {
    const status = err.code === 'PROJECT_NOT_FOUND' ? 404 : 409;
    return jsonError(status, err.code, { message: err.message });
  }
  throw err;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  const readiness = checkSubtitleTimingReadiness(id);
  const format = new URL(req.url).searchParams.get('format');
  if (format === 'srt') {
    if (readiness.status !== 'ready' || !readiness.timing) {
      return jsonError(409, 'SUBTITLE_TIMING_NOT_READY', {
        message: `Subtitle Timing 当前 ${readiness.status}，无法导出 SRT`,
      });
    }
    return new Response(formatSubtitleTimingAsSrt(readiness.timing), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
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
    const result = buildSubtitleTiming(id);
    return Response.json(
      { ...result, readiness: checkSubtitleTimingReadiness(id) },
      { status: result.reused ? 200 : 201 },
    );
  } catch (err) {
    return subtitleErrorResponse(err);
  }
}

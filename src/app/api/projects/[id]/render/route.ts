/**
 * POST /api/projects/[id]/render — 入队渲染任务。
 * body: { kind?: 'fullcut' | 'no-subtitles' }（默认 fullcut）。
 * 组装 ZhiyingFullCutProps payload 后调 enqueueRenderJob（CONTRACT §3 签名）。
 * CONTRACT §5。
 */
import { enqueueRenderJob } from '@/lib/jobs';
import {
  buildFullCutProps,
  getProject,
  jsonError,
} from '../../../_lib/shared';

export const runtime = 'nodejs';

const RENDER_KINDS = ['fullcut', 'no-subtitles'] as const;
type RenderKind = (typeof RENDER_KINDS)[number];

function isRenderKind(value: unknown): value is RenderKind {
  return (
    typeof value === 'string' &&
    (RENDER_KINDS as readonly string[]).includes(value)
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let body: unknown = {};
  try {
    // body 可空（空体视为默认 kind）
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return jsonError(400, 'invalid_json', {
      message: '请求体不是合法 JSON',
    });
  }

  const kindRaw =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).kind
      : undefined;
  const kindInput: unknown = kindRaw === undefined ? 'fullcut' : kindRaw;
  if (!isRenderKind(kindInput)) {
    return jsonError(422, 'invalid_kind', {
      message: `kind 必须是 ${RENDER_KINDS.join(' | ')}`,
    });
  }
  const kind: RenderKind = kindInput;

  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  const payload = buildFullCutProps(id, {
    showSubtitles: kind === 'fullcut',
  });
  if (!payload) {
    return jsonError(409, 'scenes_not_ready', {
      message: '项目缺少 scenes artifact，无法渲染',
    });
  }

  try {
    // CONTRACT §3：enqueueRenderJob(projectId, kind, payload)
    const job = enqueueRenderJob(id, kind, payload);
    return Response.json({ job }, { status: 201 });
  } catch (err) {
    return jsonError(500, 'enqueue_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

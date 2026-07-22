/**
 * GET /api/projects/[id]/scenes — 当前 scenes + subtitles + audio。
 * 返回完整 ZhiyingFullCutProps JSON，供 @remotion/player 的 inputProps。
 * CONTRACT §5。
 */
import {
  buildFullCutProps,
  getProject,
  jsonError,
} from '../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  const props = buildFullCutProps(id, { showSubtitles: true });
  if (!props) {
    return jsonError(404, 'scenes_not_found', {
      message: '项目缺少 scenes artifact 或内容无法解析',
    });
  }

  return Response.json(props);
}

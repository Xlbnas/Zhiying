/**
 * POST /api/projects/[id]/assets/revert-mg — 「改回素材」：删除 scene 的 MG override。
 *
 * M6.3.13：删 override 后该 scene 的 requirements 回到 pending 并重新计入
 * readiness 分母；旧 bindings 是历史（active=0），不自动恢复——用户需重新准备素材。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {deleteVisualOverride, getVisualOverride} from '@/lib/scenes/visual-overrides';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId?: string};
  try { body = await req.json() as typeof body; } catch { return jsonError(400, 'invalid_json'); }
  if (!body.sceneId) return jsonError(400, 'missing_fields', {message: '需要 sceneId'});

  const existing = getVisualOverride(id, body.sceneId);
  if (!existing) {
    return jsonError(404, 'override_not_found', {message: `场景 ${body.sceneId} 没有 MG override`});
  }
  deleteVisualOverride(id, body.sceneId);

  return Response.json({
    sceneId: body.sceneId,
    reverted: true,
    note: '已改回素材画面。原素材绑定已停用且不会自动恢复，请重新准备素材。',
  });
}

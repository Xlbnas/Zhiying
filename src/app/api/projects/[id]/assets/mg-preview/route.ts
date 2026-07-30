/**
 * POST /api/projects/[id]/assets/mg-preview — 「改用 MG」预览。
 *
 * M6.3.13：body {sceneId} → eligibility（authenticity 闸门）→ deterministic 选模板 +
 * 从 scene 的 narrationSummary/description 构建 templateProps（v1 不接 LLM，
 * web 容器无 DEEPSEEK key）→ validateTemplateProps 通过才返回
 * {sceneId, template, templateProps}；构建不出合法 props → 409。
 * 不落库（确认走 switch-to-mg）。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {buildSceneAssetPlan} from '@/lib/assets/requirements';
import {
  buildMgPreviewProps,
  canSwitchToMg,
  isSceneVisuallyOverridden,
  loadCurrentScenes,
} from '@/lib/scenes/visual-overrides';

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

  const current = loadCurrentScenes(id);
  if (!current) return jsonError(404, 'scenes_not_found', {message: '项目缺少 scenes artifact'});
  const scene = current.scenes.find((s) => s.id === body.sceneId);
  if (!scene) {
    return jsonError(404, 'scene_not_found', {message: `场景 ${body.sceneId} 不存在`});
  }

  const plan = buildSceneAssetPlan(scene);
  if (!plan.needsAssets) {
    return jsonError(409, 'not_asset_scene', {message: '该镜头无需外部素材（已是模板/排版画面）'});
  }
  if (isSceneVisuallyOverridden(id, body.sceneId)) {
    return jsonError(409, 'scene_overridden', {message: '该镜头已改用 MG 模板'});
  }
  const eligibility = canSwitchToMg(plan);
  if (!eligibility.ok) {
    return jsonError(409, 'mg_switch_not_allowed', {message: eligibility.reason});
  }

  const built = buildMgPreviewProps(scene);
  if (!built) {
    return jsonError(409, 'mg_preview_failed', {message: '无法为该镜头构建合法的 MG 画面参数'});
  }
  return Response.json({sceneId: body.sceneId, template: built.template, templateProps: built.templateProps});
}

/**
 * POST /api/projects/[id]/assets/switch-to-mg — 确认「改用 MG」（authoritative override）。
 *
 * M6.3.13：body {sceneId, template, templateProps} → 服务端重跑 eligibility +
 * validateTemplateProps（不信客户端）→ 单事务：upsert override（含当前 locked
 * scenes 版本行 id）+ 该 scene 全部 requirements deactivate binding（历史保留）
 * + clearResolutionState。不编辑 scenes artifact（whole-generation invariant）。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {buildSceneAssetPlan} from '@/lib/assets/requirements';
import {validateTemplateProps} from '@/lib/scenes/mg-templates';
import {
  canSwitchToMg,
  loadCurrentScenes,
  switchSceneToMg,
} from '@/lib/scenes/visual-overrides';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId?: string; template?: string; templateProps?: Record<string, unknown>};
  try { body = await req.json() as typeof body; } catch { return jsonError(400, 'invalid_json'); }
  if (!body.sceneId || !body.template || !body.templateProps || typeof body.templateProps !== 'object') {
    return jsonError(400, 'missing_fields', {message: '需要 sceneId、template 和 templateProps'});
  }

  const current = loadCurrentScenes(id);
  if (!current) return jsonError(404, 'scenes_not_found', {message: '项目缺少 scenes artifact'});
  const scene = current.scenes.find((s) => s.id === body.sceneId);
  if (!scene) {
    return jsonError(404, 'scene_not_found', {message: `场景 ${body.sceneId} 不存在`});
  }

  // 服务端重跑 eligibility（不信客户端预览结果）
  const plan = buildSceneAssetPlan(scene);
  if (!plan.needsAssets) {
    return jsonError(409, 'not_asset_scene', {message: '该镜头无需外部素材（已是模板/排版画面）'});
  }
  const eligibility = canSwitchToMg(plan);
  if (!eligibility.ok) {
    return jsonError(409, 'mg_switch_not_allowed', {message: eligibility.reason});
  }
  const propsCheck = validateTemplateProps(body.template, body.templateProps);
  if (!propsCheck.ok) {
    return jsonError(400, 'invalid_template_props', {message: propsCheck.message});
  }

  switchSceneToMg({
    projectId: id,
    sceneId: body.sceneId,
    scenesVersionId: current.versionId,
    template: body.template,
    templateProps: body.templateProps,
    requirements: plan.requirements,
  });

  return Response.json({sceneId: body.sceneId, template: body.template, switched: true});
}

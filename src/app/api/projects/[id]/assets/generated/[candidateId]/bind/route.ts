/**
 * POST /api/projects/[id]/assets/generated/[candidateId]/bind
 * 确认使用生成的 candidate，绑定到 exact scene + requirement（M6.3.8）。
 *
 * 安全：candidate 跨 requirement / 跨 scene 绑定一律 reject（见 lib/assets/bind.ts）。
 */
import {BindError, bindGeneratedCandidate} from '@/lib/assets/bind';
import {getProject, jsonError} from '../../../../../../_lib/shared';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string; candidateId: string}>},
): Promise<Response> {
  const {id, candidateId} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId?: string; requirementId?: string} | null = null;
  try { body = await req.json() as {sceneId?: string; requirementId?: string}; } catch { /* ok */ }

  if (!body?.sceneId || !body?.requirementId) {
    return jsonError(400, 'missing_fields', {message: '需要 sceneId 和 requirementId 以完成 exact 绑定'});
  }

  try {
    const {binding, asset, legacyProvenance} = bindGeneratedCandidate({
      projectId: id,
      candidateId,
      sceneId: body.sceneId,
      requirementId: body.requirementId,
    });
    return Response.json({
      bound: true,
      assetId: candidateId,
      sceneId: binding.scene_id,
      requirementId: binding.requirement_id,
      bindingId: binding.id,
      licenseStatus: asset.license_status,
      legacyProvenance,
    });
  } catch (err) {
    if (err instanceof BindError) {
      return jsonError(err.httpStatus, err.code, {message: err.message});
    }
    throw err;
  }
}

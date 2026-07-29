/**
 * GET /api/projects/[id]/assets/resolve — 计算每 scene 的素材解析状态和可用动作。
 * POST /api/projects/[id]/assets/resolve — 触发素材获取。
 *
 * M6.3 Asset Resolver。
 * M6.3.8：POST 支持可选 body {sceneId, requirementId} = 单 requirement 定向重新搜索；
 * 无 body = 全项目获取（跳过已有 active binding 的 requirement）。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {getDb} from '@/lib/db';
import {buildProjectResolution} from '@/lib/assets/resolver';
import {getGeneratedImageProvider} from '@/lib/assets/providers/generated';
import type {Scene} from '@/lib/scene-schema';
import {acquireAssetsForProject, acquireAssetsForRequirement} from '@/lib/assets/acquire';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  const row = getDb()
    .prepare("SELECT content FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1")
    .get(id) as {content: string} | undefined;

  if (!row?.content) {
    return Response.json({resolutions: [], reason: 'scenes not found'});
  }

  let scenesObj: Record<string, unknown>;
  try { scenesObj = JSON.parse(row.content) as Record<string, unknown>; } catch {
    return Response.json({resolutions: [], reason: 'scenes parse error'});
  }

  const scenes = (scenesObj.scenes ?? []) as Scene[];
  // M6.3.9：能力闸门 —— generate action = 语义 eligible AND provider 可用（health 内部 5min 缓存）
  const health = await getGeneratedImageProvider().checkHealth();
  const resolutions = buildProjectResolution(id, scenes, {
    generateProviderAvailable: health.available && health.healthy,
  });

  return Response.json({resolutions});
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId?: string; requirementId?: string} | null = null;
  try { body = await req.json() as {sceneId?: string; requirementId?: string}; } catch { /* 无 body = 全量 */ }

  try {
    // 单 requirement 定向获取（exact sceneId + requirementId）
    if (body?.sceneId && body?.requirementId) {
      const result = await acquireAssetsForRequirement(id, body.sceneId, body.requirementId);
      if (result.status === 'failed' && result.reason?.includes('不存在')) {
        return jsonError(400, 'requirement_not_found', {message: result.reason});
      }
      return Response.json(result, {status: 202});
    }
    // 全量 acquire（跳过已有 active binding 的 requirement）
    const summary = await acquireAssetsForProject(id);
    return Response.json(summary, {status: 202});
  } catch (err) {
    return jsonError(500, 'resolve_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

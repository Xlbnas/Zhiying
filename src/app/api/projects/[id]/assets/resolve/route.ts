/**
 * GET /api/projects/[id]/assets/resolve — 计算每 scene 的素材解析状态和可用动作。
 * POST /api/projects/[id]/assets/resolve — 执行单个解析动作（search/generate/select）。
 *
 * M6.3 Asset Resolver。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {getDb} from '@/lib/db';
import {buildProjectResolution} from '@/lib/assets/resolver';
import type {Scene} from '@/lib/scene-schema';
import {acquireAssetsForProject} from '@/lib/assets/acquire';

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
  const resolutions = buildProjectResolution(id, scenes);

  return Response.json({resolutions});
}

export async function POST(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  // POST 触发全量 acquire（复用现有逻辑：跳过已 ready，仅处理 pending/blocked）
  try {
    const summary = await acquireAssetsForProject(id);
    return Response.json(summary, {status: 202});
  } catch (err) {
    return jsonError(500, 'resolve_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

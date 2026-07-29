/**
 * GET  /api/projects/[id]/assets — 获取项目素材状态
 * POST /api/projects/[id]/assets — 触发素材获取
 *
 * M6：用户可见的"准备素材"入口。
 */
import {getProject, jsonError} from '../../../_lib/shared';
import {acquireAssetsForProject} from '@/lib/assets/acquire';
import {evaluateVisualReadiness} from '@/lib/assets/readiness';
import {getDb} from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  // 读取 locked scenes
  const row = getDb()
    .prepare(
      `SELECT content FROM project_versions
       WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
    )
    .get(id) as {content: string} | undefined;

  if (!row || !row.content) {
    return Response.json({ready: false, reason: 'scenes 尚未生成', total: 0, noAssetNeeded: 0, needAssets: 0, readyScenes: 0, missing: [], assets: []});
  }

  let scenesObj: Record<string, unknown>;
  try {
    scenesObj = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    return Response.json({ready: false, reason: 'scenes 数据无法解析', total: 0, noAssetNeeded: 0, needAssets: 0, readyScenes: 0, missing: [], assets: []});
  }

  const visual = evaluateVisualReadiness(id, (scenesObj.scenes ?? []) as Parameters<typeof evaluateVisualReadiness>[1]);
  const assetRows = getDb()
    .prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC')
    .all(id);

  return Response.json({
    ready: visual.ready,
    total: visual.total,
    noAssetNeeded: visual.noAssetNeeded,
    needAssets: visual.needAssets,
    readyScenes: visual.readyScenes,
    readyAssetScenes: visual.readyAssetScenes,
    pendingAssets: visual.pendingAssets,
    missing: visual.missing,
    assets: assetRows,
  });
}

export async function POST(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  try {
    const summary = await acquireAssetsForProject(id);
    return Response.json(summary, {status: 201});
  } catch (err) {
    return jsonError(500, 'acquire_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

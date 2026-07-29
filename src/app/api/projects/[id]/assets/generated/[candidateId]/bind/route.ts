/**
 * POST /api/projects/[id]/assets/generated/[candidateId]/bind — 确认使用生成的 candidate，绑定到 scene/requirement。
 */
import {getDb} from '@/lib/db';
import {getProject, jsonError} from '../../../../../../_lib/shared';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string; candidateId: string}>},
): Promise<Response> {
  const {id, candidateId} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId: string} | null = null;
  try { body = await req.json() as {sceneId: string}; } catch { /* ok */ }

  const db = getDb();
  const asset = db.prepare('SELECT id, project_id, scene_id, source_type, license_status, license_note, local_path, requirement_json FROM assets WHERE id = ? AND project_id = ?').get(candidateId, id) as {
    id: string; project_id: string; scene_id: string | null; source_type: string;
    license_status: string; license_note: string | null; local_path: string; requirement_json: string | null;
  } | undefined;

  if (!asset) return jsonError(404, 'candidate_not_found', {message: '候选素材不存在'});
  if (asset.source_type !== 'generated') return jsonError(400, 'not_generated_candidate', {message: '只能绑定 AI 生成的候选素材'});
  if (asset.scene_id !== null && !body?.sceneId) return jsonError(400, 'already_bound', {message: '该候选素材已绑定到场景'});

  const sceneId = body?.sceneId || asset.scene_id;
  if (!sceneId) return jsonError(400, 'missing_scene_id', {message: '需要提供 sceneId 以完成绑定'});

  // Verify scene exists for this project
  const hasScene = db.prepare("SELECT 1 FROM project_versions WHERE project_id = ? AND stage = 'scenes' AND content LIKE ?").get(id, `%${sceneId}%`);
  if (!hasScene) return jsonError(400, 'invalid_scene', {message: `场景 ${sceneId} 不存在于此项目`});

  // Update: set scene_id, mark as generated license, bind
  db.prepare('UPDATE assets SET scene_id = ?, license_status = ?, license_note = ? WHERE id = ?')
    .run(sceneId, 'generated', asset.license_note?.replace('(待确认)', '') ?? 'AI 生成', candidateId);

  return Response.json({
    bound: true,
    assetId: candidateId,
    sceneId,
    licenseStatus: 'generated',
  });
}

/**
 * GET /api/projects/[id]/narration-audio/master — narration master WAV 下载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb } from '@/lib/db';
import { getProject, jsonError } from '../../../../_lib/shared';

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
  const row = getDb()
    .prepare(
      `SELECT content_json FROM artifacts
       WHERE project_id = ? AND kind = 'narration_audio_manifest'
       ORDER BY version DESC LIMIT 1`,
    )
    .get(id) as { content_json: string } | undefined;
  if (!row) {
    return jsonError(404, 'audio_not_found', { message: '尚无 narration master' });
  }
  let masterPath: string | null = null;
  try {
    const parsed = JSON.parse(row.content_json) as { master?: { filePath?: string } };
    masterPath = parsed.master?.filePath ?? null;
  } catch {
    masterPath = null;
  }
  if (!masterPath) {
    return jsonError(404, 'audio_not_found', { message: 'manifest 无 master 路径' });
  }
  const dataDir = path.resolve(getDataDir());
  const abs = path.resolve(dataDir, masterPath);
  if (!abs.startsWith(dataDir + path.sep) || !fs.existsSync(abs)) {
    return jsonError(404, 'audio_not_found', { message: '音频文件不存在或路径非法' });
  }
  return new Response(fs.readFileSync(abs), {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(fs.statSync(abs).size),
      'Cache-Control': 'no-store',
    },
  });
}

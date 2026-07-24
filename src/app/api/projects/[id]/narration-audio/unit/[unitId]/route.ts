/**
 * GET /api/projects/[id]/narration-audio/unit/[unitId] — 单句音频下载（路径安全）。
 * 只允许读取 tts_jobs 记录中的成功 output_path，且必须位于 data 目录内。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb } from '@/lib/db';
import { getProject, jsonError } from '../../../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; unitId: string }> },
): Promise<Response> {
  const { id, unitId } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  if (!/^N\d{3}$/.test(unitId)) {
    return jsonError(422, 'invalid_unit_id', { message: `非法 unit id: ${unitId}` });
  }
  const job = getDb()
    .prepare(
      `SELECT output_path FROM tts_jobs
       WHERE project_id = ? AND unit_id = ? AND status = 'succeeded'
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(id, unitId) as { output_path: string | null } | undefined;
  if (!job?.output_path) {
    return jsonError(404, 'audio_not_found', { message: `${unitId} 尚无成功音频` });
  }
  const dataDir = path.resolve(getDataDir());
  const abs = path.resolve(dataDir, job.output_path);
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

/**
 * GET  /api/voice-profiles — Voice Profile 列表（可选 ?status=active|archived 过滤）
 * POST /api/voice-profiles — 创建 Profile（strict JSON：{displayName, description?}）
 *
 * TTS-A Voice Library（设计文档 §6）。响应绝不包含任何文件路径。
 */
import {z} from 'zod';
import {createVoiceProfileBodySchema, serializeProfile} from '@/lib/voice-library/types';
import {createVoiceProfile, listVoiceProfiles} from '@/lib/voice-library/profiles';
import {jsonError} from '../_lib/shared';
import {voiceLibraryErrorResponse} from './_lib';

export const runtime = 'nodejs';

const statusQuerySchema = z.enum(['active', 'archived']);

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const statusRaw = url.searchParams.get('status');
  if (statusRaw !== null && !statusQuerySchema.safeParse(statusRaw).success) {
    return jsonError(422, 'invalid_request', {message: "status 仅支持 'active' | 'archived'"});
  }
  const rows = listVoiceProfiles({
    status: statusRaw === null ? undefined : (statusRaw as 'active' | 'archived'),
  });
  return Response.json({profiles: rows.map(serializeProfile)});
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', {message: '请求体不是合法 JSON'});
  }
  try {
    const input = createVoiceProfileBodySchema.parse(body);
    const row = createVoiceProfile(input);
    return Response.json({profile: serializeProfile(row)}, {status: 201});
  } catch (err) {
    return voiceLibraryErrorResponse(err);
  }
}

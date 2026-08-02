/**
 * GET  /api/voice-profiles/[profileId]/revisions — revision 列表（revision_number 升序）
 * POST /api/voice-profiles/[profileId]/revisions — multipart 摄取（设计文档 §4）
 *      字段：requestId（必填）、audio（必填 File）、transcript/language（可选）
 *
 * 幂等：同 requestId + 同 fingerprint → 200 reused；同 requestId 异内容 → 409；
 * 同 Profile 相同 canonical hash → 409 duplicate_audio。
 */
import {getVoiceProfile} from '@/lib/voice-library/profiles';
import {
  ingestVoiceProfileRevision,
  listVoiceProfileRevisions,
} from '@/lib/voice-library/revisions';
import {
  MAX_REFERENCE_UPLOAD_BYTES,
  REQUEST_ID_MAX,
} from '@/lib/voice-library/constants';
import {serializeRevision} from '@/lib/voice-library/types';
import {jsonError} from '../../../_lib/shared';
import {voiceLibraryErrorResponse} from '../../_lib';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{profileId: string}>},
): Promise<Response> {
  const {profileId} = await params;
  const profile = getVoiceProfile(profileId);
  if (!profile) return jsonError(404, 'profile_not_found');
  const rows = listVoiceProfileRevisions(profileId);
  return Response.json({revisions: rows.map(serializeRevision)});
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{profileId: string}>},
): Promise<Response> {
  const {profileId} = await params;
  const profile = getVoiceProfile(profileId);
  if (!profile) return jsonError(404, 'profile_not_found');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'invalid_formdata', {message: '请求体不是合法 multipart/form-data'});
  }

  const requestId = form.get('requestId');
  const audio = form.get('audio');
  const transcript = form.get('transcript');
  const language = form.get('language');

  if (typeof requestId !== 'string' || requestId.trim().length === 0 || requestId.length > REQUEST_ID_MAX) {
    return jsonError(422, 'invalid_request', {
      message: `requestId 必填（非空字符串，长度 <= ${REQUEST_ID_MAX}）`,
    });
  }
  if (!(audio instanceof File)) {
    return jsonError(422, 'invalid_request', {message: '缺少音频文件字段 audio'});
  }
  // file.size 早判；内容权威判定在摄取管线内（ffprobe，不信任 MIME/扩展名）
  if (audio.size > MAX_REFERENCE_UPLOAD_BYTES) {
    return jsonError(413, 'file_too_large', {
      message: `音频大小 ${(audio.size / 1024 / 1024).toFixed(1)}MB 超过上限 25MB`,
    });
  }
  if (transcript !== null && typeof transcript !== 'string') {
    return jsonError(422, 'invalid_request', {message: 'transcript 必须为字符串'});
  }
  if (language !== null && typeof language !== 'string') {
    return jsonError(422, 'invalid_request', {message: 'language 必须为字符串'});
  }

  try {
    const buffer = Buffer.from(await audio.arrayBuffer());
    const result = await ingestVoiceProfileRevision({
      voiceProfileId: profileId,
      requestId,
      audioBuffer: buffer,
      originalFilename: audio.name || null,
      transcript: typeof transcript === 'string' ? transcript : null,
      language: typeof language === 'string' ? language : null,
    });
    return Response.json(
      {outcome: result.outcome, revision: serializeRevision(result.revision)},
      {status: result.status},
    );
  } catch (err) {
    return voiceLibraryErrorResponse(err);
  }
}

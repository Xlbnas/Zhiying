/**
 * GET   /api/voice-profiles/[profileId] — Profile 详情 + suggestedLatestForDisplay
 * PATCH /api/voice-profiles/[profileId] — 仅 {status: 'active'|'archived'}（strict）
 *
 * suggestedLatestForDisplay 只是 UI 显示建议（revision_number 最大的 revision 概要），
 * 不是 current/selected/activeRevision/defaultRevision——选择语义由未来 TTS-B/C 决定。
 */
import {ZodError} from 'zod';
import {getVoiceProfile, setVoiceProfileStatus} from '@/lib/voice-library/profiles';
import {listVoiceProfileRevisions} from '@/lib/voice-library/revisions';
import {
  patchVoiceProfileBodySchema,
  serializeProfile,
  serializeRevision,
  VoiceLibraryError,
} from '@/lib/voice-library/types';
import {jsonError} from '../../_lib/shared';
import {voiceLibraryErrorResponse} from '../_lib';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{profileId: string}>},
): Promise<Response> {
  const {profileId} = await params;
  const profile = getVoiceProfile(profileId);
  if (!profile) return jsonError(404, 'profile_not_found');
  const revisions = listVoiceProfileRevisions(profileId);
  const latest = revisions.length > 0 ? revisions[revisions.length - 1] : null;
  return Response.json({
    profile: serializeProfile(profile),
    revisionCount: revisions.length,
    // 仅供 UI 显示建议——不是 current/selected。
    suggestedLatestForDisplay: latest ? serializeRevision(latest) : null,
  });
}

export async function PATCH(
  req: Request,
  {params}: {params: Promise<{profileId: string}>},
): Promise<Response> {
  const {profileId} = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', {message: '请求体不是合法 JSON'});
  }
  try {
    const input = patchVoiceProfileBodySchema.parse(body);
    const updated = setVoiceProfileStatus(profileId, input.status);
    if (!updated) return jsonError(404, 'profile_not_found');
    return Response.json({profile: serializeProfile(updated)});
  } catch (err) {
    if (err instanceof ZodError || err instanceof VoiceLibraryError) {
      return voiceLibraryErrorResponse(err);
    }
    throw err;
  }
}

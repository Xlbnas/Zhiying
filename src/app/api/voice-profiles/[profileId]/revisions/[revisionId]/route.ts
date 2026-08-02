/**
 * GET /api/voice-profiles/[profileId]/revisions/[revisionId] — 单 revision immutable descriptor。
 * exact reader：Profile/Revision 不存在、跨 Profile、文件缺失 → 404；
 * hash 漂移 → 200 但 usable=false + unusableReason='hash_mismatch'（fail-closed 证据透出）。
 */
import {getVoiceProfile} from '@/lib/voice-library/profiles';
import {getVoiceProfileRevisionExact} from '@/lib/voice-library/revisions';
import {jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{profileId: string; revisionId: string}>},
): Promise<Response> {
  const {profileId, revisionId} = await params;
  if (!getVoiceProfile(profileId)) return jsonError(404, 'profile_not_found');
  const descriptor = await getVoiceProfileRevisionExact(profileId, revisionId);
  if (!descriptor) return jsonError(404, 'revision_not_found');
  return Response.json({revision: descriptor});
}

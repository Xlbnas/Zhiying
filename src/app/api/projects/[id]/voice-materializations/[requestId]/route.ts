import {NextResponse} from 'next/server';
import {getMaterializationRequest, serializeMaterializationRequest, getProjection} from '@/lib/tts-c/materialization';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  {params}: {params: Promise<{id: string; requestId: string}>},
): Promise<NextResponse> {
  const {id: projectId, requestId} = await params;
  const row = getMaterializationRequest(projectId, requestId);
  if (!row) {
    return NextResponse.json({error: {code: 'REQUEST_NOT_FOUND', message: 'request 不存在'}}, {status: 404});
  }
  const projection = row.materialization_id
    ? getProjection(row.voice_profile_id, row.voice_profile_revision_id)
    : null;
  return NextResponse.json({request: serializeMaterializationRequest(row, projection), adapterReady: false});
}

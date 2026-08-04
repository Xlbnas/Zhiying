import {NextResponse} from 'next/server';
import {createMaterializationRequest, listMaterializationRequests, serializeMaterializationRequest, getProjection, MaterializationError} from '@/lib/tts-c/materialization';
import {z} from 'zod';

export const dynamic = 'force-dynamic';

const createBodySchema = z.object({
  requestId: z.string().min(1).max(128),
  projectVoiceAssignmentArtifactId: z.string().min(1),
});

export async function POST(
  request: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<NextResponse> {
  const {id: projectId} = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({error: {code: 'BODY_INVALID', message: '请求体必须为 JSON'}}, {status: 400});
  }
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({error: {code: 'BODY_INVALID', message: parsed.error.message}}, {status: 422});
  }
  try {
    const result = await createMaterializationRequest(
      projectId,
      parsed.data.requestId,
      parsed.data.projectVoiceAssignmentArtifactId,
    );
    const view = serializeMaterializationRequest(result.request, result.projection);
    return NextResponse.json(
      {
        request: view,
        outcome: result.outcome,
        adapterReady: false,
        registryPublished: false,
        message:
          result.outcome === 'reused'
            ? 'materialized file already durable（usable existing projection，零文件写）'
            : result.outcome === 'queued'
              ? 'materialization queued（Worker 将执行 durable copy）'
              : result.outcome === 'inflight'
                ? 'materialization in flight（Worker 正在执行）'
                : result.outcome === 'failed'
                  ? 'materialization failed（Worker 失联，lease 过期恢复；请重新提交）'
                  : 'materialization cancelled（无 active subscriber）',
      },
      {status: result.outcome === 'queued' ? 202 : 200},
    );
  } catch (err) {
    if (err instanceof MaterializationError) {
      return NextResponse.json(
        {error: {code: err.code, message: err.message}},
        {status: err.status},
      );
    }
    return NextResponse.json({error: {code: 'INTERNAL', message: 'internal error'}}, {status: 500});
  }
}

export async function GET(
  _request: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<NextResponse> {
  const {id: projectId} = await params;
  try {
    const rows = listMaterializationRequests(projectId);
    const views = rows.map((r) =>
      serializeMaterializationRequest(r, r.materialization_id ? getProjection(r.voice_profile_id, r.voice_profile_revision_id) : null),
    );
    return NextResponse.json({requests: views, adapterReady: false});
  } catch {
    return NextResponse.json({error: {code: 'INTERNAL', message: 'internal error'}}, {status: 500});
  }
}

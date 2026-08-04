import {NextResponse} from 'next/server';
import {createMaterializationRequest, listMaterializationRequests, serializeMaterializationRequest, getProjection, MaterializationError} from '@/lib/tts-c/materialization';
import {z} from 'zod';

export const dynamic = 'force-dynamic';

const createBodySchema = z.object({
  requestId: z.string().min(1).max(128),
  projectVoiceAssignmentArtifactId: z.string().min(1),
});

/**
 * R2：POST feature gate——production 缺失或非显式 "true" → 503 MATERIALIZATION_NOT_ENABLED。
 * 只有未来独立 Review PASS 后才能单独启用；GET 不受影响；不泄漏内部配置。
 */
function postEnabled(): boolean {
  return process.env.TTS_C1A_MATERIALIZATION_POST_ENABLED === 'true';
}

export async function POST(
  request: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<NextResponse> {
  const {id: projectId} = await params;
  if (!postEnabled()) {
    return NextResponse.json(
      {error: {code: 'MATERIALIZATION_NOT_ENABLED', message: 'materialization POST 未启用（feature gate）'}},
      {status: 503},
    );
  }
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
    // R2：finalize 后重读 request/job/projection（禁止返回 Phase 1 缓存的 waiting row）
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
                  : result.outcome === 'indeterminate'
                    ? 'materialization indeterminate（durability 无法确定；等待 reconciliation）'
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

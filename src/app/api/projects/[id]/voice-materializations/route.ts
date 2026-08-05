import {NextResponse} from 'next/server';
import {createMaterializationRequest, listMaterializationRequests, serializeMaterializationRequest, getProjection, integrityStatusOf, MaterializationError, type ReuseIntegrityStatus} from '@/lib/tts-c/materialization';
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
    // R3：GET fail-closed integrity——绝不只序列化 DB projection status；
    // 只有 safe validator 通过才 verified（零 mkdir/零文件写）
    // R4 §九：单次请求内对同一 projection 的 integrity validation 做 memoization
    // （key = materialization_id + source_canonical_sha256 + projection.updated_at
    //  + assignment_artifact_id——request 级 assignment 分类参与判定，必须进 key）；
    // 不跨请求持久缓存；每次 HTTP 请求仍至少对每个 distinct key fail-closed 检查一次。
    const integrityMemo = new Map<string, Promise<ReuseIntegrityStatus>>();
    const views = [];
    for (const r of rows) {
      const projection = r.materialization_id ? getProjection(r.voice_profile_id, r.voice_profile_revision_id) : null;
      let integrityStatus: ReuseIntegrityStatus = 'unchecked';
      if (r.materialization_id) {
        const memoKey = projection
          ? `${r.materialization_id}:${projection.source_canonical_sha256}:${projection.updated_at}:${r.assignment_artifact_id}`
          : `request:${r.id}`;
        let pending = integrityMemo.get(memoKey);
        if (!pending) {
          pending = integrityStatusOf(r);
          integrityMemo.set(memoKey, pending);
        }
        integrityStatus = await pending;
      }
      views.push(serializeMaterializationRequest(r, projection, integrityStatus));
    }
    return NextResponse.json({requests: views, adapterReady: false});
  } catch {
    return NextResponse.json({error: {code: 'INTERNAL', message: 'internal error'}}, {status: 500});
  }
}

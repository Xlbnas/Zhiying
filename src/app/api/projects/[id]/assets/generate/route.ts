/**
 * POST /api/projects/[id]/assets/generate — AI 图像生成入队（candidate，不自动绑定）。
 * GET  /api/projects/[id]/assets/generate — 检查 provider 可用性 / 查询 job 状态。
 *
 * M7.3A.2：Web 不再同步等待真实图像生成。POST 只做 validation + 幂等 enqueue，
 * 返回 202 {jobId, requestId, status}；Worker 原子 claim 后调用 provider。
 * 同 (sceneId, requirementId, requestId) 生命周期内只产生一个 job，双击/重试不重复调用。
 */

import {defaultGeneratePrompt} from '@/lib/assets/generate-prompt';
import {
  AssetGenerationJobError,
  enqueueAssetGenerationJob,
  getAssetGenerationJobByRequestId,
  listAssetGenerationJobs,
} from '@/lib/assets/generation-jobs';
import {getGeneratedImageProvider} from '@/lib/assets/providers/generated';
import {findRequirementInPlans, loadLatestScenesPlans} from '@/lib/assets/requirements';
import {getProject, jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  const url = new URL(req.url);
  const sceneId = url.searchParams.get('sceneId');
  const requirementId = url.searchParams.get('requirementId');
  const requestId = url.searchParams.get('requestId');

  const prov = getGeneratedImageProvider();
  const health = await prov.checkHealth();

  let job = null;
  if (sceneId && requirementId && requestId) {
    job = getAssetGenerationJobByRequestId(id, sceneId, requirementId, requestId);
  }

  return Response.json({
    configured: prov.configured,
    available: health.available,
    healthy: health.healthy,
    reason: health.reason,
    provider: prov.name,
    job: job
      ? {
          jobId: job.id,
          requestId: job.request_id,
          status: job.status,
          providerRequestId: job.provider_request_id ?? null,
          resultAssetId: job.result_asset_id ?? null,
          errorCode: job.error_code ?? null,
          failurePhase: job.failure_phase ?? null,
          billingStatus: job.billing_status ?? null,
        }
      : null,
  });
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId: string; requirementId: string; prompt?: string; requestId?: string};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid_json');
  }
  if (!body.sceneId || !body.requirementId) {
    return jsonError(400, 'missing_fields', {message: '需要 sceneId 和 requirementId'});
  }
  if (!body.requestId) {
    return jsonError(400, 'missing_request_id', {message: '需要 requestId（客户端生成并保留）'});
  }

  // 目标 requirement 必须真实存在于 active scenes artifact（exact 查找）
  const plans = loadLatestScenesPlans(id);
  if (!plans) return jsonError(404, 'scenes_not_found', {message: '项目缺少 scenes artifact'});
  const found = findRequirementInPlans(plans, body.sceneId, body.requirementId);
  if (!found) {
    return jsonError(400, 'requirement_not_found', {
      message: `需求 ${body.requirementId} 不存在于场景 ${body.sceneId}`,
    });
  }
  const requirement = found.requirement;
  const prompt = body.prompt?.trim() || defaultGeneratePrompt(requirement);

  const prov = getGeneratedImageProvider();

  try {
    const result = enqueueAssetGenerationJob({
      projectId: id,
      sceneId: body.sceneId,
      requirementId: body.requirementId,
      requestId: body.requestId,
      prompt,
      provider: prov.name,
      model: process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    });

    return Response.json(
      {
        jobId: result.jobId,
        requestId: result.requestId,
        status: result.status,
        reused: result.reused,
      },
      {status: 202},
    );
  } catch (err) {
    if (err instanceof AssetGenerationJobError) {
      return jsonError(
        err.code === 'SCENE_OVERRIDDEN' ? 409 : err.code === 'REQUIREMENT_NOT_FOUND' ? 400 : 409,
        err.code,
        {message: err.message},
      );
    }
    throw err;
  }
}

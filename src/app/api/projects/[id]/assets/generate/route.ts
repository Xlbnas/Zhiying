/**
 * POST /api/projects/[id]/assets/generate — AI 图像生成（candidate，不自动绑定）。
 * GET  /api/projects/[id]/assets/generate — 检查 provider 可用性。
 *
 * M6.3.8：generate ≠ bind。candidate 记录 intended 目标（sceneId + 真实 requirement
 * 快照含 requirementId），只有用户显式调用 bind API 才产生 active binding。
 *
 * M6.3.10：每次真实 provider 调用 = 一个 generation attempt = 一条 usage event
 * （attemptId 幂等）。费用属于 attempt 而非最终 bind 的 asset：拒绝/未绑定/
 * 重新生成各自独立计费；provider 成功 → 先记 usage 再持久化 candidate，
 * candidate 后续失败不丢已发生费用。bind 链路零改动（不重复计费）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {clearResolutionState, insertAsset, upsertResolutionState} from '@/lib/assets/model';
import {defaultGeneratePrompt} from '@/lib/assets/generate-prompt';
import {getGeneratedImageProvider, ImageGenerationError} from '@/lib/assets/providers/generated';
import type {GeneratedImageCandidate} from '@/lib/assets/providers/generated';
import {findRequirementInPlans, loadLatestScenesPlans} from '@/lib/assets/requirements';
import {imageGenerationErrorStatus, recordImageGenerationUsage} from '@/lib/usage-events';
import {getProject, jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const prov = getGeneratedImageProvider();
  // Trigger health check on demand (cached internally)
  const health = await prov.checkHealth();
  return Response.json({
    configured: prov.configured,
    available: health.available,
    healthy: health.healthy,
    reason: health.reason,
    provider: prov.name,
  });
}

const IN_FLIGHT = new Set<string>(); // projectId:sceneId:requirementId → 防重复提交

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId: string; requirementId: string; prompt?: string};
  try { body = await req.json() as typeof body; } catch { return jsonError(400, 'invalid_json'); }
  if (!body.sceneId || !body.requirementId) {
    return jsonError(400, 'missing_fields', {message: '需要 sceneId 和 requirementId'});
  }

  // 目标 requirement 必须真实存在于 active scenes artifact（exact 查找）
  const plans = loadLatestScenesPlans(id);
  if (!plans) return jsonError(404, 'scenes_not_found', {message: '项目缺少 scenes artifact'});
  const found = findRequirementInPlans(plans, body.sceneId, body.requirementId);
  if (!found) {
    return jsonError(400, 'requirement_not_found', {message: `需求 ${body.requirementId} 不存在于场景 ${body.sceneId}`});
  }
  const requirement = found.requirement;
  const prompt = body.prompt?.trim() || defaultGeneratePrompt(requirement);

  const lockKey = `${id}:${body.sceneId}:${body.requirementId}`;
  if (IN_FLIGHT.has(lockKey)) return jsonError(429, 'generation_in_progress', {message: '正在为该素材需求生成图片，请稍后'});
  IN_FLIGHT.add(lockKey);

  // M6.3.10：attemptId 在调用 provider 之前生成（usage event 幂等键；
  // 每次 POST = 新 attempt = 独立计费，重复处理由主键 INSERT OR IGNORE 挡住）
  const attemptId = crypto.randomUUID();
  const prov = getGeneratedImageProvider();

  /** 记账失败不得阻断生成流程（费用已真实发生），但必须 loudly log。 */
  const recordUsage = (input: Parameters<typeof recordImageGenerationUsage>[0]): void => {
    try {
      recordImageGenerationUsage(input);
    } catch (err) {
      console.error(`[assets/generate] usage event 记录失败 attempt=${attemptId}:`, err);
    }
  };

  try {
    if (!prov.configured || !prov.health.available) return jsonError(503, 'provider_unavailable', {message: '图像生成服务未配置或不可用'});

    const candidates: GeneratedImageCandidate[] = await prov.generate({prompt});
    if (!candidates.length) {
      upsertResolutionState({projectId: id, sceneId: body.sceneId, requirementId: body.requirementId, status: 'generation_failed', reason: '未生成有效图片', provider: prov.name});
      return jsonError(500, 'generation_failed', {message: '未生成有效图片'});
    }

    const first = candidates[0]!;
    const firstMeta = (first.metadata ?? {}) as Record<string, unknown>;

    // 费用已真实发生：先记 usage event，再持久化 candidate（Phase 9 ordering）。
    // imageCount = provider 实际产出张数（含后续可能被拒绝/不绑定的 candidate）。
    recordUsage({
      attemptId,
      projectId: id,
      sceneId: body.sceneId,
      requirementId: body.requirementId,
      provider: first.provider,
      model: first.model,
      requestedSize: typeof firstMeta.size === 'string' ? firstMeta.size : '1K',
      aspectRatio: typeof firstMeta.aspectRatio === 'string' ? firstMeta.aspectRatio : '16:9',
      imageCount: candidates.length,
      status: 'succeeded',
      generationId: first.generationId,
      providerRequestId: typeof firstMeta.providerRequestId === 'string' ? firstMeta.providerRequestId : undefined,
      usageMetadata: firstMeta.usageMetadata,
    });

    const assetId = crypto.randomUUID();
    const ext = first.mimeType === 'image/png' ? 'png' : first.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const relPath = path.posix.join('assets', id, `${assetId}.${ext}`);
    const publicDir = path.join(process.cwd(), 'public');
    const absPath = path.join(publicDir, relPath);

    fs.mkdirSync(path.dirname(absPath), {recursive: true});
    // 原子写入：先写 tmp，再 rename
    const tmpPath = absPath + '.tmp';
    fs.writeFileSync(tmpPath, first.data);
    fs.renameSync(tmpPath, absPath);

    const row = insertAsset({
      projectId: id,
      // intended 目标 scene（denormalized 便利列）；是否 READY 只看 asset_bindings，
      // candidate 无 binding 行 → 不影响 readiness（candidate-first 契约不变）。
      sceneId: body.sceneId,
      mediaType: 'image',
      sourceType: 'generated',
      sourceProvider: 'apiyi',
      sourceUrl: null,
      localPath: relPath,
      mimeType: first.mimeType,
      width: first.width ?? null,
      height: first.height ?? null,
      licenseStatus: 'generated',
      licenseNote: `AI 生成 · ${first.model} (待确认)`,
      attribution: `API易 / ${first.model}`,
      description: first.prompt.slice(0, 200),
      // 真实 requirement 快照（含 requirementId）—— bind 时据此校验 exact 目标
      requirement,
    });

    // M6.3.9：生成成功 → 清除该 requirement 的失败状态（candidate_waiting 由 resolver 推导）
    clearResolutionState(id, body.sceneId, body.requirementId);

    return Response.json({
      candidate: {
        assetId: row.id,
        publicPath: row.local_path,
        sceneId: body.sceneId,
        requirementId: body.requirementId,
        provider: first.provider,
        model: first.model,
        prompt: first.prompt,
        generationId: first.generationId,
        attemptId,
      },
    }, {status: 201});
  } catch (err) {
    const msg = err instanceof Error ? err.message : '图像生成失败';
    // M6.3.10 计费口径：auth_failed → cost 0；429/timeout/5xx/空结果/http 错误
    // → unknown_billing（不计费，技术详情可见）；not_configured 未发请求 → 不记。
    if (err instanceof ImageGenerationError) {
      const usageStatus = imageGenerationErrorStatus(err.code);
      if (usageStatus) {
        recordUsage({
          attemptId,
          projectId: id,
          sceneId: body.sceneId,
          requirementId: body.requirementId,
          provider: prov.name,
          model: err.context?.model ?? 'unknown',
          requestedSize: err.context?.size ?? 'unknown',
          aspectRatio: err.context?.aspectRatio ?? 'unknown',
          imageCount: 0,
          status: usageStatus,
        });
      }
    }
    upsertResolutionState({projectId: id, sceneId: body.sceneId, requirementId: body.requirementId, status: 'generation_failed', reason: msg, provider: 'apiyi'});
    return jsonError(500, 'generation_failed', {message: msg});
  } finally {
    IN_FLIGHT.delete(lockKey);
  }
}

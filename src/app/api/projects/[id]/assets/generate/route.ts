/**
 * POST /api/projects/[id]/assets/generate — AI 图像生成（candidate，不自动绑定）。
 * GET  /api/projects/[id]/assets/generate — 检查 provider 可用性。
 *
 * M6.3.8：generate ≠ bind。candidate 记录 intended 目标（sceneId + 真实 requirement
 * 快照含 requirementId），只有用户显式调用 bind API 才产生 active binding。
 *
 * M6.3.10 / M7：每次真实 provider 调用 = 一个 generation attempt = 一条 usage event
 * （attemptId 幂等）。费用属于 attempt 而非最终 bind 的 asset：拒绝/未绑定/
 * 重新生成各自独立计费；provider 成功 → 先记 usage 再持久化 candidate，
 * candidate 后续失败不丢已发生费用。bind 链路零改动（不重复计费）。
 *
 * M7 超时修复：
 * - provider 调用前写入 in_flight usage event（DB 级幂等，跨进程防双击重计费）。
 * - 错误码细分 connect/response/download/decode/terminal 阶段。
 * - provider request id / attemptId / failure phase 持久化并返回给 UI。
 * - 本地超时后不自动重试；显式 retry 需新 attemptId。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {clearResolutionState, insertAsset, upsertResolutionState} from '@/lib/assets/model';
import {defaultGeneratePrompt} from '@/lib/assets/generate-prompt';
import {getGeneratedImageProvider, ImageGenerationError} from '@/lib/assets/providers/generated';
import type {GeneratedImageCandidate} from '@/lib/assets/providers/generated';
import {findRequirementInPlans, loadLatestScenesPlans} from '@/lib/assets/requirements';
import {isSceneVisuallyOverridden} from '@/lib/scenes/visual-overrides';
import {
  finalizeImageGenerationUsage,
  getImageGenerationUsageById,
  imageGenerationErrorStatus,
  linkAssetToImageUsageEvent,
  recordImageGenerationUsageInFlight,
} from '@/lib/usage-events';
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

/** 进程内短期锁：同一进程内防用户双击；DB 级 in_flight event 提供跨进程幂等。 */
const IN_FLIGHT = new Set<string>();

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId: string; requirementId: string; prompt?: string; attemptId?: string};
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
  // M6.3.13：已「改用 MG」的 scene 拒绝生成（防半截状态；守卫在计费/IN_FLIGHT 之前）
  if (isSceneVisuallyOverridden(id, body.sceneId)) {
    return jsonError(409, 'scene_overridden', {message: `场景 ${body.sceneId} 已改用 MG 模板，无需生成素材`});
  }
  const requirement = found.requirement;
  const prompt = body.prompt?.trim() || defaultGeneratePrompt(requirement);

  const lockKey = `${id}:${body.sceneId}:${body.requirementId}`;
  if (IN_FLIGHT.has(lockKey)) {
    return jsonError(429, 'generation_in_progress', {message: '正在为该素材需求生成图片，请稍后'});
  }

  // M7：若客户端传入 attemptId，先查询已有 attempt 状态（reconcile / 幂等重试）
  if (body.attemptId) {
    const existing = getImageGenerationUsageById(body.attemptId);
    if (existing) {
      const meta = existing.metadata;
      if (existing.status === 'succeeded' && meta.assetId) {
        return Response.json({
          candidate: {
            assetId: meta.assetId,
            sceneId: body.sceneId,
            requirementId: body.requirementId,
            provider: existing.provider,
            model: existing.model,
            prompt: meta.prompt,
            attemptId: existing.id,
            reused: true,
          },
        }, {status: 200});
      }
      if (existing.status === 'in_flight') {
        return jsonError(202, 'generation_in_progress', {
          message: '生成任务仍在进行中',
          attemptId: existing.id,
          providerRequestId: meta.providerRequestId ?? null,
        });
      }
      // failed / unknown_billing / auth_failed：返回明确终态，不自动重调 provider
      return jsonError(409, 'generation_failed', {
        message: `attempt ${existing.id} 已结束（${existing.status}）`,
        attemptId: existing.id,
        failurePhase: meta.failurePhase ?? null,
        providerRequestId: meta.providerRequestId ?? null,
      });
    }
    // attemptId 不存在：客户端不应凭空构造 attemptId
    return jsonError(404, 'attempt_not_found', {message: `attempt ${body.attemptId} 不存在`});
  }

  IN_FLIGHT.add(lockKey);

  // M7：attemptId 在调用 provider 之前生成（usage event 幂等键）
  const attemptId = crypto.randomUUID();
  const prov = getGeneratedImageProvider();
  const startAt = Date.now();

  try {
    if (!prov.configured || !prov.health.available) {
      return jsonError(503, 'provider_unavailable', {message: '图像生成服务未配置或不可用'});
    }

    // DB 级 in_flight 写入：同一 attemptId 重复请求会被拒绝；幂等起点。
    const inFlight = recordImageGenerationUsageInFlight({
      attemptId,
      projectId: id,
      sceneId: body.sceneId,
      requirementId: body.requirementId,
      provider: prov.name,
      model: process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image',
      requestedSize: process.env.APIYI_IMAGE_SIZE || '1K',
      aspectRatio: process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9',
      prompt,
    });
    if (!inFlight.inserted) {
      // 理论上仅在 attemptId 冲突时发生（UUID 几乎不可能）
      return jsonError(409, 'generation_in_progress', {message: '该 attempt 已存在'});
    }

    const candidates: GeneratedImageCandidate[] = await prov.generate({prompt});
    if (!candidates.length) {
      const reason = '未生成有效图片';
      finalizeImageGenerationUsage({
        attemptId,
        projectId: id,
        sceneId: body.sceneId,
        requirementId: body.requirementId,
        provider: prov.name,
        model: process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image',
        requestedSize: process.env.APIYI_IMAGE_SIZE || '1K',
        aspectRatio: process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9',
        imageCount: 0,
        status: 'unknown_billing',
        failurePhase: 'IMAGE_DECODE_FAILED',
        prompt,
        elapsedMs: Date.now() - startAt,
      });
      upsertResolutionState({
        projectId: id,
        sceneId: body.sceneId,
        requirementId: body.requirementId,
        status: 'generation_failed',
        reason,
        provider: prov.name,
        metadata: {attemptId, failurePhase: 'IMAGE_DECODE_FAILED', prompt, elapsedMs: Date.now() - startAt},
      });
      return jsonError(500, 'generation_failed', {message: reason, attemptId, failurePhase: 'IMAGE_DECODE_FAILED'});
    }

    const first = candidates[0]!;
    const firstMeta = (first.metadata ?? {}) as Record<string, unknown>;
    const providerRequestId = typeof firstMeta.providerRequestId === 'string' ? firstMeta.providerRequestId : undefined;
    const elapsedMs = Date.now() - startAt;

    // 费用已真实发生：先 finalize usage event，再持久化 candidate（Phase 9 ordering）。
    finalizeImageGenerationUsage({
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
      providerRequestId,
      usageMetadata: firstMeta.usageMetadata,
      prompt,
      elapsedMs,
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

    // M6.3.10：usage event 先于 candidate 持久化（费用先行），此处回补 assetId 链接，
    // 供 backfill 精确去重（metadata->>'assetId' = asset.id → 已记账，跳过）。
    try {
      linkAssetToImageUsageEvent(attemptId, row.id);
    } catch (err) {
      console.error(`[assets/generate] usage event assetId 回补失败 attempt=${attemptId}:`, err);
    }

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
        providerRequestId,
      },
    }, {status: 201});
  } catch (err) {
    const elapsedMs = Date.now() - startAt;
    const msg = err instanceof Error ? err.message : '图像生成失败';
    let failurePhase = 'PROVIDER_TERMINAL_FAILURE';
    let providerRequestId: string | undefined;
    let model = process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image';

    if (err instanceof ImageGenerationError) {
      failurePhase = err.code;
      providerRequestId = err.context?.providerRequestId;
      model = err.context?.model ?? model;
      const usageStatus = imageGenerationErrorStatus(err.code);
      if (usageStatus) {
        finalizeImageGenerationUsage({
          attemptId,
          projectId: id,
          sceneId: body.sceneId,
          requirementId: body.requirementId,
          provider: prov.name,
          model,
          requestedSize: process.env.APIYI_IMAGE_SIZE || '1K',
          aspectRatio: process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9',
          imageCount: 0,
          status: usageStatus,
          providerRequestId,
          failurePhase,
          prompt,
          elapsedMs,
        });
      }
    }

    upsertResolutionState({
      projectId: id,
      sceneId: body.sceneId,
      requirementId: body.requirementId,
      status: 'generation_failed',
      reason: msg,
      provider: prov.name,
      metadata: {attemptId, providerRequestId, failurePhase, model, prompt, elapsedMs},
    });
    return jsonError(500, 'generation_failed', {
      message: msg,
      attemptId,
      failurePhase,
      providerRequestId: providerRequestId ?? null,
    });
  } finally {
    IN_FLIGHT.delete(lockKey);
  }
}

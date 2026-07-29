/**
 * POST /api/projects/[id]/assets/generate — AI 图像生成（candidate，不自动绑定）。
 * GET  /api/projects/[id]/assets/generate — 检查 provider 可用性。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '@/lib/db';
import {insertAsset} from '@/lib/assets/model';
import {getGeneratedImageProvider} from '@/lib/assets/providers/generated';
import type {GeneratedImageCandidate} from '@/lib/assets/providers/generated';
import {getProject, jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const prov = getGeneratedImageProvider();
  return Response.json({
    available: prov.available,
    provider: prov.name,
  });
}

const IN_FLIGHT = new Set<string>(); // projectId:sceneId → 防重复提交

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let body: {sceneId: string; prompt: string; requirementIndex?: number};
  try { body = await req.json() as typeof body; } catch { return jsonError(400, 'invalid_json'); }
  if (!body.sceneId || !body.prompt) return jsonError(400, 'missing_fields', {message: '需要 sceneId 和 prompt'});

  const lockKey = `${id}:${body.sceneId}`;
  if (IN_FLIGHT.has(lockKey)) return jsonError(429, 'generation_in_progress', {message: '正在为这个镜头生成图片，请稍后'});
  IN_FLIGHT.add(lockKey);

  try {
    const prov = getGeneratedImageProvider();
    if (!prov.available) return jsonError(503, 'provider_unavailable', {message: '图像生成服务未配置'});

    const candidates: GeneratedImageCandidate[] = await prov.generate({prompt: body.prompt});
    if (!candidates.length) return jsonError(500, 'generation_failed', {message: '未生成有效图片'});

    const first = candidates[0]!;
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
      sceneId: body.sceneId,
      mediaType: 'image',
      sourceType: 'generated',
      sourceProvider: 'apiyi',
      sourceUrl: null,
      localPath: relPath,
      mimeType: first.mimeType,
      width: first.width ?? null,
      height: first.height ?? null,
      licenseStatus: 'usable' as const, // will be updated to 'generated'
      licenseNote: `AI 生成 · ${first.model}`,
      attribution: `API易 / ${first.model}`,
      description: first.prompt.slice(0, 200),
      requirement: body.requirementIndex !== undefined
        ? {kind: 'image', subject: first.prompt.slice(0, 60), query: first.prompt.slice(0, 60), usage: 'primary', policy: 'generated'}
        : null,
    });

    // Update license_status to generated (override the default 'usable')
    getDb().prepare('UPDATE assets SET license_status = ? WHERE id = ?').run('generated', row.id);

    return Response.json({
      candidate: {
        assetId: row.id,
        publicPath: row.local_path,
        sceneId: body.sceneId,
        provider: first.provider,
        model: first.model,
        prompt: first.prompt,
        generationId: first.generationId,
      },
    }, {status: 201});
  } catch (err) {
    const msg = err instanceof Error ? err.message : '图像生成失败';
    return jsonError(500, 'generation_failed', {message: msg});
  } finally {
    IN_FLIGHT.delete(lockKey);
  }
}

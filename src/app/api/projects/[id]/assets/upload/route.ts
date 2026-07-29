/**
 * POST /api/projects/[id]/assets/upload — 手动上传素材并绑定到 scene/requirement。
 *
 * M6.3 Manual Asset Provider。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '@/lib/db';
import {insertAsset, listUsableAssetsForScene} from '@/lib/assets/model';
import {getProject, jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

function extForMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

export async function POST(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'invalid_formdata', {message: '请求体不是合法 multipart/form-data'});
  }

  const file = form.get('file') as File | null;
  const sceneId = form.get('sceneId') as string | null;
  const requirementIndex = form.get('requirementIndex') as string | null;

  if (!file || !sceneId) {
    return jsonError(400, 'missing_fields', {message: '需要 file 和 sceneId'});
  }
  if (!ALLOWED_MIMES.has(file.type)) {
    return jsonError(400, 'invalid_mime', {message: `仅支持 ${[...ALLOWED_MIMES].join(', ')}，收到 ${file.type}`});
  }
  if (file.size > MAX_FILE_SIZE) {
    return jsonError(400, 'file_too_large', {message: `文件大小 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过上限 20MB`});
  }

  const assetId = crypto.randomUUID();
  const ext = extForMime(file.type);
  const relPath = path.posix.join('assets', id, `${assetId}.${ext}`);
  const publicDir = path.join(process.cwd(), 'public');
  const absPath = path.join(publicDir, relPath);

  // 安全：realpath 边界校验
  const realPublic = fs.realpathSync(publicDir);
  const realDest = path.resolve(absPath);
  if (!realDest.startsWith(realPublic + path.sep) && realDest !== realPublic) {
    return jsonError(400, 'path_traversal', {message: '非法文件路径'});
  }

  fs.mkdirSync(path.dirname(absPath), {recursive: true});
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(absPath, buf);

  // 如果有旧 binding，保留旧素材记录，新素材绑定同一 scene
  const row = insertAsset({
    projectId: id,
    sceneId,
    mediaType: 'image',
    sourceType: 'upload',
    sourceProvider: 'user_upload',
    sourceUrl: null,
    localPath: relPath,
    mimeType: file.type,
    width: null,
    height: null,
    licenseStatus: 'user_provided',
    licenseNote: '用户上传，系统未独立验证版权',
    attribution: file.name,
    description: `手动上传: ${file.name}`,
    requirement: requirementIndex !== null ? {kind: 'image', subject: file.name, query: file.name, usage: 'primary', policy: 'generated'} : null,
  });

  return Response.json({
    assetId: row.id,
    publicPath: row.local_path,
    sceneId,
    requirementIndex: requirementIndex ? Number(requirementIndex) : null,
  }, {status: 201});
}

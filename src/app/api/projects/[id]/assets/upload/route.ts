/**
 * POST /api/projects/[id]/assets/upload — 手动上传素材并绑定到 exact scene + requirement。
 *
 * M6.3 Manual Asset Provider。
 * M6.3.8：requirementId 必填；目标 requirement 必须真实存在于 active scenes artifact。
 * 同一 requirement 已有 active binding 时 = Manual Replace（replace 语义）：
 * 旧 asset 行 / 物理文件 / provenance 全部保留，仅切换 active binding。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {bindAssetToRequirement, clearResolutionState, getActiveBinding, insertAsset} from '@/lib/assets/model';
import {findRequirementInPlans, loadLatestScenesPlans} from '@/lib/assets/requirements';
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
  const requirementId = form.get('requirementId') as string | null;

  if (!file || !sceneId || !requirementId) {
    return jsonError(400, 'missing_fields', {message: '需要 file、sceneId 和 requirementId'});
  }
  if (!ALLOWED_MIMES.has(file.type)) {
    return jsonError(400, 'invalid_mime', {message: `仅支持 ${[...ALLOWED_MIMES].join(', ')}，收到 ${file.type}`});
  }
  if (file.size > MAX_FILE_SIZE) {
    return jsonError(400, 'file_too_large', {message: `文件大小 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过上限 20MB`});
  }

  // 目标 requirement 必须真实存在于 active scenes artifact（exact 查找，禁止 scene 级猜测）
  const plans = loadLatestScenesPlans(id);
  if (!plans) return jsonError(404, 'scenes_not_found', {message: '项目缺少 scenes artifact'});
  const found = findRequirementInPlans(plans, sceneId, requirementId);
  if (!found) {
    return jsonError(400, 'requirement_not_found', {message: `需求 ${requirementId} 不存在于场景 ${sceneId}`});
  }
  const requirement = found.requirement;
  // Manual Replace 判定：该 requirement 已有 active binding → 本次上传替换它
  const previousBinding = getActiveBinding(id, sceneId, requirementId);

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
    // 真实 requirement 快照（含 requirementId；policy 来自真实需求，不再误标 generated）
    requirement,
  });

  // exact binding（replace 语义：旧 binding 转历史，旧 asset 记录/文件保留）
  bindAssetToRequirement({projectId: id, sceneId, requirementId, assetId: row.id});
  // M6.3.9：上传成功 → 清除该 requirement 的失败状态
  clearResolutionState(id, sceneId, requirementId);

  return Response.json({
    assetId: row.id,
    publicPath: row.local_path,
    sceneId,
    requirementId,
    replaced: previousBinding !== undefined,
    previousAssetId: previousBinding?.asset_id ?? null,
  }, {status: 201});
}

/**
 * POST /api/projects/[id]/assets/upload — 手动上传素材并绑定到 exact scene + requirement。
 *
 * M6.3 Manual Asset Provider。
 * M6.3.8：requirementId 必填；目标 requirement 必须真实存在于 active scenes artifact。
 * 同一 requirement 已有 active binding 时 = Manual Replace（replace 语义）：
 * 旧 asset 行 / 物理文件 / provenance 全部保留，仅切换 active binding。
 *
 * 验证契约（M6.3.13）：
 * - 文件内容（magic bytes）是类型判定的唯一权威，不信任客户端自报 MIME / 扩展名。
 *   浏览器可能对合法 PNG/JPEG/WebP 自报 application/octet-stream 或错误 MIME，
 *   此类情况按内容纠正后接受（canonical 类型决定落盘扩展名与 DB mimeType）。
 * - magic bytes 不可识别 → 400 invalid_content（无论 declared MIME / 扩展名如何）。
 * - 20MB 大小上限沿用 file.size 早判，不变。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sniffImageType} from '@/lib/assets/image-sniff';
import {bindAssetToRequirement, clearResolutionState, getActiveBinding, insertAsset} from '@/lib/assets/model';
import {findRequirementInPlans, loadLatestScenesPlans} from '@/lib/assets/requirements';
import {isSceneVisuallyOverridden} from '@/lib/scenes/visual-overrides';
import {getProject, jsonError} from '../../../../_lib/shared';

export const runtime = 'nodejs';

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

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
  // M6.3.13：已「改用 MG」的 scene 拒绝上传/替换（防半截状态）
  if (isSceneVisuallyOverridden(id, sceneId)) {
    return jsonError(409, 'scene_overridden', {message: `场景 ${sceneId} 已改用 MG 模板，如需上传素材请先「改回素材」`});
  }
  const requirement = found.requirement;
  // Manual Replace 判定：该 requirement 已有 active binding → 本次上传替换它
  const previousBinding = getActiveBinding(id, sceneId, requirementId);

  // 内容权威判定：magic bytes 决定 canonical 类型（纠正浏览器误报 MIME）；
  // 不可识别内容一律拒绝（不信 declared MIME / 扩展名纸面信息）
  const buf = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffImageType(buf);
  if (!sniffed) {
    return jsonError(400, 'invalid_content', {message: '文件内容不是合法的 PNG/JPEG/WebP 图片'});
  }

  const assetId = crypto.randomUUID();
  const relPath = path.posix.join('assets', id, `${assetId}.${sniffed.ext}`);
  const publicDir = path.join(process.cwd(), 'public');
  const absPath = path.join(publicDir, relPath);

  // 安全：realpath 边界校验
  const realPublic = fs.realpathSync(publicDir);
  const realDest = path.resolve(absPath);
  if (!realDest.startsWith(realPublic + path.sep) && realDest !== realPublic) {
    return jsonError(400, 'path_traversal', {message: '非法文件路径'});
  }

  fs.mkdirSync(path.dirname(absPath), {recursive: true});
  fs.writeFileSync(absPath, buf);

  const row = insertAsset({
    projectId: id,
    sceneId,
    mediaType: 'image',
    sourceType: 'upload',
    sourceProvider: 'user_upload',
    sourceUrl: null,
    localPath: relPath,
    mimeType: sniffed.mime,
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

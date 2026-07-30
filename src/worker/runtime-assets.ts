/**
 * M6.3.12：Final Render 视觉素材 staging（P0 物理完整性）。
 *
 * 问题：bundle 打包时拷贝一次 public/；之后新生成/新绑定的素材（AI 生成图、
 * 新上传、新 Wikimedia 下载）不在缓存 bundle 里 → renderer staticFile 404 →
 * （旧行为）静默渲染占位画面。本模块在 renderMedia 前把 assetMap 引用的
 * 每个素材从 <cwd>/public 复制进 <bundleLocation>/public，源缺失即 fail-closed。
 *
 * 安全约定与 runtime-audio 一致：逻辑路径形态校验 + 源/目的 containment +
 * parent-chain symlink 防线 + tmp copy + rename；dest 已存在且 size 一致 → reuse。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';
import {ensureSafeDirectoryInsideRoot, resolveBundledPublicRoot} from './runtime-audio';

export type RuntimeAssetErrorCode = 'ASSET_FILE_MISSING' | 'ASSET_STAGE_ERROR';

export class RuntimeAssetError extends Error {
  constructor(
    public readonly code: RuntimeAssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeAssetError';
  }
}

/** public 相对逻辑路径形态：不允许绝对路径 / .. / 反斜杠。 */
function isValidPublicLogicalPath(p: string): boolean {
  return (
    p.length > 0 &&
    !path.isAbsolute(p) &&
    !p.includes('..') &&
    !p.includes('\\') &&
    !p.startsWith('/')
  );
}

/**
 * 把 payload.data.assetMap 引用的全部素材 stage 到 bundled public root。
 * 无 assetMap / 为空 → 返回 {staged: 0}（Minimal/MG-only 项目合法）。
 * 任一素材源文件缺失/为空 → throw ASSET_FILE_MISSING（调用方 failJob）。
 */
export function stageRuntimeAssets(
  parsedPayload: ZhiyingFullCutProps,
  bundleLocation: string,
): {staged: number} {
  const assetMap = parsedPayload.data.assetMap ?? {};
  const logicalPaths = new Set<string>();
  for (const assets of Object.values(assetMap)) {
    for (const asset of assets) {
      logicalPaths.add(asset.publicPath);
    }
  }
  if (logicalPaths.size === 0) return {staged: 0};

  const sourceRoot = path.resolve(process.cwd(), 'public');
  const destRoot = resolveBundledPublicRoot(bundleLocation);
  const realDestRoot = fs.realpathSync(destRoot);
  let staged = 0;

  for (const logical of logicalPaths) {
    if (!isValidPublicLogicalPath(logical)) {
      throw new RuntimeAssetError('ASSET_STAGE_ERROR', `素材逻辑路径形态非法: ${logical}`);
    }
    const srcAbs = path.resolve(sourceRoot, logical);
    if (!srcAbs.startsWith(sourceRoot + path.sep)) {
      throw new RuntimeAssetError('ASSET_STAGE_ERROR', `素材源路径越出 public root: ${logical}`);
    }
    const srcStat = fs.statSync(srcAbs, {throwIfNoEntry: false});
    if (!srcStat || !srcStat.isFile() || srcStat.size <= 0) {
      throw new RuntimeAssetError('ASSET_FILE_MISSING', `素材文件缺失或为空: ${logical}`);
    }

    const destAbs = path.resolve(destRoot, logical);
    if (!destAbs.startsWith(destRoot + path.sep)) {
      throw new RuntimeAssetError('ASSET_STAGE_ERROR', `stage destination 越出 bundled public root: ${logical}`);
    }
    const destLstat = fs.lstatSync(destAbs, {throwIfNoEntry: false});
    if (destLstat) {
      if (destLstat.isSymbolicLink()) {
        throw new RuntimeAssetError('ASSET_STAGE_ERROR', `stage destination 是 symlink: ${destAbs}`);
      }
      if (destLstat.isFile() && destLstat.size === srcStat.size) {
        continue; // 已 stage 过同尺寸文件，reuse
      }
      fs.rmSync(destAbs, {force: true});
    }
    // parent-chain symlink 防线（逐层 realpath containment）
    const segments = path.posix.dirname(logical.split(path.sep).join('/')).split('/').filter((s) => s.length > 0 && s !== '.');
    ensureSafeDirectoryInsideRoot(realDestRoot, segments);
    const tmp = `${destAbs}.${process.pid}.tmp`;
    try {
      fs.copyFileSync(srcAbs, tmp);
      fs.renameSync(tmp, destAbs);
      staged += 1;
    } finally {
      fs.rmSync(tmp, {force: true});
    }
  }
  return {staged};
}

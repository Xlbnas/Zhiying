/**
 * TTS-C.1A 投影路径（root-relative + containment，fail-closed）。
 * DB 只保存 root-relative path；绝对路径/../symlink 越界/任意扩展名一律拒绝。
 * R1（P0-3）：真实 filesystem containment——root/逐级目录 lstat + realpath 包含性；
 * 打开全部使用 O_NOFOLLOW；不依赖"lstat→open 两步"作为唯一安全边界。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {getDataDir} from '../db';
import {MATERIALIZATION_ROOT_DIR, MATERIALIZATION_CANONICAL_FILENAME} from './constants';

export class ProjectionPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionPathError';
  }
}

/** materialization root 绝对路径（dataDir/voice-materializations）。 */
export function materializationRootAbs(): string {
  return path.join(getDataDir(), MATERIALIZATION_ROOT_DIR);
}

/** 校验 root-relative 目标路径形状：<profile_id>/<revision_id>/reference.wav。 */
export function validateDestinationRelativePath(rel: string): void {
  if (typeof rel !== 'string' || rel.length === 0) throw new ProjectionPathError('empty path');
  if (path.isAbsolute(rel)) throw new ProjectionPathError('absolute path forbidden');
  const parts = rel.split('/');
  if (parts.length !== 3) throw new ProjectionPathError(`path shape must be <profile>/<revision>/reference.wav: ${rel}`);
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new ProjectionPathError(`path segment invalid: ${rel}`);
  if (parts[2] !== MATERIALIZATION_CANONICAL_FILENAME) throw new ProjectionPathError('filename must be reference.wav');
  if (rel.includes('\\')) throw new ProjectionPathError('backslash forbidden');
  // ID 段形状：UUID（TTS-A/B id 均为 uuid v4）
  for (const seg of [parts[0], parts[1]]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(seg)) {
      throw new ProjectionPathError(`id segment must be uuid: ${seg}`);
    }
  }
}

/** 构造固定目标 relative path（DB 存储值）。 */
export function destinationRelativePath(profileId: string, revisionId: string): string {
  const rel = `${profileId}/${revisionId}/${MATERIALIZATION_CANONICAL_FILENAME}`;
  validateDestinationRelativePath(rel);
  return rel;
}

/** 目标绝对路径（Worker 唯一 writer 使用）。 */
export function destinationAbsolutePath(rel: string): string {
  validateDestinationRelativePath(rel);
  const root = path.resolve(materializationRootAbs());
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new ProjectionPathError('path escapes root');
  return abs;
}

/** 同目录 staging/temp 路径（rename 原子性要求同目录）。 */
export function stagingTempPath(finalAbs: string): string {
  return `${finalAbs}.staging-${process.pid}-${Date.now()}.tmp`;
}

/**
 * P0-3：materialization root 必须真实目录且非 symlink；
 * 返回 realpath(root)（后续 containment 比较基准）。
 */
export async function ensureMaterializationRootSafe(rootAbs: string): Promise<string> {
  let st;
  try {
    st = await fs.lstat(rootAbs);
  } catch {
    await fs.mkdir(rootAbs, {recursive: true});
    try {
      st = await fs.lstat(rootAbs);
    } catch {
      throw new ProjectionPathError('materialization root 不可创建');
    }
  }
  if (st.isSymbolicLink()) throw new ProjectionPathError('materialization root 是 symlink');
  if (!st.isDirectory()) throw new ProjectionPathError('materialization root 非目录');
  const real = await fs.realpath(rootAbs);
  if (real !== path.resolve(rootAbs)) throw new ProjectionPathError('materialization root realpath 漂移');
  return real;
}

/**
 * P0-3：目标 parent 逐级 lstat（profile/revision 目录）+ realpath 包含性。
 * 任一级 symlink → fail-closed；parent realpath 必须位于 root realpath 内。
 * 返回 {realRoot, realParent} 供 rename 前后复核。
 */
export async function ensureDestinationParentSafe(
  rootAbs: string,
  rel: string,
): Promise<{realRoot: string; realParent: string}> {
  validateDestinationRelativePath(rel);
  const parts = rel.split('/');
  const realRoot = await ensureMaterializationRootSafe(rootAbs);
  // 逐级 lstat（root 已校验；profile、revision 两级，路径累积）
  let cur = realRoot;
  for (const seg of parts.slice(0, 2)) {
    cur = path.join(cur, seg);
    let segSt;
    try {
      segSt = await fs.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        await fs.mkdir(cur, {recursive: false});
        continue;
      }
      throw new ProjectionPathError(`目录不可访问: ${seg}`);
    }
    if (segSt.isSymbolicLink()) throw new ProjectionPathError(`目录段是 symlink: ${seg}`);
    if (!segSt.isDirectory()) throw new ProjectionPathError(`目录段非目录: ${seg}`);
  }
  const parentAbs = path.join(realRoot, parts[0], parts[1]);
  let realParent: string;
  try {
    realParent = await fs.realpath(parentAbs);
  } catch {
    throw new ProjectionPathError('parent realpath 不可解析');
  }
  if (realParent !== path.resolve(parentAbs)) throw new ProjectionPathError('parent realpath 漂移（symlink 逃逸）');
  if (!realParent.startsWith(realRoot + path.sep)) throw new ProjectionPathError('parent realpath 越出 root');
  return {realRoot, realParent};
}

/** P0-3：source/final 打开 flags（O_NOFOLLOW 真实生效，numeric）。 */
export const OPEN_FLAGS = {
  /** source 与 final 只读 + no-follow */
  readNoFollow: fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
  /** temp 创建：独占 + 拒绝 symlink */
  tempCreate: fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW,
} as const;

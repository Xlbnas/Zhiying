/**
 * TTS-C.1A 投影路径（root-relative + containment，fail-closed）。
 * DB 只保存 root-relative path；绝对路径/../symlink 越界/任意扩展名一律拒绝。
 */
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

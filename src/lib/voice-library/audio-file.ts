/**
 * TTS-A：revision canonical 音频读取（供 audio route 使用）。
 * 只接受 DB exact lookup 得到的存储路径，绝不接受请求侧 path 参数；
 * 前缀/realpath/symlink/hash 任一异常 → null（fail-closed，route 一律 404）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {getDataDir, getDb} from '@/lib/db';
import {sha256File} from '@/lib/render/artifact';
import {VOICE_PROFILE_REVISION_SCHEMA_VERSION} from './constants';
import type {VoiceProfileRevisionRow} from './types';

export interface RevisionAudioFile {
  absPath: string;
  size: number;
  sha256: string;
}

/**
 * exact lookup（profileId + revisionId 双 ID）→ 路径边界校验 → lstat 非 symlink
 * → 计算 sha256 并与 DB 比对。文件缺失 / 路径非法 / hash 漂移 → null。
 */
export async function readRevisionAudio(
  profileId: string,
  revisionId: string,
): Promise<RevisionAudioFile | null> {
  const row = getDb()
    .prepare('SELECT * FROM voice_profile_revisions WHERE id = ? AND voice_profile_id = ?')
    .get(revisionId, profileId) as VoiceProfileRevisionRow | undefined;
  if (!row || row.schema_version !== VOICE_PROFILE_REVISION_SCHEMA_VERSION) return null;

  // 前缀必须是 voice-library/ 且 resolve 后不越出 voice-library 根
  if (!row.canonical_audio_path.startsWith('voice-library/')) return null;
  const root = path.join(getDataDir(), 'voice-library');
  const abs = path.resolve(root, row.canonical_audio_path.slice('voice-library/'.length));
  if (!abs.startsWith(root + path.sep)) return null;
  // realpath 防护：已解析路径必须仍在 voice-library 根内（防中间目录 symlink）
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = fs.realpathSync(root);
    realAbs = fs.realpathSync(abs);
  } catch {
    return null; // 根或文件不存在
  }
  if (!realAbs.startsWith(realRoot + path.sep)) return null;

  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) return null;

  const sha256 = await sha256File(abs);
  if (sha256 !== row.canonical_audio_sha256) return null; // hash 漂移 fail-closed
  return {absPath: abs, size: st.size, sha256};
}

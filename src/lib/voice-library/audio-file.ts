/**
 * TTS-A：revision canonical 音频读取（供 audio route 使用）。
 * 只接受 DB exact lookup 得到的存储路径，绝不接受请求侧 path 参数。
 * TTS-A.R1：与 requestId reused 检查共用单一真相源 validateVoiceProfileRevisionExact
 * （不再维护第二套 path/hash 校验）；descriptor 为 null 或 usable=false → null
 * （fail-closed，route 一律 404）。
 */
import {validateVoiceProfileRevisionExact} from './revisions';

export interface RevisionAudioFile {
  absPath: string;
  size: number;
  sha256: string;
}

/**
 * exact lookup（profileId + revisionId 双 ID）→ 共享 validator（路径包含性 + 非 symlink +
 * 内容契约 + SHA256 比对）。文件缺失 / 路径非法 / 内容损坏 → null。
 */
export async function readRevisionAudio(
  profileId: string,
  revisionId: string,
): Promise<RevisionAudioFile | null> {
  const d = await validateVoiceProfileRevisionExact(profileId, revisionId);
  if (!d || !d.usable) return null;
  return {absPath: d.canonicalAudioAbsolutePath, size: d.fileSize, sha256: d.actualSha256};
}

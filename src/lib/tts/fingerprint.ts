import crypto from 'node:crypto';
import type {Delivery} from '../narration/schema-v2';

/**
 * TTS Input Fingerprint（M7.1，REVIEW DECISIONS 1.3 冻结）。
 *
 * 复用旧 unit audio 的唯一合法依据是完整输入 fingerprint 一致——
 * 禁止只按文本 hash 复用。fingerprint 覆盖全部声学输入：
 *
 *   normalizedSpokenText + voiceIdentity + referenceAudioHash
 *   + ttsModelVersion + delivery + speed + synthesisParameters
 *   + normalizationVersion
 *
 * 拼接采用长度前缀（length-prefixed fields），杜绝字段边界歧义碰撞。
 */

/** 文本归一化版本：变更归一规则必须 bump（fingerprint 随之失效，fail-closed）。 */
export const TTS_TEXT_NORMALIZATION_VERSION = 'tts-text-norm@1.0';

/** 口播文本归一：NFC + 空白折叠 + trim。 */
export function normalizeSpokenText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export interface TtsFingerprintInput {
  spokenText: string;
  /** voiceProfileId@voiceProfileRevision。 */
  voiceIdentity: string;
  /** 参考音频内容 hash（voice registry）；无参考音频时用显式 'none'。 */
  referenceAudioHash: string;
  /** provider model + providerVersion + providerCommit 的 canonical 组合。 */
  ttsModelVersion: string;
  delivery: Delivery;
  /** 合成速度参数（canonical 字符串，如 '1.0'）。 */
  speed: string;
  /** 其余合成参数的 canonical JSON（键序固定）。 */
  synthesisParameters: string;
  normalizationVersion: string;
}

function lengthPrefixed(fields: string[]): string {
  return fields.map((f) => `${f.length}:${f}`).join('|');
}

/** deterministic fingerprint：相同输入永远相同输出。 */
export function computeTtsInputFingerprint(input: TtsFingerprintInput): string {
  const canonical = lengthPrefixed([
    normalizeSpokenText(input.spokenText),
    input.voiceIdentity,
    input.referenceAudioHash,
    input.ttsModelVersion,
    input.delivery,
    input.speed,
    input.synthesisParameters,
    input.normalizationVersion,
  ]);
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** provider 快照 → ttsModelVersion canonical 组合。 */
export function ttsModelVersionOf(snapshot: {
  provider: string;
  model: string;
  providerVersion: string | null;
  providerCommit: string | null;
}): string {
  return [
    snapshot.provider,
    snapshot.model,
    snapshot.providerVersion ?? 'unknown',
    snapshot.providerCommit ?? 'unknown',
  ].join('/');
}

/** voice profile → voiceIdentity。 */
export function voiceIdentityOf(voice: {id: string; revision: string}): string {
  return `${voice.id}@${voice.revision}`;
}

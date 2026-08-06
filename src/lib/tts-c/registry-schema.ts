/**
 * TTS-C.1B.2 registry JSON schema（1.0 legacy / 1.1 publisher）与确定性序列化。
 *
 * 校验语义与 adapter（services/indextts2-api-adapter/server.py，TTS-C.1B.1）严格一致：
 *   - schemaVersion ∈ {"1.0","1.1"}；未知 → VOICE_REGISTRY_UNSUPPORTED_SCHEMA
 *   - 1.1 必须 registryGeneration positive integer（bool 显式排除）+ publisherSchemaVersion
 *     精确等于 tts-c-registry-publisher@1，否则 VOICE_REGISTRY_INVALID
 *   - voices 非空 list；每项 voiceProfile/voiceRevision/speakerName 非空 string；
 *     referenceAssetPath 绝对路径（containment 由调用方以 voice root 校验）；
 *     referenceSha256 64 位小写 hex
 *   - 同一 registry 内 voice key（voiceProfile@voiceRevision）不得重复（import/candidate fail-closed）
 *
 * 序列化：canonical JSON（键递归排序），保证同输入逐字节一致——candidate registry SHA-256
 * 是最终原始 bytes 的单一 SHA-256（frozen contract；不新增额外 checksum 层）。
 */
import crypto from 'node:crypto';
import {RegistryContractError} from './registry-contract-error';

export const LEGACY_REGISTRY_SCHEMA_VERSION = '1.0';
export const PUBLISHER_REGISTRY_SCHEMA_VERSION = '1.1';
export const SUPPORTED_REGISTRY_SCHEMA_VERSIONS = [
  LEGACY_REGISTRY_SCHEMA_VERSION,
  PUBLISHER_REGISTRY_SCHEMA_VERSION,
] as const;
/** 1.1 唯一支持的 publisherSchemaVersion 值（与 adapter SUPPORTED_PUBLISHER_SCHEMA_VERSION 一致）。 */
export const SUPPORTED_PUBLISHER_SCHEMA_VERSION = 'tts-c-registry-publisher@1';
/** frozen adapter 错误码面（复用，不引入新码）。 */
export const VOICE_REGISTRY_INVALID = 'VOICE_REGISTRY_INVALID';
export const VOICE_REGISTRY_UNSUPPORTED_SCHEMA = 'VOICE_REGISTRY_UNSUPPORTED_SCHEMA';
export const REFERENCE_VOICE_MISSING = 'REFERENCE_VOICE_MISSING';
export const REFERENCE_SHA256_MISMATCH = 'REFERENCE_SHA256_MISMATCH';

export interface RegistryVoiceEntry {
  voiceProfile: string;
  voiceRevision: string;
  speakerName: string;
  referenceAssetPath: string;
  referenceSha256: string;
}

export interface LegacyRegistryDoc {
  schemaVersion: typeof LEGACY_REGISTRY_SCHEMA_VERSION;
  voices: RegistryVoiceEntry[];
}

export interface PublisherRegistryDoc {
  schemaVersion: typeof PUBLISHER_REGISTRY_SCHEMA_VERSION;
  registryGeneration: number;
  publisherSchemaVersion: string;
  voices: RegistryVoiceEntry[];
}

export type RegistryDoc = LegacyRegistryDoc | PublisherRegistryDoc;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** canonical voice key = voiceProfile@voiceRevision（adapter 内部 key 语义）。 */
export function canonicalVoiceKey(profile: string, revision: string): string {
  return `${profile}@${revision}`;
}

/** 递归键排序的 canonical JSON 序列化（确定性；同对象逐字节一致）。 */
export function serializeCanonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function sha256Bytes(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 校验单个 voice 条目（与 adapter 严格校验链一致，不含 containment——由调用方提供 root）。
 * 抛 RegistryContractError(VOICE_REGISTRY_INVALID)。
 */
export function validateRegistryVoiceEntry(item: unknown): RegistryVoiceEntry {
  if (item === null || typeof item !== 'object') throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'voice entry 非对象');
  const obj = item as Record<string, unknown>;
  const voiceProfile = obj.voiceProfile;
  const voiceRevision = obj.voiceRevision;
  const speakerName = obj.speakerName;
  const referenceAssetPath = obj.referenceAssetPath;
  const referenceSha256 = obj.referenceSha256;
  if (!isNonEmptyString(voiceProfile)) throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'voiceProfile 缺失或非非空 string');
  if (!isNonEmptyString(voiceRevision)) throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'voiceRevision 缺失或非非空 string');
  if (!isNonEmptyString(speakerName)) throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'speakerName 缺失或非非空 string');
  if (typeof referenceAssetPath !== 'string' || !referenceAssetPath.startsWith('/')) {
    throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'referenceAssetPath 必须绝对路径');
  }
  if (typeof referenceSha256 !== 'string' || !SHA256_HEX_RE.test(referenceSha256)) {
    throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'referenceSha256 必须 64 位小写 hex');
  }
  return {voiceProfile, voiceRevision, speakerName, referenceAssetPath, referenceSha256};
}

/**
 * 解析并完整校验 registry 文档原始 bytes。
 * 返回 doc + 校验后的 voices（按 canonical key 升序，去重检查）。
 * 抛 RegistryContractError（VOICE_REGISTRY_INVALID / VOICE_REGISTRY_UNSUPPORTED_SCHEMA /
 * 重复 key 使用 VOICE_REGISTRY_INVALID）。
 */
export function parseAndValidateRegistry(bytes: Buffer): {doc: RegistryDoc; voices: RegistryVoiceEntry[]} {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'registry JSON 解析失败');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'registry 顶层必须对象');
  }
  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== LEGACY_REGISTRY_SCHEMA_VERSION && schemaVersion !== PUBLISHER_REGISTRY_SCHEMA_VERSION) {
    throw new RegistryContractError(VOICE_REGISTRY_UNSUPPORTED_SCHEMA, `未知 schemaVersion: ${String(schemaVersion)}`);
  }

  let registryGeneration: number | null = null;
  if (schemaVersion === PUBLISHER_REGISTRY_SCHEMA_VERSION) {
    const g = obj.registryGeneration;
    if (typeof g !== 'number' || !Number.isInteger(g) || g < 1) {
      throw new RegistryContractError(VOICE_REGISTRY_INVALID, '1.1 registryGeneration 必须 positive integer');
    }
    registryGeneration = g;
    const pv = obj.publisherSchemaVersion;
    if (pv !== SUPPORTED_PUBLISHER_SCHEMA_VERSION) {
      throw new RegistryContractError(VOICE_REGISTRY_INVALID, `1.1 publisherSchemaVersion 必须 ${SUPPORTED_PUBLISHER_SCHEMA_VERSION}`);
    }
  }

  const rawVoices = obj.voices;
  if (!Array.isArray(rawVoices) || rawVoices.length === 0) {
    throw new RegistryContractError(VOICE_REGISTRY_INVALID, 'voices 必须非空数组');
  }

  const voices: RegistryVoiceEntry[] = [];
  const seen = new Set<string>();
  for (const item of rawVoices) {
    const v = validateRegistryVoiceEntry(item);
    const key = canonicalVoiceKey(v.voiceProfile, v.voiceRevision);
    if (seen.has(key)) {
      throw new RegistryContractError(VOICE_REGISTRY_INVALID, `duplicate voice key: ${key}`);
    }
    seen.add(key);
    voices.push(v);
  }
  // 确定性顺序：canonical key 升序（导入与 candidate 的排序基准；不依赖数组顺序）
  voices.sort((a, b) => canonicalVoiceKey(a.voiceProfile, a.voiceRevision).localeCompare(canonicalVoiceKey(b.voiceProfile, b.voiceRevision)));

  const doc =
    schemaVersion === PUBLISHER_REGISTRY_SCHEMA_VERSION
      ? ({schemaVersion, registryGeneration: registryGeneration as number, publisherSchemaVersion: SUPPORTED_PUBLISHER_SCHEMA_VERSION, voices} as PublisherRegistryDoc)
      : ({schemaVersion, voices} as LegacyRegistryDoc);
  return {doc, voices};
}

/** 1.1 candidate registry 文档确定性序列化（canonical JSON）。 */
export function serializePublisherRegistry(doc: PublisherRegistryDoc): string {
  return serializeCanonicalJson(doc);
}

/** legacy 1.0 文档确定性序列化（用于测试/对比）。 */
export function serializeLegacyRegistry(doc: LegacyRegistryDoc): string {
  return serializeCanonicalJson(doc);
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DEFAULT_VOICE_PROFILE} from './index';

export interface ResolvedVoiceProfile {
  id: string;
  revision: string;
  referenceSha256: string | null;
}

interface LegacyRegistryVoice {
  voiceProfile?: unknown;
  voiceRevision?: unknown;
  referenceAssetPath?: unknown;
  referenceSha256?: unknown;
}

interface LegacyRegistryDocument {
  schemaVersion?: unknown;
  voices?: unknown;
}

export class VoiceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceRegistryError';
    this.code = 'VOICE_NOT_READY';
  }

  readonly code = 'VOICE_NOT_READY';
}

function registryPath(): string {
  return process.env.ZHIYING_ACTIVE_REGISTRY_PATH ?? '/registry/voice-registry.json';
}

function voiceRoot(): string {
  return process.env.ZHIYING_LEGACY_VOICE_ROOT_DIR ?? '/voices';
}

function sha256File(absPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function resolveReferencePath(referenceAssetPath: string): string {
  if (!referenceAssetPath.startsWith('/voices/')) {
    throw new VoiceRegistryError('voice referenceAssetPath 必须位于 /voices 下');
  }
  const root = path.resolve(voiceRoot());
  const lexical = path.resolve(root, referenceAssetPath.slice('/voices/'.length));
  if (!lexical.startsWith(root + path.sep)) {
    throw new VoiceRegistryError('voice reference 越出 voice root');
  }
  let realRoot: string;
  let realReference: string;
  try {
    realRoot = fs.realpathSync(root);
    realReference = fs.realpathSync(lexical);
  } catch {
    throw new VoiceRegistryError('voice reference 文件不存在或不可读');
  }
  if (!realReference.startsWith(realRoot + path.sep) || !fs.statSync(realReference).isFile()) {
    throw new VoiceRegistryError('voice reference 文件不满足 containment/regular-file contract');
  }
  return realReference;
}

/**
 * Resolve and fail-closed validate an explicit legacy production voice.
 * The no-argument path intentionally preserves historical default@1 behavior.
 */
export function resolveRequestedVoice(raw: string | undefined): ResolvedVoiceProfile {
  if (raw === undefined) {
    return {...DEFAULT_VOICE_PROFILE, referenceSha256: null};
  }
  const match = raw.match(/^([^@/\s]+)@([1-9]\d*)$/);
  if (!match) throw new VoiceRegistryError('voice 必须是 <profile>@<revision>');
  const id = match[1]!;
  const revision = match[2]!;

  let document: LegacyRegistryDocument;
  try {
    document = JSON.parse(fs.readFileSync(registryPath(), 'utf8')) as LegacyRegistryDocument;
  } catch {
    throw new VoiceRegistryError(`voice registry 不可读: ${registryPath()}`);
  }
  if (document.schemaVersion !== '1.0' && document.schemaVersion !== '1.1') {
    throw new VoiceRegistryError('voice registry schema 不受支持');
  }
  const entries = Array.isArray(document.voices) ? document.voices as LegacyRegistryVoice[] : [];
  const entry = entries.find((candidate) => candidate.voiceProfile === id && candidate.voiceRevision === revision);
  if (!entry) throw new VoiceRegistryError(`voice identity 不存在或未 ready: ${id}@${revision}`);
  if (typeof entry.referenceAssetPath !== 'string' || !/^([0-9a-f]{64})$/.test(String(entry.referenceSha256))) {
    throw new VoiceRegistryError(`voice identity reference contract 非法: ${id}@${revision}`);
  }
  const reference = resolveReferencePath(entry.referenceAssetPath);
  const actualSha256 = sha256File(reference);
  if (actualSha256 !== entry.referenceSha256) {
    throw new VoiceRegistryError(`voice reference SHA256 不匹配: ${id}@${revision}`);
  }
  return {id, revision, referenceSha256: actualSha256};
}

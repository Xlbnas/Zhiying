/**
 * TTS-A Voice Library 共享类型 / 错误 / 纯函数助手。
 * 设计文档：docs/TTS_A_VOICE_LIBRARY_DESIGN.md §3/§5。
 */
import {z} from 'zod';
import {
  ADAPTER_COMPATIBILITY_KEY,
  DESCRIPTION_MAX,
  DISPLAY_NAME_MAX,
  LANGUAGE_MAX,
  ORIGINAL_FILENAME_DISPLAY_MAX,
  REQUEST_ID_MAX,
  TRANSCRIPT_MAX,
  VOICE_CANONICALIZATION_VERSION,
  VOICE_PROFILE_REVISION_SCHEMA_VERSION,
  VOICE_PROFILE_SCHEMA_VERSION,
} from './constants';

// ---------- 错误 ----------

export type VoiceLibraryErrorCode =
  | 'profile_not_found'
  | 'profile_archived'
  | 'request_id_conflict'
  | 'duplicate_audio'
  | 'file_too_large'
  | 'unsupported_audio'
  | 'invalid_audio_contract'
  | 'invalid_request'
  | 'ingest_failed';

export class VoiceLibraryError extends Error {
  readonly code: VoiceLibraryErrorCode;
  readonly httpStatus: number;

  constructor(code: VoiceLibraryErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'VoiceLibraryError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------- DB 行类型（对应 db.ts TTS-A 建表语句） ----------

export interface VoiceProfileRow {
  id: string;
  schema_version: string;
  display_name: string;
  provider: string;
  description: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface VoiceProfileRevisionRow {
  id: string;
  schema_version: string;
  voice_profile_id: string;
  revision_number: number;
  request_id: string;
  provider: string;
  adapter_compatibility_key: string;
  original_audio_sha256: string;
  canonical_audio_sha256: string;
  original_filename_display: string | null;
  canonical_audio_path: string;
  codec: string;
  sample_rate: number;
  channels: number;
  duration_ms: number;
  transcript: string | null;
  language: string | null;
  metadata_json: string;
  request_fingerprint: string;
  created_at: string;
}

// ---------- zod：输入契约（strict，未知字段 422） ----------

export const createVoiceProfileBodySchema = z
  .object({
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
    description: z.string().max(DESCRIPTION_MAX).optional(),
  })
  .strict();

export const patchVoiceProfileBodySchema = z
  .object({
    status: z.enum(['active', 'archived']),
  })
  .strict();

// ---------- zod：metadata_json strict shape ----------
// 仅固定键；禁止任意 provider 参数袋、禁止 performance/timing 字段。
// .strict() 保证读出时遇到未知键同样 fail-closed。

export const revisionMetadataSchema = z
  .object({
    canonicalizationVersion: z.literal(VOICE_CANONICALIZATION_VERSION),
    adapterCompatibilityKey: z.literal(ADAPTER_COMPATIBILITY_KEY),
    ingestedAt: z.string().min(1),
  })
  .strict();

export type RevisionMetadata = z.infer<typeof revisionMetadataSchema>;

// ---------- 序列化（API 唯一出口；绝不包含任何文件路径） ----------

export function serializeProfile(row: VoiceProfileRow) {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    displayName: row.display_name,
    provider: row.provider,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeRevision(row: VoiceProfileRevisionRow) {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    voiceProfileId: row.voice_profile_id,
    revisionNumber: row.revision_number,
    requestId: row.request_id,
    provider: row.provider,
    adapterCompatibilityKey: row.adapter_compatibility_key,
    originalAudioSha256: row.original_audio_sha256,
    canonicalAudioSha256: row.canonical_audio_sha256,
    originalFilenameDisplay: row.original_filename_display,
    codec: row.codec,
    sampleRate: row.sample_rate,
    channels: row.channels,
    durationMs: row.duration_ms,
    transcript: row.transcript,
    language: row.language,
    requestFingerprint: row.request_fingerprint,
    createdAt: row.created_at,
  };
}

// ---------- 纯函数助手 ----------

/** 文本归一：NFC + 空白折叠 + trim（与 fingerprint.ts normalizeSpokenText 同规则）。 */
export function normalizeTranscript(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** original_filename 清洗：去路径分隔符/控制字符、trim、截断；空 → null。纯 display。 */
export function sanitizeOriginalFilename(name: string): string | null {
  const cleaned = name
    .replace(/[/\\]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, ORIGINAL_FILENAME_DISPLAY_MAX);
}

/** 请求级字段校验（API 与 lib 共用；失败抛 invalid_request）。 */
export function validateIngestFields(fields: {
  requestId: string;
  transcript?: string | null;
  language?: string | null;
}): void {
  if (fields.requestId.trim().length === 0 || fields.requestId.length > REQUEST_ID_MAX) {
    throw new VoiceLibraryError(
      'invalid_request',
      422,
      `requestId 必须为非空字符串且长度 <= ${REQUEST_ID_MAX}`,
    );
  }
  if (fields.transcript != null && fields.transcript.length > TRANSCRIPT_MAX) {
    throw new VoiceLibraryError(
      'invalid_request',
      422,
      `transcript 长度超过上限 ${TRANSCRIPT_MAX}`,
    );
  }
  if (fields.language != null && (fields.language.trim().length === 0 || fields.language.length > LANGUAGE_MAX)) {
    throw new VoiceLibraryError(
      'invalid_request',
      422,
      `language 必须为 1..${LANGUAGE_MAX} 字符（BCP-47-ish）`,
    );
  }
}

/**
 * TTS-B Project Voice Assignment schema（设计文档 §3；TTS-B.R1：ID schema 收紧）。
 * immutable candidate：不 current/active/locked/default；禁止保存路径/文本/音频/
 * performance/timing/job 字段。创建前必须经 TTS-A exact validator（见 assignment.ts）。
 * Voice Profile / Revision 是服务端 UUID——voiceProfileId / voiceProfileRevisionId
 * 必须为 UUID（malformed → 422 invalid_request；well-formed 但不存在 → 404）。
 * projectId 保留 min(1)：历史项目存在非 UUID 的 project id（如 'legacy-p1'），
 * 兼容原因见 docs/TTS_B_ASSIGNMENT_PERFORMANCE_DESIGN.md §8。
 */
import {z} from 'zod';
import {
  ADAPTER_COMPATIBILITY_KEY,
  PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION,
  PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION,
  VOICE_PROFILE_REVISION_SCHEMA_VERSION,
  VOICE_PROVIDER,
} from './constants';

/** Voice Profile / Revision 服务端 UUID 形状。 */
export const VOICE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const voiceUuidSchema = z.string().regex(VOICE_UUID_RE);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1);

export const projectVoiceAssignmentSourceSchema = z
  .object({
    voiceProfileId: voiceUuidSchema,
    voiceProfileRevisionId: voiceUuidSchema,
    revisionSchemaVersion: z.literal(VOICE_PROFILE_REVISION_SCHEMA_VERSION),
    provider: z.literal(VOICE_PROVIDER),
    canonicalAudioSha256: hex64,
    adapterCompatibilityKey: z.literal(ADAPTER_COMPATIBILITY_KEY),
  })
  .strict();

export const projectVoiceAssignmentArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION),
    compilerVersion: z.literal(PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION),
    projectId: id,
    source: projectVoiceAssignmentSourceSchema,
  })
  .strict();

export type ProjectVoiceAssignmentArtifactV1 = z.infer<typeof projectVoiceAssignmentArtifactV1Schema>;
export type ProjectVoiceAssignmentSourceV1 = z.infer<typeof projectVoiceAssignmentSourceSchema>;

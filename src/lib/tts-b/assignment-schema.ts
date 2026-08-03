/**
 * TTS-B Project Voice Assignment schema（设计文档 §3）。
 * immutable candidate：不 current/active/locked/default；禁止保存路径/文本/音频/
 * performance/timing/job 字段。创建前必须经 TTS-A exact validator（见 assignment.ts）。
 */
import {z} from 'zod';
import {
  ADAPTER_COMPATIBILITY_KEY,
  PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION,
  PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION,
  VOICE_PROFILE_REVISION_SCHEMA_VERSION,
  VOICE_PROVIDER,
} from './constants';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1);

export const projectVoiceAssignmentSourceSchema = z
  .object({
    voiceProfileId: id,
    voiceProfileRevisionId: id,
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

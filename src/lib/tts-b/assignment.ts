/**
 * TTS-B Project Voice Assignment（设计文档 §3/§4/§8）。
 *
 * immutable candidate（artifacts 表 kind='project_voice_assignment'）：
 * - 不 current/active/locked/default；不更新 projects 指针；不建 snapshot；
 * - source 只保存 exact 身份字段（voiceProfileId + revisionId + schema +
 *   provider + canonicalAudioSha256 + adapterCompatibilityKey），无路径/文本/音频；
 * - 创建前必须经 TTS-A exact validator（validateVoiceProfileRevisionExact）：
 *   Profile 存在且 active（archived → 409）、Revision 属于该 Profile、usable=true、
 *   provider=indextts2、canonical hash 与 descriptor 一致、adapter key 一致；
 * - 分类：current_candidate / stale_source / invalid_source（archive 后 historical
 *   exact read 仍 current；新 revision 不 stale 旧 assignment；无 latest fallback）。
 *
 * 幂等（最小 request envelope，设计文档 §4）：deterministic 无 LLM，不用
 * generation_runs（owner_token/lease/indeterminate 语义为 LLM 运行设计）。
 * 表 voice_assignment_requests（UNIQUE(project_id, request_id)）+ 单 BEGIN IMMEDIATE
 * 事务 = 原子唯一性，无 check-then-insert 竞态；同 requestId + 同 (profile, revision)
 * → 复用同一 artifact；不同 → 409。
 */

import crypto from 'node:crypto';
import {getDb, type Db} from '../db';
import {canonicalizeRequestId} from '../llm-generation/runs';
import {getVoiceProfile} from '../voice-library/profiles';
import {
  validateVoiceProfileRevisionExact,
  type VoiceRevisionExactDescriptor,
} from '../voice-library/revisions';
import {
  PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION,
  PROJECT_VOICE_ASSIGNMENT_KIND,
  PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION,
} from './constants';
import {
  projectVoiceAssignmentArtifactV1Schema,
  type ProjectVoiceAssignmentArtifactV1,
} from './assignment-schema';

export type AssignmentErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'REQUEST_ID_REQUIRED'
  | 'REQUEST_ID_INVALID'
  | 'REQUEST_ID_CONFLICT'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_ARCHIVED'
  | 'REVISION_NOT_FOUND'
  | 'VOICE_UNUSABLE';

export class AssignmentError extends Error {
  constructor(public readonly code: AssignmentErrorCode, message: string) {
    super(message);
    this.name = 'AssignmentError';
  }
}

export interface AssignmentArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

export function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ── 行读取 / parse / get / list ──

export function listProjectVoiceAssignmentRows(projectId: string): AssignmentArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, PROJECT_VOICE_ASSIGNMENT_KIND) as AssignmentArtifactRow[];
}

export function parseProjectVoiceAssignment(
  row: AssignmentArtifactRow,
): ProjectVoiceAssignmentArtifactV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = projectVoiceAssignmentArtifactV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function getProjectVoiceAssignment(
  projectId: string,
  artifactId: string,
): {assignment: ProjectVoiceAssignmentArtifactV1; artifact: AssignmentArtifactRow} | null {
  const row = getDb()
    .prepare('SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?')
    .get(artifactId, projectId, PROJECT_VOICE_ASSIGNMENT_KIND) as AssignmentArtifactRow | undefined;
  if (!row) return null;
  const assignment = parseProjectVoiceAssignment(row);
  if (!assignment) return null;
  return {assignment, artifact: row};
}

// ── 分类（deterministic 纯读；archive 后 historical exact read 仍 current） ──

export type AssignmentCandidateStatus = 'current_candidate' | 'stale_source' | 'invalid_source';

export interface AssignmentCandidate {
  artifact: AssignmentArtifactRow;
  assignment: ProjectVoiceAssignmentArtifactV1 | null;
  status: AssignmentCandidateStatus;
  statusReason: string | null;
}

export async function classifyProjectVoiceAssignment(
  projectId: string,
  row: AssignmentArtifactRow,
): Promise<AssignmentCandidate> {
  const assignment = parseProjectVoiceAssignment(row);
  if (!assignment) {
    return {
      artifact: row,
      assignment: null,
      status: 'invalid_source',
      statusReason: '内容无法通过 project-voice-assignment@1.0 契约校验',
    };
  }
  if (assignment.compilerVersion !== PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION) {
    return {
      artifact: row,
      assignment,
      status: 'stale_source',
      statusReason: `compilerVersion ${assignment.compilerVersion} ≠ ${PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION}`,
    };
  }
  // 重新调用 TTS-A exact validator（fail-closed；archive 后 exact read 仍可用，
  // 因此不检查 profile.status——新建时才禁止 archived）。
  const descriptor = await validateVoiceProfileRevisionExact(
    assignment.source.voiceProfileId,
    assignment.source.voiceProfileRevisionId,
  );
  if (!descriptor) {
    return {
      artifact: row,
      assignment,
      status: 'invalid_source',
      statusReason: 'exact voice revision 不可读（profile/revision 缺失、路径非法或文件缺失）',
    };
  }
  if (!descriptor.usable) {
    return {
      artifact: row,
      assignment,
      status: 'invalid_source',
      statusReason: `exact voice revision 不可用（${descriptor.unusableReason ?? 'unknown'}）`,
    };
  }
  return {artifact: row, assignment, status: 'current_candidate', statusReason: null};
}

export async function listProjectVoiceAssignmentCandidates(
  projectId: string,
): Promise<AssignmentCandidate[]> {
  const rows = listProjectVoiceAssignmentRows(projectId);
  const out: AssignmentCandidate[] = [];
  for (const row of rows) {
    out.push(await classifyProjectVoiceAssignment(projectId, row));
  }
  return out;
}

// ── precheck（Web route 与同步 build 共用；fail-closed，不写任何行） ──

export async function precheckProjectVoiceAssignmentSource(input: {
  projectId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  requestId: string;
}): Promise<{requestId: string; descriptor: VoiceRevisionExactDescriptor}> {
  const db: Db = getDb();
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new AssignmentError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = canonicalizeRequestId(input.requestId);
  if (!requestId) {
    throw new AssignmentError(
      'REQUEST_ID_INVALID',
      'requestId 非法：trim 后须为 8–128 字符，仅允许 [A-Za-z0-9._:-]（拒绝空白/换行/控制字符/超长）',
    );
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new AssignmentError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }
  const profile = getVoiceProfile(input.voiceProfileId);
  if (!profile) {
    throw new AssignmentError('PROFILE_NOT_FOUND', `voice profile ${input.voiceProfileId} 不存在`);
  }
  if (profile.status === 'archived') {
    throw new AssignmentError(
      'PROFILE_ARCHIVED',
      `voice profile ${input.voiceProfileId} 已归档，不能创建新的 voice assignment`,
    );
  }
  // TTS-A exact validator（异步：sha256 文件）
  return {requestId, descriptor: await precheckDescriptorOrThrow(input)};
}

async function precheckDescriptorOrThrow(input: {
  voiceProfileId: string;
  voiceProfileRevisionId: string;
}): Promise<VoiceRevisionExactDescriptor> {
  const descriptor = await validateVoiceProfileRevisionExact(
    input.voiceProfileId,
    input.voiceProfileRevisionId,
  );
  if (!descriptor) {
    throw new AssignmentError(
      'REVISION_NOT_FOUND',
      `voice profile revision ${input.voiceProfileRevisionId} 不存在/跨 Profile/路径非法/文件缺失`,
    );
  }
  if (!descriptor.usable) {
    throw new AssignmentError(
      'VOICE_UNUSABLE',
      `exact voice revision ${input.voiceProfileRevisionId} 不可用（${descriptor.unusableReason ?? 'unknown'}）`,
    );
  }
  return descriptor;
}

// ── build（同步 deterministic；单 BEGIN IMMEDIATE 信封事务） ──

export type BuildAssignmentResult =
  | {
      kind: 'created';
      artifact: AssignmentArtifactRow;
      assignment: ProjectVoiceAssignmentArtifactV1;
      reused: false;
    }
  | {
      kind: 'reused';
      artifact: AssignmentArtifactRow;
      assignment: ProjectVoiceAssignmentArtifactV1;
      reused: true;
    };

export async function buildProjectVoiceAssignment(input: {
  projectId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  requestId: string;
}): Promise<BuildAssignmentResult> {
  const db: Db = getDb();
  // precheck 内 await exact validator（异步）；再进入单事务 build
  const pre = await precheckProjectVoiceAssignmentSource(input);
  const {requestId, descriptor} = pre;

  const content: ProjectVoiceAssignmentArtifactV1 = {
    schemaVersion: PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION,
    compilerVersion: PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION,
    projectId: input.projectId,
    source: {
      voiceProfileId: descriptor.row.voice_profile_id,
      voiceProfileRevisionId: descriptor.row.id,
      // usable=true 已保证 schema_version/provider/adapter_compatibility_key 精确等于
      // frozen literal（exact validator 契约），此处断言以匹配 zod literal 类型。
      revisionSchemaVersion: descriptor.row.schema_version as ProjectVoiceAssignmentArtifactV1['source']['revisionSchemaVersion'],
      provider: descriptor.row.provider as ProjectVoiceAssignmentArtifactV1['source']['provider'],
      canonicalAudioSha256: descriptor.row.canonical_audio_sha256,
      adapterCompatibilityKey: descriptor.row.adapter_compatibility_key as ProjectVoiceAssignmentArtifactV1['source']['adapterCompatibilityKey'],
    },
  };

  const tx = db.transaction((): BuildAssignmentResult => {
    const existing = db
      .prepare(
        `SELECT * FROM voice_assignment_requests
         WHERE project_id = ? AND request_id = ?`,
      )
      .get(input.projectId, requestId) as
      | {
          id: string;
          project_id: string;
          request_id: string;
          voice_profile_id: string;
          voice_profile_revision_id: string;
          artifact_id: string;
          created_at: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.voice_profile_id !== input.voiceProfileId ||
        existing.voice_profile_revision_id !== input.voiceProfileRevisionId
      ) {
        throw new AssignmentError(
          'REQUEST_ID_CONFLICT',
          `requestId ${requestId} 已用于 voice profile ${existing.voice_profile_id}@${existing.voice_profile_revision_id}，不得复用于 ${input.voiceProfileId}@${input.voiceProfileRevisionId}`,
        );
      }
      const ref = getProjectVoiceAssignment(input.projectId, existing.artifact_id);
      if (!ref) {
        throw new AssignmentError(
          'REQUEST_ID_CONFLICT',
          `requestId ${requestId} 已存在但对应 artifact ${existing.artifact_id} 不可读（内部不一致）`,
        );
      }
      return {kind: 'reused', artifact: ref.artifact, assignment: ref.assignment, reused: true};
    }

    const artifactId = crypto.randomUUID();
    const iso = new Date().toISOString();
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    ).run(
      artifactId,
      input.projectId,
      PROJECT_VOICE_ASSIGNMENT_KIND,
      input.projectId,
      PROJECT_VOICE_ASSIGNMENT_KIND,
      JSON.stringify(content),
      iso,
    );
    db.prepare(
      `INSERT INTO voice_assignment_requests
         (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, artifact_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      input.projectId,
      requestId,
      input.voiceProfileId,
      input.voiceProfileRevisionId,
      artifactId,
      iso,
    );
    const artifact = db
      .prepare('SELECT * FROM artifacts WHERE id = ?')
      .get(artifactId) as AssignmentArtifactRow | undefined;
    if (!artifact) {
      throw new Error(`buildProjectVoiceAssignment: inserted artifact ${artifactId} not found`);
    }
    return {kind: 'created', artifact, assignment: content, reused: false};
  });
  return tx.immediate();
}

/**
 * TTS-B Project Voice Assignment（设计文档 §3/§4/§8；TTS-B.R1：atomic commit fence）。
 *
 * immutable candidate（artifacts 表 kind='project_voice_assignment'）：
 * - 不 current/active/locked/default；不更新 projects 指针；不建 snapshot；
 * - source 只保存 exact 身份字段，无路径/文本/音频；
 * - 创建前必须经 TTS-A exact validator（validateVoiceProfileRevisionExact）：
 *   Profile 存在且 active（archived → 409 新建）、Revision 属于该 Profile、usable=true、
 *   provider=indextts2、canonical hash 与 descriptor 一致、adapter key 一致；
 * - 分类：current_candidate / stale_source / invalid_source（archive 后 historical
 *   exact read 仍 current；新 revision 不 stale 旧 assignment；无 latest fallback）。
 *
 * Atomic commit fence（TTS-B.R1 §五）：
 * 1. envelope-first 优先裁决（单 BEGIN IMMEDIATE 只读）：既有 envelope →
 *    同 source → 校验既有 artifact 自洽 + exact voice usable（archived 允许
 *    historical reuse）→ 200 reused，不新增；异 source → 409；
 *    artifact 丢失/非法 → fail-closed（REQUEST_STATE_INCONSISTENT）。
 * 2. 新请求：初始 exact validator → Profile 必须 active → 构造 content →
 *    commit 前再次 exact validator（beforeCommitFenceForTest 测试 hook，
 *    仅 NODE_ENV !== production）→ BEGIN IMMEDIATE → 事务内重读：
 *    envelope 仍不存在（同 source 已插入 → reuse；异 → 409）、Profile 仍 active、
 *    revision row exact 属于该 profile 且 schema/provider/hash/adapter 与最终
 *    descriptor 完全一致 → INSERT artifact + envelope。
 *
 * 幂等（最小 request envelope，UNIQUE(project_id, request_id)）：同 requestId +
 * 同 exact revision → 复用；不同 → 409；无 check-then-insert 竞态。
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
  VOICE_UUID_RE,
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
  | 'VOICE_UNUSABLE'
  | 'INVALID_PROFILE_ID'
  | 'INVALID_REVISION_ID'
  | 'REQUEST_STATE_INCONSISTENT'
  | 'ASSIGNMENT_SOURCE_MISMATCH'
  | 'ASSIGNMENT_UNUSABLE';

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

interface AssignmentEnvelopeRow {
  id: string;
  project_id: string;
  request_id: string;
  voice_profile_id: string;
  voice_profile_revision_id: string;
  artifact_id: string;
  created_at: string;
}

export function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ── 测试 hook（仅 NODE_ENV !== production；production 无后门） ──

let beforeCommitFenceForTest: (() => void) | null = null;

export function setAssignmentBeforeCommitFenceForTest(fn: (() => void) | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setAssignmentBeforeCommitFenceForTest 禁止在 NODE_ENV=production 下使用');
  }
  beforeCommitFenceForTest = fn;
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

/**
 * source 自洽（TTS-B.R1 §六）：Assignment content 必须与 exact voice descriptor 逐项一致。
 * 任一不一致 → invalid_source（reason ASSIGNMENT_SOURCE_MISMATCH），绝不返回 current_candidate。
 */
function sourceMismatchReason(
  assignment: ProjectVoiceAssignmentArtifactV1,
  projectId: string,
  row: AssignmentArtifactRow,
  descriptor: VoiceRevisionExactDescriptor,
): string | null {
  const src = assignment.source;
  const mismatches: string[] = [];
  if (row.project_id !== projectId) mismatches.push('row.project_id');
  if (assignment.projectId !== projectId) mismatches.push('projectId');
  if (src.voiceProfileId !== descriptor.row.voice_profile_id) mismatches.push('voiceProfileId');
  if (src.voiceProfileRevisionId !== descriptor.row.id) mismatches.push('voiceProfileRevisionId');
  if (src.revisionSchemaVersion !== descriptor.row.schema_version) mismatches.push('revisionSchemaVersion');
  if (src.provider !== descriptor.row.provider) mismatches.push('provider');
  if (src.canonicalAudioSha256 !== descriptor.row.canonical_audio_sha256) mismatches.push('canonicalAudioSha256');
  if (src.adapterCompatibilityKey !== descriptor.row.adapter_compatibility_key) mismatches.push('adapterCompatibilityKey');
  if (mismatches.length === 0) return null;
  return `ASSIGNMENT_SOURCE_MISMATCH: ${mismatches.join(', ')}`;
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
  // source 自洽（semantic fence——对象保持 schema 可 parse，仅字段值不一致）
  const mismatch = sourceMismatchReason(assignment, projectId, row, descriptor);
  if (mismatch !== null) {
    return {artifact: row, assignment, status: 'invalid_source', statusReason: mismatch};
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

// ── 请求基础校验（requestId + project + UUID shape；malformed → 422） ──

function validateAssignmentRequest(input: {
  projectId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  requestId: string;
}, db: Db): string {
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new AssignmentError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = canonicalizeRequestId(input.requestId);
  if (!requestId) {
    throw new AssignmentError(
      'REQUEST_ID_INVALID',
      'requestId 非法：trim 后须为 8–128 字符，仅允许 [A-Za-z0-9._:-]',
    );
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new AssignmentError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }
  // ID schema（TTS-B.R1 §八）：malformed UUID → 422；well-formed 但不存在 → 404（下方 lookup）
  if (typeof input.voiceProfileId !== 'string' || !VOICE_UUID_RE.test(input.voiceProfileId)) {
    throw new AssignmentError('INVALID_PROFILE_ID', `voiceProfileId 必须是服务端 UUID：${input.voiceProfileId}`);
  }
  if (
    typeof input.voiceProfileRevisionId !== 'string' ||
    !VOICE_UUID_RE.test(input.voiceProfileRevisionId)
  ) {
    throw new AssignmentError(
      'INVALID_REVISION_ID',
      `voiceProfileRevisionId 必须是服务端 UUID：${input.voiceProfileRevisionId}`,
    );
  }
  return requestId;
}

async function exactDescriptorOrThrow(input: {
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

// ── build（同步 deterministic；envelope-first + 两阶段 commit fence） ──

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
  const requestId = validateAssignmentRequest(input, db);

  // 1. envelope-first 优先裁决（单 BEGIN IMMEDIATE 只读；可变 precondition 之前）
  const envelopeFirst = db.transaction((): {kind: 'reused'; artifactId: string} | {kind: 'new'} => {
    const existing = db
      .prepare(
        `SELECT * FROM voice_assignment_requests
         WHERE project_id = ? AND request_id = ?`,
      )
      .get(input.projectId, requestId) as AssignmentEnvelopeRow | undefined;
    if (!existing) return {kind: 'new'};
    if (
      existing.voice_profile_id !== input.voiceProfileId ||
      existing.voice_profile_revision_id !== input.voiceProfileRevisionId
    ) {
      throw new AssignmentError(
        'REQUEST_ID_CONFLICT',
        `requestId ${requestId} 已用于 voice profile ${existing.voice_profile_id}@${existing.voice_profile_revision_id}，不得复用于 ${input.voiceProfileId}@${input.voiceProfileRevisionId}`,
      );
    }
    return {kind: 'reused', artifactId: existing.artifact_id};
  });
  const envResult = envelopeFirst.immediate();

  if (envResult.kind === 'reused') {
    // B：同 source → exact 读取既有 artifact + source 自洽 + voice usable；
    // archived Profile 允许 historical reuse（classify 不检查 profile.status）。
    const ref = getProjectVoiceAssignment(input.projectId, envResult.artifactId);
    if (!ref) {
      throw new AssignmentError(
        'REQUEST_STATE_INCONSISTENT',
        `requestId ${requestId} 的既有 envelope 指向不可读 artifact ${envResult.artifactId}（fail-closed，不重建）`,
      );
    }
    const candidate = await classifyProjectVoiceAssignment(input.projectId, ref.artifact);
    if (candidate.status !== 'current_candidate') {
      throw new AssignmentError(
        'ASSIGNMENT_UNUSABLE',
        `requestId ${requestId} 的既有 assignment 已 ${candidate.status}（${candidate.statusReason ?? ''}）——fail-closed，不创建第二个 artifact`,
      );
    }
    return {kind: 'reused', artifact: ref.artifact, assignment: ref.assignment, reused: true};
  }

  // 2. 新请求：Profile 存在 + active（新请求才禁止 archived），再 exact validator
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
  const initialDescriptor = await exactDescriptorOrThrow(input);

  const content: ProjectVoiceAssignmentArtifactV1 = {
    schemaVersion: PROJECT_VOICE_ASSIGNMENT_SCHEMA_VERSION,
    compilerVersion: PROJECT_VOICE_ASSIGNMENT_COMPILER_VERSION,
    projectId: input.projectId,
    source: {
      voiceProfileId: initialDescriptor.row.voice_profile_id,
      voiceProfileRevisionId: initialDescriptor.row.id,
      // usable=true 已保证 schema_version/provider/adapter_compatibility_key 精确等于
      // frozen literal（exact validator 契约），此处断言以匹配 zod literal 类型。
      revisionSchemaVersion: initialDescriptor.row.schema_version as ProjectVoiceAssignmentArtifactV1['source']['revisionSchemaVersion'],
      provider: initialDescriptor.row.provider as ProjectVoiceAssignmentArtifactV1['source']['provider'],
      canonicalAudioSha256: initialDescriptor.row.canonical_audio_sha256,
      adapterCompatibilityKey: initialDescriptor.row.adapter_compatibility_key as ProjectVoiceAssignmentArtifactV1['source']['adapterCompatibilityKey'],
    },
  };

  // commit 前再次 exact validator（final fence）；测试 hook 在其前（可注入 archive/
  // 删文件等，验证 final validator 与事务内重读能 fail-closed）
  beforeCommitFenceForTest?.();
  const finalDescriptor = await exactDescriptorOrThrow(input);

  // 3. BEGIN IMMEDIATE：事务内重读（envelope 不存在 / Profile active / revision 身份一致）
  const tx = db.transaction((): BuildAssignmentResult => {
    const existing2 = db
      .prepare(
        `SELECT * FROM voice_assignment_requests
         WHERE project_id = ? AND request_id = ?`,
      )
      .get(input.projectId, requestId) as AssignmentEnvelopeRow | undefined;
    if (existing2) {
      // 另一请求已插入 envelope：same source → exact reuse；different → 409；不建第二个
      if (
        existing2.voice_profile_id !== input.voiceProfileId ||
        existing2.voice_profile_revision_id !== input.voiceProfileRevisionId
      ) {
        throw new AssignmentError(
          'REQUEST_ID_CONFLICT',
          `requestId ${requestId} 已在事务内被其他请求占用（${existing2.voice_profile_id}@${existing2.voice_profile_revision_id}）`,
        );
      }
      const ref2 = getProjectVoiceAssignment(input.projectId, existing2.artifact_id);
      if (!ref2) {
        throw new AssignmentError('REQUEST_STATE_INCONSISTENT', `并发插入的 envelope 指向不可读 artifact`);
      }
      return {kind: 'reused', artifact: ref2.artifact, assignment: ref2.assignment, reused: true};
    }
    const profileNow = getVoiceProfile(input.voiceProfileId);
    if (!profileNow) {
      throw new AssignmentError('PROFILE_NOT_FOUND', `voice profile ${input.voiceProfileId} 不存在`);
    }
    if (profileNow.status === 'archived') {
      throw new AssignmentError(
        'PROFILE_ARCHIVED',
        `voice profile ${input.voiceProfileId} 已归档，不能创建新的 voice assignment`,
      );
    }
    // revision row exact 身份与最终 descriptor 完全一致（fail-closed）
    const revRow = db
      .prepare('SELECT * FROM voice_profile_revisions WHERE id = ? AND voice_profile_id = ?')
      .get(input.voiceProfileRevisionId, input.voiceProfileId) as
      | {
          schema_version: string;
          provider: string;
          canonical_audio_sha256: string;
          adapter_compatibility_key: string;
        }
      | undefined;
    if (!revRow) {
      throw new AssignmentError(
        'REVISION_NOT_FOUND',
        `revision ${input.voiceProfileRevisionId} 不属于 profile ${input.voiceProfileId}（事务内重读）`,
      );
    }
    if (
      revRow.schema_version !== finalDescriptor.row.schema_version ||
      revRow.provider !== finalDescriptor.row.provider ||
      revRow.canonical_audio_sha256 !== finalDescriptor.row.canonical_audio_sha256 ||
      revRow.adapter_compatibility_key !== finalDescriptor.row.adapter_compatibility_key
    ) {
      throw new AssignmentError(
        'VOICE_UNUSABLE',
        'revision 行身份与 commit 前 descriptor 不一致（voice 在提交前变化，fail-closed）',
      );
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

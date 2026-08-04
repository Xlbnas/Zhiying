/**
 * TTS-C.1A — Durable Voice Materialization 核心（Phase 1/2/3 + Worker 终局）。
 *
 * 数据流：exact Assignment → project-scoped request envelope（initializing→waiting）
 *   → single-flight validating_existing job（Scheduler 不可见）→ fenced finalize
 *   （usable→reused 零文件写 / zero subscriber→cancelled / unusable→queued）
 *   → Worker durable copy（temp→fsync→validate→rename→fsync→dir-fsync）
 *   → projection file_ready_unpublished（唯一终态；不发布 registry）。
 *
 * 全部写路径使用 BEGIN IMMEDIATE 原子事务；fence 失败 → STALE_VALIDATION_OWNER /
 * 对应错误，零副作用。fail-closed：无 latest fallback、路径包含性、symlink 拒绝。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {getDb, type Db} from '../db';
import {getProjectVoiceAssignment, classifyProjectVoiceAssignment} from '../tts-b/assignment';
import {validateVoiceProfileRevisionExact} from '../voice-library/revisions';
import {
  destinationRelativePath,
  destinationAbsolutePath,
  materializationRootAbs,
} from './paths';
import {MATERIALIZATION_VALIDATION_LEASE_MS} from './constants';
import {probeAudio, sha256FileBytes} from './audio-probe';

export type MaterializationErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'ASSIGNMENT_UNUSABLE'
  | 'REQUEST_ID_REQUIRED'
  | 'REQUEST_ID_INVALID'
  | 'REQUEST_ID_CONFLICT'
  | 'REQUEST_STATE_INCONSISTENT'
  | 'STALE_VALIDATION_OWNER'
  | 'SOURCE_STALE'
  | 'MATERIALIZATION_ALREADY_EXISTS';

export class MaterializationError extends Error {
  constructor(
    public readonly code: MaterializationErrorCode,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'MaterializationError';
  }
}

export interface VoiceMaterializationRequestRow {
  id: string;
  project_id: string;
  request_id: string;
  voice_profile_id: string;
  voice_profile_revision_id: string;
  assignment_artifact_id: string;
  request_fingerprint: string;
  job_id: string | null;
  materialization_id: string | null;
  status: 'initializing' | 'waiting' | 'running' | 'succeeded' | 'reused' | 'failed' | 'cancelled' | 'indeterminate';
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceMaterializationJobRow {
  id: string;
  voice_profile_id: string;
  voice_profile_revision_id: string;
  status: 'validating_existing' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
  owner_token: string | null;
  lease_expires_at_epoch_ms: number | null;
  heartbeat_at: string | null;
  validation_owner_token: string | null;
  validation_lease_expires_at_epoch_ms: number | null;
  validation_attempt: number;
  candidate_materialization_id: string | null;
  candidate_materialization_metadata_hash: string | null;
  source_canonical_sha256: string;
  adapter_compatibility_key: string;
  destination_voice_root_relative_path: string;
  attempt: number;
  max_attempts: number;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceMaterializationRow {
  id: string;
  voice_profile_id: string;
  voice_profile_revision_id: string;
  source_canonical_sha256: string;
  adapter_compatibility_key: string;
  destination_voice_root_relative_path: string;
  status: 'file_ready_unpublished' | 'published_usable' | 'failed' | 'indeterminate';
  published_registry_generation: number | null;
  published_registry_sha256: string | null;
  published_by_publication_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * P0-1：不可伪造的 validation ownership handle。
 * 只有 Phase 1 创建 job 或 fenced takeover（changes=1）的赢家持有；
 * 禁止接受"一整行 fresh DB job"作为 ownership credential——
 * loser 重读 DB 只能得到当前行，不得获得 handle。
 */
export interface ValidationLeaseHandle {
  jobId: string;
  validationOwnerToken: string;
  validationAttempt: number;
  validationLeaseExpiresAtEpochMs: number;
  candidateMaterializationId: string | null;
  candidateMaterializationMetadataHash: string | null;
}

/** P0-2：Worker execution lease handle（scheduler claim 返回；executor/final 全程 exact）。 */
export interface MaterializationExecutionHandle {
  jobId: string;
  ownerToken: string;
  attempt: number;
  leaseExpiresAtEpochMs: number;
}

const DBNOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowEpochMs(): number {
  return Date.now();
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── 行读取 ──

export function getMaterializationRequest(
  projectId: string,
  requestId: string,
): VoiceMaterializationRequestRow | undefined {
  return getDb()
    .prepare('SELECT * FROM voice_materialization_requests WHERE project_id = ? AND request_id = ?')
    .get(projectId, requestId) as VoiceMaterializationRequestRow | undefined;
}

export function listMaterializationRequests(projectId: string): VoiceMaterializationRequestRow[] {
  return getDb()
    .prepare('SELECT * FROM voice_materialization_requests WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as VoiceMaterializationRequestRow[];
}

export function getMaterializationJob(jobId: string): VoiceMaterializationJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM voice_materialization_jobs WHERE id = ?')
    .get(jobId) as VoiceMaterializationJobRow | undefined;
}

export function getActiveMaterializationJob(
  profileId: string,
  revisionId: string,
): VoiceMaterializationJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM voice_materialization_jobs
       WHERE voice_profile_id = ? AND voice_profile_revision_id = ?
         AND status IN ('validating_existing','queued','running','indeterminate')`,
    )
    .get(profileId, revisionId) as VoiceMaterializationJobRow | undefined;
}

export function getProjection(profileId: string, revisionId: string): VoiceMaterializationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM voice_materializations WHERE voice_profile_id = ? AND voice_profile_revision_id = ?')
    .get(profileId, revisionId) as VoiceMaterializationRow | undefined;
}

export function listActiveRequestRows(jobId: string): VoiceMaterializationRequestRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM voice_materialization_requests
       WHERE job_id = ? AND status IN ('waiting','running') ORDER BY created_at ASC`,
    )
    .all(jobId) as VoiceMaterializationRequestRow[];
}

// ── 源身份派生（唯一权威，无第二套 identity） ──

export interface MaterializationSourceIdentity {
  projectId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  canonicalAudioSha256: string;
  adapterCompatibilityKey: string;
  provider: string;
  assignmentArtifactId: string;
  requestFingerprint: string;
}

export async function resolveMaterializationSourceIdentity(
  projectId: string,
  assignmentArtifactId: string,
): Promise<MaterializationSourceIdentity> {
  const found = getProjectVoiceAssignment(projectId, assignmentArtifactId);
  if (!found) throw new MaterializationError('ASSIGNMENT_NOT_FOUND', `assignment ${assignmentArtifactId} 不存在或不属于 project ${projectId}`, 404);
  const classified = await classifyProjectVoiceAssignment(projectId, found.artifact);
  if (classified.status !== 'current_candidate' || !classified.assignment) {
    throw new MaterializationError(
      'ASSIGNMENT_UNUSABLE',
      `assignment 不可用（${classified.statusReason ?? 'unknown'}）——无 latest fallback`,
      422,
    );
  }
  const src = classified.assignment.source;
  const fingerprint = sha256Text(
    JSON.stringify({
      projectId,
      voiceProfileId: src.voiceProfileId,
      voiceProfileRevisionId: src.voiceProfileRevisionId,
      canonicalAudioSha256: src.canonicalAudioSha256,
      adapterCompatibilityKey: src.adapterCompatibilityKey,
      provider: src.provider,
    }),
  );
  return {
    projectId,
    voiceProfileId: src.voiceProfileId,
    voiceProfileRevisionId: src.voiceProfileRevisionId,
    canonicalAudioSha256: src.canonicalAudioSha256,
    adapterCompatibilityKey: src.adapterCompatibilityKey,
    provider: src.provider,
    assignmentArtifactId,
    requestFingerprint: fingerprint,
  };
}

// ── Phase 2：exact projection/file validator（事务外只读） ──

export type ProjectionValidationResult =
  | {kind: 'usable'; projection: VoiceMaterializationRow; fileSha256: string}
  | {kind: 'unusable'; reason: string};

export async function validateExistingProjection(
  projection: VoiceMaterializationRow,
): Promise<ProjectionValidationResult> {
  if (projection.status !== 'file_ready_unpublished' && projection.status !== 'published_usable') {
    return {kind: 'unusable', reason: `projection status=${projection.status}`};
  }
  const descriptor = await validateVoiceProfileRevisionExact(
    projection.voice_profile_id,
    projection.voice_profile_revision_id,
  );
  if (!descriptor) return {kind: 'unusable', reason: 'exact voice revision 不可读'};
  if (!descriptor.usable) {
    return {kind: 'unusable', reason: descriptor.unusableReason ?? 'hash_mismatch'};
  }
  // projection 文件本身必须存在且内容 exact（设计 §5.2：文件存在 + SHA/codec/size 一致）
  const abs = destinationAbsolutePath(projection.destination_voice_root_relative_path);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    return {kind: 'unusable', reason: 'projection 文件不存在'};
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return {kind: 'unusable', reason: 'projection 非 regular file（拒绝 symlink）'};
  }
  if (st.size !== descriptor.fileSize) {
    return {kind: 'unusable', reason: `projection size 不一致（${st.size} ≠ ${descriptor.fileSize}）`};
  }
  let fileSha256: string;
  try {
    fileSha256 = await sha256FileBytes(abs);
  } catch {
    return {kind: 'unusable', reason: 'projection 文件不可读'};
  }
  if (fileSha256 !== projection.source_canonical_sha256) {
    return {kind: 'unusable', reason: `projection sha256 不一致（${fileSha256.slice(0, 12)}…）`};
  }
  let probe;
  try {
    probe = probeAudio(abs);
  } catch {
    return {kind: 'unusable', reason: 'projection 非可读 WAV'};
  }
  if (probe.codec !== 'pcm_s16le' || probe.sampleRate !== 48000 || probe.channels !== 1 || probe.durationMs <= 0) {
    return {kind: 'unusable', reason: `projection WAV 契约不匹配: ${JSON.stringify(probe)}`};
  }
  return {
    kind: 'usable',
    projection,
    fileSha256,
  };
}

// ── Phase 3：fenced finalize（BEGIN IMMEDIATE；只接受 handle，不接受整行 fresh job） ──

export type FinalizeOutcome = 'reused' | 'queued' | 'cancelled' | 'inflight' | 'failed' | 'indeterminate';

export function finalizeValidatingJob(
  handle: ValidationLeaseHandle,
  validationResult: ProjectionValidationResult,
  db: Db = getDb(),
): FinalizeOutcome {
  const now = nowIso();
  const outcome = db.transaction((): FinalizeOutcome => {
    // fenced reread：凭据只来自 handle（id/token/attempt/lease/candidate id+hash exact）
    const fresh = db
      .prepare(
        `SELECT * FROM voice_materialization_jobs
         WHERE id = ? AND status = 'validating_existing'
           AND validation_owner_token = ? AND validation_attempt = ?
           AND (${DBNOW_MS}) <= validation_lease_expires_at_epoch_ms
           AND candidate_materialization_id IS ?
           AND candidate_materialization_metadata_hash IS ?`,
      )
      .get(
        handle.jobId,
        handle.validationOwnerToken,
        handle.validationAttempt,
        handle.candidateMaterializationId,
        handle.candidateMaterializationMetadataHash,
      ) as VoiceMaterializationJobRow | undefined;
    if (!fresh) {
      throw new MaterializationError('STALE_VALIDATION_OWNER', 'validation handle 已失效（接管/过期）', 409);
    }
    const subscribers = listActiveRequestRows(handle.jobId);

    if (validationResult.kind === 'usable') {
      const projection = validationResult.projection;
      // 零文件写：job→succeeded + active requests→reused
      const j = db
        .prepare(
          `UPDATE voice_materialization_jobs
           SET status = 'succeeded', validation_owner_token = NULL,
               validation_lease_expires_at_epoch_ms = NULL, updated_at = ?
           WHERE id = ? AND status = 'validating_existing'`,
        )
        .run(now, handle.jobId);
      if (j.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'job finalize failed', 409);
      for (const r of subscribers) {
        const res = db
          .prepare(
            `UPDATE voice_materialization_requests
             SET status = 'reused', materialization_id = ?, updated_at = ?
             WHERE id = ? AND status IN ('waiting','running')`,
          )
          .run(projection.id, now, r.id);
        if (res.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'request reuse failed', 409);
      }
      return 'reused';
    }

    // unusable
    if (subscribers.length === 0) {
      const j = db
        .prepare(
          `UPDATE voice_materialization_jobs
           SET status = 'cancelled', validation_owner_token = NULL,
               validation_lease_expires_at_epoch_ms = NULL, updated_at = ?
           WHERE id = ? AND status = 'validating_existing'`,
        )
        .run(now, handle.jobId);
      if (j.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'job cancel failed', 409);
      return 'cancelled';
    }
    // unusable + subscriber>0 → queued（Scheduler 才可见）
    const j = db
      .prepare(
        `UPDATE voice_materialization_jobs
         SET status = 'queued', validation_owner_token = NULL,
             validation_lease_expires_at_epoch_ms = NULL, updated_at = ?
         WHERE id = ? AND status = 'validating_existing'`,
      )
      .run(now, handle.jobId);
    if (j.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'job enqueue failed', 409);
    return 'queued';
  });
  return outcome.immediate();
}

// ── stale validating job 接管（fenced CAS；只有赢家返回 handle） ──

export function takeoverStaleValidatingJob(jobId: string, db: Db = getDb()): ValidationLeaseHandle | null {
  const token = crypto.randomUUID();
  const lease = nowEpochMs() + MATERIALIZATION_VALIDATION_LEASE_MS;
  const res = db
    .prepare(
      `UPDATE voice_materialization_jobs
       SET validation_owner_token = ?, validation_lease_expires_at_epoch_ms = ?,
           validation_attempt = validation_attempt + 1, updated_at = ?
       WHERE id = ? AND status = 'validating_existing'
         AND validation_lease_expires_at_epoch_ms < (${DBNOW_MS})`,
    )
    .run(token, lease, nowIso(), jobId);
  if (res.changes !== 1) return null; // loser：不重读借用新 owner token
  const fresh = db
    .prepare('SELECT * FROM voice_materialization_jobs WHERE id = ?')
    .get(jobId) as VoiceMaterializationJobRow;
  return {
    jobId: fresh.id,
    validationOwnerToken: fresh.validation_owner_token!,
    validationAttempt: fresh.validation_attempt,
    validationLeaseExpiresAtEpochMs: fresh.validation_lease_expires_at_epoch_ms!,
    candidateMaterializationId: fresh.candidate_materialization_id,
    candidateMaterializationMetadataHash: fresh.candidate_materialization_metadata_hash,
  };
}

// ── 主入口：createMaterializationRequest（Phase 1 + Phase 2 + Phase 3） ──

export interface CreateMaterializationRequestResult {
  request: VoiceMaterializationRequestRow;
  job: VoiceMaterializationJobRow;
  outcome: FinalizeOutcome;
  projection: VoiceMaterializationRow | null;
  adapterReady: false;
}

type Phase1Result =
  | {kind: 'existing'; request: VoiceMaterializationRequestRow}
  | {
      kind: 'new';
      request: VoiceMaterializationRequestRow;
      job: VoiceMaterializationJobRow;
      handle: ValidationLeaseHandle | null;
    };

/** P1：existing request outcome 必须基于持久状态映射，禁止统一 reused。 */
function existingRequestResult(
  request: VoiceMaterializationRequestRow,
  identity: MaterializationSourceIdentity,
): CreateMaterializationRequestResult {
  const projection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null;
  const job = request.job_id ? getMaterializationJob(request.job_id) : undefined;
  if (!job) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 无 job 关联`, 409);
  const base = {request, job, projection, adapterReady: false as const};
  switch (request.status) {
    case 'succeeded':
    case 'reused': {
      if (!request.materialization_id) {
        throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 终态缺 materialization_id`, 409);
      }
      if (!projection) {
        throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 终态缺 projection`, 409);
      }
      return {...base, outcome: 'reused'};
    }
    case 'waiting': {
      // 按 job 真实状态映射（fan-in 不运行 validator/finalize）
      switch (job.status) {
        case 'validating_existing':
        case 'running':
        case 'indeterminate':
          return {...base, outcome: 'inflight'};
        case 'queued':
          return {...base, outcome: 'queued'};
        case 'succeeded':
          return {...base, outcome: 'reused'};
        case 'failed':
          return {...base, outcome: 'failed'};
        case 'cancelled':
          return {...base, outcome: 'cancelled'};
      }
      break;
    }
    case 'running':
      return {...base, outcome: 'inflight'};
    case 'failed':
      return {...base, outcome: 'failed'};
    case 'cancelled':
      return {...base, outcome: 'cancelled'};
    case 'indeterminate':
      return {...base, outcome: 'indeterminate'};
    case 'initializing':
      // committed initializing 不允许长期存在（冻结语义）
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 遗留 committed initializing`, 409);
  }
  throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 状态映射失败`, 409);
}

/** 无 handle 的新请求：按 job 真实状态映射 outcome。 */
function jobOutcomeResult(
  job: VoiceMaterializationJobRow,
  request: VoiceMaterializationRequestRow,
  identity: MaterializationSourceIdentity,
): CreateMaterializationRequestResult {
  const projection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null;
  const base = {request, job, projection, adapterReady: false as const};
  switch (job.status) {
    case 'queued':
      return {...base, outcome: 'queued'};
    case 'running':
    case 'validating_existing':
    case 'indeterminate':
      return {...base, outcome: 'inflight'};
    case 'succeeded':
      return {...base, outcome: 'reused'};
    case 'failed':
      return {...base, outcome: 'failed'};
    case 'cancelled':
      return {...base, outcome: 'cancelled'};
  }
  throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `job ${job.id} 状态映射失败`, 409);
}

export async function createMaterializationRequest(
  projectId: string,
  requestId: string,
  assignmentArtifactId: string,
): Promise<CreateMaterializationRequestResult> {
  if (!requestId || requestId.length === 0) throw new MaterializationError('REQUEST_ID_REQUIRED', 'requestId 必填', 422);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) throw new MaterializationError('REQUEST_ID_INVALID', 'requestId 格式非法', 422);
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new MaterializationError('PROJECT_NOT_FOUND', `project ${projectId} 不存在`, 404);

  // 事务外只读身份解析（Assignment + classify + exact Revision 可读性；fail-closed 无 fallback）
  const identity = await resolveMaterializationSourceIdentity(projectId, assignmentArtifactId);
  const descriptor = await validateVoiceProfileRevisionExact(identity.voiceProfileId, identity.voiceProfileRevisionId);
  if (!descriptor) {
    throw new MaterializationError('ASSIGNMENT_UNUSABLE', 'exact voice revision 不可读（profile/revision 缺失或路径非法）', 422);
  }

  // P1：envelope-first BEGIN IMMEDIATE 裁决（requestId 检查与 INSERT 同事务，无 TOCTOU；
  // UNIQUE race 在事务内捕获重读裁决，不允许逃逸成 500）
  const now = nowIso();
  const tx = db.transaction((): Phase1Result => {
    const existing = db
      .prepare('SELECT * FROM voice_materialization_requests WHERE project_id = ? AND request_id = ?')
      .get(projectId, requestId) as VoiceMaterializationRequestRow | undefined;
    if (existing) {
      if (existing.request_fingerprint !== identity.requestFingerprint) {
        throw new MaterializationError(
          'REQUEST_ID_CONFLICT',
          `requestId ${requestId} 已被不同 exact source 占用`,
          409,
        );
      }
      return {kind: 'existing', request: existing};
    }

    const requestIdUuid = crypto.randomUUID();
    try {
      db.prepare(
        `INSERT INTO voice_materialization_requests
           (id, project_id, request_id, voice_profile_id, voice_profile_revision_id,
            assignment_artifact_id, request_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`,
      ).run(requestIdUuid, projectId, requestId, identity.voiceProfileId, identity.voiceProfileRevisionId,
        identity.assignmentArtifactId, identity.requestFingerprint, now, now);
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        // 并发 INSERT race：重读并裁决（不逃逸成 500）
        const raced = db
          .prepare('SELECT * FROM voice_materialization_requests WHERE project_id = ? AND request_id = ?')
          .get(projectId, requestId) as VoiceMaterializationRequestRow | undefined;
        if (raced) {
          if (raced.request_fingerprint !== identity.requestFingerprint) {
            throw new MaterializationError(
              'REQUEST_ID_CONFLICT',
              `requestId ${requestId} 已被不同 exact source 占用`,
              409,
            );
          }
          return {kind: 'existing', request: raced};
        }
      }
      throw err;
    }

    // job 查/建 + validation handle（P0-1）
    const existingProjection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId);
    let activeJob = getActiveMaterializationJob(identity.voiceProfileId, identity.voiceProfileRevisionId);
    let handle: ValidationLeaseHandle | null = null;
    if (activeJob && activeJob.status === 'running'
        && activeJob.lease_expires_at_epoch_ms !== null
        && activeJob.lease_expires_at_epoch_ms < nowEpochMs()) {
      // 失联 running（lease 已过期）：同事务 fenced running→failed + 该 job 的
      // waiting/running requests → failed（request.job_id write-once，不能重链接；
      // 失败请求显式终态，新请求自建 envelope → 新 job）
      const died = db
        .prepare(
          `UPDATE voice_materialization_jobs
           SET status = 'failed', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
               heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'
             AND lease_expires_at_epoch_ms < (${DBNOW_MS})`,
        )
        .run(nowIso(), activeJob.id);
      if (died.changes === 1) {
        db.prepare(
          `UPDATE voice_materialization_requests SET status = 'failed', updated_at = ?
           WHERE job_id = ? AND status IN ('waiting','running')`,
        ).run(nowIso(), activeJob.id);
      }
      activeJob = undefined;
    }
    if (!activeJob) {
      // 新 job：本请求是 validation owner → handle
      const jobId = crypto.randomUUID();
      const token = crypto.randomUUID();
      const lease = nowEpochMs() + MATERIALIZATION_VALIDATION_LEASE_MS;
      const destRel = destinationRelativePath(identity.voiceProfileId, identity.voiceProfileRevisionId);
      const candidateHash = existingProjection
        ? sha256Text(JSON.stringify({id: existingProjection.id, status: existingProjection.status, sha: existingProjection.source_canonical_sha256}))
        : null;
      db.prepare(
        `INSERT INTO voice_materialization_jobs
           (id, voice_profile_id, voice_profile_revision_id, status,
            validation_owner_token, validation_lease_expires_at_epoch_ms, validation_attempt,
            candidate_materialization_id, candidate_materialization_metadata_hash,
            source_canonical_sha256, adapter_compatibility_key, destination_voice_root_relative_path,
            created_at, updated_at)
         VALUES (?, ?, ?, 'validating_existing', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(jobId, identity.voiceProfileId, identity.voiceProfileRevisionId,
        token, lease,
        existingProjection ? existingProjection.id : null, candidateHash,
        identity.canonicalAudioSha256, identity.adapterCompatibilityKey, destRel, now, now);
      handle = {
        jobId,
        validationOwnerToken: token,
        validationAttempt: 1,
        validationLeaseExpiresAtEpochMs: lease,
        candidateMaterializationId: existingProjection ? existingProjection.id : null,
        candidateMaterializationMetadataHash: candidateHash,
      };
      activeJob = getMaterializationJob(jobId)!;
    } else if (activeJob.status === 'validating_existing'
        && activeJob.validation_lease_expires_at_epoch_ms !== null
        && activeJob.validation_lease_expires_at_epoch_ms < nowEpochMs()) {
      // stale validating：fenced takeover——赢家拿 handle；输家 null（只 fan-in，不跑 validator）
      handle = takeoverStaleValidatingJob(activeJob.id, db);
    }
    // 其余（validating_existing lease 有效 / queued / running 有效 / indeterminate）：
    // handle=null，只 fan-in 链接，不运行 validateExistingProjection，不 finalize

    // 链接 request→job + request→waiting（同一事务）
    const linked = db
      .prepare(
        `UPDATE voice_materialization_requests
         SET status = 'waiting', job_id = ?, updated_at = ?
         WHERE id = ? AND status = 'initializing'`,
      )
      .run(activeJob.id, now, requestIdUuid);
    if (linked.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'request link failed', 409);
    return {
      kind: 'new',
      request: getMaterializationRequest(projectId, requestId)!,
      job: activeJob,
      handle,
    };
  });
  const r1 = tx.immediate();

  if (r1.kind === 'existing') {
    return existingRequestResult(r1.request, identity);
  }

  if (r1.handle) {
    // 我是 validation owner：Phase 2（事务外只读）→ Phase 3（handle fenced finalize；
    // Phase 2 期间 lease 被接管/过期 → finalize fenced reread 失败 → STALE，零更新）
    const projection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId);
    const validation: ProjectionValidationResult = projection
      ? await validateExistingProjection(projection)
      : {kind: 'unusable', reason: 'no projection yet'};
    const outcome = finalizeValidatingJob(r1.handle, validation);
    return {
      request: r1.request,
      job: getMaterializationJob(r1.job.id)!,
      outcome,
      projection: validation.kind === 'usable' ? validation.projection : null,
      adapterReady: false,
    };
  }

  // 无 handle（fan-in / queued / running / indeterminate / takeover loser）：按真实状态映射
  return jobOutcomeResult(r1.job, r1.request, identity);
}

// ── Worker 侧：claim 后终局（materialization-executor 调用） ──

export interface WorkerFinalizeInput {
  /** P0-2：execution handle（claim 时取得；final WHERE 必须 exact owner/attempt/lease） */
  handle: MaterializationExecutionHandle;
  /** 最终文件证据（executor 实测） */
  finalRelativePath: string;
  finalSha256: string;
  finalSize: number;
  codec: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  /** 开始前 exact Revision descriptor 证据（commit 时逐项重读比对） */
  revisionEvidence: {
    voiceProfileId: string;
    voiceProfileRevisionId: string;
    canonicalAudioSha256: string;
    adapterCompatibilityKey: string;
    provider: string;
    fileSize: number;
  };
}

export interface WorkerFinalizeResult {
  projectionId: string;
  requestsUpdated: number;
}

/**
 * BEGIN IMMEDIATE 原子终局（P0-2 + commit-time exact source fence）：
 *   fenced reread job（status='running' + owner_token=handle + attempt=handle + DB_NOW<=lease）→
 *   cancel_requested 裁决 → destination path shape 复核 →
 *   exact Revision DB metadata identity 重读（sha/adapter/provider 逐项）→
 *   每个 active request 的 Assignment source 逐项重读（project/profile/revision/provider/sha/adapter）→
 *   final evidence 逐项比较（relative path/SHA/size/regular/codec/sr/ch/duration）→
 *   INSERT（或 repair failed/indeterminate→file_ready）projection → job→succeeded →
 *   active requests→succeeded + materialization_id。
 * 任一失败整事务回滚；cancel_requested → 不写 projection，job/requests cancelled。
 */
export function workerFinalizeMaterialization(
  input: WorkerFinalizeInput,
  db: Db = getDb(),
): WorkerFinalizeResult {
  const now = nowIso();
  const outcome = db.transaction((): WorkerFinalizeResult => {
    // P0-2：execution handle exact fence（禁止仅 owner_token IS NOT NULL）
    const job = db
      .prepare(
        `SELECT * FROM voice_materialization_jobs
         WHERE id = ? AND status = 'running'
           AND owner_token = ? AND attempt = ?
           AND (${DBNOW_MS}) <= lease_expires_at_epoch_ms`,
      )
      .get(input.handle.jobId, input.handle.ownerToken, input.handle.attempt) as VoiceMaterializationJobRow | undefined;
    if (!job) {
      throw new MaterializationError('STALE_VALIDATION_OWNER', 'execution handle 已失效（接管/过期）', 409);
    }
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE voice_materialization_jobs
         SET status = 'cancelled', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
             heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, job.id);
      const reqs = db
        .prepare(
          `UPDATE voice_materialization_requests SET status = 'cancelled', updated_at = ?
           WHERE job_id = ? AND status IN ('waiting','running')`,
        )
        .run(now, job.id);
      return {projectionId: '', requestsUpdated: reqs.changes};
    }
    // commit-time exact source fence（§八：逐项重读，全部证据参与）
    // 1) destination path shape（job 冻结值 vs 实测 final path）
    const destRel = destinationRelativePath(job.voice_profile_id, job.voice_profile_revision_id);
    if (destRel !== job.destination_voice_root_relative_path) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'destination path 漂移（与 job 冻结值不一致）', 409);
    }
    if (input.finalRelativePath !== job.destination_voice_root_relative_path) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'final relative path 与 job 冻结值不一致', 409);
    }
    // 2) exact Revision DB metadata identity 重读（TTS-A row 为唯一真相）
    const revisionRow = db
      .prepare('SELECT * FROM voice_profile_revisions WHERE id = ? AND voice_profile_id = ?')
      .get(job.voice_profile_revision_id, job.voice_profile_id) as
      | {canonical_audio_sha256: string; adapter_compatibility_key: string; provider: string}
      | undefined;
    if (
      !revisionRow ||
      revisionRow.canonical_audio_sha256 !== input.revisionEvidence.canonicalAudioSha256 ||
      revisionRow.adapter_compatibility_key !== input.revisionEvidence.adapterCompatibilityKey ||
      revisionRow.provider !== input.revisionEvidence.provider
    ) {
      throw new MaterializationError('SOURCE_STALE', 'exact Revision metadata identity 漂移（commit 前被改写）', 409);
    }
    if (
      job.source_canonical_sha256 !== input.revisionEvidence.canonicalAudioSha256 ||
      job.adapter_compatibility_key !== input.revisionEvidence.adapterCompatibilityKey
    ) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'job 冻结源身份与 revisionEvidence 不一致', 409);
    }
    // 3) 每个 active request 的 Assignment source 逐项重读
    const subscribers = listActiveRequestRows(job.id);
    for (const r of subscribers) {
      const asg = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
      if (!asg) {
        throw new MaterializationError('SOURCE_STALE', `request ${r.request_id} assignment 不可读`, 409);
      }
      const src = asg.assignment.source;
      if (
        src.voiceProfileId !== job.voice_profile_id ||
        src.voiceProfileRevisionId !== job.voice_profile_revision_id ||
        src.canonicalAudioSha256 !== job.source_canonical_sha256 ||
        src.adapterCompatibilityKey !== job.adapter_compatibility_key ||
        src.provider !== input.revisionEvidence.provider
      ) {
        throw new MaterializationError('SOURCE_STALE', `request ${r.request_id} assignment source 漂移（commit 前被改写）`, 409);
      }
    }
    // 4) final evidence 逐项比较（全部字段参与，不允许 unused）
    if (input.finalSha256 !== job.source_canonical_sha256) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'final SHA 与 job 冻结值不一致', 409);
    }
    if (input.finalSize !== input.revisionEvidence.fileSize) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'final size 与 revision 不一致', 409);
    }
    if (input.codec !== 'pcm_s16le' || input.sampleRate !== 48000 || input.channels !== 1 || input.durationMs <= 0) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `final WAV 契约不匹配: ${JSON.stringify({codec: input.codec, sampleRate: input.sampleRate, channels: input.channels, durationMs: input.durationMs})}`, 409);
    }
    // projection：INSERT 或 repair（failed/indeterminate → file_ready_unpublished）
    const existing = db
      .prepare('SELECT * FROM voice_materializations WHERE voice_profile_id = ? AND voice_profile_revision_id = ?')
      .get(job.voice_profile_id, job.voice_profile_revision_id) as VoiceMaterializationRow | undefined;
    let projectionId: string;
    if (!existing) {
      projectionId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO voice_materializations
           (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
            adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'file_ready_unpublished', ?, ?)`,
      ).run(projectionId, job.voice_profile_id, job.voice_profile_revision_id,
        job.source_canonical_sha256, job.adapter_compatibility_key, destRel, now, now);
    } else if (existing.status === 'failed' || existing.status === 'indeterminate') {
      projectionId = existing.id;
      db.prepare(
        `UPDATE voice_materializations SET status = 'file_ready_unpublished', updated_at = ? WHERE id = ?`,
      ).run(now, existing.id);
    } else {
      throw new MaterializationError('MATERIALIZATION_ALREADY_EXISTS', 'projection 已存在（应走 reuse）', 409);
    }
    const j = db
      .prepare(
        `UPDATE voice_materialization_jobs
         SET status = 'succeeded', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
             heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'
           AND owner_token = ? AND attempt = ?`,
      )
      .run(now, job.id, input.handle.ownerToken, input.handle.attempt);
    if (j.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'job success failed', 409);
    const reqs = db
      .prepare(
        `UPDATE voice_materialization_requests
         SET status = 'succeeded', materialization_id = ?, updated_at = ?
         WHERE job_id = ? AND status IN ('waiting','running')`,
      )
      .run(projectionId, now, job.id);
    return {projectionId, requestsUpdated: reqs.changes};
  });
  return outcome.immediate();
}

// ── Autonomous recovery（不依赖新 HTTP request；Worker scheduler tick 前调用） ──

export type RecoveryVerdict = 'recovered_success' | 'failed' | 'indeterminate' | 'not_owned';

/**
 * 确定性 executor 错误且仍持有 exact owner/attempt/lease → 立即 fenced failed + fan-out，
 * 不等待 lease 自然过期（prompt §七）。
 */
export function failMaterializationJobFenced(
  handle: MaterializationExecutionHandle,
  errorCode: string,
  errorMessage: string,
  db: Db = getDb(),
): boolean {
  const now = nowIso();
  const res = db.transaction((): boolean => {
    const j = db
      .prepare(
        `UPDATE voice_materialization_jobs
         SET status = 'failed', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
             heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'
           AND owner_token = ? AND attempt = ?
           AND (${DBNOW_MS}) <= lease_expires_at_epoch_ms`,
      )
      .run(now, handle.jobId, handle.ownerToken, handle.attempt);
    if (j.changes !== 1) return false;
    db.prepare(
      `UPDATE voice_materialization_requests
       SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('waiting','running')`,
    ).run(errorCode, errorMessage.slice(0, 500), now, handle.jobId);
    return true;
  }).immediate();
  return res;
}

/**
 * 独立 recovery sweep：扫描 expired running jobs（lease < DB_NOW），按 final file 状态裁决：
 * - final file 存在且 exact（SHA + WAV 契约）：文件已 durable、DB 未 commit 的崩溃窗口 →
 *   新事务完成 projection/job/request（fenced：status='running' AND lease < DB_NOW，多 Worker 恰一裁决）；
 * - 文件缺失/损坏：job→failed + requests→failed（error_code 稳定）；
 * - 无法确定（校验异常）：job/requests→indeterminate（不冒充 success）。
 * 返回已处理的 job 数（not_owned 不计）。
 */
export async function recoverExpiredMaterializationJobs(limit = 10, db: Db = getDb()): Promise<number> {
  const expired = db
    .prepare(
      `SELECT * FROM voice_materialization_jobs
       WHERE status = 'running' AND lease_expires_at_epoch_ms < (${DBNOW_MS})
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as VoiceMaterializationJobRow[];
  let handled = 0;
  for (const job of expired) {
    // final file 状态（事务外只读；fail-closed：任何异常不得冒充 success）
    let fileState: 'ok' | 'missing' | 'damaged' | 'unknown';
    try {
      const finalAbs = destinationAbsolutePath(job.destination_voice_root_relative_path);
      const st = await fs.lstat(finalAbs);
      if (st.isSymbolicLink() || !st.isFile()) {
        fileState = 'damaged';
      } else {
        const sha = await sha256FileBytes(finalAbs);
        if (sha !== job.source_canonical_sha256) {
          fileState = 'damaged';
        } else {
          const probe = probeAudio(finalAbs);
          fileState =
            probe.codec === 'pcm_s16le' && probe.sampleRate === 48000 && probe.channels === 1 && probe.durationMs > 0
              ? 'ok'
              : 'damaged';
        }
      }
    } catch (err) {
      fileState = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unknown';
    }

    const verdict = db.transaction((): RecoveryVerdict => {
      const fresh = db
        .prepare(
          `SELECT * FROM voice_materialization_jobs
           WHERE id = ? AND status = 'running'
             AND lease_expires_at_epoch_ms < (${DBNOW_MS})`,
        )
        .get(job.id) as VoiceMaterializationJobRow | undefined;
      if (!fresh) return 'not_owned'; // 已被他人处理
      const now = nowIso();
      if (fileState === 'ok') {
        // 文件已 durable：完成 projection/job/request（不冒充 success——file 证据 exact）
        const destRel = destinationRelativePath(fresh.voice_profile_id, fresh.voice_profile_revision_id);
        const existing = db
          .prepare('SELECT * FROM voice_materializations WHERE voice_profile_id = ? AND voice_profile_revision_id = ?')
          .get(fresh.voice_profile_id, fresh.voice_profile_revision_id) as VoiceMaterializationRow | undefined;
        let projectionId: string;
        if (!existing) {
          projectionId = crypto.randomUUID();
          db.prepare(
            `INSERT INTO voice_materializations
               (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
                adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'file_ready_unpublished', ?, ?)`,
          ).run(projectionId, fresh.voice_profile_id, fresh.voice_profile_revision_id,
            fresh.source_canonical_sha256, fresh.adapter_compatibility_key, destRel, now, now);
        } else if (existing.status === 'failed' || existing.status === 'indeterminate') {
          projectionId = existing.id;
          db.prepare(
            `UPDATE voice_materializations SET status = 'file_ready_unpublished', updated_at = ? WHERE id = ?`,
          ).run(now, existing.id);
        } else {
          throw new MaterializationError('MATERIALIZATION_ALREADY_EXISTS', 'recovery: projection 已存在（应走 reuse）', 409);
        }
        db.prepare(
          `UPDATE voice_materialization_jobs
           SET status = 'succeeded', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
               heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, fresh.id);
        db.prepare(
          `UPDATE voice_materialization_requests
           SET status = 'succeeded', materialization_id = ?, updated_at = ?
           WHERE job_id = ? AND status IN ('waiting','running')`,
        ).run(projectionId, now, fresh.id);
        return 'recovered_success';
      }
      if (fileState === 'missing' || fileState === 'damaged') {
        db.prepare(
          `UPDATE voice_materialization_jobs
           SET status = 'failed', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
               heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, fresh.id);
        db.prepare(
          `UPDATE voice_materialization_requests
           SET status = 'failed', error_code = 'RECOVERY_FILE_UNAVAILABLE', error_message = ?, updated_at = ?
           WHERE job_id = ? AND status IN ('waiting','running')`,
        ).run(fileState === 'missing' ? 'final file missing after worker loss' : 'final file damaged after worker loss', now, fresh.id);
        return 'failed';
      }
      // unknown：无法确定 → indeterminate（不冒充 success/failed）
      db.prepare(
        `UPDATE voice_materialization_jobs
         SET status = 'indeterminate', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
             heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, fresh.id);
      db.prepare(
        `UPDATE voice_materialization_requests
         SET status = 'indeterminate', updated_at = ?
         WHERE job_id = ? AND status IN ('waiting','running')`,
      ).run(now, fresh.id);
      return 'indeterminate';
    }).immediate();
    if (verdict !== 'not_owned') handled++;
  }
  return handled;
}

// ── 序列化（redaction：禁止输出任何 path） ──

export interface MaterializationRequestView {
  projectId: string;
  requestId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  requestFingerprintShort: string;
  status: string;
  materialization: {
    profileId: string;
    revisionId: string;
    sourceSha256Short: string;
    status: string | null;
    durationMs: number | null;
    codec: string | null;
    sampleRate: number | null;
    channels: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    adapterReady: false;
    registryPublished: false;
  } | null;
  jobStatus: string | null;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export function serializeMaterializationRequest(
  row: VoiceMaterializationRequestRow,
  projection?: VoiceMaterializationRow | null,
): MaterializationRequestView {
  return {
    projectId: row.project_id,
    requestId: row.request_id,
    voiceProfileId: row.voice_profile_id,
    voiceProfileRevisionId: row.voice_profile_revision_id,
    requestFingerprintShort: row.request_fingerprint.slice(0, 12),
    status: row.status,
    materialization: projection
      ? {
          profileId: projection.voice_profile_id,
          revisionId: projection.voice_profile_revision_id,
          sourceSha256Short: projection.source_canonical_sha256.slice(0, 12),
          status: projection.status,
          durationMs: null,
          codec: null,
          sampleRate: null,
          channels: null,
          createdAt: projection.created_at,
          updatedAt: projection.updated_at,
          adapterReady: false,
          registryPublished: false,
        }
      : null,
    jobStatus: row.job_id ? (getMaterializationJob(row.job_id)?.status ?? null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export {materializationRootAbs};

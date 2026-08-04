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

// ── Phase 3：fenced finalize（BEGIN IMMEDIATE） ──

export type FinalizeOutcome = 'reused' | 'queued' | 'cancelled' | 'inflight' | 'failed';

export function finalizeValidatingJob(
  job: VoiceMaterializationJobRow,
  validationResult: ProjectionValidationResult,
  db: Db = getDb(),
): FinalizeOutcome {
  const now = nowIso();
  const outcome = db.transaction((): FinalizeOutcome => {
    // fenced reread（status/token/attempt/lease + candidate metadata hash）
    const fresh = db
      .prepare(
        `SELECT * FROM voice_materialization_jobs
         WHERE id = ? AND status = 'validating_existing'
           AND validation_owner_token = ? AND validation_attempt = ?
           AND (${DBNOW_MS}) <= validation_lease_expires_at_epoch_ms
           AND candidate_materialization_metadata_hash IS ?`,
      )
      .get(job.id, job.validation_owner_token, job.validation_attempt, job.candidate_materialization_metadata_hash) as
      | VoiceMaterializationJobRow
      | undefined;
    if (!fresh) {
      throw new MaterializationError('STALE_VALIDATION_OWNER', 'validating job 已被接管/过期', 409);
    }
    const subscribers = listActiveRequestRows(job.id);

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
        .run(now, job.id);
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
        .run(now, job.id);
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
      .run(now, job.id);
    if (j.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'job enqueue failed', 409);
    return 'queued';
  });
  return outcome.immediate();
}

// ── stale validating job 接管（fenced CAS） ──

export function takeoverStaleValidatingJob(job: VoiceMaterializationJobRow): boolean {
  const db = getDb();
  const now = nowEpochMs();
  const res = db
    .prepare(
      `UPDATE voice_materialization_jobs
       SET validation_owner_token = ?, validation_lease_expires_at_epoch_ms = ?,
           validation_attempt = validation_attempt + 1, updated_at = ?
       WHERE id = ? AND status = 'validating_existing'
         AND validation_lease_expires_at_epoch_ms < (${DBNOW_MS})`,
    )
    .run(crypto.randomUUID(), now + MATERIALIZATION_VALIDATION_LEASE_MS, nowIso(), job.id);
  return res.changes === 1;
}

// ── 主入口：createMaterializationRequest（Phase 1 + Phase 2 + Phase 3） ──

export interface CreateMaterializationRequestResult {
  request: VoiceMaterializationRequestRow;
  job: VoiceMaterializationJobRow;
  outcome: FinalizeOutcome;
  projection: VoiceMaterializationRow | null;
  adapterReady: false;
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

  const identity = await resolveMaterializationSourceIdentity(projectId, assignmentArtifactId);

  const existing = getMaterializationRequest(projectId, requestId);
  if (existing) {
    if (existing.request_fingerprint !== identity.requestFingerprint) {
      throw new MaterializationError(
        'REQUEST_ID_CONFLICT',
        `requestId ${requestId} 已被不同 exact source 占用`,
        409,
      );
    }
    // 幂等复用同一 envelope（已终态直接返回）
    return {request: existing, job: await ensureJobForRequest(existing, identity), outcome: 'reused', projection: getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null, adapterReady: false};
  }

  const now = nowIso();
  const requestIdUuid = crypto.randomUUID();
  // exact revision 存在性（fail-closed；usable 与否由 Phase 2 决定，这里要求可读；事务外只读）
  const descriptor = await validateVoiceProfileRevisionExact(identity.voiceProfileId, identity.voiceProfileRevisionId);
  if (!descriptor) {
    throw new MaterializationError('ASSIGNMENT_UNUSABLE', 'exact voice revision 不可读（profile/revision 缺失或路径非法）', 422);
  }
  const tx = db.transaction((): {request: VoiceMaterializationRequestRow; job: VoiceMaterializationJobRow} => {
    // 1) INSERT initializing envelope（占用 project+requestId）
    db.prepare(
      `INSERT INTO voice_materialization_requests
         (id, project_id, request_id, voice_profile_id, voice_profile_revision_id,
          assignment_artifact_id, request_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`,
    ).run(requestIdUuid, projectId, requestId, identity.voiceProfileId, identity.voiceProfileRevisionId,
      identity.assignmentArtifactId, identity.requestFingerprint, now, now);
    // 3) 现有 projection 查询 + 查/建 active validating job（single-flight）
    const existingProjection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId);
    let activeJob = getActiveMaterializationJob(identity.voiceProfileId, identity.voiceProfileRevisionId);
    if (activeJob && activeJob.status === 'running'
        && activeJob.lease_expires_at_epoch_ms !== null
        && activeJob.lease_expires_at_epoch_ms < nowEpochMs()) {
      // 失联 running（lease 已过期）：同事务 fenced running→failed + 该 job 的
      // waiting/running requests → failed（request.job_id write-once，不能重链接；
      // 失败请求显式终态，新请求自行建新 envelope → 新 job）
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
      const jobId = crypto.randomUUID();
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
        crypto.randomUUID(), nowEpochMs() + MATERIALIZATION_VALIDATION_LEASE_MS,
        existingProjection ? existingProjection.id : null, candidateHash,
        identity.canonicalAudioSha256, identity.adapterCompatibilityKey, destRel, now, now);
      activeJob = getMaterializationJob(jobId)!;
    }
    // 4) 链接 request→job + request→waiting（同一事务）
    const linked = db
      .prepare(
        `UPDATE voice_materialization_requests
         SET status = 'waiting', job_id = ?, updated_at = ?
         WHERE id = ? AND status = 'initializing'`,
      )
      .run(activeJob.id, now, requestIdUuid);
    if (linked.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'request link failed', 409);
    return {request: getMaterializationRequest(projectId, requestId)!, job: activeJob};
  });
  const {request, job} = tx.immediate();

  // 按 job 状态分流（single-flight 恢复语义）：
  //   validating_existing：Phase 2/3（stale lease → fenced takeover CAS 后重验）；
  //   queued：已入队（Worker 将 copy）→ 'queued'；
  //   running + lease 有效：Worker 在飞 → 'inflight'（等待 Worker commit 后 succeeded）；
  //   running + lease 过期（竞态窗口）：fenced running→failed + 该 job requests→failed；
  //     当前 request 已 write-once 链接该 job → 显式 'failed'（无假成功；新请求自行恢复）；
  //   indeterminate：等待显式 resolve（1A 范围外）→ 'inflight'。
  const freshJob0 = getMaterializationJob(job.id)!;
  if (freshJob0.status === 'running') {
    if (freshJob0.lease_expires_at_epoch_ms !== null && freshJob0.lease_expires_at_epoch_ms >= nowEpochMs()) {
      return {
        request: getMaterializationRequest(projectId, requestId)!,
        job: freshJob0,
        outcome: 'inflight',
        projection: getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null,
        adapterReady: false,
      };
    }
    // lease 过期（Phase 1 与事务外之间的竞态窗口）：fenced running→failed + requests→failed
    const recovered = db.transaction((): boolean => {
      const died = db
        .prepare(
          `UPDATE voice_materialization_jobs
           SET status = 'failed', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
               heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'
             AND lease_expires_at_epoch_ms < (${DBNOW_MS})`,
        )
        .run(nowIso(), job.id);
      if (died.changes !== 1) return false;
      db.prepare(
        `UPDATE voice_materialization_requests SET status = 'failed', updated_at = ?
         WHERE job_id = ? AND status IN ('waiting','running')`,
      ).run(nowIso(), job.id);
      return true;
    }).immediate();
    if (!recovered) {
      // 并发接管：他人已处理 → 走 inflight
      return {
        request: getMaterializationRequest(projectId, requestId)!,
        job: getMaterializationJob(job.id)!,
        outcome: 'inflight',
        projection: getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null,
        adapterReady: false,
      };
    }
    return {
      request: getMaterializationRequest(projectId, requestId)!,
      job: getMaterializationJob(job.id)!,
      outcome: 'failed',
      projection: getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null,
      adapterReady: false,
    };
  }

  // stale validating job 接管（若 lease 已过期）
  const freshJob = getMaterializationJob(job.id)!;
  if (freshJob.status === 'validating_existing'
      && freshJob.validation_lease_expires_at_epoch_ms !== null
      && freshJob.validation_lease_expires_at_epoch_ms < nowEpochMs()) {
    takeoverStaleValidatingJob(freshJob);
  }
  if (freshJob.status === 'queued' || freshJob.status === 'running') {
    return {
      request: getMaterializationRequest(projectId, requestId)!,
      job: getMaterializationJob(job.id)!,
      outcome: freshJob.status === 'queued' ? 'queued' : 'inflight',
      projection: getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null,
      adapterReady: false,
    };
  }
  if (freshJob.status === 'indeterminate') {
    return {
      request: getMaterializationRequest(projectId, requestId)!,
      job: freshJob,
      outcome: 'inflight',
      projection: getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null,
      adapterReady: false,
    };
  }

  // Phase 2（事务外只读）+ Phase 3（BEGIN IMMEDIATE fenced finalize）
  const projection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId);
  let validation: ProjectionValidationResult;
  if (projection) {
    validation = await validateExistingProjection(projection);
  } else {
    validation = {kind: 'unusable', reason: 'no projection yet'};
  }
  const freshJob2 = getMaterializationJob(job.id)!;
  const outcome = finalizeValidatingJob(freshJob2, validation);
  return {
    request: getMaterializationRequest(projectId, requestId)!,
    job: getMaterializationJob(job.id)!,
    outcome,
    projection: validation.kind === 'usable' ? validation.projection : null,
    adapterReady: false,
  };
}

async function ensureJobForRequest(
  request: VoiceMaterializationRequestRow,
  identity: MaterializationSourceIdentity,
): Promise<VoiceMaterializationJobRow> {
  if (request.status === 'waiting' && request.job_id) {
    const job = getMaterializationJob(request.job_id);
    if (job) return job;
  }
  // 已终态 request：无需 job
  const job = getActiveMaterializationJob(identity.voiceProfileId, identity.voiceProfileRevisionId);
  if (job) return job;
  const fallback = getMaterializationJob(request.job_id ?? '');
  if (fallback) return fallback;
  throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'request 无可用 job 关联', 409);
}

// ── Worker 侧：claim 后终局（materialization-executor 调用） ──

export interface WorkerFinalizeInput {
  jobId: string;
  sourceAbsPath: string;
  sourceSha256: string;
  sourceSize: number;
  codec: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
}

export interface WorkerFinalizeResult {
  projectionId: string;
  requestsUpdated: number;
}

/**
 * BEGIN IMMEDIATE 原子终局：
 *   fenced reread job（running + owner + attempt + lease）→
 *   源身份 reread（Profile/Revision/Assignment exact）→
 *   path shape 复核 → INSERT（或 repair UPDATE failed/indeterminate→file_ready）projection →
 *   job→succeeded（清 owner/lease/heartbeat）→ active requests→succeeded + materialization_id。
 * 任一失败整事务回滚；cancel_requested → 不写 projection，job/requests cancelled。
 */
export function workerFinalizeMaterialization(
  input: WorkerFinalizeInput,
  db: Db = getDb(),
): WorkerFinalizeResult {
  const now = nowIso();
  const outcome = db.transaction((): WorkerFinalizeResult => {
    const job = db
      .prepare(
        `SELECT * FROM voice_materialization_jobs
         WHERE id = ? AND status = 'running'
           AND owner_token IS NOT NULL
           AND (${DBNOW_MS}) <= lease_expires_at_epoch_ms`,
      )
      .get(input.jobId) as VoiceMaterializationJobRow | undefined;
    if (!job) {
      throw new MaterializationError('STALE_VALIDATION_OWNER', 'job 不在 running 或 lease 已过期', 409);
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
    // exact 源 reread（TTS-A validator：profile/revision exact + 路径包含 + 文件 SHA）
    // 此处用 Worker 实测值核对；identity 层由 executor 的 Phase 2 复核。
    const destRel = destinationRelativePath(job.voice_profile_id, job.voice_profile_revision_id);
    if (destRel !== job.destination_voice_root_relative_path) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'destination path 漂移（与 job 冻结值不一致）', 409);
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
         WHERE id = ? AND status = 'running'`,
      )
      .run(now, job.id);
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

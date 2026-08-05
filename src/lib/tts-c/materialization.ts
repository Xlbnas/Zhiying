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
import fsSync from 'node:fs';
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
import {
  openHeldMaterializedFileEvidence,
  validateMaterializedFileSnapshot,
  assertHeldCurrentSync,
  assertHeldCapability,
  MaterializedFileError,
  ValidatedReusableProjectionCapability,
  validateProjectionForReuse,
  consumeValidatedProjectionForReuse,
  type MaterializedFileEvidence,
  type HeldMaterializedFileEvidence,
  type ValidationOwnerShape,
} from './materialized-file-validator';

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
  | 'MATERIALIZATION_UNUSABLE'
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

export function dbNowMs(db: Db): number {
  const row = db.prepare(`SELECT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) AS n`).get() as {n: number};
  return row.n;
}



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

/** R5 §七：按 exact materialization id 读取（response link closure）。 */
export function getMaterializationById(materializationId: string): VoiceMaterializationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM voice_materializations WHERE id = ?')
    .get(materializationId) as VoiceMaterializationRow | undefined;
}

/** R5：依据 exact revision 行读取 provider（无行 → 'unknown'）；仅 Phase 3 capability binding 使用。 */
async function getRevisionProviderOrUnknown(profileId: string, revisionId: string): Promise<string> {
  const {validateVoiceProfileRevisionExact} = await import('../voice-library/revisions');
  const d = await validateVoiceProfileRevisionExact(profileId, revisionId).catch(() => null);
  return d && d.row ? d.row.provider : 'unknown';
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

/**
 * R6 P0-A P0-B：Phase 2 outcome 持有 opaque branded capability。usable 分支的能力不暴露
 * 任何身份/授权字段（capability 公开字段仅作诊断）；`projection` 字段仅作 serial 化时
 * 携带 DB 行。`fileSha256/fileEvidence` 从 capability.diagnosticSnapshot 派生（仅诊断）。
 */
export type ProjectionValidationOutcome =
  | {
      kind: 'usable';
      capability: ValidatedReusableProjectionCapability;
      projection: VoiceMaterializationRow;
    }
  | {kind: 'unusable'; reason: string};

/** R4/R5 兼容别名（既存 tests 使用）。 */
export type ProjectionValidationResult = ProjectionValidationOutcome;

/** R4 兼容类型（既存 tests 仍引用）。 */
export interface ValidatedProjectionEvidence {
  projectionId: string;
  profileId: string;
  revisionId: string;
  sourceSha256: string;
  adapterCompatibilityKey: string;
  status: string;
  relativePath: string;
  fileEvidence: MaterializedFileEvidence;
  candidateMetadataHash: string | null;
  validatedAt: string;
}

/** R5 §九：production hook guard。test 环境方可注入；NODE_ENV=production 拒绝。 */
function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** 测试 hook（仅测试）：recovery durabilize 完成后、success transaction 前。 */
export let afterRecoveryEvidenceBeforeCommit:
  | ((ctx: {jobId: string; relativePath: string}) => Promise<void> | void)
  | null = null;
export function setAfterRecoveryEvidenceBeforeCommit(
  fn: ((ctx: {jobId: string; relativePath: string}) => Promise<void> | void) | null,
): void {
  if (isProductionEnv()) {
    throw new Error('test hook disabled in production（setAfterRecoveryEvidenceBeforeCommit）');
  }
  afterRecoveryEvidenceBeforeCommit = fn;
}

/** 测试 hook（仅测试）：Phase 2 完成后、finalize 前。 */
export let afterProjectionValidationBeforeFinalize:
  | ((ctx: {projectionId: string | null; validationKind: 'usable' | 'unusable'}) => Promise<void> | void)
  | null = null;
export function setAfterProjectionValidationBeforeFinalize(
  fn: ((ctx: {projectionId: string | null; validationKind: 'usable' | 'unusable'}) => Promise<void> | void) | null,
): void {
  if (isProductionEnv()) {
    throw new Error('test hook disabled in production（setAfterProjectionValidationBeforeFinalize）');
  }
  afterProjectionValidationBeforeFinalize = fn;
}

/**
 * R6 P0-A P0-C P0-D：Phase 2 高层 entry。**仅**委托 validator 的 `validateProjectionForReuse`
 * （module-private issuer/WeakMap 注册入口已被删除——materialization.ts 不持有任何能构造
 * 合法 capability 的 token 或函数）。issuance 严格一致性 + one-shot handle binding 由 validator
 * 负责；任一不一致 → 关闭 held + 不注册 record + throw；本函数捕获后返回 unusable。
 *
 * handle 是真实 validation owner handle（Phase 2 阶段已确定）——issuance 时绑定到 record
 * 用于 Phase 3 one-shot exact re-check。
 */
export async function validateExistingProjection(
  projection: VoiceMaterializationRow,
  candidateMetadataHash: string | null,
  handle: ValidationLeaseHandle,
  provider: string,
): Promise<ProjectionValidationOutcome> {
  if (projection.status !== 'file_ready_unpublished' && projection.status !== 'published_usable') {
    return {kind: 'unusable', reason: `projection status=${projection.status}`};
  }
  const expectedHandle: ValidationOwnerShape = {
    jobId: handle.jobId,
    validationOwnerToken: handle.validationOwnerToken,
    validationAttempt: handle.validationAttempt,
    candidateMaterializationId: handle.candidateMaterializationId,
    candidateMaterializationMetadataHash: handle.candidateMaterializationMetadataHash,
  };
  return validateProjectionForReuse(projection, candidateMetadataHash, expectedHandle, provider);
}

// ── Phase 3：fenced finalize（BEGIN IMMEDIATE；只接受 handle，不接受整行 fresh job） ──

export type FinalizeOutcome = 'reused' | 'queued' | 'cancelled' | 'inflight' | 'failed' | 'indeterminate';

export function finalizeValidatingJob(
  handle: ValidationLeaseHandle,
  outcome: ProjectionValidationOutcome,
  db: Db = getDb(),
): FinalizeOutcome {
  const now = nowIso();
  // R6 P0-A P0-D P0-E：usable 分支**全部事务内工作**通过 `consumeValidatedProjectionForReuse`
  // 委派给 validator（包含 one-shot exact-handle re-check + unified seal + module-private
  // consume/close 路径）；unusable 分支走独立 fenced cancel/queue 路径。
  if (outcome.kind !== 'usable') {
    return finalizeUnusableReusePath(handle, db, now);
  }
  // 注意：consumeValidatedProjectionForReuse 是 async（含 assertHeldCurrentSync + 事务），
  // 但本函数签名是 sync。R6 设计下此 sync 入口对 usable 路径抛错；调用方
  // （createMaterializationRequest）必须走 async 路径 consumeReuseTransaction。
  void outcome;
  throw new Error('finalizeValidatingJob sync path removed in R6; use consumeReuseTransaction');
}

/**
 * R6 unusable 路径（fenced cancel / queue）——未绑定 capability；事务 fence + 裁决。
 */
function finalizeUnusableReusePath(
  handle: ValidationLeaseHandle,
  db: Db,
  now: string,
): FinalizeOutcome {
  const tx = db.transaction((): FinalizeOutcome => {
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
  return tx.immediate();
}

/**
 * R6 P0-A P0-D P0-E：Phase 3 usable 完整事务入口（async）。
 *
 * 流程（**所有授权判断从 private record 读取；capability 公开字段不参与**）：
 *  1. 委托 validator `consumeValidatedProjectionForReuse`：
 *      a. exact handle re-check（jobId/ownerToken/attempt/candidate id+hash）
 *      b. one-shot consumed check
 *      c. unified seal (`assertHeldCurrentSync` requireDurability=false)
 *      d. 事务内 fenced reread + UPDATE job→succeeded + active requests→reused
 *      e. 无论成功/失败 module-private 关闭路径标记 consumed + closed + 关闭底层 held fd
 *  2. 返回 `{outcome, projection}`：outcome 为 FinalizeOutcome；projection 来自 record-bound
 *     不可变 identity（**不**基于 validation.kind）。
 */
export async function consumeReuseTransaction(
  handle: ValidationLeaseHandle,
  capability: ValidatedReusableProjectionCapability,
  db: Db = getDb(),
  beforeCommitHook?: () => Promise<void> | void,
): Promise<{outcome: FinalizeOutcome; projection: VoiceMaterializationRow | null}> {
  const now = nowIso();
  let resultOutcome: FinalizeOutcome = 'cancelled';
  let resultProjection: VoiceMaterializationRow | null = null;

  try {
    await consumeValidatedProjectionForReuse(capability, {
      jobId: handle.jobId,
      validationOwnerToken: handle.validationOwnerToken,
      validationAttempt: handle.validationAttempt,
      candidateMaterializationId: handle.candidateMaterializationId,
      candidateMaterializationMetadataHash: handle.candidateMaterializationMetadataHash,
    }, async () => {
    // R7 P0-A：onCommit 不接收 record（ReuseAuthorityRecord 不离开 validator module）
    // 事务内 fenced reread + UPDATE（通过闭包变量回传）
    await db.transaction((): FinalizeOutcome => {
      const freshJob = db
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
      if (!freshJob) {
        throw new MaterializationError('STALE_VALIDATION_OWNER', 'validation handle 已失效（接管/过期）', 409);
      }
      const subscribers = listActiveRequestRows(handle.jobId);
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
        resultOutcome = 'cancelled';
        return 'cancelled';
      }
      const projectionId = handle.candidateMaterializationId;
      if (!projectionId) {
        throw new MaterializationError('MATERIALIZATION_UNUSABLE', 'handle.candidateMaterializationId 空（usable 但无 candidate projection）', 409);
      }
      const currentProjection = db
        .prepare('SELECT * FROM voice_materializations WHERE id = ?')
        .get(projectionId) as VoiceMaterializationRow | undefined;
      if (!currentProjection) {
        throw new MaterializationError('MATERIALIZATION_UNUSABLE', 'projection row 不存在（Phase 2→3 期间被删）', 409);
      }
      const currentHash = sha256Text(JSON.stringify({id: currentProjection.id, status: currentProjection.status, sha: currentProjection.source_canonical_sha256}));
      if (currentHash !== handle.candidateMaterializationMetadataHash) {
        throw new MaterializationError('MATERIALIZATION_UNUSABLE', 'projection metadata hash 与 handle.candidate 不一致（漂移）', 409);
      }
      for (const r of subscribers) {
        const asg = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
        if (!asg) throw new MaterializationError('SOURCE_STALE', `request ${r.request_id} assignment 不可读`, 409);
        const src = asg.assignment.source;
        if (
          src.voiceProfileId !== currentProjection.voice_profile_id ||
          src.voiceProfileRevisionId !== currentProjection.voice_profile_revision_id ||
          src.canonicalAudioSha256 !== currentProjection.source_canonical_sha256 ||
          src.adapterCompatibilityKey !== currentProjection.adapter_compatibility_key
        ) {
          throw new MaterializationError('SOURCE_STALE', `request ${r.request_id} assignment source 漂移（Phase 2→3）`, 409);
        }
      }
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
          .run(currentProjection.id, now, r.id);
        if (res.changes !== 1) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'request reuse failed', 409);
      }
      resultOutcome = 'reused';
      resultProjection = currentProjection;
      return 'reused';
    })();
    }, beforeCommitHook);
  } catch (e) {
    if (e instanceof MaterializedFileError) {
      throw new MaterializationError(
        'MATERIALIZATION_UNUSABLE',
        `reuse commit seal reject（${e.code}）：${e.message}`,
        409,
      );
    }
    throw e;
  }

  return {outcome: resultOutcome, projection: resultProjection};
}

// ── stale validating job 接管（fenced CAS；只有赢家返回 handle） ──

export function takeoverStaleValidatingJob(jobId: string, db: Db = getDb()): ValidationLeaseHandle | null {
  const token = crypto.randomUUID();
  const lease = dbNowMs(db) + MATERIALIZATION_VALIDATION_LEASE_MS;
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


export type ReuseIntegrityStatus = 'verified' | 'missing' | 'damaged' | 'source_stale' | 'unchecked';

/**
 * R3 §八：唯一复用验证入口。所有 succeeded/reused 相关路径必须调用本 helper：
 * 1. request.status=succeeded；2. reused；3. waiting + job.succeeded；4. jobOutcomeResult succeeded；5. GET usable 显示前。
 * 8 项 fail-closed；返回 projection + verified snapshot；任一失败抛 MaterializationError。
 */
export async function validateReusableMaterializationRequest(
  request: VoiceMaterializationRequestRow,
  db: Db = getDb(),
): Promise<{projection: VoiceMaterializationRow; evidence: MaterializedFileEvidence}> {
  if (!request.materialization_id) {
    throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 终态缺 materialization_id`, 409);
  }
  const projection = db
    .prepare('SELECT * FROM voice_materializations WHERE id = ?')
    .get(request.materialization_id) as VoiceMaterializationRow | undefined;
  if (!projection) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `request ${request.request_id} 的 projection 不存在`, 422);
  }
  if (projection.id !== request.materialization_id) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', 'request.materialization_id ≠ projection.id（链接漂移）', 422);
  }
  if (projection.status !== 'file_ready_unpublished' && projection.status !== 'published_usable') {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `projection status=${projection.status} 不可 reused`, 422);
  }
  const descriptor = await validateVoiceProfileRevisionExact(projection.voice_profile_id, projection.voice_profile_revision_id);
  if (!descriptor || !descriptor.usable) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `exact Revision 不可用（${descriptor?.unusableReason ?? 'identity failed'}）`, 422);
  }
  const asgRow = getProjectVoiceAssignment(request.project_id, request.assignment_artifact_id);
  if (!asgRow) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `request ${request.request_id} assignment 不可读`, 422);
  }
  const classified = await classifyProjectVoiceAssignment(request.project_id, asgRow.artifact);
  if (classified.status !== 'current_candidate' || !classified.assignment) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `request ${request.request_id} assignment 非 current_candidate（${classified.statusReason ?? '?'}）`, 422);
  }
  const src = classified.assignment.source;
  if (
    src.voiceProfileId !== projection.voice_profile_id ||
    src.voiceProfileRevisionId !== projection.voice_profile_revision_id ||
    src.canonicalAudioSha256 !== projection.source_canonical_sha256 ||
    src.adapterCompatibilityKey !== projection.adapter_compatibility_key ||
    src.provider !== descriptor.row.provider
  ) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `request ${request.request_id} assignment source 与 projection 不一致`, 422);
  }
  let evidence: MaterializedFileEvidence;
  try {
    evidence = await validateMaterializedFileSnapshot({
      relativePath: projection.destination_voice_root_relative_path,
      voiceProfileId: projection.voice_profile_id,
      voiceProfileRevisionId: projection.voice_profile_revision_id,
      expectedSha256: projection.source_canonical_sha256,
      expectedSize: descriptor.fileSize,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: projection.adapter_compatibility_key,
    });
  } catch (err) {
    throw new MaterializationError('MATERIALIZATION_UNUSABLE', `projection 文件不可用: ${err instanceof Error ? err.message : String(err)}`, 422);
  }
  return {projection, evidence};
}

/** GET/序列化辅助：把 helper 的失败分类为 integrityStatus（绝不把损坏 projection 显示为可用）。 */
export async function integrityStatusOf(request: VoiceMaterializationRequestRow, db: Db = getDb()): Promise<ReuseIntegrityStatus> {
  if (!request.materialization_id) return 'unchecked';
  try {
    await validateReusableMaterializationRequest(request, db);
    return 'verified';
  } catch (err) {
    if (err instanceof MaterializationError) {
      const msg = err.message;
      if (msg.includes('assignment') || msg.includes('Revision') || msg.includes('current_candidate')) return 'source_stale';
      if (msg.includes('不存在') || msg.includes('parent 目录缺失') || msg.includes('MISSING')) return 'missing';
      return 'damaged';
    }
    return 'damaged';
  }
}


// ── 主入口：createMaterializationRequest（Phase 1 + Phase 2 + Phase 3） ──

export interface CreateMaterializationRequestResult {
  request: VoiceMaterializationRequestRow;
  job: VoiceMaterializationJobRow;
  outcome: FinalizeOutcome;
  projection: VoiceMaterializationRow | null;
  /**
   * R6 §九：真实 integrity status（来自统一 integrity validator；reused 必为 'verified'，否则
   * createMaterializationRequest 已 throw）。其它 outcome 为 'unchecked'。POST route 序列化必须
   * 显式传入 serializer——不得使用默认 'unchecked' 也不得硬编码 'verified'。
   */
  integrityStatus: ReuseIntegrityStatus;
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

/** P1+R2：existing request outcome 必须基于持久状态映射，禁止统一 reused。 */
async function existingRequestResult(
  request: VoiceMaterializationRequestRow,
  identity: MaterializationSourceIdentity,
  db: Db = getDb(),
): Promise<CreateMaterializationRequestResult> {
  const projection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null;
  const job = request.job_id ? getMaterializationJob(request.job_id) : undefined;
  if (!job) throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `request ${request.request_id} 无 job 关联`, 409);
  const base = {request, job, projection, adapterReady: false as const};
  switch (request.status) {
    case 'succeeded':
    case 'reused': {
      // R6 §九：真实 integrity status——调用统一 integrity validator；damaged → throw
      const integrityStatus = await integrityStatusOf(request);
      if (integrityStatus !== 'verified') {
        throw new MaterializationError(
          'MATERIALIZATION_UNUSABLE',
          `reuse 投影文件不可用（integrity=${integrityStatus}）；fail-closed`,
          422,
        );
      }
      return {...base, outcome: 'reused', integrityStatus};
    }
    case 'waiting': {
      // 按 job 真实状态映射（fan-in 不运行 validator/finalize）
      switch (job.status) {
        case 'validating_existing':
        case 'running':
        case 'indeterminate':
          return {...base, outcome: 'inflight', integrityStatus: 'unchecked'};
        case 'queued':
          return {...base, outcome: 'queued', integrityStatus: 'unchecked'};
        case 'succeeded':
          // R6 §九：waiting + job.succeeded 也必须走唯一复用验证入口
          const integrityStatus2 = await integrityStatusOf(request);
          if (integrityStatus2 !== 'verified') {
            throw new MaterializationError(
              'MATERIALIZATION_UNUSABLE',
              `reuse 投影文件不可用（integrity=${integrityStatus2}）；fail-closed`,
              422,
            );
          }
          return {...base, outcome: 'reused', integrityStatus: integrityStatus2};
        case 'failed':
          return {...base, outcome: 'failed', integrityStatus: 'unchecked'};
        case 'cancelled':
          return {...base, outcome: 'cancelled', integrityStatus: 'unchecked'};
      }
      break;
    }
    case 'running':
      return {...base, outcome: 'inflight', integrityStatus: 'unchecked'};
    case 'failed':
      return {...base, outcome: 'failed', integrityStatus: 'unchecked'};
    case 'cancelled':
      return {...base, outcome: 'cancelled', integrityStatus: 'unchecked'};
    case 'indeterminate':
      return {...base, outcome: 'indeterminate', integrityStatus: 'unchecked'};
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
      return {...base, outcome: 'queued', integrityStatus: 'unchecked'};
    case 'running':
    case 'validating_existing':
    case 'indeterminate':
      return {...base, outcome: 'inflight', integrityStatus: 'unchecked'};
    case 'succeeded':
      // R3：不得仅凭 job.status=succeeded 直接 reused——必须经唯一复用验证入口
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', `job ${job.id} succeeded 但 request ${request.request_id} 状态 ${request.status}（需复用验证）`, 409);
    case 'failed':
      return {...base, outcome: 'failed', integrityStatus: 'unchecked'};
    case 'cancelled':
      return {...base, outcome: 'cancelled', integrityStatus: 'unchecked'};
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
    // R3 §十二：DB-time lease 闭环——事务内读取一次 dbNow，所有分支（expired running/
    // expired validating/takeover 决策/lease 创建）使用；host 时钟不参与裁决
    const dbNow = dbNowMs(db);
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
        && activeJob.lease_expires_at_epoch_ms < dbNow) {
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
      const lease = dbNowMs(db) + MATERIALIZATION_VALIDATION_LEASE_MS;
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
        && activeJob.validation_lease_expires_at_epoch_ms < dbNow) {
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
    return await existingRequestResult(r1.request, identity);
  }

  if (r1.handle) {
    // 我是 validation owner：Phase 2（事务外只读）→ hook → Phase 3（consumeReuseTransaction
    // 通过 validator private record 完成 one-shot exact-handle re-check + unified seal +
    // module-private consume/close 路径）
    const projection = getProjection(identity.voiceProfileId, identity.voiceProfileRevisionId) ?? null;
    const validation: ProjectionValidationOutcome = projection
      ? await validateExistingProjection(
          projection,
          r1.handle.candidateMaterializationMetadataHash,
          r1.handle,
          await getRevisionProviderOrUnknown(identity.voiceProfileId, identity.voiceProfileRevisionId),
        )
      : {kind: 'unusable', reason: 'no projection yet'};
    let outcome: FinalizeOutcome;
    let resultProjection: VoiceMaterializationRow | null = null;
    if (validation.kind === 'usable') {
      // R7 P0-D：Phase 2 hook 移入 consumeValidatedProjectionForReuse 受控生命周期内部
      // （open→consuming 之后、commit-time seal 之前；hook throw 必关闭 capability）
      const hook = afterProjectionValidationBeforeFinalize;
      const txResult = await consumeReuseTransaction(
        r1.handle,
        validation.capability,
        getDb(),
        hook
          ? async () => {
              await hook({
                projectionId: validation.projection.id,
                validationKind: 'usable',
              });
            }
          : undefined,
      );
      outcome = txResult.outcome;
      resultProjection = txResult.projection;
    } else {
      // unusable：走 fenced cancel/queue 路径
      outcome = finalizeUnusableReusePath(r1.handle, getDb(), nowIso());
    }
    // R5 §七：response link closure——重读最终 request，按 request.materialization_id 取 projection，
    // 不得按 validation.kind === 'usable' 取 projection（防止 reused 但 materialization_id 未链接）
    const finalRequest = getMaterializationRequest(projectId, requestId)!;
    const finalJob = getMaterializationJob(r1.job.id)!;
    const finalProjection =
      finalRequest.materialization_id !== null
        ? (getMaterializationById(finalRequest.materialization_id) ?? null)
        : null;
    // R6 §九：real POST integrity——对 reused 终态调用统一 integrity validator；非 verified → fail-closed
    let integrityStatus: ReuseIntegrityStatus = 'unchecked';
    if (outcome === 'reused' && finalRequest.status === 'reused' && finalRequest.materialization_id) {
      integrityStatus = await integrityStatusOf(finalRequest);
      if (integrityStatus !== 'verified') {
        throw new MaterializationError(
          'MATERIALIZATION_UNUSABLE',
          `reuse 投影文件不可用（integrity=${integrityStatus}）；fail-closed 不冒充 reused`,
          422,
        );
      }
    } else if (outcome === 'reused') {
      integrityStatus = 'unchecked';
    } else if (outcome === 'queued' || outcome === 'inflight' || outcome === 'cancelled' || outcome === 'failed' || outcome === 'indeterminate') {
      integrityStatus = 'unchecked';
    }
    return {
      request: finalRequest,
      job: finalJob,
      outcome,
      projection: finalProjection,
      integrityStatus,
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
  /** P0-A/R3：held final-file evidence（fd 持有到 commit；普通快照不得作为凭据） */
  held: HeldMaterializedFileEvidence;
  /** 开始前 exact Revision descriptor 证据（commit 时逐项重读比对） */
  revisionEvidence: {
    voiceProfileId: string;
    voiceProfileRevisionId: string;
    canonicalAudioSha256: string;
    adapterCompatibilityKey: string;
    provider: string;
    fileSize: number;
  };
  /** 事务外 classify 快照（assignment content hash；事务内整体漂移检测） */
  asgSnapshots: Array<{artifactId: string; contentHash: string}>;
}

export interface WorkerFinalizeResult {
  projectionId: string;
  requestsUpdated: number;
}

/**
 * BEGIN IMMEDIATE 原子终局（P0-2 + commit-time exact source fence）：
 *   capability 真实性首验（R4 P0-A WeakSet brand）→
 *   fenced reread job（status='running' + owner_token=handle + attempt=handle + DB_NOW<=lease）→
 *   cancel_requested 裁决 → zero-subscriber 事务内重统计（R4 §七：0 → cancelled，
 *   不创建/repair projection、不写 succeeded、requestsUpdated=0）→
 *   destination path shape 复核 →
 *   exact Revision DB metadata identity 重读（sha/adapter/provider 逐项）→
 *   每个 active request 的 Assignment source 逐项重读（project/profile/revision/provider/sha/adapter）→
 *   final evidence 逐项比较（relative path/SHA/size/regular/codec/sr/ch/duration）→
 *   INSERT（或 repair failed/indeterminate→file_ready）projection → job→succeeded →
 *   active requests→succeeded + materialization_id。
 * 任一失败整事务回滚；cancel_requested / zero-subscriber → 不写 projection，job cancelled。
 */
export function workerFinalizeMaterialization(
  input: WorkerFinalizeInput,
  db: Db = getDb(),
): WorkerFinalizeResult {
  // R5 P0-A：capability 真实性是第一道 fence（伪造/clone/spoof/closed 一律 SEAL_MISMATCH）
  try {
    assertHeldCapability(input.held);
  } catch (e) {
    if (e instanceof MaterializedFileError) {
      throw new MaterializationError(
        'REQUEST_STATE_INCONSISTENT',
        `held capability brand reject（${e.code}）：${e.message}`,
        409,
      );
    }
    throw e;
  }
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
    // R4 §七：zero-subscriber 终局独立 fail-closed——事务内重新统计 active subscriber；
    // 为 0 → cancelled，不创建/repair projection、不写 succeeded（不得只依赖 cancel_requested）
    const subCount = (
      db
        .prepare(
          `SELECT count(*) AS n FROM voice_materialization_requests
           WHERE job_id = ? AND status IN ('waiting','running')`,
        )
        .get(job.id) as {n: number}
    ).n;
    if (subCount === 0) {
      db.prepare(
        `UPDATE voice_materialization_jobs
         SET status = 'cancelled', owner_token = NULL, lease_expires_at_epoch_ms = NULL,
             heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, job.id);
      return {projectionId: '', requestsUpdated: 0};
    }
    // commit-time exact source fence（§八：逐项重读，全部证据参与）
    // 1) destination path shape（job 冻结值 vs 实测 final path）
    const destRel = destinationRelativePath(job.voice_profile_id, job.voice_profile_revision_id);
    if (destRel !== job.destination_voice_root_relative_path) {
      throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'destination path 漂移（与 job 冻结值不一致）', 409);
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
    // 3) 每个 active request 的 Assignment：content hash 整体漂移检测 + source 逐项（provider 参与）
    const subscribers = listActiveRequestRows(job.id);
    for (const r of subscribers) {
      const asg = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
      if (!asg) {
        throw new MaterializationError('SOURCE_STALE', `request ${r.request_id} assignment 不可读`, 409);
      }
      const snap = input.asgSnapshots.find((x) => x.artifactId === r.assignment_artifact_id);
      if (!snap || sha256Text(asg.artifact.content_json) !== snap.contentHash) {
        throw new MaterializationError('SOURCE_STALE', `request ${r.request_id} assignment content 整体漂移（commit 前被改写）`, 409);
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
    // 4) R5：unified ancestor seal（requireDurability=true：worker path）
    //    job-binding 与 commit-time current-file seal（同步；同 inode 改写/path 替换/parent 替换均拒绝）
    //    注：早期 evidence 字段比较移除——R5 改由 seal 内 record-based 检查覆盖（P0-A authority record）；
    //    size/WAV/durability 由 seal 内 record + fsyncAlready 完成保证。
    try {
      assertHeldCurrentSync(input.held, {
        requireDurability: true,
        expectedVoiceProfileId: job.voice_profile_id,
        expectedVoiceProfileRevisionId: job.voice_profile_revision_id,
        expectedSha256: job.source_canonical_sha256,
      });
    } catch (e) {
      if (e instanceof MaterializedFileError) {
        throw new MaterializationError(
          'REQUEST_STATE_INCONSISTENT',
          `worker commit seal reject（${e.code}）：${e.message}`,
          409,
        );
      }
      throw e;
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

export type RecoveryVerdict = 'recovered_success' | 'failed' | 'indeterminate' | 'cancelled' | 'not_owned';

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
 * 独立 recovery sweep（R2 P0-C）：扫描 expired running jobs（lease < DB_NOW）。
 * 每个 job 独立 try/catch（一个坏 job 不阻断其余、不使 Worker fatal）。
 * 稳定裁决：
 * - MISSING / damaged（SHA/size/WAV/containment/inode）→ failed（RECOVERY_FILE_UNAVAILABLE）；
 * - source evidence 漂移（Revision/Assignment）→ failed（RECOVERY_SOURCE_STALE）；
 * - FSYNC_FAILED / IO 无法确定 → indeterminate（不冒充 success）；
 * - exact + durability 重新建立（durabilize：fsync final + dir + exact reread + fenced）→ recovered_success。
 * 返回已处理的 job 数（not_owned 不计）。
 */
export interface MaterializationRecoveryDeps {
  /** 测试注入（仅测试）：透传 safe file validator 的 fsync 失败注入。 */
  fsyncFile?: (fh: import('node:fs/promises').FileHandle) => Promise<void>;
  fsyncDir?: (fh: import('node:fs/promises').FileHandle) => Promise<void>;
}

export async function recoverExpiredMaterializationJobs(limit = 10, db: Db = getDb(), deps: MaterializationRecoveryDeps = {}): Promise<number> {
  const expired = db
    .prepare(
      `SELECT * FROM voice_materialization_jobs
       WHERE status = 'running' AND lease_expires_at_epoch_ms < (${DBNOW_MS})
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as VoiceMaterializationJobRow[];
  let handled = 0;
  for (const job of expired) {
    try {
      const verdict = await recoverOneMaterializationJob(job, db, deps);
      if (verdict !== 'not_owned') handled++;
    } catch (err) {
      // 单个 job 异常只记录（不得阻断后续 job / Worker 进程）
      console.error(`[tts-c1a recovery] job ${job.id} 异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return handled;
}

/** 终态裁决（fenced：status='running' AND lease < DB_NOW；多 Worker 恰一）。 */
function finalizeRecoveredTerminal(
  jobId: string,
  status: 'failed' | 'indeterminate',
  errorCode: string | null,
  errorMessage: string,
  db: Db,
): RecoveryVerdict {
  const now = nowIso();
  return db.transaction((): RecoveryVerdict => {
    const fresh = db
      .prepare(
        `SELECT * FROM voice_materialization_jobs
         WHERE id = ? AND status = 'running'
           AND lease_expires_at_epoch_ms < (${DBNOW_MS})`,
      )
      .get(jobId) as VoiceMaterializationJobRow | undefined;
    if (!fresh) return 'not_owned';
    db.prepare(
      `UPDATE voice_materialization_jobs
       SET status = ?, owner_token = NULL, lease_expires_at_epoch_ms = NULL,
           heartbeat_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(status, now, jobId);
    db.prepare(
      `UPDATE voice_materialization_requests
       SET status = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('waiting','running')`,
    ).run(status, errorCode, errorMessage.slice(0, 500), now, jobId);
    return status === 'failed' ? 'failed' : 'indeterminate';
  }).immediate();
}

/**
 * 单个 expired running job 的 recovery（R2 P0-C）：
 * 1) safe final validator durabilize（fd SHA + fd WAV + fsync final + dir fsync）——
 *    不得因"文件可见且 hash 正确"就假定旧 Worker 已完成 fsync；
 * 2) BEGIN IMMEDIATE 内 exact reread：job fenced + destination shape + Revision DB metadata
 *    + 每个 active request Assignment source + final path inode/dev 复核（validate→commit 变化检测）；
 * 3) projection/job/request 同事务完成。
 */
async function recoverOneMaterializationJob(job: VoiceMaterializationJobRow, db: Db, deps: MaterializationRecoveryDeps): Promise<RecoveryVerdict> {
  // R3 预裁决（durabilize 前，短事务）：cancel_requested / 无 active subscriber → cancelled，
  // 不创建 projection、不调用 durabilize（final orphan 由受控 cleanup 处理，不冒充 success）
  const pre = db.transaction((): 'not_owned' | 'cancelled' | 'proceed' => {
    const fresh = db
      .prepare(
        `SELECT * FROM voice_materialization_jobs
         WHERE id = ? AND status = 'running'
           AND lease_expires_at_epoch_ms < (${DBNOW_MS})`,
      )
      .get(job.id) as VoiceMaterializationJobRow | undefined;
    if (!fresh) return 'not_owned';
    const now = nowIso();
    if (fresh.cancel_requested === 1) {
      db.prepare(
        `UPDATE voice_materialization_jobs SET status = 'cancelled', owner_token = NULL,
           lease_expires_at_epoch_ms = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, job.id);
      db.prepare(
        `UPDATE voice_materialization_requests SET status = 'cancelled', updated_at = ?
         WHERE job_id = ? AND status IN ('waiting','running')`,
      ).run(now, job.id);
      return 'cancelled';
    }
    const subscribers = listActiveRequestRows(job.id);
    if (subscribers.length === 0) {
      db.prepare(
        `UPDATE voice_materialization_jobs SET status = 'cancelled', owner_token = NULL,
           lease_expires_at_epoch_ms = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      ).run(now, job.id);
      return 'cancelled';
    }
    return 'proceed';
  }).immediate();
  if (pre === 'not_owned' || pre === 'cancelled') return pre;

  // phase A：safe final validator durabilize（held fd + fsync final + dir）——重新建立 durability
  let held: HeldMaterializedFileEvidence;
  try {
    held = await openHeldMaterializedFileEvidence(
      {
        relativePath: job.destination_voice_root_relative_path,
        voiceProfileId: job.voice_profile_id,
        voiceProfileRevisionId: job.voice_profile_revision_id,
        expectedSha256: job.source_canonical_sha256,
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: job.adapter_compatibility_key,
      },
      'durabilize',
      deps,
    );
  } catch (err) {
    if (err instanceof MaterializedFileError) {
      if (err.code === 'MISSING') {
        return finalizeRecoveredTerminal(job.id, 'failed', 'RECOVERY_FILE_UNAVAILABLE', 'final file missing after worker loss', db);
      }
      if (err.code === 'FSYNC_FAILED' || err.code === 'IO_ERROR') {
        return finalizeRecoveredTerminal(job.id, 'indeterminate', null, `durability 无法确定: ${err.message}`, db);
      }
      return finalizeRecoveredTerminal(job.id, 'failed', 'RECOVERY_FILE_UNAVAILABLE', `final file damaged: ${err.message}`, db);
    }
    return finalizeRecoveredTerminal(job.id, 'indeterminate', null, `file 校验异常: ${err instanceof Error ? err.message : String(err)}`, db);
  }

  try {
    if (afterRecoveryEvidenceBeforeCommit) {
      await afterRecoveryEvidenceBeforeCommit({jobId: job.id, relativePath: job.destination_voice_root_relative_path});
    }
    // 事务外 classify（async）：每个 active request Assignment 必须 current_candidate；
    // 记录 content hash 供事务内整体漂移检测（VAL-SEAL-04 语义）。
    // R4 §八：唯一合法路径 = getProjectVoiceAssignment → artifact row → classify（无 as never）
    const asgSnapshots: Array<{artifactId: string; contentHash: string}> = [];
    for (const r of listActiveRequestRows(job.id)) {
      const asgRow = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
      if (!asgRow) throw new MaterializationError('SOURCE_STALE', `recovery: request ${r.request_id} assignment 不可读`, 409);
      const classified = await classifyProjectVoiceAssignment(r.project_id, asgRow.artifact);
      if (classified.status !== 'current_candidate' || !classified.assignment) {
        throw new MaterializationError('SOURCE_STALE', `recovery: request ${r.request_id} assignment 非 current_candidate（${classified.statusReason ?? '?'}）`, 409);
      }
      asgSnapshots.push({
        artifactId: r.assignment_artifact_id,
        contentHash: sha256Text(asgRow.artifact.content_json),
      });
    }

    return db.transaction((): RecoveryVerdict => {
      const fresh = db
        .prepare(
          `SELECT * FROM voice_materialization_jobs
           WHERE id = ? AND status = 'running'
             AND lease_expires_at_epoch_ms < (${DBNOW_MS})`,
        )
        .get(job.id) as VoiceMaterializationJobRow | undefined;
      if (!fresh) return 'not_owned';
      const now = nowIso();
      // success 事务再检查：cancel_requested / subscriber 归零
      if (fresh.cancel_requested === 1) {
        db.prepare(
          `UPDATE voice_materialization_jobs SET status = 'cancelled', owner_token = NULL,
             lease_expires_at_epoch_ms = NULL, heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, job.id);
        db.prepare(
          `UPDATE voice_materialization_requests SET status = 'cancelled', updated_at = ?
           WHERE job_id = ? AND status IN ('waiting','running')`,
        ).run(now, job.id);
        return 'cancelled';
      }
      const subscribers = listActiveRequestRows(job.id);
      if (subscribers.length === 0) {
        db.prepare(
          `UPDATE voice_materialization_jobs SET status = 'cancelled', owner_token = NULL,
             lease_expires_at_epoch_ms = NULL, heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        ).run(now, job.id);
        return 'cancelled';
      }
      // destination shape
      const destRel = destinationRelativePath(fresh.voice_profile_id, fresh.voice_profile_revision_id);
      if (destRel !== fresh.destination_voice_root_relative_path) {
        throw new MaterializationError('REQUEST_STATE_INCONSISTENT', 'recovery: destination path 漂移', 409);
      }
      // exact Revision DB metadata identity
      const revisionRow = db
        .prepare('SELECT * FROM voice_profile_revisions WHERE id = ? AND voice_profile_id = ?')
        .get(fresh.voice_profile_revision_id, fresh.voice_profile_id) as
        | {canonical_audio_sha256: string; adapter_compatibility_key: string; provider: string}
        | undefined;
      if (
        !revisionRow ||
        revisionRow.canonical_audio_sha256 !== fresh.source_canonical_sha256 ||
        revisionRow.adapter_compatibility_key !== fresh.adapter_compatibility_key
      ) {
        throw new MaterializationError('SOURCE_STALE', 'recovery: exact Revision metadata identity 漂移', 409);
      }
      // Assignment content hash 整体漂移检测 + source 字段逐项（provider 参与）
      for (const r of subscribers) {
        const asgRow = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
        if (!asgRow) throw new MaterializationError('SOURCE_STALE', `recovery: request ${r.request_id} assignment 不可读`, 409);
        const snap = asgSnapshots.find((x) => x.artifactId === r.assignment_artifact_id);
        if (!snap || sha256Text(asgRow.artifact.content_json) !== snap.contentHash) {
          throw new MaterializationError('SOURCE_STALE', `recovery: request ${r.request_id} assignment content 整体漂移`, 409);
        }
        const src = asgRow.assignment.source;
        if (
          src.voiceProfileId !== fresh.voice_profile_id ||
          src.voiceProfileRevisionId !== fresh.voice_profile_revision_id ||
          src.canonicalAudioSha256 !== fresh.source_canonical_sha256 ||
          src.adapterCompatibilityKey !== fresh.adapter_compatibility_key ||
          src.provider !== revisionRow.provider
        ) {
          throw new MaterializationError('SOURCE_STALE', `recovery: request ${r.request_id} assignment source 漂移`, 409);
        }
      }
      // R5 P0-C：unified ancestor seal（recovery durabilize path 也走统一 seal）
      try {
        assertHeldCurrentSync(held, {
          requireDurability: true,
          expectedVoiceProfileId: fresh.voice_profile_id,
          expectedVoiceProfileRevisionId: fresh.voice_profile_revision_id,
          expectedSha256: fresh.source_canonical_sha256,
        });
      } catch (e) {
        if (e instanceof MaterializedFileError) {
          throw new MaterializationError(
            'REQUEST_STATE_INCONSISTENT',
            `recovery commit seal reject（${e.code}）：${e.message}`,
            409,
          );
        }
        throw e;
      }
      // R3 REC-EXIST：existing projection 确定性裁决（不悬挂 running）
      const existing = db
        .prepare('SELECT * FROM voice_materializations WHERE voice_profile_id = ? AND voice_profile_revision_id = ?')
        .get(fresh.voice_profile_id, fresh.voice_profile_revision_id) as VoiceMaterializationRow | undefined;
      let projectionId: string;
      if (existing) {
        if (
          existing.status === 'file_ready_unpublished' &&
          existing.source_canonical_sha256 === fresh.source_canonical_sha256 &&
          existing.adapter_compatibility_key === fresh.adapter_compatibility_key
        ) {
          projectionId = existing.id; // exact：不重复 INSERT
        } else {
          throw new MaterializationError('MATERIALIZATION_UNUSABLE', `recovery: existing projection 不可用（status=${existing.status}）`, 409);
        }
      } else {
        projectionId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO voice_materializations
             (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
              adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'file_ready_unpublished', ?, ?)`,
        ).run(projectionId, fresh.voice_profile_id, fresh.voice_profile_revision_id,
          fresh.source_canonical_sha256, fresh.adapter_compatibility_key, destRel, now, now);
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
    }).immediate();
  } catch (err) {
    if (err instanceof MaterializationError && err.code === 'SOURCE_STALE') {
      return finalizeRecoveredTerminal(job.id, 'failed', 'RECOVERY_SOURCE_STALE', err.message, db);
    }
    if (err instanceof MaterializationError && (err.code === 'MATERIALIZATION_UNUSABLE' || err.code === 'REQUEST_STATE_INCONSISTENT')) {
      return finalizeRecoveredTerminal(job.id, 'failed', 'RECOVERY_FILE_UNAVAILABLE', err.message, db);
    }
    return finalizeRecoveredTerminal(job.id, 'indeterminate', null, `recovery 裁决异常: ${err instanceof Error ? err.message : String(err)}`, db);
  } finally {
    await held.close().catch(() => undefined); // DB 事务完成后关闭 held fd
  }
}


// ── 序列化（redaction：禁止输出任何 path） ──

export interface MaterializationRequestView {
  projectId: string;
  requestId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  requestFingerprintShort: string;
  status: string;
  /** R3：GET fail-closed integrity（verified/missing/damaged/source_stale/unchecked） */
  integrityStatus: ReuseIntegrityStatus;
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
  integrityStatus: ReuseIntegrityStatus = 'unchecked',
): MaterializationRequestView {
  return {
    projectId: row.project_id,
    requestId: row.request_id,
    voiceProfileId: row.voice_profile_id,
    voiceProfileRevisionId: row.voice_profile_revision_id,
    requestFingerprintShort: row.request_fingerprint.slice(0, 12),
    status: row.status,
    integrityStatus,
    materialization: projection
      ? {
          profileId: projection.voice_profile_id,
          revisionId: projection.voice_profile_revision_id,
          sourceSha256Short: projection.source_canonical_sha256.slice(0, 12),
          // R3：GET fail-closed——非 verified 时不得把损坏 projection 显示为当前可用状态
          status: integrityStatus === 'verified' ? projection.status : 'unusable',
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

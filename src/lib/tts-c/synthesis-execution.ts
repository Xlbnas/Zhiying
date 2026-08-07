/**
 * TTS-C.2 — synthesis execution layer（frozen §2.2c 五类 atomic command +
 * §2.3 generation attempts + §2.4 immutable sentence audio artifact）。
 *
 * 模式（frozen per-column fence）：
 *   每条 execution command 的 INSERT（tts_job_execution_transitions）验证双侧当前状态
 *   （from_*）与 execution-head chain（previous_command_id / command_seq 双侧 +1）；
 *   随后 claim/job 的 UPDATE 必须与 command 行逐字段匹配（head / owner / attempt /
 *   heartbeat / started/finished / error 等 fence trigger 强制）。
 *   claim/job 的任何 status 迁移与执行期 owner 字段更新只能经 command——直接 UPDATE 一律 ABORT。
 *
 * 语义：
 *   - worker_claim：queued→running（双侧）+ 建立 owner/lease/attempt/claimed_at/heartbeat；
 *     同一事务创建 attempt（execution_phase='created'）。
 *   - lease_renewal：running/indeterminate 同态续租（claim lease + job heartbeat）。
 *   - execution_takeover：lease 过期 fenced 接管（新 owner + 双侧 attempt+1）。
 *   - prestart_terminal：generation_pending/queued → failed/cancelled（无 owner）。
 *   - state_transition：running/indeterminate → succeeded/failed/cancelled/indeterminate
 *     （succeeded 必须 result_artifact_id；failed 必须 error_code）。
 *   - attempt 证据 write-once（trg_tga_evidence）+ phase 状态机（trg_tga_transition）。
 *   - artifact 不可变（trg_saa_update_abort/delete_abort）+ provenance 闭包
 *     （trg_saa_provenance：attempt succeeded、project/unit/fingerprint/variant/voice 逐项
 *     与 job/claim 一致）+ capability provenance（snapshot/compiled_payload/compiler_version）。
 */
import crypto from 'node:crypto';
import type {Db} from '../db';
import {dbNowMs, nowIso} from './materialization';
import {RegistryContractError} from './registry-contract-error';

export const EXECUTION_NOT_OWNER = 'EXECUTION_NOT_OWNER';
export const EXECUTION_INVALID_STATE = 'EXECUTION_INVALID_STATE';
export const EXECUTION_LEASE_EXPIRED = 'EXECUTION_LEASE_EXPIRED';
export const EXECUTION_NOT_FOUND = 'EXECUTION_NOT_FOUND';

export const EXECUTION_LEASE_MS = 15 * 60 * 1000;

interface JobRow {
  id: string;
  /** TTS-C job 恒非 NULL（getTtsCJob 已断言；legacy 行不经过本模块）。 */
  claim_id: string;
  status: string;
  attempt: number;
  claimed_by: string | null;
  heartbeat_at: string | null;
  last_execution_command_id: string | null;
  execution_command_seq: number;
  project_id: string;
  unit_id: string;
  provider: string;
  payload_json: string | null;
  exact_source_fingerprint: string | null;
  synthesis_payload_fingerprint: string | null;
  final_tts_input_fingerprint: string | null;
  narration_plan_artifact_id: string | null;
  cancel_requested: number | null;
}

export function getTtsCJob(db: Db, jobId: string): JobRow {
  const row = db.prepare('SELECT * FROM tts_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!row || !row.claim_id) throw new RegistryContractError(EXECUTION_NOT_FOUND, `TTS-C job 不存在: ${jobId}`);
  return row;
}

interface CommandInsert {
  jobId: string;
  claimId: string;
  commandKind: 'worker_claim' | 'lease_renewal' | 'execution_takeover' | 'prestart_terminal' | 'state_transition';
  fromClaimStatus: string;
  toClaimStatus: string;
  fromJobStatus: string;
  toJobStatus: string;
  workerOwnerToken?: string | null;
  workerLease?: number | null;
  workerAttempt: number;
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  resultArtifactId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  reason?: string | null;
}

/** INSERT execution command（frozen §2.2c 唯一原子入口；trg_tjet_execute 验证双侧状态与 chain）。 */
function insertExecutionCommand(db: Db, c: CommandInsert): {commandId: string; seq: number} {
  const claim = db.prepare('SELECT last_execution_command_id, execution_command_seq FROM tts_synthesis_claims WHERE id=?').get(c.claimId) as
    | {last_execution_command_id: string | null; execution_command_seq: number}
    | undefined;
  const job = db.prepare('SELECT execution_command_seq FROM tts_jobs WHERE id=? AND claim_id=?').get(c.jobId, c.claimId) as
    | {execution_command_seq: number}
    | undefined;
  if (!claim || !job) throw new RegistryContractError(EXECUTION_NOT_FOUND, 'claim/job 缺失');
  if (claim.execution_command_seq !== job.execution_command_seq) {
    throw new RegistryContractError(EXECUTION_INVALID_STATE, 'claim/job execution head 漂移');
  }
  const seq = claim.execution_command_seq + 1;
  const commandId = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO tts_job_execution_transitions
       (id, transition_request_id, job_id, claim_id, previous_command_id, command_seq,
        command_kind, from_claim_status, to_claim_status, from_job_status, to_job_status,
        worker_owner_token, worker_lease_expires_at_epoch_ms, worker_attempt,
        claimed_at, heartbeat_at, result_artifact_id, error_code, error_message, reason,
        activated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    commandId,
    crypto.randomUUID(),
    c.jobId,
    c.claimId,
    claim.last_execution_command_id,
    seq,
    c.commandKind,
    c.fromClaimStatus,
    c.toClaimStatus,
    c.fromJobStatus,
    c.toJobStatus,
    c.workerOwnerToken ?? null,
    c.workerLease ?? null,
    c.workerAttempt,
    c.claimedAt ?? null,
    c.heartbeatAt ?? null,
    c.resultArtifactId ?? null,
    c.errorCode ?? null,
    c.errorMessage ?? null,
    c.reason ?? null,
    now,
    now,
  );
  return {commandId, seq};
}

/** 双侧 execution head 推进（command id/seq 写回 claim 与 job）。 */
function advanceHead(db: Db, claimId: string, jobId: string, commandId: string, seq: number): void {
  db.prepare(
    `UPDATE tts_synthesis_claims
        SET last_execution_command_id=?, execution_command_seq=?
      WHERE id=?`,
  ).run(commandId, seq, claimId);
  db.prepare(
    `UPDATE tts_jobs
        SET last_execution_command_id=?, execution_command_seq=?
      WHERE id=? AND claim_id=?`,
  ).run(commandId, seq, jobId, claimId);
}

/**
 * Worker claim（frozen worker_claim command）：queued→running 双侧 + 建立
 * owner/lease/attempt/claimed_at/heartbeat/started_at；同一事务创建 attempt（phase=created）。
 */
export function claimSynthesisJob(
  db: Db,
  options: {jobId: string; workerOwnerToken: string; leaseMs?: number; providerRequestHash: string; providerRequestJson: string; model: string},
): {claimId: string; attemptId: string} {
  const tx = db.transaction((): {claimId: string; attemptId: string} => {
    const job = getTtsCJob(db, options.jobId);
    if (job.status !== 'queued') throw new RegistryContractError(EXECUTION_INVALID_STATE, `job ${options.jobId} 状态 ${job.status} 不可 claim`);
    const claim = db.prepare('SELECT status, project_id FROM tts_synthesis_claims WHERE id=?').get(job.claim_id) as {status: string; project_id: string} | undefined;
    if (!claim || claim.status !== 'generation_pending') {
      throw new RegistryContractError(EXECUTION_INVALID_STATE, `claim ${job.claim_id} 状态非 generation_pending`);
    }
    const now = nowIso();
    const lease = dbNowMs(db) + (options.leaseMs ?? EXECUTION_LEASE_MS);
    const {commandId, seq} = insertExecutionCommand(db, {
      jobId: job.id,
      claimId: job.claim_id,
      commandKind: 'worker_claim',
      fromClaimStatus: 'generation_pending',
      toClaimStatus: 'running',
      fromJobStatus: 'queued',
      toJobStatus: 'running',
      workerOwnerToken: options.workerOwnerToken,
      workerLease: lease,
      workerAttempt: 1,
      claimedAt: now,
      heartbeatAt: now,
    });
    // claim → running（owner/lease/head；fence trigger 逐字段比对 command 行）
    db.prepare(
      `UPDATE tts_synthesis_claims
          SET status='running', owner_token=?, lease_expires_at_epoch_ms=?,
              last_execution_command_id=?, execution_command_seq=?, updated_at=?
        WHERE id=? AND status='generation_pending'`,
    ).run(options.workerOwnerToken, lease, commandId, seq, now, job.claim_id);
    // job → running（claimed_by/attempt/head/started_at；fence 同 command 行）
    db.prepare(
      `UPDATE tts_jobs
          SET status='running', claimed_by=?, claimed_at=?, heartbeat_at=?, attempt=?,
              started_at=?, last_execution_command_id=?, execution_command_seq=?
        WHERE id=? AND claim_id=? AND status='queued'`,
    ).run(options.workerOwnerToken, now, now, 1, now, commandId, seq, job.id, job.claim_id);
    // attempt（phase=created；provider/model/request 证据）
    const attemptId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO tts_generation_attempts
         (id, job_id, attempt_number, provider, model, request_hash, request_json,
          execution_phase, started_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'created', ?)`,
    ).run(attemptId, job.id, job.provider, options.model, options.providerRequestHash, options.providerRequestJson, now);
    return {claimId: job.claim_id, attemptId};
  });
  return tx.immediate();
}

/** Lease renewal（frozen lease_renewal command）：running/indeterminate 同态续租。 */
export function renewSynthesisLease(
  db: Db,
  options: {jobId: string; workerOwnerToken: string; leaseMs?: number},
): void {
  const tx = db.transaction((): void => {
    const job = getTtsCJob(db, options.jobId);
    if (job.status !== 'running' && job.status !== 'indeterminate') {
      throw new RegistryContractError(EXECUTION_INVALID_STATE, `job ${options.jobId} 状态 ${job.status} 不可续租`);
    }
    const claim = db.prepare('SELECT status, owner_token FROM tts_synthesis_claims WHERE id=?').get(job.claim_id) as {status: string; owner_token: string | null} | undefined;
    if (!claim || claim.status !== job.status || claim.owner_token !== options.workerOwnerToken) {
      throw new RegistryContractError(EXECUTION_NOT_OWNER, `claim ${job.claim_id} owner 不匹配`);
    }
    const now = nowIso();
    const lease = dbNowMs(db) + (options.leaseMs ?? EXECUTION_LEASE_MS);
    const {commandId, seq} = insertExecutionCommand(db, {
      jobId: job.id,
      claimId: job.claim_id,
      commandKind: 'lease_renewal',
      fromClaimStatus: job.status,
      toClaimStatus: job.status,
      fromJobStatus: job.status,
      toJobStatus: job.status,
      workerOwnerToken: options.workerOwnerToken,
      workerLease: lease,
      workerAttempt: job.attempt,
      heartbeatAt: now,
    });
    db.prepare(
      `UPDATE tts_synthesis_claims
          SET lease_expires_at_epoch_ms=?, last_execution_command_id=?, execution_command_seq=?, updated_at=?
        WHERE id=? AND owner_token=? AND status=?`,
    ).run(lease, commandId, seq, now, job.claim_id, options.workerOwnerToken, job.status);
    db.prepare(
      `UPDATE tts_jobs
          SET heartbeat_at=?, last_execution_command_id=?, execution_command_seq=?
        WHERE id=? AND claim_id=? AND claimed_by=? AND status=?`,
    ).run(now, commandId, seq, job.id, job.claim_id, options.workerOwnerToken, job.status);
  });
  tx.immediate();
}

/**
 * Execution takeover（frozen execution_takeover command）：lease 过期 fenced 接管——
 * 新 owner + 双侧 attempt+1 + 新 lease；旧 owner 后续任何 renew/finalize 全部失败。
 */
export function takeoverSynthesisExecution(
  db: Db,
  options: {jobId: string; newOwnerToken: string; leaseMs?: number},
): {claimId: string; newAttempt: number} {
  const tx = db.transaction((): {claimId: string; newAttempt: number} => {
    const job = getTtsCJob(db, options.jobId);
    if (job.status !== 'running' && job.status !== 'indeterminate') {
      throw new RegistryContractError(EXECUTION_INVALID_STATE, `job ${options.jobId} 状态 ${job.status} 不可 takeover`);
    }
    const claim = db.prepare('SELECT status, lease_expires_at_epoch_ms, validation_attempt FROM tts_synthesis_claims WHERE id=?').get(job.claim_id) as
      | {status: string; lease_expires_at_epoch_ms: number | null; validation_attempt: number}
      | undefined;
    if (!claim || claim.status !== job.status) throw new RegistryContractError(EXECUTION_INVALID_STATE, 'claim/job 状态不一致');
    if (claim.lease_expires_at_epoch_ms !== null && claim.lease_expires_at_epoch_ms >= dbNowMs(db)) {
      throw new RegistryContractError(EXECUTION_LEASE_EXPIRED, `claim ${job.claim_id} lease 未过期——不可 takeover`);
    }
    const now = nowIso();
    const lease = dbNowMs(db) + (options.leaseMs ?? EXECUTION_LEASE_MS);
    const newAttempt = job.attempt + 1;
    const {commandId, seq} = insertExecutionCommand(db, {
      jobId: job.id,
      claimId: job.claim_id,
      commandKind: 'execution_takeover',
      fromClaimStatus: job.status,
      toClaimStatus: job.status,
      fromJobStatus: job.status,
      toJobStatus: job.status,
      workerOwnerToken: options.newOwnerToken,
      workerLease: lease,
      workerAttempt: newAttempt,
      claimedAt: now,
      heartbeatAt: now,
    });
    db.prepare(
      `UPDATE tts_synthesis_claims
          SET owner_token=?, lease_expires_at_epoch_ms=?, validation_attempt=?,
              last_execution_command_id=?, execution_command_seq=?, updated_at=?
        WHERE id=? AND status=?`,
    ).run(options.newOwnerToken, lease, newAttempt, commandId, seq, now, job.claim_id, job.status);
    db.prepare(
      `UPDATE tts_jobs
          SET claimed_by=?, claimed_at=?, heartbeat_at=?, attempt=?,
              last_execution_command_id=?, execution_command_seq=?
        WHERE id=? AND claim_id=? AND status=?`,
    ).run(options.newOwnerToken, now, now, newAttempt, commandId, seq, job.id, job.claim_id, job.status);
    return {claimId: job.claim_id, newAttempt};
  });
  return tx.immediate();
}

/** Prestart terminal（frozen prestart_terminal command）：generation_pending/queued → failed/cancelled（无 owner）。 */
export function prestartTerminalSynthesisJob(
  db: Db,
  options: {jobId: string; terminal: 'failed' | 'cancelled'; errorCode?: string; errorMessage?: string; reason?: string},
): void {
  const tx = db.transaction((): void => {
    const job = getTtsCJob(db, options.jobId);
    if (job.status !== 'queued') throw new RegistryContractError(EXECUTION_INVALID_STATE, `job ${options.jobId} 状态 ${job.status} 不可 prestart terminal`);
    const now = nowIso();
    const {commandId, seq} = insertExecutionCommand(db, {
      jobId: job.id,
      claimId: job.claim_id,
      commandKind: 'prestart_terminal',
      fromClaimStatus: 'generation_pending',
      toClaimStatus: options.terminal,
      fromJobStatus: 'queued',
      toJobStatus: options.terminal,
      workerAttempt: 1,
      errorCode: options.errorCode ?? null,
      errorMessage: options.errorMessage ?? null,
      reason: options.reason ?? null,
    });
    db.prepare(
      `UPDATE tts_synthesis_claims
          SET status=?, last_execution_command_id=?, execution_command_seq=?, updated_at=?
        WHERE id=? AND status='generation_pending'`,
    ).run(options.terminal, commandId, seq, now, job.claim_id);
    db.prepare(
      `UPDATE tts_jobs
          SET status=?, finished_at=?, error_code=?, error_message=?, cancel_requested=NULL,
              last_execution_command_id=?, execution_command_seq=?
        WHERE id=? AND claim_id=? AND status='queued'`,
    ).run(options.terminal, now, options.errorCode ?? null, options.errorMessage ?? null, commandId, seq, job.id, job.claim_id);
  });
  tx.immediate();
}

// ── attempt evidence（§2.3；write-once + phase 状态机） ──

export interface AttemptEvidence {
  providerRequestId?: string;
  recoveryTempRelativePath?: string;
  responseHash?: string;
  finalRelativePath?: string;
  audioSha256?: string;
  outputSize?: number;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  ffprobeDurationMs?: number;
}

export function getGenerationAttempt(db: Db, attemptId: string): {execution_phase: string; job_id: string} {
  const row = db.prepare('SELECT execution_phase, job_id FROM tts_generation_attempts WHERE id=?').get(attemptId) as
    | {execution_phase: string; job_id: string}
    | undefined;
  if (!row) throw new RegistryContractError(EXECUTION_NOT_FOUND, `attempt 不存在: ${attemptId}`);
  return row;
}

/** 推进 attempt phase（created→provider_in_flight→response_persisted→file_validated→file_durable）。 */
export function advanceAttemptPhase(
  db: Db,
  attemptId: string,
  targetPhase: 'provider_in_flight' | 'response_persisted' | 'file_validated' | 'file_durable',
  evidence?: AttemptEvidence,
): void {
  const attempt = getGenerationAttempt(db, attemptId);
  const allowed: Record<string, string[]> = {
    created: ['provider_in_flight'],
    provider_in_flight: ['response_persisted'],
    response_persisted: ['file_validated'],
    file_validated: ['file_durable'],
  };
  if (!(allowed[attempt.execution_phase] ?? []).includes(targetPhase)) {
    throw new RegistryContractError(EXECUTION_INVALID_STATE, `attempt ${attemptId} phase ${attempt.execution_phase} → ${targetPhase} 非法`);
  }
  const e = evidence ?? {};
  db.prepare(
    `UPDATE tts_generation_attempts
        SET execution_phase=?, provider_request_id=COALESCE(?, provider_request_id),
            recovery_temp_relative_path=COALESCE(?, recovery_temp_relative_path),
            response_hash=COALESCE(?, response_hash),
            final_relative_path=COALESCE(?, final_relative_path),
            audio_sha256=COALESCE(?, audio_sha256),
            output_size=COALESCE(?, output_size),
            codec=COALESCE(?, codec),
            sample_rate=COALESCE(?, sample_rate),
            channels=COALESCE(?, channels),
            ffprobe_duration_ms=COALESCE(?, ffprobe_duration_ms)
      WHERE id=?`,
  ).run(
    targetPhase,
    e.providerRequestId ?? null,
    e.recoveryTempRelativePath ?? null,
    e.responseHash ?? null,
    e.finalRelativePath ?? null,
    e.audioSha256 ?? null,
    e.outputSize ?? null,
    e.codec ?? null,
    e.sampleRate ?? null,
    e.channels ?? null,
    e.ffprobeDurationMs ?? null,
    attemptId,
  );
}

// ── finalize（state_transition succeeded：attempt→succeeded + artifact + 双侧 terminal） ──

export interface FinalizeSuccessOptions {
  jobId: string;
  workerOwnerToken: string;
  attemptId: string;
  attemptEvidence: AttemptEvidence & {audioSha256: string; finalRelativePath: string; outputSize: number; codec: string; sampleRate: number; channels: number; ffprobeDurationMs: number};
  /** artifact provenance（frozen §2.4；narration/assignment/performance plan + capability 三件套）。 */
  artifact: {
    narrationPlanArtifactId: string;
    narrationPlanContentHash: string;
    assignmentArtifactId: string;
    assignmentContentHash: string;
    performancePlanArtifactId: string;
    performancePlanContentHash: string;
    voiceProfileId: string;
    voiceProfileRevisionId: string;
    providerVersion?: string | null;
    providerCommit?: string | null;
    capabilityCompilerVersion: string;
    capabilitySnapshotJson: string;
    compiledPayloadJson: string;
    originatingRequestId?: string | null;
  };
}

export function finalizeSynthesisJobSuccess(db: Db, options: FinalizeSuccessOptions): {claimId: string; artifactId: string} {
  const tx = db.transaction((): {claimId: string; artifactId: string} => {
    const job = getTtsCJob(db, options.jobId);
    if (job.status !== 'running' && job.status !== 'indeterminate') {
      throw new RegistryContractError(EXECUTION_INVALID_STATE, `job ${options.jobId} 状态 ${job.status} 不可 finalize`);
    }
    const claim = db.prepare('SELECT status, owner_token, unit_id, final_tts_input_fingerprint, generation_variant_id FROM tts_synthesis_claims WHERE id=?').get(job.claim_id) as
      | {status: string; owner_token: string | null; unit_id: string; final_tts_input_fingerprint: string; generation_variant_id: string}
      | undefined;
    if (!claim || claim.status !== job.status || claim.owner_token !== options.workerOwnerToken) {
      throw new RegistryContractError(EXECUTION_NOT_OWNER, `claim ${job.claim_id} owner 不匹配`);
    }
    const attempt = getGenerationAttempt(db, options.attemptId);
    if (attempt.job_id !== job.id || attempt.execution_phase !== 'file_durable') {
      throw new RegistryContractError(EXECUTION_INVALID_STATE, `attempt ${options.attemptId} 必须 file_durable 且属于 job`);
    }
    const now = nowIso();
    // 1) attempt → succeeded（evidence write-once + terminal 冻结）
    db.prepare(
      `UPDATE tts_generation_attempts
          SET execution_phase='succeeded', finished_at=?,
              provider_request_id=COALESCE(?, provider_request_id),
              final_relative_path=COALESCE(?, final_relative_path),
              audio_sha256=COALESCE(?, audio_sha256),
              output_size=COALESCE(?, output_size),
              codec=COALESCE(?, codec),
              sample_rate=COALESCE(?, sample_rate),
              channels=COALESCE(?, channels),
              ffprobe_duration_ms=COALESCE(?, ffprobe_duration_ms)
        WHERE id=? AND execution_phase='file_durable'`,
    ).run(
      now,
      options.attemptEvidence.providerRequestId ?? null,
      options.attemptEvidence.finalRelativePath,
      options.attemptEvidence.audioSha256,
      options.attemptEvidence.outputSize,
      options.attemptEvidence.codec,
      options.attemptEvidence.sampleRate,
      options.attemptEvidence.channels,
      options.attemptEvidence.ffprobeDurationMs,
      options.attemptId,
    );
    // 2) artifact INSERT（trg_saa_provenance 验证 attempt succeeded + 逐项 identity 闭包；
    //    canonical_audio_sha256 必须 == voice_profile_revisions.canonical_audio_sha256）
    const artifactId = crypto.randomUUID();
    const revisionSha = (db.prepare('SELECT canonical_audio_sha256 FROM voice_profile_revisions WHERE id=?').get(options.artifact.voiceProfileRevisionId) as {canonical_audio_sha256: string} | undefined)?.canonical_audio_sha256;
    if (!revisionSha) throw new RegistryContractError(EXECUTION_INVALID_STATE, 'voice revision 缺失');
    db.prepare(
      `INSERT INTO sentence_audio_artifacts
         (id, project_id, unit_id, narration_plan_artifact_id, narration_plan_content_hash,
          assignment_artifact_id, assignment_content_hash,
          performance_plan_artifact_id, performance_plan_content_hash,
          voice_profile_id, voice_profile_revision_id, canonical_audio_sha256,
          exact_source_fingerprint, synthesis_payload_fingerprint, final_tts_input_fingerprint,
          provider, model, provider_version, provider_commit,
          capability_compiler_version, capability_snapshot_json, compiled_payload_json,
          claim_id, job_id, successful_attempt_id, originating_request_id,
          output_relative_path, audio_sha256, output_size, codec, sample_rate, channels,
          ffprobe_duration_ms, generation_variant_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      job.project_id,
      claim.unit_id,
      options.artifact.narrationPlanArtifactId,
      options.artifact.narrationPlanContentHash,
      options.artifact.assignmentArtifactId,
      options.artifact.assignmentContentHash,
      options.artifact.performancePlanArtifactId,
      options.artifact.performancePlanContentHash,
      options.artifact.voiceProfileId,
      options.artifact.voiceProfileRevisionId,
      revisionSha,
      job.exact_source_fingerprint ?? '',
      job.synthesis_payload_fingerprint ?? '',
      claim.final_tts_input_fingerprint,
      job.provider,
      'IndexTTS-2',
      options.artifact.providerVersion ?? null,
      options.artifact.providerCommit ?? null,
      options.artifact.capabilityCompilerVersion,
      options.artifact.capabilitySnapshotJson,
      options.artifact.compiledPayloadJson,
      job.claim_id,
      job.id,
      options.attemptId,
      options.artifact.originatingRequestId ?? null,
      options.attemptEvidence.finalRelativePath,
      options.attemptEvidence.audioSha256,
      options.attemptEvidence.outputSize,
      options.attemptEvidence.codec,
      options.attemptEvidence.sampleRate,
      options.attemptEvidence.channels,
      options.attemptEvidence.ffprobeDurationMs,
      claim.generation_variant_id,
      now,
    );
    // 3) state_transition succeeded command + 双侧 terminal
    const {commandId, seq} = insertExecutionCommand(db, {
      jobId: job.id,
      claimId: job.claim_id,
      commandKind: 'state_transition',
      fromClaimStatus: job.status,
      toClaimStatus: 'succeeded',
      fromJobStatus: job.status,
      toJobStatus: 'succeeded',
      workerOwnerToken: options.workerOwnerToken,
      workerAttempt: job.attempt,
      resultArtifactId: artifactId,
    });
    db.prepare(
      `UPDATE tts_synthesis_claims
          SET status='succeeded', result_artifact_id=?, owner_token=NULL, lease_expires_at_epoch_ms=NULL,
              last_execution_command_id=?, execution_command_seq=?, updated_at=?
        WHERE id=? AND status=?`,
    ).run(artifactId, commandId, seq, now, job.claim_id, job.status);
    db.prepare(
      `UPDATE tts_jobs
          SET status='succeeded', result_artifact_id=?, finished_at=?, cancel_requested=NULL,
              last_execution_command_id=?, execution_command_seq=?
        WHERE id=? AND claim_id=? AND status=?`,
    ).run(artifactId, now, commandId, seq, job.id, job.claim_id, job.status);
    return {claimId: job.claim_id, artifactId};
  });
  return tx.immediate();
}

/** Fail（state_transition failed）：attempt → validation_failed/transport_failed + 双侧 failed。 */
export function failSynthesisJob(
  db: Db,
  options: {jobId: string; workerOwnerToken: string; errorCode: string; errorMessage: string; attemptId?: string; attemptFailurePhase?: 'transport_failed' | 'validation_failed' | 'indeterminate'},
): void {
  const tx = db.transaction((): void => {
    const job = getTtsCJob(db, options.jobId);
    if (job.status !== 'running' && job.status !== 'indeterminate') {
      throw new RegistryContractError(EXECUTION_INVALID_STATE, `job ${options.jobId} 状态 ${job.status} 不可 fail`);
    }
    const claim = db.prepare('SELECT status, owner_token FROM tts_synthesis_claims WHERE id=?').get(job.claim_id) as {status: string; owner_token: string | null} | undefined;
    if (!claim || claim.status !== job.status || claim.owner_token !== options.workerOwnerToken) {
      throw new RegistryContractError(EXECUTION_NOT_OWNER, `claim ${job.claim_id} owner 不匹配`);
    }
    const now = nowIso();
    if (options.attemptId) {
      const attempt = getGenerationAttempt(db, options.attemptId);
      if (attempt.job_id === job.id && attempt.execution_phase !== 'succeeded') {
        db.prepare(
          `UPDATE tts_generation_attempts
              SET execution_phase=?, error_classification=?, finished_at=?
            WHERE id=? AND execution_phase IN ('created','provider_in_flight','response_persisted','file_validated','file_durable','indeterminate')`,
        ).run(options.attemptFailurePhase ?? 'validation_failed', options.errorCode, now, options.attemptId);
      }
    }
    const {commandId, seq} = insertExecutionCommand(db, {
      jobId: job.id,
      claimId: job.claim_id,
      commandKind: 'state_transition',
      fromClaimStatus: job.status,
      toClaimStatus: 'failed',
      fromJobStatus: job.status,
      toJobStatus: 'failed',
      workerOwnerToken: options.workerOwnerToken,
      workerAttempt: job.attempt,
      errorCode: options.errorCode,
      errorMessage: options.errorMessage,
    });
    db.prepare(
      `UPDATE tts_synthesis_claims
          SET status='failed', owner_token=NULL, lease_expires_at_epoch_ms=NULL,
              last_execution_command_id=?, execution_command_seq=?, updated_at=?
        WHERE id=? AND status=?`,
    ).run(commandId, seq, now, job.claim_id, job.status);
    db.prepare(
      `UPDATE tts_jobs
          SET status='failed', finished_at=?, error_code=?, error_message=?, cancel_requested=NULL,
              last_execution_command_id=?, execution_command_seq=?
        WHERE id=? AND claim_id=? AND status=?`,
    ).run(now, options.errorCode, options.errorMessage, commandId, seq, job.id, job.claim_id, job.status);
  });
  tx.immediate();
}

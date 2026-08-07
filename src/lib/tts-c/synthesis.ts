/**
 * TTS-C.2 — synthesis request envelope / claim fan-in / validation reuse /
 * zero-subscriber / atomic generation dispatch（frozen §2.1/§2.2/§2.2b 应用层）。
 *
 * 语义（frozen contract）：
 *   - request：initializing → waiting（同一 BEGIN IMMEDIATE 内建立 authoritative
 *     claim link——trg_tar_waiting_link 强制 waiting 必须 claim_id 非 NULL）；
 *     initializing 不计入 subscriber，waiting/running 才是有效 subscriber。
 *   - claim：唯一 synthesis reservation（validating_reuse 初始态；trg_tsc_initial 强制）；
 *     fan-in key = (project_id, unit_id, final_tts_input_fingerprint, generation_variant_id)
 *     ——同 key 的 active claim 复用（uq_tts_synthesis_claim_active）。
 *   - validation：candidate artifact（同 synthesis identity 的 succeeded artifact）存在 →
 *     validating_reuse + validation owner/lease/attempt；usable → 复用（不建 provider job）；
 *     unusable + subscriber>0 → 原子 dispatch；unusable + subscriber=0 → claim cancelled。
 *   - dispatch：单条 INSERT tts_claim_generation_dispatches（trg_tcgd_dispatch 自动完成
 *     fenced 验证 + zero-subscriber 检查 + 恰好一个 queued job + claim→generation_pending）。
 *   - cancel：per-request 只 detach 自己（request→cancelled）；最后 subscriber 退出时
 *     validating_reuse → claim cancelled（零 job）；generation_pending/running →
 *     job.cancel_requested=1。
 *
 * 全部通过 SQLite 事务 + frozen trigger 单裁决，不引入进程级 mutex。
 */
import crypto from 'node:crypto';
import type {Db} from '../db';
import {dbNowMs, nowIso} from './materialization';
import {RegistryContractError} from './registry-contract-error';
import {computeSynthesisPayloadFingerprint} from './synthesis-payload';

export const SYNTHESIS_VALIDATION_LEASE_MS = 15 * 60 * 1000;
export const VALIDATION_STALE_OWNER = 'STALE_VALIDATION_OWNER';
export const SYNTHESIS_INVALID_STATE = 'SYNTHESIS_INVALID_STATE';
export const SYNTHESIS_ZERO_SUBSCRIBER = 'SYNTHESIS_ZERO_SUBSCRIBER';
export const SYNTHESIS_NOT_FOUND = 'SYNTHESIS_NOT_FOUND';
export const SYNTHESIS_CONFLICT = 'SYNTHESIS_CONFLICT';
/** 同 (project_id, request_id) 已存在且 frozen identity 不同。 */
export const REQUEST_ID_CONFLICT = 'REQUEST_ID_CONFLICT';

export interface SynthesisRequestInput {
  requestId: string;
  unitId: string;
  exactSourceFingerprint: string;
  synthesisPayloadFingerprint: string;
  finalTtsInputFingerprint: string;
  generationVariantId?: string;
}

export interface SynthesisClaimRow {
  id: string;
  project_id: string;
  unit_id: string;
  final_tts_input_fingerprint: string;
  generation_variant_id: string;
  status: string;
  result_artifact_id: string | null;
  validation_owner_token: string | null;
  validation_lease_expires_at_epoch_ms: number | null;
  validation_attempt: number;
  candidate_artifact_id: string | null;
  candidate_artifact_metadata_hash: string | null;
  validation_started_at: string | null;
}

export interface SynthesisRequestRow {
  id: string;
  project_id: string;
  request_id: string;
  unit_id: string;
  status: string;
  claim_id: string | null;
  job_id: string | null;
  result_artifact_id: string | null;
}

export function getSynthesisClaim(db: Db, claimId: string): SynthesisClaimRow {
  const row = db.prepare('SELECT * FROM tts_synthesis_claims WHERE id = ?').get(claimId) as SynthesisClaimRow | undefined;
  if (!row) throw new RegistryContractError(SYNTHESIS_NOT_FOUND, `claim 不存在: ${claimId}`);
  return row;
}

export function getSynthesisRequest(db: Db, projectId: string, requestId: string): SynthesisRequestRow {
  const row = db
    .prepare('SELECT * FROM tts_audio_requests WHERE project_id = ? AND request_id = ?')
    .get(projectId, requestId) as SynthesisRequestRow | undefined;
  if (!row) throw new RegistryContractError(SYNTHESIS_NOT_FOUND, `request 不存在: ${projectId}/${requestId}`);
  return row;
}

/** active subscriber 数（waiting/running）。 */
export function countClaimSubscribers(db: Db, claimId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) n FROM tts_audio_requests WHERE claim_id = ? AND status IN ('waiting','running')")
      .get(claimId) as {n: number}
  ).n;
}

/** candidate artifact 查找：同 synthesis identity 的 succeeded artifact（validation reuse 候选）。 */
export function findCandidateArtifact(
  db: Db,
  projectId: string,
  unitId: string,
  finalTtsInputFingerprint: string,
  generationVariantId: string,
): {id: string; metadataHash: string} | null {
  const row = db
    .prepare(
      `SELECT a.id, a.canonical_audio_sha256, a.output_size, a.codec, a.sample_rate, a.channels,
              a.ffprobe_duration_ms, a.provider, a.model
         FROM sentence_audio_artifacts a
         JOIN tts_synthesis_claims c ON c.result_artifact_id = a.id
        WHERE a.project_id = ? AND a.unit_id = ? AND a.final_tts_input_fingerprint = ?
          AND a.generation_variant_id = ? AND c.status = 'succeeded'
        ORDER BY a.created_at DESC LIMIT 1`,
    )
    .get(projectId, unitId, finalTtsInputFingerprint, generationVariantId) as
    | {
        id: string;
        canonical_audio_sha256: string;
        output_size: number;
        codec: string;
        sample_rate: number;
        channels: number;
        ffprobe_duration_ms: number;
        provider: string;
        model: string;
      }
    | undefined;
  if (!row) return null;
  const metadataHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        sha256: row.canonical_audio_sha256,
        size: row.output_size,
        codec: row.codec,
        sampleRate: row.sample_rate,
        channels: row.channels,
        durationMs: row.ffprobe_duration_ms,
        provider: row.provider,
        model: row.model,
      }),
      'utf8',
    )
    .digest('hex');
  return {id: row.id, metadataHash};
}

/**
 * 创建 synthesis requests（envelope + fan-in）：
 *   每个 request 同事务内：INSERT initializing → 查找/创建 active claim
 *   （validating_reuse + validation owner/lease/attempt + candidate）→ request→waiting + claim_id。
 * 同 (project, unit, fingerprint, variant) 的 active claim 复用（many requests → one claim）。
 */
export function createSynthesisRequests(
  db: Db,
  options: {
    projectId: string;
    requests: SynthesisRequestInput[];
  },
): Array<{requestId: string; claimId: string | null; status: string; replayed: boolean}> {
  const tx = db.transaction((): Array<{requestId: string; claimId: string | null; status: string; replayed: boolean}> => {
    const out: Array<{requestId: string; claimId: string | null; status: string; replayed: boolean}> = [];
    for (const req of options.requests) {
      const now = nowIso();
      const generationVariantId = req.generationVariantId ?? 'default';
      // P1-4：requestId replay / conflict（frozen scope = (project_id, request_id)）——
      // 同 requestId + exact 同 identity → replay（不 INSERT 第二行、不建第二 claim、不抛 raw UNIQUE）；
      // 同 requestId + identity 不同 → REQUEST_ID_CONFLICT（不暴露 SQLite UNIQUE error）。
      const existing = db
        .prepare(
          `SELECT id, unit_id, exact_source_fingerprint, synthesis_payload_fingerprint,
                  final_tts_input_fingerprint, generation_variant_id, status, claim_id
             FROM tts_audio_requests WHERE project_id = ? AND request_id = ?`,
        )
        .get(options.projectId, req.requestId) as
        | {
            id: string;
            unit_id: string;
            exact_source_fingerprint: string;
            synthesis_payload_fingerprint: string;
            final_tts_input_fingerprint: string;
            generation_variant_id: string;
            status: string;
            claim_id: string | null;
          }
        | undefined;
      if (existing) {
        const sameIdentity =
          existing.unit_id === req.unitId &&
          existing.exact_source_fingerprint === req.exactSourceFingerprint &&
          existing.synthesis_payload_fingerprint === req.synthesisPayloadFingerprint &&
          existing.final_tts_input_fingerprint === req.finalTtsInputFingerprint &&
          existing.generation_variant_id === generationVariantId;
        if (!sameIdentity) {
          throw new RegistryContractError(REQUEST_ID_CONFLICT, `requestId ${req.requestId} 已存在且 frozen identity 不同`);
        }
        out.push({requestId: req.requestId, claimId: existing.claim_id, status: existing.status, replayed: true});
        continue;
      }
      const requestId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO tts_audio_requests
           (id, project_id, request_id, unit_id, exact_source_fingerprint,
            synthesis_payload_fingerprint, final_tts_input_fingerprint, generation_variant_id,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`,
      ).run(
        requestId,
        options.projectId,
        req.requestId,
        req.unitId,
        req.exactSourceFingerprint,
        req.synthesisPayloadFingerprint,
        req.finalTtsInputFingerprint,
        generationVariantId,
        now,
        now,
      );
      // fan-in：同 key active claim 复用；否则创建（validating_reuse 初始态）
      const active = db
        .prepare(
          `SELECT id FROM tts_synthesis_claims
            WHERE project_id = ? AND unit_id = ? AND final_tts_input_fingerprint = ?
              AND generation_variant_id = ?
              AND status IN ('validating_reuse','generation_pending','running','indeterminate')
            ORDER BY created_at ASC LIMIT 1`,
        )
        .get(
          options.projectId,
          req.unitId,
          req.finalTtsInputFingerprint,
          generationVariantId,
        ) as {id: string} | undefined;
      let claimId: string;
      if (active) {
        claimId = active.id;
      } else {
        claimId = crypto.randomUUID();
        const validationOwner = crypto.randomUUID();
        const lease = dbNowMs(db) + SYNTHESIS_VALIDATION_LEASE_MS;
        const candidate = findCandidateArtifact(
          db,
          options.projectId,
          req.unitId,
          req.finalTtsInputFingerprint,
          generationVariantId,
        );
        db.prepare(
          `INSERT INTO tts_synthesis_claims
             (id, project_id, unit_id, final_tts_input_fingerprint, generation_variant_id,
              status, validation_owner_token, validation_lease_expires_at_epoch_ms,
              validation_attempt, candidate_artifact_id, candidate_artifact_metadata_hash,
              validation_started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'validating_reuse', ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).run(
          claimId,
          options.projectId,
          req.unitId,
          req.finalTtsInputFingerprint,
          generationVariantId,
          validationOwner,
          lease,
          candidate?.id ?? null,
          candidate?.metadataHash ?? null,
          now,
          now,
          now,
        );
      }
      // initializing → waiting（同事务 authoritative claim link；trg_tar_waiting_link 强制）
      const res = db
        .prepare(
          `UPDATE tts_audio_requests SET status='waiting', claim_id=?, updated_at=?
            WHERE id=? AND status='initializing'`,
        )
        .run(claimId, now, requestId);
      if (res.changes !== 1) throw new RegistryContractError(SYNTHESIS_INVALID_STATE, `request ${req.requestId} 无法推进 waiting`);
      out.push({requestId: req.requestId, claimId, status: 'waiting', replayed: false});
    }
    return out;
  });
  return tx.immediate();
}

export type ValidationResolveOutcome =
  | {kind: 'reused'; claimId: string; artifactId: string}
  | {kind: 'dispatched'; claimId: string; jobId: string}
  | {kind: 'cancelled'; claimId: string};

/** dispatch command 的 job 身份上下文（trg_tcgd_dispatch 建 job 所需的全部冻结字段）。 */
export interface DispatchJobContext {
  narrationPlanArtifactId: string;
  narrationPlanVersion: number;
  provider: string;
  voiceProfileId: string;
  voiceProfileRevision: string;
  voiceProfileRevisionId: string;
  payloadJson: string;
  originatingRequestId?: string | null;
  exactSourceFingerprint: string;
  synthesisPayloadFingerprint: string;
}

/**
 * Validation resolve（fenced）：candidate usable → 复用（claim→succeeded + request→succeeded，
 * 不建 provider job）；unusable + subscriber>0 → 原子 dispatch（单条 INSERT command，
 * trigger 建唯一 queued job + claim→generation_pending）；unusable + subscriber=0 → claim cancelled。
 * 调用方必须持有 claim.validation_owner_token / validation_attempt / 本次 exact validation
 * snapshot（candidateArtifactId / candidateMetadataHash，NULL 用 SQLite IS 语义）。
 * usable 与 zero-subscriber 的 terminal UPDATE 均为 frozen §3.1 exact fenced CAS
 * （id + status + owner + attempt + DB_NOW<=lease + candidate IS + hash IS；changes=1；
 * 不命中 → STALE_VALIDATION_OWNER 整事务回滚零副作用）。
 */
export function resolveClaimValidation(
  db: Db,
  options: {
    claimId: string;
    validationOwnerToken: string;
    validationAttempt: number;
    candidateUsable: boolean;
    /** 本次 exact validation snapshot（frozen §3.1；NULL 用 IS 语义）。 */
    candidateArtifactId?: string | null;
    candidateMetadataHash?: string | null;
    /** unusable + subscriber>0 时必填（dispatch command 的 job 身份字段）。 */
    jobContext?: DispatchJobContext;
  },
): ValidationResolveOutcome {
  const tx = db.transaction((): ValidationResolveOutcome => {
    const claim = getSynthesisClaim(db, options.claimId);
    if (claim.status !== 'validating_reuse') {
      throw new RegistryContractError(SYNTHESIS_INVALID_STATE, `claim ${options.claimId} 状态 ${claim.status} 不可 resolve validation`);
    }
    if (claim.validation_owner_token !== options.validationOwnerToken || claim.validation_attempt !== options.validationAttempt) {
      throw new RegistryContractError(VALIDATION_STALE_OWNER, `claim ${options.claimId} validation owner/attempt 不匹配`);
    }
    const snapshotCandidateId = options.candidateArtifactId === undefined ? claim.candidate_artifact_id : options.candidateArtifactId;
    const snapshotCandidateHash = options.candidateMetadataHash === undefined ? claim.candidate_artifact_metadata_hash : options.candidateMetadataHash;
    const subscribers = countClaimSubscribers(db, options.claimId);
    const now = nowIso();
    if (options.candidateUsable) {
      if (!snapshotCandidateId) {
        throw new RegistryContractError(SYNTHESIS_INVALID_STATE, 'candidateUsable 但 claim 无 candidate');
      }
      // 复用：frozen §3.1 exact fenced CAS → claim succeeded + result link；全部 active request → succeeded
      const res = db
        .prepare(
          `UPDATE tts_synthesis_claims
              SET status='succeeded', result_artifact_id=?,
                  validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
                  updated_at=?
            WHERE id=? AND status='validating_reuse'
              AND validation_owner_token=? AND validation_attempt=?
              AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                  <= validation_lease_expires_at_epoch_ms
              AND candidate_artifact_id IS ? AND candidate_artifact_metadata_hash IS ?`,
        )
        .run(snapshotCandidateId, now, options.claimId, options.validationOwnerToken, options.validationAttempt, snapshotCandidateId, snapshotCandidateHash);
      if (res.changes !== 1) {
        throw new RegistryContractError(VALIDATION_STALE_OWNER, `claim ${options.claimId} usable finalize fence 不命中（stale owner/lease/candidate）`);
      }
      db.prepare(
        `UPDATE tts_audio_requests
            SET status='succeeded', result_artifact_id=?, updated_at=?
          WHERE claim_id=? AND status IN ('waiting','running')`,
      ).run(snapshotCandidateId, now, options.claimId);
      return {kind: 'reused', claimId: options.claimId, artifactId: snapshotCandidateId};
    }
    if (subscribers === 0) {
      // zero-subscriber：frozen §3.1 exact fenced CAS → claim cancelled，零 provider job
      const res = db
        .prepare(
          `UPDATE tts_synthesis_claims
              SET status='cancelled', validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
                  updated_at=?
            WHERE id=? AND status='validating_reuse'
              AND validation_owner_token=? AND validation_attempt=?
              AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                  <= validation_lease_expires_at_epoch_ms
              AND candidate_artifact_id IS ? AND candidate_artifact_metadata_hash IS ?`,
        )
        .run(now, options.claimId, options.validationOwnerToken, options.validationAttempt, snapshotCandidateId, snapshotCandidateHash);
      if (res.changes !== 1) {
        throw new RegistryContractError(VALIDATION_STALE_OWNER, `claim ${options.claimId} zero-subscriber cancel fence 不命中`);
      }
      return {kind: 'cancelled', claimId: options.claimId};
    }
    // 原子 dispatch：单条 INSERT command（trg_tcgd_dispatch 完成 fenced 验证 + zero-subscriber
    // 检查 + 恰好一个 queued job + claim→generation_pending）
    if (!options.jobContext) {
      throw new RegistryContractError(SYNTHESIS_INVALID_STATE, 'unusable candidate + subscriber>0 需要 jobContext（dispatch command）');
    }
    const ctx = options.jobContext;
    // frozen §2.0 应用层契约：payload_json 必须与 synthesis_payload_fingerprint exact 对应
    // （SQL 不可表达——应用层同事务重算比较）
    if (computeSynthesisPayloadFingerprint(ctx.payloadJson) !== ctx.synthesisPayloadFingerprint) {
      throw new RegistryContractError(SYNTHESIS_INVALID_STATE, 'payload_json 与 synthesis_payload_fingerprint 不一致');
    }
    const jobId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO tts_claim_generation_dispatches
         (id, claim_id, job_id, validation_owner_token, validation_attempt,
          candidate_artifact_id, candidate_artifact_metadata_hash,
          project_id, unit_id, narration_plan_artifact_id, narration_plan_version,
          provider, voice_profile_id, voice_profile_revision, voice_profile_revision_id,
          payload_json, originating_request_id, exact_source_fingerprint,
          synthesis_payload_fingerprint, final_tts_input_fingerprint, generation_variant_id,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      options.claimId,
      jobId,
      options.validationOwnerToken,
      options.validationAttempt,
      snapshotCandidateId,
      snapshotCandidateHash,
      claim.project_id,
      claim.unit_id,
      ctx.narrationPlanArtifactId,
      ctx.narrationPlanVersion,
      ctx.provider,
      ctx.voiceProfileId,
      ctx.voiceProfileRevision,
      ctx.voiceProfileRevisionId,
      ctx.payloadJson,
      ctx.originatingRequestId ?? null,
      ctx.exactSourceFingerprint,
      ctx.synthesisPayloadFingerprint,
      claim.final_tts_input_fingerprint,
      claim.generation_variant_id,
      now,
    );
    return {kind: 'dispatched', claimId: options.claimId, jobId};
  });
  return tx.immediate();
}

/**
 * Validation renewal（frozen §3.3 最小 DB primitive）：validating_reuse 同态续租——
 * status + owner + attempt exact + 旧 lease >= DB_NOW_MS；新 lease > DB_NOW_MS。
 * changes=1 才成功；旧 owner / lease expired → STALE_VALIDATION_OWNER 零副作用。
 */
export function renewClaimValidation(
  db: Db,
  options: {claimId: string; validationOwnerToken: string; validationAttempt: number; leaseMs?: number},
): {claimId: string; newLease: number} {
  const tx = db.transaction((): {claimId: string; newLease: number} => {
    const newLease = dbNowMs(db) + (options.leaseMs ?? SYNTHESIS_VALIDATION_LEASE_MS);
    const res = db
      .prepare(
        `UPDATE tts_synthesis_claims
            SET validation_lease_expires_at_epoch_ms=?, updated_at=?
          WHERE id=? AND status='validating_reuse'
            AND validation_owner_token=? AND validation_attempt=?
            AND validation_lease_expires_at_epoch_ms IS NOT NULL
            AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                <= validation_lease_expires_at_epoch_ms`,
      )
      .run(newLease, nowIso(), options.claimId, options.validationOwnerToken, options.validationAttempt);
    if (res.changes !== 1) {
      throw new RegistryContractError(VALIDATION_STALE_OWNER, `claim ${options.claimId} validation renew 不命中（stale owner/lease）`);
    }
    return {claimId: options.claimId, newLease};
  });
  return tx.immediate();
}

/**
 * Validation takeover（frozen §3.2）：validation lease 过期后 fenced CAS 接管——
 * 新 validation owner + attempt+1 + 新 lease + validation_started_at=当前 attempt 开始时间；
 * changes=1 才获得 ownership（单裁决）。旧 validator 后续 resolve 因 owner/attempt
 * 不匹配 → STALE_VALIDATION_OWNER。
 */
export function takeoverClaimValidation(
  db: Db,
  options: {claimId: string; newValidationOwnerToken: string; leaseMs?: number},
): {claimId: string; newValidationAttempt: number} {
  const tx = db.transaction((): {claimId: string; newValidationAttempt: number} => {
    const now = nowIso();
    const lease = dbNowMs(db) + (options.leaseMs ?? SYNTHESIS_VALIDATION_LEASE_MS);
    const res = db
      .prepare(
        `UPDATE tts_synthesis_claims
            SET validation_owner_token=?, validation_lease_expires_at_epoch_ms=?,
                validation_attempt=validation_attempt+1, validation_started_at=?, updated_at=?
          WHERE id=? AND status='validating_reuse'
            AND validation_lease_expires_at_epoch_ms IS NOT NULL
            AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
                > validation_lease_expires_at_epoch_ms`,
      )
      .run(options.newValidationOwnerToken, lease, now, now, options.claimId);
    if (res.changes !== 1) {
      throw new RegistryContractError(VALIDATION_STALE_OWNER, `claim ${options.claimId} validation takeover 不命中（lease 未过期/状态非 validating_reuse）`);
    }
    const claim = getSynthesisClaim(db, options.claimId);
    return {claimId: options.claimId, newValidationAttempt: claim.validation_attempt};
  });
  return tx.immediate();
}

/**
 * Per-request cancel（只 detach 自己；claim_id 保留为 provenance）。
 * 最后 subscriber 退出时：validating_reuse → claim cancelled（零 job）；
 * generation_pending/running → job.cancel_requested=1。
 */
export function cancelSynthesisRequest(db: Db, projectId: string, requestId: string): {claimId: string | null; jobCancelledRequested: boolean} {
  const tx = db.transaction((): {claimId: string | null; jobCancelledRequested: boolean} => {
    const req = getSynthesisRequest(db, projectId, requestId);
    if (req.status === 'succeeded' || req.status === 'cancelled' || req.status === 'failed') {
      throw new RegistryContractError(SYNTHESIS_INVALID_STATE, `request ${requestId} 已终态 ${req.status}`);
    }
    const now = nowIso();
    db.prepare(
      `UPDATE tts_audio_requests SET status='cancelled', updated_at=? WHERE id=? AND status NOT IN ('succeeded','cancelled','failed')`,
    ).run(now, req.id);
    if (!req.claim_id) return {claimId: null, jobCancelledRequested: false};
    const claim = getSynthesisClaim(db, req.claim_id);
    let jobCancelledRequested = false;
    if (countClaimSubscribers(db, req.claim_id) === 0) {
      if (claim.status === 'validating_reuse') {
        db.prepare(
          `UPDATE tts_synthesis_claims
              SET status='cancelled', validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL,
                  updated_at=?
            WHERE id=? AND status='validating_reuse'`,
        ).run(now, req.claim_id);
      } else if (claim.status === 'generation_pending' || claim.status === 'running') {
        const res = db
          .prepare(
            `UPDATE tts_jobs SET cancel_requested=1 WHERE claim_id=? AND status IN ('queued','running')`,
          )
          .run(req.claim_id);
        jobCancelledRequested = res.changes > 0;
      }
    }
    return {claimId: req.claim_id, jobCancelledRequested};
  });
  return tx.immediate();
}

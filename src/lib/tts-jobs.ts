import crypto from 'node:crypto';
import {z} from 'zod';
import {getDb} from './db';
import {releaseResourceLeaseForJob} from './resources/leases';

/**
 * TTS 任务队列数据层（M3-B §二十三/二十四/四十二/四十三）。
 * 生命周期与 llm_jobs 对齐：queued/running/succeeded/failed/cancelled，
 * heartbeat / stale recovery（cancel 优先）/ cancel / retry（上限）。
 * 一个 speech unit 一个 job；同 (plan artifact, unit, provider, voice) 幂等。
 */

export type TtsJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TtsJobRow {
  id: string;
  project_id: string;
  narration_plan_artifact_id: string;
  narration_plan_version: number;
  unit_id: string;
  provider: string;
  voice_profile_id: string;
  voice_profile_revision: string;
  status: TtsJobStatus;
  payload_json: string;
  output_path: string | null;
  duration_ms: number | null;
  audio_sha256: string | null;
  result_json: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  max_attempts: number;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  cancel_requested: number;
}

const ttsQcReplacementSchema = z.object({
  reason: z.literal('AUDIO_QC_CLIPPING'),
  supersedesJobId: z.string().min(1),
  candidateNumber: z.number().int().min(1).max(2),
  method: z.literal('EXACT_TEXT_MICRO_SEGMENT').optional(),
  microComposite: z.object({
    splitPlan: z.number().int().min(1).max(2),
    parentTextSha256: z.string().regex(/^[0-9a-f]{64}$/),
    childJobIds: z.array(z.string().min(1)).min(2).max(3),
  }).optional(),
});

const ttsQcMicroSegmentSchema = z.object({
  reason: z.literal('AUDIO_QC_PROVIDER_CLIPPING'),
  supersedesJobId: z.string().min(1),
  parentUnitId: z.string().regex(/^N\d{3}$/),
  parentTextSha256: z.string().regex(/^[0-9a-f]{64}$/),
  childTextSha256: z.string().regex(/^[0-9a-f]{64}$/),
  splitPlan: z.number().int().min(1).max(2),
  childIndex: z.number().int().min(1).max(3),
  childCount: z.number().int().min(2).max(3),
  candidateNumber: z.number().int().min(1).max(2),
});

/** 入队快照（immutable Narration Plan source + unit + voice）。 */
export const ttsJobPayloadSchema = z.object({
  schemaVersion: z.literal('1.0'),
  narrationPlanArtifactId: z.string().min(1),
  narrationPlanArtifactVersion: z.number().int().positive(),
  scriptV2Version: z.number().int().positive(),
  compilerVersion: z.string().min(1),
  unitId: z.string().regex(/^N\d{3}(?:-R[12]-[A-C])?$/),
  unitText: z.string().min(1),
  /** Optional legacy-registry reference snapshot; absent on historical jobs. */
  referenceAudioSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Append-only replacement of a technically succeeded unit that failed audio QC. */
  qcReplacement: ttsQcReplacementSchema.optional(),
  /** Exact-text child generated only to repair a clipped logical parent unit. */
  qcMicroSegment: ttsQcMicroSegmentSchema.optional(),
});

export type TtsJobPayload = z.infer<typeof ttsJobPayloadSchema>;

/**
 * M7.1：v2 payload（typed narration）。delivery + 完整 ttsInputFingerprint
 * （REVIEW DECISIONS 1.3）。旧 v1.0 payload 保持可读（union 解析）。
 */
export const ttsJobPayloadV11Schema = z.object({
  schemaVersion: z.literal('tts-payload@1.1'),
  narrationPlanArtifactId: z.string().min(1),
  narrationPlanArtifactVersion: z.number().int().positive(),
  scriptV2Version: z.number().int().positive(),
  compilerVersion: z.string().min(1),
  unitId: z.string().regex(/^N\d{3}$/),
  spokenText: z.string().min(1),
  delivery: z.enum(['normal', 'slow', 'fast', 'soft', 'firm', 'emphasis']),
  ttsInputFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  referenceAudioSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  qcReplacement: ttsQcReplacementSchema.optional(),
  qcMicroSegment: ttsQcMicroSegmentSchema.optional(),
});

export type TtsJobPayloadV11 = z.infer<typeof ttsJobPayloadV11Schema>;

/** 读取任意历史 payload：v1.0（unitText）或 v1.1（spokenText + fingerprint）。 */
export const anyTtsJobPayloadSchema = z.union([ttsJobPayloadSchema, ttsJobPayloadV11Schema]);
export type AnyTtsJobPayload = z.infer<typeof anyTtsJobPayloadSchema>;

/** 解析持久化 payload_json；非法返回 null（不 crash、不猜）。 */
export function parseTtsJobPayload(payloadJson: string): AnyTtsJobPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const parsed = anyTtsJobPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 任意 payload → 朗读文本（v1.0=unitText，v1.1=spokenText）。 */
export function payloadSpokenText(payload: AnyTtsJobPayload): string {
  return payload.schemaVersion === '1.0' ? payload.unitText : payload.spokenText;
}

/**
 * 成功时持久化的 Provider 返回快照 + ffprobe 元数据（M3-B Hardening §三/五）。
 * 记录的是「实际生成这一个 WAV 时 Provider 返回的 snapshot」，
 * 不从 provider name / 环境变量推断；manifest 的唯一 metadata 来源。
 */
export const ttsJobResultSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  providerVersion: z.string().min(1).nullable().default(null),
  providerCommit: z.string().min(1).nullable().default(null),
  settings: z.object({
    voiceProfileId: z.string().min(1),
    voiceProfileRevision: z.string().min(1),
    useRandom: z.boolean(),
    /** Optional reference snapshot; absent on historical result_json. */
    referenceSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  }),
  audio: z.object({
    codec: z.string().min(1),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
  }),
});

export type TtsJobResult = z.infer<typeof ttsJobResultSchema>;

export class TtsJobError extends Error {
  constructor(
    public readonly code: 'JOB_ALREADY_ACTIVE' | 'JOB_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'TtsJobError';
  }
}

function now(): string {
  return new Date().toISOString();
}

export function getTtsJob(jobId: string): TtsJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM tts_jobs WHERE id = ?')
    .get(jobId) as TtsJobRow | undefined;
}

/** 同 (plan artifact, unit, provider, voice) 的活跃 job（去重依据）。 */
export function getActiveTtsJob(
  projectId: string,
  planArtifactId: string,
  unitId: string,
  provider: string,
  voiceProfileId: string,
  voiceProfileRevision: string,
): TtsJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM tts_jobs
       WHERE project_id = ? AND narration_plan_artifact_id = ? AND unit_id = ?
         AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
         AND status IN ('queued', 'running')
       ORDER BY queued_at ASC LIMIT 1`,
    )
    .get(projectId, planArtifactId, unitId, provider, voiceProfileId, voiceProfileRevision) as
    | TtsJobRow
    | undefined;
}

/** 同源同 voice 的最新成功 job（manifest 选用依据）。 */
export function getLatestSucceededTtsJob(
  projectId: string,
  planArtifactId: string,
  unitId: string,
  provider: string,
  voiceProfileId: string,
  voiceProfileRevision: string,
): TtsJobRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM tts_jobs
       WHERE project_id = ? AND narration_plan_artifact_id = ? AND unit_id = ?
         AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
         AND status = 'succeeded'
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(projectId, planArtifactId, unitId, provider, voiceProfileId, voiceProfileRevision) as
    | TtsJobRow
    | undefined;
}

/** 【事务内 helper】去重 + INSERT（调用方负责事务）。 */
export function enqueueTtsJobTx(
  projectId: string,
  provider: string,
  voiceProfileId: string,
  voiceProfileRevision: string,
  payload: AnyTtsJobPayload,
  options: {maxAttempts?: number} = {},
): TtsJobRow {
  const db = getDb();
  const active = getActiveTtsJob(
    projectId,
    payload.narrationPlanArtifactId,
    payload.unitId,
    provider,
    voiceProfileId,
    voiceProfileRevision,
  );
  if (active) {
    throw new TtsJobError(
      'JOB_ALREADY_ACTIVE',
      `${payload.unitId} 已有进行中的 TTS 任务（${active.id}）`,
    );
  }
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts 必须为正整数');
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tts_jobs (
       id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
       provider, voice_profile_id, voice_profile_revision,
       status, payload_json, queued_at, attempt, max_attempts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?)`,
  ).run(
    id,
    projectId,
    payload.narrationPlanArtifactId,
    payload.narrationPlanArtifactVersion,
    payload.unitId,
    provider,
    voiceProfileId,
    voiceProfileRevision,
    JSON.stringify(payload),
    now(),
    maxAttempts,
  );
  const row = getTtsJob(id);
  if (!row) {
    throw new Error(`enqueueTtsJobTx: inserted job ${id} not found`);
  }
  return row;
}

/** 心跳（仅 running）。 */
export function heartbeatTtsJob(jobId: string): void {
  getDb()
    .prepare(`UPDATE tts_jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'`)
    .run(now(), jobId);
}

export type FinalizeTtsJobSuccessCode =
  | 'SUCCEEDED'
  | 'CANCELLED'
  | 'JOB_NOT_RUNNING'
  | 'JOB_NOT_FOUND';

/**
 * 成功终局原子裁决（M3-B Hardening §十）：cancel 与 success 谁先进入本事务谁赢。
 * 事务内重新读取 job：
 * - not found → JOB_NOT_FOUND；非 running → JOB_NOT_RUNNING
 * - cancel_requested=1 → cancelled（不写 output/result），返回 CANCELLED
 * - 否则 succeeded + 写 output/duration/sha256/result_json，返回 SUCCEEDED
 * 调用方负责：非 SUCCEEDED 时删除已 rename 的 final WAV（§十一文件与 DB 一致）。
 */
export function finalizeTtsJobSuccess(
  jobId: string,
  outcome: {outputPath: string; durationMs: number; audioSha256: string; result: TtsJobResult},
): FinalizeTtsJobSuccessCode {
  const db = getDb();
  const tx = db.transaction((): FinalizeTtsJobSuccessCode => {
    const job = getTtsJob(jobId);
    if (!job) return 'JOB_NOT_FOUND';
    if (job.status !== 'running') return 'JOB_NOT_RUNNING';
    const at = now();
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE tts_jobs SET status = 'cancelled', finished_at = ?
         WHERE id = ? AND status = 'running' AND cancel_requested = 1`,
      ).run(at, jobId);
      return 'CANCELLED';
    }
    db.prepare(
      `UPDATE tts_jobs
       SET status = 'succeeded', progress = 100, finished_at = ?,
           output_path = ?, duration_ms = ?, audio_sha256 = ?, result_json = ?
       WHERE id = ? AND status = 'running' AND cancel_requested = 0`,
    ).run(
      at,
      outcome.outputPath,
      outcome.durationMs,
      outcome.audioSha256,
      JSON.stringify(outcome.result),
      jobId,
    );
    return 'SUCCEEDED';
  });
  return tx.immediate();
}

export type FinalizeTtsJobFailureCode =
  | 'REQUEUED'
  | 'FAILED'
  | 'CANCELLED'
  | 'JOB_NOT_RUNNING'
  | 'JOB_NOT_FOUND';

/** 失败终局原子裁决（与 llm 同规则：cancel 优先，绝不复活）。 */
export function failTtsJob(
  jobId: string,
  code: string,
  msg: string,
  opts: {retryable: boolean},
): FinalizeTtsJobFailureCode {
  const db = getDb();
  const tx = db.transaction((): FinalizeTtsJobFailureCode => {
    const job = getTtsJob(jobId);
    if (!job) return 'JOB_NOT_FOUND';
    if (job.status !== 'running') return 'JOB_NOT_RUNNING';
    const at = now();
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE tts_jobs SET status = 'cancelled', finished_at = ?, error_code = ?, error_message = ?
         WHERE id = ? AND status = 'running' AND cancel_requested = 1`,
      ).run(at, code, msg, jobId);
      return 'CANCELLED';
    }
    if (opts.retryable && job.attempt < job.max_attempts) {
      db.prepare(
        `UPDATE tts_jobs
         SET status = 'queued', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
             error_code = ?, error_message = ?
         WHERE id = ?`,
      ).run(code, msg, jobId);
      return 'REQUEUED';
    }
    db.prepare(
      `UPDATE tts_jobs SET status = 'failed', finished_at = ?, error_code = ?, error_message = ?
       WHERE id = ?`,
    ).run(at, code, msg, jobId);
    return 'FAILED';
  });
  return tx.immediate();
}

/** 回收僵尸 running：cancel_requested=1 → cancelled；否则 → queued。 */
export function recoverStaleTtsJobs(timeoutMs: number): {requeued: number; cancelled: number} {
  const db = getDb();
  const tx = db.transaction(() => {
    const at = now();
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();

    // 先读取要回收的 job id，以便后续释放 production_gpu lease
    const staleJobIds = (
      db.prepare(
        `SELECT id FROM tts_jobs
         WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
      )
      .all(cutoff) as Array<{id: string}>
    ).map((r) => r.id);

    const cancelled = db
      .prepare(
        `UPDATE tts_jobs
         SET status = 'cancelled', finished_at = ?,
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE id IN (SELECT id FROM tts_jobs WHERE status = 'running'
           AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
           AND cancel_requested = 1)`,
      )
      .run(at, cutoff).changes;
    const requeued = db
      .prepare(
        `UPDATE tts_jobs
         SET status = 'queued', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
           AND cancel_requested = 0`,
      )
      .run(cutoff).changes;

    // 释放所有回收的 TTS job 的 production_gpu lease
    for (const jobId of staleJobIds) {
      try {
        releaseResourceLeaseForJob('production_gpu', 'tts', jobId);
      } catch {
        // lease 可能已被回收，静默忽略
      }
    }
    return {requeued, cancelled};
  });
  return tx.immediate();
}

export function requestCancelTtsJob(jobId: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE tts_jobs SET cancel_requested = 1
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(jobId).changes > 0
  );
}

export function isTtsCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare('SELECT cancel_requested FROM tts_jobs WHERE id = ?')
    .get(jobId) as {cancel_requested: number} | undefined;
  return row !== undefined && row.cancel_requested === 1;
}

/** running 任务标记 cancelled。 */
export function markTtsCancelled(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE tts_jobs SET status = 'cancelled', finished_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(now(), jobId);
}

/** queued 任务直接终结为 cancelled。 */
export function cancelQueuedTtsJob(jobId: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE tts_jobs SET status = 'cancelled', finished_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(now(), jobId).changes > 0
  );
}

/** shutdown requeue：cancel 优先于 requeue（同 llm 规则）。 */
export function requeueTtsJob(jobId: string): 'REQUEUED' | 'CANCELLED' | 'JOB_NOT_RUNNING' {
  const db = getDb();
  const tx = db.transaction((): 'REQUEUED' | 'CANCELLED' | 'JOB_NOT_RUNNING' => {
    const job = getTtsJob(jobId);
    if (!job || job.status !== 'running') return 'JOB_NOT_RUNNING';
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE tts_jobs SET status = 'cancelled', finished_at = ?,
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE id = ? AND status = 'running' AND cancel_requested = 1`,
      ).run(now(), jobId);
      return 'CANCELLED';
    }
    db.prepare(
      `UPDATE tts_jobs SET status = 'queued',
           claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ? AND status = 'running'`,
    ).run(jobId);
    return 'REQUEUED';
  });
  return tx.immediate();
}

import crypto from 'node:crypto';
import {z} from 'zod';
import {getDb} from './db';

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

/** 入队快照（immutable Narration Plan source + unit + voice）。 */
export const ttsJobPayloadSchema = z.object({
  schemaVersion: z.literal('1.0'),
  narrationPlanArtifactId: z.string().min(1),
  narrationPlanArtifactVersion: z.number().int().positive(),
  scriptV2Version: z.number().int().positive(),
  compilerVersion: z.string().min(1),
  unitId: z.string().regex(/^N\d{3}$/),
  unitText: z.string().min(1),
});

export type TtsJobPayload = z.infer<typeof ttsJobPayloadSchema>;

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
  payload: TtsJobPayload,
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
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tts_jobs (
       id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
       provider, voice_profile_id, voice_profile_revision,
       status, payload_json, queued_at, attempt, max_attempts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, 2)`,
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

/** 任务成功：写入 output_path/duration/sha256（仅 running → succeeded）。 */
export function completeTtsJob(
  jobId: string,
  outputPath: string,
  durationMs: number,
  audioSha256: string,
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE tts_jobs
         SET status = 'succeeded', progress = 100, finished_at = ?,
             output_path = ?, duration_ms = ?, audio_sha256 = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(now(), outputPath, durationMs, audioSha256, jobId).changes > 0
  );
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
    const cancelled = db
      .prepare(
        `UPDATE tts_jobs
         SET status = 'cancelled', finished_at = ?,
             claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
         WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
           AND cancel_requested = 1`,
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

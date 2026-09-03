import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {getDataDir, getDb} from '../db';
import {isLegacyM1Project} from '../projects';
import {DEFAULT_VOICE_PROFILE, getTtsProvider} from '../tts';
import {
  enqueueTtsJobTx,
  getActiveTtsJob,
  getTtsJob,
  getLatestSucceededTtsJob,
  parseTtsJobPayload,
  payloadSpokenText,
  ttsJobResultSchema,
  type TtsJobResult,
  type TtsJobRow,
} from '../tts-jobs';
import {getCurrentNarrationPlan} from './plan';
import type {NarrationPlan, NarrationUnit} from './schema';
import {detectPlanContamination, type PlanContamination} from './contamination';
import {describeLeakage, findDirectiveLeakage} from './leakage';
import {isSpeakableText} from './speech-text';
import {probeAudio, sha256FileBytes} from '../tts-c/audio-probe';

/**
 * Narration Audio 管线（M3-B §三十–三十二/四十四–五十四）。
 *
 * 链：Narration Plan current → 每个 speech unit 一个 TTS job →
 * 全部成功 → narration-audio@1.0 manifest + narration_master.wav。
 *
 * 铁律：
 * - 只有 kind=speech 调 Provider；pause(有时长)→manifest 直记，无时长/留白/prosody → unresolved
 * - Duration 唯一真相：ffprobe 实测（job 完成时记录）；pause 用声明值；不给无时长项拍脑袋
 * - Prosody 第一版不改变音频（appliedToTts=false），不做 speed/duration 伪装
 * - Job = 提交时 plan snapshot；stale 后禁止新 jobs，但旧 job 可继续完成
 * - Master 拼接经 ffmpeg 统一为 48kHz/mono/s16 PCM WAV
 */

export const NARRATION_AUDIO_SCHEMA_VERSION = 'narration-audio@1.0';
export const NARRATION_AUDIO_ARTIFACT_KIND = 'narration_audio_manifest';
export const MASTER_SAMPLE_RATE = 48000;
export const MASTER_CHANNELS = 1;
/** Measured minimum safe margin: -1.3 dBTP reached 0.0; -1.4 dB keeps 0.1 dB clearance. */
export const NARRATION_AUDIO_REPAIR_HEADROOM_DB = -1.4;

// ---------- Manifest Schema ----------

const manifestSpeechUnitSchema = z.object({
  unitId: z.string(),
  kind: z.literal('speech'),
  text: z.string(),
  filePath: z.string(),
  durationMs: z.number().int().positive(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  sha256: z.string(),
  ttsJobId: z.string(),
});

const manifestPauseUnitSchema = z.object({
  unitId: z.string(),
  kind: z.literal('pause'),
  directive: z.string().nullable(),
  durationMs: z.number().int().positive().nullable(),
  resolved: z.boolean(),
});

const manifestVisualBreathUnitSchema = z.object({
  unitId: z.string(),
  kind: z.literal('visual_breath'),
  durationMs: z.null(),
  resolved: z.literal(false),
});

const manifestProsodyUnitSchema = z.object({
  unitId: z.string(),
  kind: z.literal('prosody'),
  directive: z.string(),
  appliedToTts: z.literal(false),
});

export const narrationAudioManifestSchema = z.object({
  schemaVersion: z.literal(NARRATION_AUDIO_SCHEMA_VERSION),
  source: z.object({
    narrationPlanArtifactId: z.string(),
    narrationPlanArtifactVersion: z.number().int().positive(),
    scriptV2Version: z.number().int().positive(),
    compilerVersion: z.string(),
  }),
  provider: z.object({
    name: z.string(),
    model: z.string(),
    providerVersion: z.string().nullable(),
    providerCommit: z.string().nullable(),
    voiceProfile: z.object({id: z.string(), revision: z.string()}),
    // Optional for backward compatibility with historical default@1 manifests.
    referenceSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
    useRandom: z.literal(false),
  }),
  units: z.array(
    z.discriminatedUnion('kind', [
      manifestSpeechUnitSchema,
      manifestPauseUnitSchema,
      manifestVisualBreathUnitSchema,
      manifestProsodyUnitSchema,
    ]),
  ),
  master: z.object({
    filePath: z.string(),
    durationMs: z.number().int().positive(),
    sha256: z.string(),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
  }),
  repair: z.object({
    reason: z.literal('AUDIO_QC_CLIPPING'),
    supersedes: z.object({id: z.string(), version: z.number().int().positive()}),
    preResampleHeadroomDb: z.number().negative(),
    reusedSegments: z.array(z.string()),
    replacedSegments: z.array(z.string()),
  }).optional(),
});

export type NarrationAudioManifest = z.infer<typeof narrationAudioManifestSchema>;

// ---------- 错误 ----------

export type NarrationAudioErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'NARRATION_PLAN_NOT_CURRENT'
  | 'NARRATION_PLAN_SOURCE_MISMATCH'
  | 'NARRATION_PLAN_CONTAMINATED'
  | 'PROVIDER_SNAPSHOT_MISMATCH'
  | 'QC_REPLACEMENT_INVALID'
  | 'QC_REPLACEMENT_LIMIT'
  | 'MASTER_HARD_CLIPPING'
  | 'MASTER_PATH_CONFLICT';

export class NarrationAudioError extends Error {
  constructor(
    public readonly code: NarrationAudioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NarrationAudioError';
  }
}

// ---------- Enqueue ----------

export interface EnqueueAudioResult {
  enqueued: number;
  reused: number;
  active: number;
  planArtifactId: string;
  planArtifactVersion: number;
}

/**
 * 为当前 Narration Plan 的全部 speech units 入队（单 BEGIN IMMEDIATE）。
 * Plan 必须 current（ready）；同 (plan artifact, unit, provider, voice) 幂等。
 */
export function enqueueNarrationAudioJobs(
  projectId: string,
  options?: {
    voiceProfile?: {id: string; revision: string};
    referenceSha256?: string;
    expectedPlan?: {artifactId: string; version: number};
  },
): EnqueueAudioResult {
  const db = getDb();
  const voice = options?.voiceProfile ?? DEFAULT_VOICE_PROFILE;
  const provider = getTtsProvider();
  const tx = db.transaction((): EnqueueAudioResult => {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as
      | {id: string}
      | undefined;
    if (!project) {
      throw new NarrationAudioError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (isLegacyM1Project(projectId)) {
      throw new NarrationAudioError('LEGACY_PROJECT', 'Legacy M1 项目无 Narration Plan');
    }
    const current = getCurrentNarrationPlan(projectId);
    if (!current) {
      throw new NarrationAudioError(
        'NARRATION_PLAN_NOT_CURRENT',
        'Narration Plan 不是当前版本（missing 或 stale）——请先 Build Narration Plan',
      );
    }
    const {plan, artifact} = current;
    if (
      options?.expectedPlan &&
      (artifact.id !== options.expectedPlan.artifactId ||
        artifact.version !== options.expectedPlan.version)
    ) {
      throw new NarrationAudioError(
        'NARRATION_PLAN_SOURCE_MISMATCH',
        `Narration Plan source mismatch: expected ${options.expectedPlan.artifactId}@${options.expectedPlan.version}, ` +
          `current ${artifact.id}@${artifact.version}`,
      );
    }

    // Gate B（M7.2.1 P0 hotfix）：任何 TTS job 创建前重跑统一 leakage validator。
    // 旧污染 plan（如 script-v2@2.0 DSL 被 M6 compiler 误编产生的 artifact）：
    // 整批拒绝——零 job、零 provider 调用，绝不只跳过污染单元继续生成。
    // 错误列出全部污染 unit 与 raw token。
    const contaminated: string[] = [];
    for (const unit of plan.units) {
      if (unit.kind !== 'speech' || !unit.text) continue;
      const leaks = findDirectiveLeakage(unit.text);
      if (leaks.length > 0) {
        contaminated.push(`${unit.id} ${describeLeakage(leaks)}`);
      }
    }
    if (contaminated.length > 0) {
      throw new NarrationAudioError(
        'NARRATION_PLAN_CONTAMINATED',
        `当前 Narration Plan 的 speech unit 含导演指令/DSL 语法位（${contaminated.length} 个 unit），` +
          `整批拒绝入队（零 TTS job）：${contaminated.slice(0, 10).join('；')}` +
          `${contaminated.length > 10 ? '；…' : ''}。请修正 script_v2 并重新构建 Narration Plan。`,
      );
    }

    let enqueued = 0;
    let reused = 0;
    let active = 0;
    for (const unit of plan.units) {
      // M6.3.1.3 纵深防御：旧脏 plan（compilerVersion bump 前已存在）中的
      // 不可朗读 speech unit（如 text='---'）跳过入队，不再送进 TTS。
      if (unit.kind !== 'speech' || !unit.text || !isSpeakableText(unit.text)) continue;
      const existingActive = getActiveTtsJob(
        projectId, artifact.id, unit.id, provider.name, voice.id, voice.revision,
      );
      if (existingActive) {
        reused++;
        active++;
        continue;
      }
      const existingSucceeded = getLatestSucceededTtsJob(
        projectId, artifact.id, unit.id, provider.name, voice.id, voice.revision,
      );
      if (existingSucceeded) {
        reused++;
        continue;
      }
      enqueueTtsJobTx(projectId, provider.name, voice.id, voice.revision, {
        schemaVersion: '1.0',
        narrationPlanArtifactId: artifact.id,
        narrationPlanArtifactVersion: artifact.version,
        scriptV2Version: plan.source.version,
        compilerVersion: plan.compilerVersion,
        unitId: unit.id,
        unitText: unit.text,
        ...(options?.referenceSha256 ? {referenceAudioSha256: options.referenceSha256} : {}),
      });
      enqueued++;
    }
    return {
      enqueued,
      reused,
      active,
      planArtifactId: artifact.id,
      planArtifactVersion: artifact.version,
    };
  });
  return tx.immediate();
}

export interface NarrationAudioQcReplacementRequest {
  unitId: string;
  supersedesJobId: string;
}

/**
 * Append-only, affected-unit-only replacement path for generated audio that failed QC.
 * The original succeeded job and WAV stay immutable; at most two replacement candidates
 * may be created for one original job.
 */
export function enqueueNarrationAudioQcReplacementJobs(
  projectId: string,
  requests: NarrationAudioQcReplacementRequest[],
  options: {
    voiceProfile: {id: string; revision: string};
    referenceSha256?: string;
    expectedPlan: {artifactId: string; version: number};
  },
): {jobs: Array<{unitId: string; jobId: string; candidateNumber: number; reused: boolean}>} {
  const db = getDb();
  const provider = getTtsProvider();
  const unique = new Map(requests.map((request) => [request.unitId, request]));
  if (unique.size !== requests.length || requests.length === 0) {
    throw new NarrationAudioError('QC_REPLACEMENT_INVALID', 'QC replacement units 必须非空且不重复');
  }
  const tx = db.transaction(() => {
    const current = getCurrentNarrationPlan(projectId);
    if (
      !current ||
      current.artifact.id !== options.expectedPlan.artifactId ||
      current.artifact.version !== options.expectedPlan.version
    ) {
      throw new NarrationAudioError('NARRATION_PLAN_SOURCE_MISMATCH', 'QC replacement Narration Plan identity mismatch');
    }
    const units = new Map(current.plan.units.filter((unit) => unit.kind === 'speech').map((unit) => [unit.id, unit]));
    const jobs: Array<{unitId: string; jobId: string; candidateNumber: number; reused: boolean}> = [];
    for (const request of requests) {
      const unit = units.get(request.unitId);
      const original = getTtsJob(request.supersedesJobId);
      const originalPayload = original ? parseTtsJobPayload(original.payload_json) : null;
      if (
        !unit || !unit.text || !original || original.status !== 'succeeded' || !originalPayload ||
        original.project_id !== projectId || original.unit_id !== request.unitId ||
        original.narration_plan_artifact_id !== current.artifact.id ||
        original.narration_plan_version !== current.artifact.version ||
        original.provider !== provider.name ||
        original.voice_profile_id !== options.voiceProfile.id ||
        original.voice_profile_revision !== options.voiceProfile.revision ||
        payloadSpokenText(originalPayload) !== unit.text ||
        originalPayload.qcReplacement !== undefined
      ) {
        throw new NarrationAudioError(
          'QC_REPLACEMENT_INVALID',
          `${request.unitId} original succeeded job identity 不满足 QC replacement contract`,
        );
      }
      const rows = db.prepare(`
        SELECT * FROM tts_jobs
        WHERE project_id = ? AND narration_plan_artifact_id = ? AND unit_id = ?
          AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
        ORDER BY queued_at
      `).all(
        projectId, current.artifact.id, request.unitId, provider.name,
        options.voiceProfile.id, options.voiceProfile.revision,
      ) as TtsJobRow[];
      const replacements = rows.flatMap((row) => {
        const payload = parseTtsJobPayload(row.payload_json);
        return payload?.qcReplacement?.supersedesJobId === original.id ? [{row, payload}] : [];
      });
      const active = replacements.find(({row}) => row.status === 'queued' || row.status === 'running');
      if (active) {
        jobs.push({
          unitId: request.unitId,
          jobId: active.row.id,
          candidateNumber: active.payload.qcReplacement!.candidateNumber,
          reused: true,
        });
        continue;
      }
      if (replacements.length >= 2) {
        throw new NarrationAudioError(
          'QC_REPLACEMENT_LIMIT',
          `${request.unitId} 已达到 2 个 QC replacement candidates`,
        );
      }
      const candidateNumber = replacements.length + 1;
      const job = enqueueTtsJobTx(projectId, provider.name, options.voiceProfile.id, options.voiceProfile.revision, {
        schemaVersion: '1.0',
        narrationPlanArtifactId: current.artifact.id,
        narrationPlanArtifactVersion: current.artifact.version,
        scriptV2Version: current.plan.source.version,
        compilerVersion: current.plan.compilerVersion,
        unitId: unit.id,
        unitText: unit.text,
        ...(options.referenceSha256 ? {referenceAudioSha256: options.referenceSha256} : {}),
        qcReplacement: {
          reason: 'AUDIO_QC_CLIPPING',
          supersedesJobId: original.id,
          candidateNumber,
        },
      });
      jobs.push({unitId: request.unitId, jobId: job.id, candidateNumber, reused: false});
    }
    return {jobs};
  });
  return tx.immediate();
}

// ---------- 状态查询 ----------

export type NarrationAudioStatus =
  | 'ready'
  | 'generating'
  | 'failed'
  | 'stale'
  | 'missing'
  | 'not_ready'
  | 'blocked_contaminated';

export interface UnitAudioProgress {
  unitId: string;
  kind: NarrationUnit['kind'];
  text: string | null;
  directive: string | null;
  pauseMs: number | null;
  jobStatus: string | null;
  jobId: string | null;
  durationMs: number | null;
  outputPath: string | null;
}

export interface NarrationAudioOverview {
  status: NarrationAudioStatus;
  planReady: boolean;
  providerName: string;
  voiceProfile: {id: string; revision: string};
  speechComplete: number;
  speechTotal: number;
  master: {filePath: string; durationMs: number} | null;
  /**
   * 污染阻断状态（M7.2.1 hotfix UX 闭环）：非 null 时 status=blocked_contaminated。
   * 只含 unit ID + token 摘要，不含完整正文；历史污染 job/音频保留可审计。
   */
  contamination: PlanContamination | null;
  /** manifest ready 时透出真实 Provider 快照（源自 job.result_json，非推断）。 */
  providerDetail: {
    model: string;
    providerVersion: string | null;
    providerCommit: string | null;
  } | null;
  units: UnitAudioProgress[];
}

function collectUnitProgress(
  projectId: string,
  plan: NarrationPlan,
  planArtifactId: string,
  providerName: string,
  voice: {id: string; revision: string},
): UnitAudioProgress[] {
  return plan.units.map((unit) => {
    if (unit.kind !== 'speech') {
      return {
        unitId: unit.id,
        kind: unit.kind,
        text: null,
        directive: unit.directive,
        pauseMs: unit.pauseMs,
        jobStatus: null,
        jobId: null,
        durationMs: unit.kind === 'pause' ? unit.pauseMs : null,
        outputPath: null,
      };
    }
    const active = getActiveTtsJob(projectId, planArtifactId, unit.id, providerName, voice.id, voice.revision);
    const succeeded = active
      ? null
      : getLatestSucceededTtsJob(projectId, planArtifactId, unit.id, providerName, voice.id, voice.revision);
    const latestFailed = !active && !succeeded
      ? (getDb()
          .prepare(
            `SELECT * FROM tts_jobs WHERE project_id = ? AND narration_plan_artifact_id = ?
               AND unit_id = ? AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
             ORDER BY queued_at DESC LIMIT 1`,
          )
          .get(projectId, planArtifactId, unit.id, providerName, voice.id, voice.revision) as TtsJobRow | undefined)
      : undefined;
    const job = active ?? succeeded ?? latestFailed;
    return {
      unitId: unit.id,
      kind: 'speech' as const,
      text: unit.text,
      directive: null,
      pauseMs: null,
      jobStatus: job?.status ?? null,
      jobId: job?.id ?? null,
      durationMs: succeeded?.duration_ms ?? null,
      outputPath: succeeded?.output_path ?? null,
    };
  });
}

/** Narration Audio 区 overview（纯读）。 */
export function getNarrationAudioOverview(
  projectId: string,
  options?: {voiceProfile?: {id: string; revision: string}; referenceSha256?: string | null},
): NarrationAudioOverview {
  const provider = getTtsProvider();
  const voice = options?.voiceProfile ?? DEFAULT_VOICE_PROFILE;
  const current = getCurrentNarrationPlan(projectId);
  if (!current) {
    return {
      status: 'stale',
      planReady: false,
      providerName: provider.name,
      voiceProfile: voice,
      speechComplete: 0,
      speechTotal: 0,
      master: null,
      contamination: null,
      providerDetail: null,
      units: [],
    };
  }
  const {plan, artifact} = current;
  // 污染判定优先于一切 job/manifest 状态（复用统一 leakage validator）：
  // 历史 succeeded 污染 job 不得使 overall status 变 ready/generating。
  const contamination = detectPlanContamination(plan);
  const units = collectUnitProgress(projectId, plan, artifact.id, provider.name, voice);
  const speechUnits = units.filter((u) => u.kind === 'speech');
  const complete = speechUnits.filter((u) => u.jobStatus === 'succeeded').length;
  const anyFailed = speechUnits.some((u) => u.jobStatus === 'failed');
  const anyActive = speechUnits.some((u) => u.jobStatus === 'queued' || u.jobStatus === 'running');

  const manifest = readCurrentManifest(projectId, voice, options?.referenceSha256);
  let status: NarrationAudioStatus;
  if (contamination) {
    status = 'blocked_contaminated';
  } else if (manifest) {
    status = 'ready';
  } else if (anyFailed) {
    status = 'failed';
  } else if (complete === speechUnits.length && speechUnits.length > 0) {
    status = 'not_ready'; // 全部完成但 manifest 未 finalize（可由 POST/GET 触发）
  } else if (anyActive || complete > 0) {
    status = 'generating';
  } else {
    status = 'missing';
  }
  return {
    status,
    planReady: true,
    providerName: provider.name,
    voiceProfile: voice,
    speechComplete: complete,
    speechTotal: speechUnits.length,
    master: manifest
      ? {filePath: manifest.master.filePath, durationMs: manifest.master.durationMs}
      : null,
    contamination,
    providerDetail: manifest
      ? {
          model: manifest.provider.model,
          providerVersion: manifest.provider.providerVersion,
          providerCommit: manifest.provider.providerCommit,
        }
      : null,
    units,
  };
}

// ---------- Manifest 读取 ----------

interface ArtifactRow {
  id: string;
  version: number;
  content_json: string;
}

/**
 * current manifest 读取（M3-B Hardening §九–十一）：
 * JSON.parse → zod → source/provider/voice match → master 路径安全 + 文件真实性。
 * master 缺失/越界/过小的 artifact 不认作 current（skip，保留历史行，不 DELETE），
 * overview 落回 not_ready，由 finalize 重新生成。
 */
function readCurrentManifestRow(
  projectId: string,
  voice: {id: string; revision: string} = DEFAULT_VOICE_PROFILE,
  referenceSha256?: string | null,
): {artifact: ArtifactRow; manifest: NarrationAudioManifest} | null {
  const current = getCurrentNarrationPlan(projectId);
  if (!current) return null;
  const rows = getDb()
    .prepare(
      `SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
    )
    .all(projectId, NARRATION_AUDIO_ARTIFACT_KIND) as ArtifactRow[];
  const provider = getTtsProvider();
  const dataDir = path.resolve(getDataDir());
  for (const row of rows) {
    try {
      const parsed = narrationAudioManifestSchema.safeParse(JSON.parse(row.content_json));
      if (
        parsed.success &&
        parsed.data.source.narrationPlanArtifactId === current.artifact.id &&
        parsed.data.provider.name === provider.name &&
        parsed.data.provider.voiceProfile.id === voice.id &&
        parsed.data.provider.voiceProfile.revision === voice.revision &&
        (referenceSha256 === undefined || parsed.data.provider.referenceSha256 === referenceSha256)
      ) {
        // §三不变量：current manifest 的 master.filePath 必须对应完整正式文件
        const abs = path.resolve(dataDir, parsed.data.master.filePath);
        if (!abs.startsWith(dataDir + path.sep)) continue; // path traversal → 不认
        if (!fs.existsSync(abs) || fs.statSync(abs).size <= 44) continue; // 缺失/过小 → 不认
        return {artifact: row, manifest: parsed.data};
      }
    } catch {
      // 非法 artifact 跳过
    }
  }
  return null;
}

function readCurrentManifest(
  projectId: string,
  voice: {id: string; revision: string} = DEFAULT_VOICE_PROFILE,
  referenceSha256?: string | null,
): NarrationAudioManifest | null {
  return readCurrentManifestRow(projectId, voice, referenceSha256)?.manifest ?? null;
}

/**
 * M3-C 只读扩展：暴露 current Narration Audio artifact 的 id/version + manifest。
 * 与 readCurrentManifest 走完全相同的防线（plan current / source gate /
 * provider/voice gate / master 路径安全 / master 文件存在），不改变 M3-B contract。
 */
export function getCurrentNarrationAudioArtifact(
  projectId: string,
  options?: {voiceProfile?: {id: string; revision: string}; referenceSha256?: string | null},
): {
  artifact: {id: string; version: number};
  manifest: NarrationAudioManifest;
} | null {
  const row = readCurrentManifestRow(projectId, options?.voiceProfile, options?.referenceSha256);
  if (!row) return null;
  return {
    artifact: {id: row.artifact.id, version: row.artifact.version},
    manifest: row.manifest,
  };
}

export type NarrationAudioArtifact = {
  artifact: {id: string; version: number};
  manifest: NarrationAudioManifest;
};

async function validateExactNarrationAudioArtifact(
  projectId: string,
  expectedPlan: {artifactId: string; version: number},
  audio: NarrationAudioArtifact,
  options?: {voiceProfile?: {id: string; revision: string}; referenceSha256?: string | null},
): Promise<NarrationAudioArtifact | null> {
  const current = getCurrentNarrationPlan(projectId);
  if (
    !current ||
    current.artifact.id !== expectedPlan.artifactId ||
    current.artifact.version !== expectedPlan.version ||
    audio.manifest.schemaVersion !== NARRATION_AUDIO_SCHEMA_VERSION ||
    audio.manifest.source.narrationPlanArtifactId !== expectedPlan.artifactId ||
    audio.manifest.source.narrationPlanArtifactVersion !== expectedPlan.version ||
    audio.manifest.provider.name !== getTtsProvider().name ||
    (options?.voiceProfile !== undefined &&
      (audio.manifest.provider.voiceProfile.id !== options.voiceProfile.id ||
        audio.manifest.provider.voiceProfile.revision !== options.voiceProfile.revision)) ||
    (options?.referenceSha256 !== undefined &&
      audio.manifest.provider.referenceSha256 !== options.referenceSha256)
  ) return null;

  const dataDir = path.resolve(getDataDir());
  const masterPath = path.resolve(dataDir, audio.manifest.master.filePath);
  if (!masterPath.startsWith(dataDir + path.sep)) return null;

  let masterStat: fs.Stats;
  try {
    masterStat = fs.statSync(masterPath);
    if (!masterStat.isFile() || masterStat.size <= 44) return null;
    const header = Buffer.alloc(44);
    const fd = fs.openSync(masterPath, 'r');
    try {
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      if (
        bytesRead !== header.length ||
        header.toString('ascii', 0, 4) !== 'RIFF' ||
        header.toString('ascii', 8, 12) !== 'WAVE' ||
        header.toString('ascii', 36, 40) !== 'data' ||
        header.readUInt32LE(40) !== masterStat.size - 44
      ) return null;
    } finally {
      fs.closeSync(fd);
    }
    if (await sha256FileBytes(masterPath) !== audio.manifest.master.sha256) return null;
    const probe = probeAudio(masterPath, 'wav');
    if (
      probe.durationMs !== audio.manifest.master.durationMs ||
      probe.sampleRate !== audio.manifest.master.sampleRate ||
      probe.channels !== audio.manifest.master.channels
    ) return null;
  } catch {
    return null;
  }

  if (audio.manifest.units.length !== current.plan.units.length) return null;
  const manifestUnits = new Map(audio.manifest.units.map((unit) => [unit.unitId, unit]));
  const provider = audio.manifest.provider;
  for (const unit of current.plan.units) {
    const manifestUnit = manifestUnits.get(unit.id);
    if (!manifestUnit || manifestUnit.kind !== unit.kind) return null;
    if (unit.kind !== 'speech') continue;
    if (!unit.text || !isSpeakableText(unit.text) || manifestUnit.kind !== 'speech') return null;
    if (manifestUnit.text !== unit.text) return null;

    const job = getDb().prepare('SELECT * FROM tts_jobs WHERE id = ?').get(manifestUnit.ttsJobId) as TtsJobRow | undefined;
    if (
      !job ||
      job.project_id !== projectId ||
      job.narration_plan_artifact_id !== expectedPlan.artifactId ||
      job.narration_plan_version !== expectedPlan.version ||
      job.unit_id !== unit.id ||
      job.provider !== provider.name ||
      job.voice_profile_id !== provider.voiceProfile.id ||
      job.voice_profile_revision !== provider.voiceProfile.revision ||
      job.status !== 'succeeded' ||
      job.output_path !== manifestUnit.filePath ||
      job.duration_ms !== manifestUnit.durationMs ||
      job.audio_sha256 !== manifestUnit.sha256 ||
      !job.result_json
    ) return null;
    const payload = parseTtsJobPayload(job.payload_json);
    if (
      !payload ||
      payload.narrationPlanArtifactId !== expectedPlan.artifactId ||
      payload.narrationPlanArtifactVersion !== expectedPlan.version ||
      payload.unitId !== unit.id ||
      payloadSpokenText(payload) !== unit.text
    ) return null;
    let resultJson: unknown;
    try {
      resultJson = JSON.parse(job.result_json);
    } catch {
      return null;
    }
    const result = ttsJobResultSchema.safeParse(resultJson);
    if (
      !result.success ||
      result.data.provider !== provider.name ||
      result.data.model !== provider.model ||
      result.data.providerVersion !== provider.providerVersion ||
      result.data.providerCommit !== provider.providerCommit ||
      result.data.settings.voiceProfileId !== provider.voiceProfile.id ||
      result.data.settings.voiceProfileRevision !== provider.voiceProfile.revision ||
      (options?.referenceSha256 !== undefined && result.data.settings.referenceSha256 !== options.referenceSha256) ||
      (options?.referenceSha256 !== undefined && payload.referenceAudioSha256 !== options.referenceSha256) ||
      result.data.settings.useRandom !== false ||
      result.data.audio.sampleRate !== manifestUnit.sampleRate ||
      result.data.audio.channels !== manifestUnit.channels
    ) return null;
  }

  const stillCurrent = getCurrentNarrationPlan(projectId);
  if (
    !stillCurrent ||
    stillCurrent.artifact.id !== expectedPlan.artifactId ||
    stillCurrent.artifact.version !== expectedPlan.version
  ) return null;
  return audio;
}

/** Exact identity path: never resolves latest/current/default audio. */
export async function getExactNarrationAudioArtifact(
  projectId: string,
  expectedAudio: {artifactId: string; version: number},
): Promise<NarrationAudioArtifact | null> {
  const row = getDb().prepare(
    `SELECT id, project_id, kind, version, content_json FROM artifacts WHERE id = ?`,
  ).get(expectedAudio.artifactId) as (ArtifactRow & {project_id: string; kind: string}) | undefined;
  if (
    !row ||
    row.project_id !== projectId ||
    row.kind !== NARRATION_AUDIO_ARTIFACT_KIND ||
    row.version !== expectedAudio.version
  ) return null;

  let manifest: NarrationAudioManifest;
  try {
    const parsed = narrationAudioManifestSchema.safeParse(JSON.parse(row.content_json));
    if (!parsed.success) return null;
    manifest = parsed.data;
  } catch {
    return null;
  }
  return validateExactNarrationAudioArtifact(
    projectId,
    {
      artifactId: manifest.source.narrationPlanArtifactId,
      version: manifest.source.narrationPlanArtifactVersion,
    },
    {artifact: {id: row.id, version: row.version}, manifest},
    {
      voiceProfile: manifest.provider.voiceProfile,
      referenceSha256: manifest.provider.referenceSha256 ?? undefined,
    },
  );
}

/**
 * Read-only compatibility path for an already finalized M6 narration audio.
 * This deliberately validates the immutable artifact before any enqueue gate;
 * callers must fall back to enqueueNarrationAudioJobs when it returns null.
 */
export async function getExactReusableNarrationAudioArtifact(
  projectId: string,
  expectedPlan: {artifactId: string; version: number},
  options?: {voiceProfile?: {id: string; revision: string}; referenceSha256?: string | null},
): Promise<{
  artifact: {id: string; version: number};
  manifest: NarrationAudioManifest;
} | null> {
  const current = getCurrentNarrationPlan(projectId);
  if (
    !current ||
    current.artifact.id !== expectedPlan.artifactId ||
    current.artifact.version !== expectedPlan.version
  ) return null;

  const voice = options?.voiceProfile ?? DEFAULT_VOICE_PROFILE;
  const audio = getCurrentNarrationAudioArtifact(projectId, {
    voiceProfile: voice,
    referenceSha256: options?.referenceSha256,
  });
  if (!audio) return null;
  return validateExactNarrationAudioArtifact(projectId, expectedPlan, audio, options);
}

// ---------- Master 构建（ffmpeg 统一 48k/mono/s16） ----------

export function normalizeUnitToPcm(wavPath: string, headroomDb?: number): Buffer {
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', wavPath,
    ...(headroomDb === undefined ? [] : ['-af', `volume=${headroomDb}dB`]),
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', String(MASTER_SAMPLE_RATE), '-ac', String(MASTER_CHANNELS), '-',
  ], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024});
  return out;
}

export interface HardClippingMetrics {
  fullScaleSamples: number;
  saturationRuns: number;
  hardPlateauRuns: number;
  longestSaturationRun: number;
  minSample: number;
  maxSample: number;
}

export function analyzeS16PcmHardClipping(pcm: Buffer): HardClippingMetrics {
  if (pcm.length % 2 !== 0) throw new Error('s16 PCM byte length must be even');
  let fullScaleSamples = 0;
  let saturationRuns = 0;
  let hardPlateauRuns = 0;
  let longestSaturationRun = 0;
  let currentRun = 0;
  let currentSign = 0;
  let minSample = 32767;
  let maxSample = -32768;
  const finishRun = (): void => {
    if (currentRun === 0) return;
    saturationRuns++;
    if (currentRun >= 2) hardPlateauRuns++;
    longestSaturationRun = Math.max(longestSaturationRun, currentRun);
    currentRun = 0;
    currentSign = 0;
  };
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    minSample = Math.min(minSample, value);
    maxSample = Math.max(maxSample, value);
    const sign = value === 32767 ? 1 : value === -32768 ? -1 : 0;
    if (sign === 0) {
      finishRun();
      continue;
    }
    fullScaleSamples++;
    if (currentRun > 0 && sign !== currentSign) finishRun();
    if (currentRun === 0) currentSign = sign;
    currentRun++;
  }
  finishRun();
  return {fullScaleSamples, saturationRuns, hardPlateauRuns, longestSaturationRun, minSample, maxSample};
}

export function analyzeS16WavHardClipping(wavPath: string): HardClippingMetrics {
  const wav = fs.readFileSync(wavPath);
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('invalid WAV');
  let cursor = 12;
  while (cursor + 8 <= wav.length) {
    const id = wav.toString('ascii', cursor, cursor + 4);
    const length = wav.readUInt32LE(cursor + 4);
    if (id === 'data') {
      const end = cursor + 8 + length;
      if (end > wav.length) throw new Error('truncated WAV data chunk');
      return analyzeS16PcmHardClipping(wav.subarray(cursor + 8, end));
    }
    cursor += 8 + length + (length % 2);
  }
  throw new Error('WAV data chunk missing');
}

export function silencePcm(durationMs: number): Buffer {
  const samples = Math.round((durationMs / 1000) * MASTER_SAMPLE_RATE) * MASTER_CHANNELS;
  return Buffer.alloc(samples * 2, 0);
}

export function wrapPcmAsWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(MASTER_CHANNELS, 22);
  header.writeUInt32LE(MASTER_SAMPLE_RATE, 24);
  header.writeUInt32LE(MASTER_SAMPLE_RATE * MASTER_CHANNELS * 2, 28);
  header.writeUInt16LE(MASTER_CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ---------- Finalize ----------

/**
 * 测试注入（M3-B Final File Commit Hardening §十三）：确定性 fault injection。
 * 不 monkey patch 全局 fs；仅替换 winner 路径的 rename / artifact INSERT。
 */
export interface FinalizeNarrationAudioDeps {
  renameImpl?: (oldPath: string, newPath: string) => void;
  insertArtifactImpl?: (contentJson: string) => void;
  expectedPlan?: {artifactId: string; version: number};
  voiceProfile?: {id: string; revision: string};
  referenceSha256?: string | null;
  repair?: {
    reason: 'AUDIO_QC_CLIPPING';
    supersedes: {id: string; version: number};
    preResampleHeadroomDb: number;
    selectedTtsJobIds: Record<string, string>;
    replacedSegments: string[];
  };
}

/**
 * 幂等 finalize（M3-B Hardening §十四–二十 + Final File Commit Hardening §三–十二）：
 * plan current + 全部 speech succeeded 且 result_json 合法
 * → Provider 快照一致性校验（mixed → PROVIDER_SNAPSHOT_MISMATCH）
 * → master 写唯一 tmp 并验证（exists/size>44/RIFF/duration>0）
 * → BEGIN IMMEDIATE：重查 plan current → 重查同快照 manifest（reuse）
 *   → orphan 裁决（无引用安全删除 / 有引用 MASTER_PATH_CONFLICT）
 *   → winner 先 rename tmp→final 并 verify，再 INSERT artifact（§四：DB 永不先宣布不存在的 master）
 * → INSERT/事务失败补偿删除本次 final（§六）；reuse 只删自己的 tmp，绝不碰 existing final（§七）。
 */
export function tryFinalizeNarrationAudio(
  projectId: string,
  deps: FinalizeNarrationAudioDeps = {},
): NarrationAudioManifest | null {
  const db = getDb();
  const rename = deps.renameImpl ?? ((oldPath: string, newPath: string) => fs.renameSync(oldPath, newPath));
  const insertArtifact =
    deps.insertArtifactImpl ??
    ((contentJson: string): void => {
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
           ?, NULL, ?)`,
      ).run(
        crypto.randomUUID(),
        projectId,
        NARRATION_AUDIO_ARTIFACT_KIND,
        projectId,
        NARRATION_AUDIO_ARTIFACT_KIND,
        contentJson,
        new Date().toISOString(),
      );
    });
  const current = getCurrentNarrationPlan(projectId);
  if (!current) {
    if (deps.expectedPlan) {
      throw new NarrationAudioError(
        'NARRATION_PLAN_SOURCE_MISMATCH',
        `Narration Plan source mismatch: expected ${deps.expectedPlan.artifactId}@${deps.expectedPlan.version}, current missing`,
      );
    }
    return null;
  }
  const {plan, artifact} = current;
  if (
    deps.expectedPlan &&
    (artifact.id !== deps.expectedPlan.artifactId || artifact.version !== deps.expectedPlan.version)
  ) {
    throw new NarrationAudioError(
      'NARRATION_PLAN_SOURCE_MISMATCH',
      `Narration Plan source mismatch: expected ${deps.expectedPlan.artifactId}@${deps.expectedPlan.version}, ` +
        `current ${artifact.id}@${artifact.version}`,
    );
  }
  const provider = getTtsProvider();
  const voice = deps.voiceProfile ?? DEFAULT_VOICE_PROFILE;

  const existing = readCurrentManifest(projectId, voice, deps.referenceSha256);
  const repairMatches = (manifest: NarrationAudioManifest): boolean => {
    if (
      deps.repair === undefined ||
      manifest.repair?.reason !== deps.repair.reason ||
      manifest.repair.supersedes.id !== deps.repair.supersedes.id ||
      manifest.repair.supersedes.version !== deps.repair.supersedes.version ||
      manifest.repair.preResampleHeadroomDb !== deps.repair.preResampleHeadroomDb
    ) return false;

    const expectedReplaced = [...deps.repair.replacedSegments].sort();
    const actualReplaced = [...manifest.repair.replacedSegments].sort();
    if (
      expectedReplaced.length !== actualReplaced.length ||
      expectedReplaced.some((unitId, index) => unitId !== actualReplaced[index])
    ) return false;

    const speechUnits = manifest.units.filter(
      (unit): unit is z.infer<typeof manifestSpeechUnitSchema> => unit.kind === 'speech',
    );
    const selected = Object.entries(deps.repair.selectedTtsJobIds);
    return speechUnits.length === selected.length && selected.every(([unitId, jobId]) =>
      speechUnits.some((unit) => unit.unitId === unitId && unit.ttsJobId === jobId));
  };
  if ((!deps.repair && existing) || (existing && repairMatches(existing))) return existing;

  let supersededManifest: NarrationAudioManifest | null = null;
  if (deps.repair) {
    const superseded = db.prepare(
      `SELECT project_id, kind, version, content_json FROM artifacts WHERE id = ?`,
    ).get(deps.repair.supersedes.id) as {
      project_id: string;
      kind: string;
      version: number;
      content_json: string;
    } | undefined;
    let parsed: ReturnType<typeof narrationAudioManifestSchema.safeParse> | null = null;
    if (
      superseded && superseded.project_id === projectId &&
      superseded.kind === NARRATION_AUDIO_ARTIFACT_KIND &&
      superseded.version === deps.repair.supersedes.version
    ) {
      try {
        parsed = narrationAudioManifestSchema.safeParse(JSON.parse(superseded.content_json));
      } catch {
        parsed = null;
      }
    }
    if (!parsed?.success) {
      throw new NarrationAudioError('QC_REPLACEMENT_INVALID', 'superseded audio artifact identity invalid');
    }
    supersededManifest = parsed.data;
  }

  // 收集全部 speech 输出（必须全部 succeeded 且 result_json 合法——§十四唯一 metadata 来源）
  const speechUnits = plan.units.filter((u) => u.kind === 'speech');
  if (deps.repair) {
    const expected = new Set(speechUnits.map((unit) => unit.id));
    const selected = Object.keys(deps.repair.selectedTtsJobIds);
    if (selected.length !== expected.size || selected.some((unitId) => !expected.has(unitId))) {
      throw new NarrationAudioError('QC_REPLACEMENT_INVALID', 'repair selectedTtsJobIds 必须精确覆盖全部 speech units');
    }
  }
  const supersededJobs = new Map(
    (supersededManifest?.units ?? [])
      .filter((unit): unit is z.infer<typeof manifestSpeechUnitSchema> => unit.kind === 'speech')
      .map((unit) => [unit.unitId, unit.ttsJobId]),
  );
  const outputs: Array<{unit: NarrationUnit; job: TtsJobRow; result: TtsJobResult}> = [];
  for (const unit of speechUnits) {
    const selectedJobId = deps.repair?.selectedTtsJobIds[unit.id];
    const job = selectedJobId
      ? getTtsJob(selectedJobId)
      : getLatestSucceededTtsJob(
          projectId, artifact.id, unit.id, provider.name, voice.id, voice.revision,
        );
    if (!job || !job.output_path || job.duration_ms === null || !job.audio_sha256 || !job.result_json) {
      return null; // 未全部完成（或缺 result_json 的旧数据）→ 不允许 finalize
    }
    if (
      job.status !== 'succeeded' || job.project_id !== projectId ||
      job.narration_plan_artifact_id !== artifact.id || job.narration_plan_version !== artifact.version ||
      job.unit_id !== unit.id || job.provider !== provider.name ||
      job.voice_profile_id !== voice.id || job.voice_profile_revision !== voice.revision
    ) {
      throw new NarrationAudioError('QC_REPLACEMENT_INVALID', `${unit.id} selected TTS job identity mismatch`);
    }
    if (deps.repair) {
      const originalJobId = supersededJobs.get(unit.id);
      const selectedPayload = parseTtsJobPayload(job.payload_json);
      const replacement = selectedPayload?.qcReplacement;
      if (deps.repair.replacedSegments.includes(unit.id)) {
        if (!originalJobId || replacement?.reason !== deps.repair.reason || replacement.supersedesJobId !== originalJobId) {
          throw new NarrationAudioError('QC_REPLACEMENT_INVALID', `${unit.id} replacement provenance mismatch`);
        }
        const clipping = analyzeS16WavHardClipping(path.join(getDataDir(), job.output_path));
        if (clipping.fullScaleSamples !== 0 || clipping.saturationRuns !== 0) {
          throw new NarrationAudioError(
            'MASTER_HARD_CLIPPING',
            `${unit.id} replacement source still clips: fullScale=${clipping.fullScaleSamples} runs=${clipping.saturationRuns}`,
          );
        }
      } else if (!originalJobId || job.id !== originalJobId || replacement !== undefined) {
        throw new NarrationAudioError('QC_REPLACEMENT_INVALID', `${unit.id} clean original was not reused exactly`);
      }
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(job.result_json);
    } catch {
      return null;
    }
    const parsed = ttsJobResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return null;
    }
    if (
      deps.referenceSha256 &&
      (parsed.data.settings.referenceSha256 !== deps.referenceSha256 ||
        parseTtsJobPayload(job.payload_json)?.referenceAudioSha256 !== deps.referenceSha256)
    ) {
      return null;
    }
    outputs.push({unit, job, result: parsed.data});
  }
  if (outputs.length === 0) return null;

  // §十五/十六：同一 manifest 的 speech 输出必须属于同一生产条件快照
  const first = outputs[0]!.result;
  const mixed = outputs.some(
    (o) =>
      o.result.provider !== first.provider ||
      o.result.model !== first.model ||
      o.result.providerVersion !== first.providerVersion ||
      o.result.providerCommit !== first.providerCommit ||
      o.result.settings.voiceProfileId !== first.settings.voiceProfileId ||
      o.result.settings.voiceProfileRevision !== first.settings.voiceProfileRevision ||
      o.result.settings.referenceSha256 !== first.settings.referenceSha256 ||
      o.result.settings.useRandom !== first.settings.useRandom,
  );
  if (mixed) {
    throw new NarrationAudioError(
      'PROVIDER_SNAPSHOT_MISMATCH',
      '同一 Narration Plan 的 speech 输出来自不同 provider/model/version/commit/voice 快照，' +
        '拒绝生成混合 manifest（请核查 sidecar 是否在生成过程中被升级）',
    );
  }

  // 构建 master PCM（顺序严格按 plan units）
  const chunks: Buffer[] = [];
  let expectedMs = 0;
  for (const unit of plan.units) {
    if (unit.kind === 'speech') {
      const output = outputs.find((o) => o.unit.id === unit.id)!;
      chunks.push(normalizeUnitToPcm(
        path.join(getDataDir(), output.job.output_path!),
        deps.repair?.preResampleHeadroomDb,
      ));
      expectedMs += output.job.duration_ms!;
    } else if (unit.kind === 'pause' && unit.pauseMs !== null) {
      chunks.push(silencePcm(unit.pauseMs));
      expectedMs += unit.pauseMs;
    }
    // prosody / visual_breath / 无时长 pause：无音频
  }
  const masterPcm = Buffer.concat(chunks);
  const masterWav = wrapPcmAsWav(masterPcm);
  const masterDurationMs = Math.round(
    (masterPcm.length / 2 / MASTER_CHANNELS / MASTER_SAMPLE_RATE) * 1000,
  );

  const nextAudioVersion = (db.prepare(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts WHERE project_id = ? AND kind = ?`,
  ).get(projectId, NARRATION_AUDIO_ARTIFACT_KIND) as {version: number}).version;
  const relMaster = path.posix.join(
    'projects', projectId, 'audio',
    deps.repair
      ? `narration-master-v${artifact.version}-${provider.name}-${voice.id}@${voice.revision}-audio-r${nextAudioVersion}.wav`
      : `narration-master-v${artifact.version}-${provider.name}-${voice.id}@${voice.revision}.wav`,
  );
  const absMaster = path.join(getDataDir(), relMaster);
  // §二十：先写唯一 tmp；winner rename 前不发生任何 DB 提交
  const absTmpMaster = `${absMaster}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(absMaster), {recursive: true});
  fs.writeFileSync(absTmpMaster, masterWav);
  const masterSha = crypto.createHash('sha256').update(masterWav).digest('hex');

  let finalOwnedByThisAttempt = false;
  try {
    // §十二：tmp 提交前验证（exists/size>44/RIFF/duration>0）
    const tmpStat = fs.statSync(absTmpMaster);
    const tmpHead = Buffer.alloc(4);
    const tmpFd = fs.openSync(absTmpMaster, 'r');
    fs.readSync(tmpFd, tmpHead, 0, 4, 0);
    fs.closeSync(tmpFd);
    if (tmpStat.size <= 44 || tmpHead.toString('ascii') !== 'RIFF' || masterDurationMs <= 0) {
      throw new Error(
        `tmp master 验证失败：size=${tmpStat.size} head=${tmpHead.toString('ascii')} durationMs=${masterDurationMs}`,
      );
    }

    const manifest: NarrationAudioManifest = narrationAudioManifestSchema.parse({
      schemaVersion: NARRATION_AUDIO_SCHEMA_VERSION,
      source: {
        narrationPlanArtifactId: artifact.id,
        narrationPlanArtifactVersion: artifact.version,
        scriptV2Version: plan.source.version,
        compilerVersion: plan.compilerVersion,
      },
      provider: {
        name: first.provider,
        model: first.model,
        providerVersion: first.providerVersion,
        providerCommit: first.providerCommit,
        voiceProfile: {
          id: first.settings.voiceProfileId,
          revision: first.settings.voiceProfileRevision,
        },
        referenceSha256: first.settings.referenceSha256,
        useRandom: false,
      },
      units: plan.units.map((unit) => {
        if (unit.kind === 'speech') {
          const output = outputs.find((o) => o.unit.id === unit.id)!;
          return {
            unitId: unit.id,
            kind: 'speech' as const,
            text: unit.text ?? '',
            filePath: output.job.output_path!,
            durationMs: output.job.duration_ms!,
            sampleRate: output.result.audio.sampleRate,
            channels: output.result.audio.channels,
            sha256: output.job.audio_sha256!,
            ttsJobId: output.job.id,
          };
        }
        if (unit.kind === 'pause') {
          return {
            unitId: unit.id,
            kind: 'pause' as const,
            directive: unit.directive,
            durationMs: unit.pauseMs,
            resolved: unit.pauseMs !== null,
          };
        }
        if (unit.kind === 'visual_breath') {
          return {unitId: unit.id, kind: 'visual_breath' as const, durationMs: null, resolved: false as const};
        }
        return {unitId: unit.id, kind: 'prosody' as const, directive: unit.directive ?? '', appliedToTts: false as const};
      }),
      master: {
        filePath: relMaster,
        durationMs: masterDurationMs,
        sha256: masterSha,
        sampleRate: MASTER_SAMPLE_RATE,
        channels: MASTER_CHANNELS,
      },
      ...(deps.repair && supersededManifest ? {
        repair: {
          reason: deps.repair.reason,
          supersedes: deps.repair.supersedes,
          preResampleHeadroomDb: deps.repair.preResampleHeadroomDb,
          reusedSegments: speechUnits
            .map((unit) => unit.id)
            .filter((unitId) => !deps.repair!.replacedSegments.includes(unitId)),
          replacedSegments: deps.repair.replacedSegments,
        },
      } : {}),
    });

    if (deps.repair) {
      const clipping = analyzeS16PcmHardClipping(masterPcm);
      if (clipping.fullScaleSamples !== 0 || clipping.saturationRuns !== 0) {
        throw new NarrationAudioError(
          'MASTER_HARD_CLIPPING',
          `repaired master still clips: fullScale=${clipping.fullScaleSamples} runs=${clipping.saturationRuns}`,
        );
      }
    }

    // 时长一致性防线：master ≈ speech + 显式 pause（允许帧取整容差 100ms）
    if (Math.abs(masterDurationMs - expectedMs) > 100) {
      throw new NarrationAudioError(
        'NARRATION_PLAN_NOT_CURRENT',
        `master 时长 ${masterDurationMs}ms 与预期 ${expectedMs}ms 偏差过大`,
      );
    }

    // §四：最终事务——winner 的正式 rename 必须发生在 manifest INSERT 之前
    type TxOutcome =
      | {outcome: 'inserted'}
      | {outcome: 'reuse'; manifest: NarrationAudioManifest}
      | {outcome: 'stale'};
    const tx = db.transaction((): TxOutcome => {
      const still = getCurrentNarrationPlan(projectId);
      if (
        deps.expectedPlan &&
        (!still ||
          still.artifact.id !== deps.expectedPlan.artifactId ||
          still.artifact.version !== deps.expectedPlan.version)
      ) {
        throw new NarrationAudioError(
          'NARRATION_PLAN_SOURCE_MISMATCH',
          `Narration Plan source mismatch: expected ${deps.expectedPlan.artifactId}@${deps.expectedPlan.version}, ` +
            `current ${still ? `${still.artifact.id}@${still.artifact.version}` : 'missing'}`,
        );
      }
      if (
        !still ||
        still.artifact.id !== artifact.id ||
        still.artifact.version !== artifact.version
      ) return {outcome: 'stale'};
      const won = readCurrentManifest(projectId, voice, deps.referenceSha256);
      if ((!deps.repair && won) || (won && repairMatches(won))) {
        return {outcome: 'reuse', manifest: won};
      }
      // §八：final 路径已存在时的 orphan/冲突裁决
      if (fs.existsSync(absMaster)) {
        const referenced = (
          db
            .prepare('SELECT content_json FROM artifacts WHERE project_id = ? AND kind = ?')
            .all(projectId, NARRATION_AUDIO_ARTIFACT_KIND) as Array<{content_json: string | null}>
        ).some((row) => {
          try {
            const json = JSON.parse(row.content_json ?? '') as {master?: {filePath?: string}};
            return json.master?.filePath === relMaster;
          } catch {
            return false;
          }
        });
        if (referenced) {
          // 有历史 artifact 引用但未被识别为 current：拒绝覆盖历史 winner 文件
          throw new NarrationAudioError(
            'MASTER_PATH_CONFLICT',
            `master 正式路径已被历史 artifact 引用但非 current，拒绝覆盖：${relMaster}`,
          );
        }
        fs.rmSync(absMaster, {force: true}); // 无引用 orphan（旧中断/旧 bug 残留）→ 安全删除
      }
      rename(absTmpMaster, absMaster);
      finalOwnedByThisAttempt = true;
      if (!fs.existsSync(absMaster)) {
        throw new Error('rename 后 final master 不存在');
      }
      insertArtifact(JSON.stringify(manifest));
      return {outcome: 'inserted'};
    });
    const txResult = tx.immediate();
    if (txResult.outcome === 'inserted') {
      return manifest;
    }
    // §七：reuse/stale 只清理自己的 unique tmp，绝不删除 existing manifest 引用的正式 master
    fs.rmSync(absTmpMaster, {force: true});
    return txResult.outcome === 'reuse' ? txResult.manifest : null;
  } catch (err) {
    // §六：rename 成功后 INSERT/事务失败 → 补偿删除本次产生的 final，不残留无 DB 记录的正式文件
    if (finalOwnedByThisAttempt) {
      fs.rmSync(absMaster, {force: true});
    }
    fs.rmSync(absTmpMaster, {force: true});
    throw err;
  }
}

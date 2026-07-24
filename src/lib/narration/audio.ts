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
  getLatestSucceededTtsJob,
  type TtsJobRow,
} from '../tts-jobs';
import {getCurrentNarrationPlan} from './plan';
import type {NarrationPlan, NarrationUnit} from './schema';

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
    providerCommit: z.string().nullable(),
    voiceProfile: z.object({id: z.string(), revision: z.string()}),
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
});

export type NarrationAudioManifest = z.infer<typeof narrationAudioManifestSchema>;

// ---------- 错误 ----------

export type NarrationAudioErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'NARRATION_PLAN_NOT_CURRENT';

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
  options?: {voiceProfile?: {id: string; revision: string}},
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
    let enqueued = 0;
    let reused = 0;
    let active = 0;
    for (const unit of plan.units) {
      if (unit.kind !== 'speech' || !unit.text) continue;
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

// ---------- 状态查询 ----------

export type NarrationAudioStatus =
  | 'ready'
  | 'generating'
  | 'failed'
  | 'stale'
  | 'missing'
  | 'not_ready';

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
export function getNarrationAudioOverview(projectId: string): NarrationAudioOverview {
  const provider = getTtsProvider();
  const voice = DEFAULT_VOICE_PROFILE;
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
      units: [],
    };
  }
  const {plan, artifact} = current;
  const units = collectUnitProgress(projectId, plan, artifact.id, provider.name, voice);
  const speechUnits = units.filter((u) => u.kind === 'speech');
  const complete = speechUnits.filter((u) => u.jobStatus === 'succeeded').length;
  const anyFailed = speechUnits.some((u) => u.jobStatus === 'failed');
  const anyActive = speechUnits.some((u) => u.jobStatus === 'queued' || u.jobStatus === 'running');

  const manifest = readCurrentManifest(projectId);
  let status: NarrationAudioStatus;
  if (manifest) {
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
    units,
  };
}

// ---------- Manifest 读取 ----------

interface ArtifactRow {
  id: string;
  version: number;
  content_json: string;
}

function readCurrentManifest(projectId: string): NarrationAudioManifest | null {
  const current = getCurrentNarrationPlan(projectId);
  if (!current) return null;
  const rows = getDb()
    .prepare(
      `SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
    )
    .all(projectId, NARRATION_AUDIO_ARTIFACT_KIND) as ArtifactRow[];
  const provider = getTtsProvider();
  for (const row of rows) {
    try {
      const parsed = narrationAudioManifestSchema.safeParse(JSON.parse(row.content_json));
      if (
        parsed.success &&
        parsed.data.source.narrationPlanArtifactId === current.artifact.id &&
        parsed.data.provider.name === provider.name &&
        parsed.data.provider.voiceProfile.id === DEFAULT_VOICE_PROFILE.id &&
        parsed.data.provider.voiceProfile.revision === DEFAULT_VOICE_PROFILE.revision
      ) {
        return parsed.data;
      }
    } catch {
      // 非法 artifact 跳过
    }
  }
  return null;
}

// ---------- Master 构建（ffmpeg 统一 48k/mono/s16） ----------

function normalizeUnitToPcm(wavPath: string): Buffer {
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-i', wavPath,
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', String(MASTER_SAMPLE_RATE), '-ac', String(MASTER_CHANNELS), '-',
  ], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024});
  return out;
}

function silencePcm(durationMs: number): Buffer {
  const samples = Math.round((durationMs / 1000) * MASTER_SAMPLE_RATE) * MASTER_CHANNELS;
  return Buffer.alloc(samples * 2, 0);
}

function wrapPcmAsWav(pcm: Buffer): Buffer {
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
 * 幂等 finalize（单 BEGIN IMMEDIATE 检查，文件操作在事务外完成的安全顺序）：
 * plan current + 全部 speech succeeded → 构建 master + manifest artifact。
 * 已存在同 (plan, provider, voice) manifest → 直接复用。
 */
export function tryFinalizeNarrationAudio(projectId: string): NarrationAudioManifest | null {
  const db = getDb();
  const current = getCurrentNarrationPlan(projectId);
  if (!current) return null;
  const {plan, artifact} = current;
  const provider = getTtsProvider();
  const voice = DEFAULT_VOICE_PROFILE;

  const existing = readCurrentManifest(projectId);
  if (existing) return existing;

  // 收集全部 speech 输出（必须全部 succeeded 且同源同 voice）
  const speechUnits = plan.units.filter((u) => u.kind === 'speech');
  const outputs: Array<{unit: NarrationUnit; job: TtsJobRow}> = [];
  for (const unit of speechUnits) {
    const job = getLatestSucceededTtsJob(
      projectId, artifact.id, unit.id, provider.name, voice.id, voice.revision,
    );
    if (!job || !job.output_path || job.duration_ms === null || !job.audio_sha256) {
      return null; // 未全部完成
    }
    outputs.push({unit, job});
  }
  if (outputs.length === 0) return null;

  // 构建 master PCM（顺序严格按 plan units）
  const chunks: Buffer[] = [];
  let expectedMs = 0;
  for (const unit of plan.units) {
    if (unit.kind === 'speech') {
      const output = outputs.find((o) => o.unit.id === unit.id)!;
      chunks.push(normalizeUnitToPcm(path.join(getDataDir(), output.job.output_path!)));
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

  const relMaster = path.posix.join(
    'projects', projectId, 'audio',
    `narration-master-v${artifact.version}-${provider.name}-${voice.id}@${voice.revision}.wav`,
  );
  const absMaster = path.join(getDataDir(), relMaster);
  fs.mkdirSync(path.dirname(absMaster), {recursive: true});
  fs.writeFileSync(absMaster, masterWav);
  const masterSha = crypto.createHash('sha256').update(masterWav).digest('hex');

  const manifest: NarrationAudioManifest = narrationAudioManifestSchema.parse({
    schemaVersion: NARRATION_AUDIO_SCHEMA_VERSION,
    source: {
      narrationPlanArtifactId: artifact.id,
      narrationPlanArtifactVersion: artifact.version,
      scriptV2Version: plan.source.version,
      compilerVersion: plan.compilerVersion,
    },
    provider: {
      name: provider.name,
      model: provider.name === 'mock' ? 'mock-tone-v1' : 'IndexTTS-2',
      providerCommit: null,
      voiceProfile: voice,
      useRandom: false,
    },
    units: plan.units.map((unit) => {
      if (unit.kind === 'speech') {
        const output = outputs.find((o) => o.unit.id === unit.id)!;
        const probePath = path.join(getDataDir(), output.job.output_path!);
        const probe = execFileSync('ffprobe', [
          '-v', 'error', '-print_format', 'json', '-show_streams', probePath,
        ], {encoding: 'utf8'});
        const stream = (JSON.parse(probe) as {streams?: Array<{sample_rate?: string; channels?: number}>})
          .streams?.[0];
        return {
          unitId: unit.id,
          kind: 'speech' as const,
          text: unit.text ?? '',
          filePath: output.job.output_path!,
          durationMs: output.job.duration_ms!,
          sampleRate: Number(stream?.sample_rate ?? 0),
          channels: stream?.channels ?? 0,
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
  });

  // 时长一致性防线：master ≈ speech + 显式 pause（允许帧取整容差 100ms）
  if (Math.abs(masterDurationMs - expectedMs) > 100) {
    throw new NarrationAudioError(
      'NARRATION_PLAN_NOT_CURRENT',
      `master 时长 ${masterDurationMs}ms 与预期 ${expectedMs}ms 偏差过大`,
    );
  }

  const tx = db.transaction((): void => {
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
      JSON.stringify(manifest),
      new Date().toISOString(),
    );
  });
  tx.immediate();
  return manifest;
}

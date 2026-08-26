import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDataDir, getDb} from '../db';
import {
  computeTtsInputFingerprint,
  normalizeSpokenText,
  ttsModelVersionOf,
  voiceIdentityOf,
  TTS_TEXT_NORMALIZATION_VERSION,
} from '../tts/fingerprint';
import {
  enqueueTtsJobTx,
  getActiveTtsJob,
  parseTtsJobPayload,
  payloadSpokenText,
  ttsJobResultSchema,
  type TtsJobResult,
  type TtsJobRow,
} from '../tts-jobs';
import {DEFAULT_VOICE_PROFILE, getTtsProvider} from '../tts';
import {describeLeakage, findDirectiveLeakage} from './leakage';
import {classifyNarrationPlanV2Candidate, getNarrationPlanV2Artifact} from './plan-v2';
import type {NarrationPlanV2, SpeechUnitV2} from './schema-v2';
import {
  narrationAudioManifestV2Schema,
  NARRATION_AUDIO_V2_ARTIFACT_KIND,
  NARRATION_AUDIO_V2_SCHEMA_VERSION,
  type NarrationAudioManifestV2,
} from './audio-v2-manifest';
import {
  MASTER_CHANNELS,
  MASTER_SAMPLE_RATE,
  normalizeUnitToPcm,
  silencePcm,
  wrapPcmAsWav,
} from './audio';
import {probeAudio, sha256FileBytes} from '../tts-c/audio-probe';
import {AUDIO_TIMELINE_TOLERANCE_MS_V2} from '../subtitles/schema-v2';

/**
 * Narration Audio V2 — TTS 复用决策与 v2 enqueue（M7.1）。
 *
 * 本轮只实现机制与测试：不在 production 执行 Freud/拖延的任何 TTS 合成。
 *
 * 复用规则（REVIEW DECISIONS 1.3 冻结）：
 * - v2 job（payload 含完整 ttsInputFingerprint）：fingerprint 完全一致才允许复用
 * - legacy job（v1.0 payload，无 fingerprint 字段）：默认不得猜测复用；
 *   仅当 normalizedText + delivery=normal + voice + provider/model/version/commit
 *   全部可证明等价时，走受控 legacy compatibility（显式 reason code，测试锁定）
 * - 所有 reuse/rebuild 决策产出 deterministic diff report
 */

export interface TtsProviderSnapshot {
  name: string;
  model: string;
  providerVersion: string | null;
  providerCommit: string | null;
}

export type TtsReuseDecisionKind = 'reuse' | 'rebuild';

export type TtsReuseReasonCode =
  | 'FINGERPRINT_MATCH'
  | 'LEGACY_TEXT_VOICE_MODEL_EQUIVALENT'
  | 'NO_LEGACY_MATCH'
  | 'DELIVERY_DIFFERS_FROM_LEGACY'
  | 'LEGACY_MODEL_OR_VOICE_MISMATCH'
  | 'LEGACY_PAYLOAD_UNREADABLE'
  | 'ALREADY_ACTIVE';

export interface TtsReuseDecision {
  unitId: string;
  decision: TtsReuseDecisionKind;
  reasonCode: TtsReuseReasonCode;
  ttsInputFingerprint: string;
  matchedLegacyJobId: string | null;
  matchedLegacyPlanArtifactId: string | null;
  detail: string;
}

export interface TtsReusePlan {
  projectId: string;
  decisions: TtsReuseDecision[];
  reuseCount: number;
  rebuildCount: number;
}

/** unit 的完整 fingerprint 输入（除文本外的声学参数全部显式）。 */
export function fingerprintForUnit(
  unit: SpeechUnitV2,
  provider: TtsProviderSnapshot,
  voice: {id: string; revision: string},
  referenceAudioHash: string,
): string {
  return computeTtsInputFingerprint({
    spokenText: unit.spokenText,
    voiceIdentity: voiceIdentityOf(voice),
    referenceAudioHash,
    ttsModelVersion: ttsModelVersionOf({
      provider: provider.name,
      model: provider.model,
      providerVersion: provider.providerVersion,
      providerCommit: provider.providerCommit,
    }),
    delivery: unit.delivery,
    speed: '1.0',
    synthesisParameters: '{}',
    normalizationVersion: TTS_TEXT_NORMALIZATION_VERSION,
  });
}

/** 项目全部 succeeded tts_jobs（复用候选池，按完成时间倒序）。 */
function listSucceededTtsJobs(projectId: string): TtsJobRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tts_jobs
       WHERE project_id = ? AND status = 'succeeded'
       ORDER BY finished_at DESC`,
    )
    .all(projectId) as TtsJobRow[];
}

function legacyEquivalent(input: {
  unit: SpeechUnitV2;
  job: TtsJobRow;
  payloadText: string;
  provider: TtsProviderSnapshot;
  voice: {id: string; revision: string};
}): TtsReuseReasonCode {
  const {unit, job, payloadText, provider, voice} = input;
  if (normalizeSpokenText(payloadText) !== normalizeSpokenText(unit.spokenText)) {
    return 'NO_LEGACY_MATCH';
  }
  // delivery 等价只在 default 可证明（v1 无 delivery 概念，appliedToTts 恒 false）
  if (unit.delivery !== 'normal') {
    return 'DELIVERY_DIFFERS_FROM_LEGACY';
  }
  if (job.provider !== provider.name) {
    return 'LEGACY_MODEL_OR_VOICE_MISMATCH';
  }
  if (
    job.voice_profile_id !== voice.id ||
    job.voice_profile_revision !== voice.revision
  ) {
    return 'LEGACY_MODEL_OR_VOICE_MISMATCH';
  }
  if (job.result_json) {
    try {
      const result = ttsJobResultSchema.safeParse(JSON.parse(job.result_json));
      if (result.success) {
        const r = result.data;
        if (
          r.model !== provider.model ||
          r.providerVersion !== provider.providerVersion ||
          r.providerCommit !== provider.providerCommit
        ) {
          return 'LEGACY_MODEL_OR_VOICE_MISMATCH';
        }
      }
      // result_json 无法解析：不据此否决（旧数据可能缺字段），其余等价证据已成立
    } catch {
      // 同上：不猜测、不否决
    }
  }
  return 'LEGACY_TEXT_VOICE_MODEL_EQUIVALENT';
}

/**
 * 复用决策（纯读 DB，deterministic diff report）：
 * 1. v2 fingerprint 精确匹配 → reuse（FINGERPRINT_MATCH）
 * 2. legacy 受控等价判定 → reuse（LEGACY_TEXT_VOICE_MODEL_EQUIVALENT）
 * 3. 其余 → rebuild（显式 reason code，绝不猜测复用）
 */
export function planTtsReuseDecisions(input: {
  projectId: string;
  plan: NarrationPlanV2;
  provider: TtsProviderSnapshot;
  voice?: {id: string; revision: string};
  referenceAudioHash?: string;
}): TtsReusePlan {
  const voice = input.voice ?? DEFAULT_VOICE_PROFILE;
  const referenceAudioHash = input.referenceAudioHash ?? 'none';
  const succeeded = listSucceededTtsJobs(input.projectId);
  const decisions: TtsReuseDecision[] = [];

  for (const unit of input.plan.units) {
    if (unit.kind !== 'speech') continue;
    const fingerprint = fingerprintForUnit(unit, input.provider, voice, referenceAudioHash);

    // 1. v2 fingerprint 精确匹配
    const exact = succeeded.find((job) => {
      const payload = parseTtsJobPayload(job.payload_json);
      return (
        payload !== null &&
        payload.schemaVersion === 'tts-payload@1.1' &&
        payload.ttsInputFingerprint === fingerprint
      );
    });
    if (exact) {
      decisions.push({
        unitId: unit.id,
        decision: 'reuse',
        reasonCode: 'FINGERPRINT_MATCH',
        ttsInputFingerprint: fingerprint,
        matchedLegacyJobId: exact.id,
        matchedLegacyPlanArtifactId: exact.narration_plan_artifact_id,
        detail: '完整 fingerprint 一致',
      });
      continue;
    }

    // 2. legacy 受控等价（默认不得猜测复用）
    let decision: TtsReuseDecision | null = null;
    for (const job of succeeded) {
      const payload = parseTtsJobPayload(job.payload_json);
      if (!payload) {
        if (!decision) {
          decision = {
            unitId: unit.id,
            decision: 'rebuild',
            reasonCode: 'LEGACY_PAYLOAD_UNREADABLE',
            ttsInputFingerprint: fingerprint,
            matchedLegacyJobId: job.id,
            matchedLegacyPlanArtifactId: job.narration_plan_artifact_id,
            detail: '旧 payload 无法解析，禁止猜测复用',
          };
        }
        continue;
      }
      if (payload.schemaVersion !== '1.0') continue; // v1.1 已在精确匹配处理
      const reason = legacyEquivalent({
        unit,
        job,
        payloadText: payloadSpokenText(payload),
        provider: input.provider,
        voice,
      });
      if (reason === 'LEGACY_TEXT_VOICE_MODEL_EQUIVALENT') {
        decision = {
          unitId: unit.id,
          decision: 'reuse',
          reasonCode: reason,
          ttsInputFingerprint: fingerprint,
          matchedLegacyJobId: job.id,
          matchedLegacyPlanArtifactId: job.narration_plan_artifact_id,
          detail: 'legacy 等价：normalizedText+delivery=normal+voice+provider/model 全部一致',
        };
        break;
      }
      if (!decision || decision.reasonCode === 'LEGACY_PAYLOAD_UNREADABLE') {
        decision = {
          unitId: unit.id,
          decision: 'rebuild',
          reasonCode: reason,
          ttsInputFingerprint: fingerprint,
          matchedLegacyJobId: job.id,
          matchedLegacyPlanArtifactId: job.narration_plan_artifact_id,
          detail:
            reason === 'NO_LEGACY_MATCH'
              ? '无文本一致的旧音频'
              : reason === 'DELIVERY_DIFFERS_FROM_LEGACY'
                ? `delivery=${unit.delivery} 与 legacy（无 delivery）不可证明等价`
                : 'provider/model/voice 快照不一致',
        };
      }
    }
    decisions.push(
      decision ?? {
        unitId: unit.id,
        decision: 'rebuild',
        reasonCode: 'NO_LEGACY_MATCH',
        ttsInputFingerprint: fingerprint,
        matchedLegacyJobId: null,
        matchedLegacyPlanArtifactId: null,
        detail: '无文本一致的旧音频',
      },
    );
  }

  return {
    projectId: input.projectId,
    decisions,
    reuseCount: decisions.filter((d) => d.decision === 'reuse').length,
    rebuildCount: decisions.filter((d) => d.decision === 'rebuild').length,
  };
}

export class NarrationAudioV2Error extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'NARRATION_PLAN_V2_NOT_FOUND'
      | 'NARRATION_PLAN_V2_NOT_ELIGIBLE'
      | 'DIRECTIVE_LEAKAGE'
      | 'V2_SOURCE_SET_INCOMPLETE'
      | 'V2_SOURCE_ACTIVE'
      | 'V2_SOURCE_INVALID'
      | 'V2_MASTER_INVALID'
      | 'MASTER_PATH_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'NarrationAudioV2Error';
  }
}

/**
 * v2 enqueue（单 BEGIN IMMEDIATE）。M7.1.1 起必须显式传入
 * narrationPlanV2ArtifactId（禁止 current/latest 解析）：
 * artifact 必须存在、属于本项目、契约合法、且当前为 eligible_candidate
 * （stale/needs_review/invalid 一律拒绝）；每个 speech unit 再过
 * leakage hard gate 后才允许入队（纵深防御第三道）。
 * 本轮不接入 API/UI，仅供机制测试与后续里程碑使用。
 */
export function enqueueNarrationAudioJobsV2(input: {
  projectId: string;
  narrationPlanV2ArtifactId: string;
  provider: TtsProviderSnapshot;
  voiceProfile?: {id: string; revision: string};
  referenceAudioHash?: string;
}): {enqueued: number; reused: number; active: number; decisions: TtsReuseDecision[]} {
  const db = getDb();
  const voice = input.voiceProfile ?? DEFAULT_VOICE_PROFILE;
  const tx = db.transaction(() => {
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(input.projectId) as {id: string} | undefined;
    if (!project) {
      throw new NarrationAudioV2Error('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
    }
    const ref = getNarrationPlanV2Artifact(input.projectId, input.narrationPlanV2ArtifactId);
    if (!ref) {
      throw new NarrationAudioV2Error(
        'NARRATION_PLAN_V2_NOT_FOUND',
        `narration plan v2 artifact ${input.narrationPlanV2ArtifactId} 不存在/跨项目/契约非法——禁止入队`,
      );
    }
    const status = classifyNarrationPlanV2Candidate(input.projectId, ref.artifact);
    if (status.status !== 'eligible_candidate') {
      throw new NarrationAudioV2Error(
        'NARRATION_PLAN_V2_NOT_ELIGIBLE',
        `narration plan v2 状态=${status.status}（${status.statusReason ?? ''}）——只有 eligible_candidate 才允许入队`,
      );
    }
    const {plan, artifact} = ref;
    const reusePlan = planTtsReuseDecisions({
      projectId: input.projectId,
      plan,
      provider: input.provider,
      voice,
      referenceAudioHash: input.referenceAudioHash,
    });
    let enqueued = 0;
    let reused = 0;
    let active = 0;
    const provider = getTtsProvider();
    for (const unit of plan.units) {
      if (unit.kind !== 'speech') continue;
      // 纵深防御：入队前最后一次 leakage hard gate
      const leak = findDirectiveLeakage(unit.spokenText);
      if (leak.length > 0) {
        throw new NarrationAudioV2Error(
          'DIRECTIVE_LEAKAGE',
          `${unit.id} spokenText 含指令泄漏，禁止入队：${describeLeakage(leak)}`,
        );
      }
      const decision = reusePlan.decisions.find((d) => d.unitId === unit.id);
      if (decision?.decision === 'reuse') {
        reused++;
        continue;
      }
      const existingActive = getActiveTtsJob(
        input.projectId, artifact.id, unit.id, provider.name, voice.id, voice.revision,
      );
      if (existingActive) {
        active++;
        continue;
      }
      enqueueTtsJobTx(input.projectId, provider.name, voice.id, voice.revision, {
        schemaVersion: 'tts-payload@1.1',
        narrationPlanArtifactId: artifact.id,
        narrationPlanArtifactVersion: artifact.version,
        scriptV2Version: plan.source.scriptV2Version,
        compilerVersion: plan.compilerVersion,
        unitId: unit.id,
        spokenText: unit.spokenText,
        delivery: unit.delivery,
        ...(input.referenceAudioHash ? {referenceAudioSha256: input.referenceAudioHash} : {}),
        ttsInputFingerprint:
          decision?.ttsInputFingerprint ??
          fingerprintForUnit(unit, input.provider, voice, input.referenceAudioHash ?? 'none'),
      });
      enqueued++;
    }
    return {enqueued, reused, active, decisions: reusePlan.decisions};
  });
  return tx.immediate();
}

export interface NarrationAudioV2Artifact {
  artifact: {id: string; version: number};
  manifest: NarrationAudioManifestV2;
}

export interface FinalizeNarrationAudioV2Input {
  projectId: string;
  narrationPlanV2ArtifactId: string;
  narrationPlanV2ArtifactVersion: number;
  provider: TtsProviderSnapshot;
  voiceProfile: {id: string; revision: string};
  referenceSha256: string | null;
}

export interface FinalizeNarrationAudioV2Result extends NarrationAudioV2Artifact {
  reused: boolean;
  resolvedSources: number;
  active: number;
  decisions: TtsReuseDecision[];
}

type ValidatedSpeechSource = {
  unit: SpeechUnitV2;
  decision: TtsReuseDecision;
  job: TtsJobRow;
  result: TtsJobResult;
};

type AudioV2ArtifactRow = {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
};

function exactPlan(input: FinalizeNarrationAudioV2Input): {
  plan: NarrationPlanV2;
  artifact: {id: string; version: number};
} {
  const ref = getNarrationPlanV2Artifact(input.projectId, input.narrationPlanV2ArtifactId);
  if (!ref || ref.artifact.version !== input.narrationPlanV2ArtifactVersion) {
    throw new NarrationAudioV2Error(
      'NARRATION_PLAN_V2_NOT_FOUND',
      `exact narration plan v2 不存在/跨项目/version 不匹配: ${input.narrationPlanV2ArtifactId}@${input.narrationPlanV2ArtifactVersion}`,
    );
  }
  const candidate = classifyNarrationPlanV2Candidate(input.projectId, ref.artifact);
  if (candidate.status !== 'eligible_candidate') {
    throw new NarrationAudioV2Error(
      'NARRATION_PLAN_V2_NOT_ELIGIBLE',
      `exact narration plan v2 状态=${candidate.status}: ${candidate.statusReason ?? ''}`,
    );
  }
  return {plan: ref.plan, artifact: {id: ref.artifact.id, version: ref.artifact.version}};
}

function activeSourceCount(input: FinalizeNarrationAudioV2Input): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS count FROM tts_jobs
     WHERE project_id = ? AND narration_plan_artifact_id = ?
       AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
       AND status IN ('queued', 'running')`,
  ).get(
    input.projectId,
    input.narrationPlanV2ArtifactId,
    input.provider.name,
    input.voiceProfile.id,
    input.voiceProfile.revision,
  ) as {count: number};
  return row.count;
}

function safeAudioPath(relativePath: string): string | null {
  const dataDir = path.resolve(getDataDir());
  const abs = path.resolve(dataDir, relativePath);
  return abs.startsWith(dataDir + path.sep) ? abs : null;
}

function parseSucceededResult(job: TtsJobRow): TtsJobResult | null {
  if (!job.result_json) return null;
  try {
    const parsed = ttsJobResultSchema.safeParse(JSON.parse(job.result_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function validateSelectedSpeechSource(input: {
  request: FinalizeNarrationAudioV2Input;
  unit: SpeechUnitV2;
  decision: TtsReuseDecision;
}): Promise<ValidatedSpeechSource> {
  const {request, unit, decision} = input;
  const jobId = decision.matchedLegacyJobId;
  const job = jobId
    ? getDb().prepare('SELECT * FROM tts_jobs WHERE id = ?').get(jobId) as TtsJobRow | undefined
    : undefined;
  const payload = job ? parseTtsJobPayload(job.payload_json) : null;
  const result = job ? parseSucceededResult(job) : null;
  if (
    decision.decision !== 'reuse' ||
    !job ||
    job.project_id !== request.projectId ||
    job.status !== 'succeeded' ||
    job.unit_id !== unit.id ||
    job.provider !== request.provider.name ||
    job.voice_profile_id !== request.voiceProfile.id ||
    job.voice_profile_revision !== request.voiceProfile.revision ||
    !payload ||
    payload.unitId !== unit.id ||
    normalizeSpokenText(payloadSpokenText(payload)) !== normalizeSpokenText(unit.spokenText) ||
    !result ||
    result.provider !== request.provider.name ||
    result.model !== request.provider.model ||
    result.providerVersion !== request.provider.providerVersion ||
    result.providerCommit !== request.provider.providerCommit ||
    result.settings.voiceProfileId !== request.voiceProfile.id ||
    result.settings.voiceProfileRevision !== request.voiceProfile.revision ||
    result.settings.useRandom !== false ||
    (payload.referenceAudioSha256 ?? null) !== request.referenceSha256 ||
    (result.settings.referenceSha256 ?? null) !== request.referenceSha256 ||
    !job.output_path ||
    job.duration_ms === null ||
    !job.audio_sha256
  ) {
    throw new NarrationAudioV2Error(
      'V2_SOURCE_INVALID',
      `${unit.id} planner source ${jobId ?? 'missing'} provenance/payload/result 不满足 exact contract`,
    );
  }
  if (
    payload.schemaVersion === 'tts-payload@1.1' &&
    (payload.delivery !== unit.delivery ||
      decision.reasonCode !== 'FINGERPRINT_MATCH' ||
      payload.ttsInputFingerprint !== decision.ttsInputFingerprint ||
      payload.ttsInputFingerprint !==
        fingerprintForUnit(unit, request.provider, request.voiceProfile, request.referenceSha256 ?? 'none'))
  ) {
    throw new NarrationAudioV2Error(
      'V2_SOURCE_INVALID',
      `${unit.id} v2 fingerprint 与 exact planner/input 不一致`,
    );
  }
  if (
    payload.schemaVersion === '1.0' &&
    (unit.delivery !== 'normal' ||
      decision.reasonCode !== 'LEGACY_TEXT_VOICE_MODEL_EQUIVALENT')
  ) {
    throw new NarrationAudioV2Error(
      'V2_SOURCE_INVALID',
      `${unit.id} legacy source 未通过受控 legacy-equivalence reason`,
    );
  }
  const abs = safeAudioPath(job.output_path);
  if (!abs) {
    throw new NarrationAudioV2Error('V2_SOURCE_INVALID', `${unit.id} output_path 越出 data dir`);
  }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size <= 44) throw new Error('not a regular WAV');
    const head = Buffer.alloc(4);
    const fd = fs.openSync(abs, 'r');
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (head.toString('ascii') !== 'RIFF') throw new Error('not RIFF');
    if (await sha256FileBytes(abs) !== job.audio_sha256) throw new Error('SHA mismatch');
    const probe = probeAudio(abs, 'wav');
    if (
      probe.durationMs !== job.duration_ms ||
      probe.sampleRate !== result.audio.sampleRate ||
      probe.channels !== result.audio.channels
    ) throw new Error('probe facts mismatch');
  } catch (error) {
    throw new NarrationAudioV2Error(
      'V2_SOURCE_INVALID',
      `${unit.id} physical WAV 无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {unit, decision, job, result};
}

async function validateExactAudioV2Row(
  projectId: string,
  row: AudioV2ArtifactRow,
): Promise<NarrationAudioV2Artifact | null> {
  let manifest: NarrationAudioManifestV2;
  try {
    const parsed = narrationAudioManifestV2Schema.safeParse(JSON.parse(row.content_json));
    if (!parsed.success) return null;
    manifest = parsed.data;
  } catch {
    return null;
  }
  const planRef = getNarrationPlanV2Artifact(projectId, manifest.source.narrationPlanV2ArtifactId);
  if (
    !planRef ||
    planRef.artifact.version !== manifest.source.narrationPlanV2ArtifactVersion ||
    planRef.plan.source.scriptV2VersionId !== manifest.source.scriptV2VersionId ||
    planRef.plan.source.scriptV2Version !== manifest.source.scriptV2Version ||
    planRef.plan.compilerVersion !== manifest.source.narrationCompilerVersion ||
    manifest.units.length !== planRef.plan.units.length
  ) return null;
  const masterPath = safeAudioPath(manifest.master.filePath);
  if (!masterPath) return null;
  try {
    const stat = fs.statSync(masterPath);
    if (!stat.isFile() || stat.size <= 44) return null;
    if (await sha256FileBytes(masterPath) !== manifest.master.sha256) return null;
    const probe = probeAudio(masterPath, 'wav');
    if (
      probe.durationMs !== manifest.master.durationMs ||
      probe.sampleRate !== manifest.master.sampleRate ||
      probe.channels !== manifest.master.channels
    ) return null;
  } catch {
    return null;
  }
  const firstSpeechManifest = manifest.units.find((unit) => unit.kind === 'speech');
  if (!firstSpeechManifest) return null;
  const firstSpeechJob = getDb().prepare('SELECT * FROM tts_jobs WHERE id = ?').get(firstSpeechManifest.ttsJobId) as TtsJobRow | undefined;
  const firstSpeechResult = firstSpeechJob ? parseSucceededResult(firstSpeechJob) : null;
  if (!firstSpeechResult) return null;
  const request: FinalizeNarrationAudioV2Input = {
    projectId,
    narrationPlanV2ArtifactId: planRef.artifact.id,
    narrationPlanV2ArtifactVersion: planRef.artifact.version,
    provider: {
      name: manifest.provider.name,
      model: manifest.provider.model,
      providerVersion: manifest.provider.providerVersion,
      providerCommit: manifest.provider.providerCommit,
    },
    voiceProfile: manifest.provider.voiceProfile,
    referenceSha256: firstSpeechResult.settings.referenceSha256 ?? null,
  };
  try {
    for (const [index, unit] of planRef.plan.units.entries()) {
      const manifestUnit = manifest.units[index];
      if (!manifestUnit || manifestUnit.unitId !== unit.id || manifestUnit.kind !== unit.kind) return null;
      if (unit.kind === 'silence') {
        if (manifestUnit.kind !== 'silence' || manifestUnit.durationMs !== unit.durationMs || manifestUnit.reason !== unit.reason) return null;
        continue;
      }
      if (manifestUnit.kind !== 'speech') return null;
      const sourceJob = getDb().prepare('SELECT * FROM tts_jobs WHERE id = ?').get(manifestUnit.ttsJobId) as TtsJobRow | undefined;
      const sourcePayload = sourceJob ? parseTtsJobPayload(sourceJob.payload_json) : null;
      if (!sourcePayload) return null;
      const decision: TtsReuseDecision = {
        unitId: unit.id,
        decision: 'reuse',
        reasonCode: sourcePayload.schemaVersion === 'tts-payload@1.1'
          ? 'FINGERPRINT_MATCH'
          : 'LEGACY_TEXT_VOICE_MODEL_EQUIVALENT',
        ttsInputFingerprint: fingerprintForUnit(
          unit,
          request.provider,
          request.voiceProfile,
          request.referenceSha256 ?? 'none',
        ),
        matchedLegacyJobId: manifestUnit.ttsJobId,
        matchedLegacyPlanArtifactId: sourceJob?.narration_plan_artifact_id ?? null,
        detail: 'persisted exact source validation',
      };
      const source = await validateSelectedSpeechSource({request, unit, decision});
      if (
        manifestUnit.spokenText !== unit.spokenText ||
        manifestUnit.delivery !== unit.delivery ||
        manifestUnit.ttsInputFingerprint !== decision.ttsInputFingerprint ||
        manifestUnit.filePath !== source.job.output_path ||
        manifestUnit.durationMs !== source.job.duration_ms ||
        manifestUnit.sha256 !== source.job.audio_sha256 ||
        manifestUnit.sampleRate !== source.result.audio.sampleRate ||
        manifestUnit.channels !== source.result.audio.channels
      ) return null;
    }
  } catch {
    return null;
  }
  return {artifact: {id: row.id, version: row.version}, manifest};
}

/** Exact identity read: never resolves current/latest/default. */
export async function getExactNarrationAudioV2Artifact(
  projectId: string,
  expectedAudio: {artifactId: string; version: number},
): Promise<NarrationAudioV2Artifact | null> {
  const row = getDb().prepare(
    'SELECT id, project_id, kind, version, content_json FROM artifacts WHERE id = ?',
  ).get(expectedAudio.artifactId) as AudioV2ArtifactRow | undefined;
  if (
    !row ||
    row.project_id !== projectId ||
    row.kind !== NARRATION_AUDIO_V2_ARTIFACT_KIND ||
    row.version !== expectedAudio.version
  ) return null;
  return validateExactAudioV2Row(projectId, row);
}

async function findReusableAudioV2(
  request: FinalizeNarrationAudioV2Input,
  decisionJobIds: string[],
): Promise<NarrationAudioV2Artifact | null> {
  const rows = getDb().prepare(
    `SELECT id, project_id, kind, version, content_json FROM artifacts
     WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
  ).all(request.projectId, NARRATION_AUDIO_V2_ARTIFACT_KIND) as AudioV2ArtifactRow[];
  for (const row of rows) {
    let manifest: NarrationAudioManifestV2;
    try {
      const parsed = narrationAudioManifestV2Schema.safeParse(JSON.parse(row.content_json));
      if (!parsed.success) continue;
      manifest = parsed.data;
    } catch { continue; }
    const speechJobIds = manifest.units.filter((unit) => unit.kind === 'speech').map((unit) => unit.ttsJobId);
    if (
      manifest.source.narrationPlanV2ArtifactId !== request.narrationPlanV2ArtifactId ||
      manifest.source.narrationPlanV2ArtifactVersion !== request.narrationPlanV2ArtifactVersion ||
      manifest.provider.name !== request.provider.name ||
      manifest.provider.model !== request.provider.model ||
      manifest.provider.providerVersion !== request.provider.providerVersion ||
      manifest.provider.providerCommit !== request.provider.providerCommit ||
      manifest.provider.voiceProfile.id !== request.voiceProfile.id ||
      manifest.provider.voiceProfile.revision !== request.voiceProfile.revision ||
      JSON.stringify(speechJobIds) !== JSON.stringify(decisionJobIds)
    ) continue;
    const valid = await validateExactAudioV2Row(request.projectId, row);
    if (valid) return valid;
  }
  return null;
}

/**
 * Exact V2 finalize-only materializer. It only consumes planner-selected succeeded jobs;
 * it never calls enqueue and fails closed while any source is missing or active.
 */
export async function tryFinalizeNarrationAudioV2(
  request: FinalizeNarrationAudioV2Input,
): Promise<FinalizeNarrationAudioV2Result> {
  const db = getDb();
  const {plan, artifact} = exactPlan(request);
  const active = activeSourceCount(request);
  if (active > 0) {
    throw new NarrationAudioV2Error('V2_SOURCE_ACTIVE', `exact plan 仍有 ${active} 个 active TTS job，禁止 finalize`);
  }
  const reuse = planTtsReuseDecisions({
    projectId: request.projectId,
    plan,
    provider: request.provider,
    voice: request.voiceProfile,
    referenceAudioHash: request.referenceSha256 ?? 'none',
  });
  if (reuse.rebuildCount > 0 || reuse.reuseCount !== plan.units.filter((unit) => unit.kind === 'speech').length) {
    throw new NarrationAudioV2Error(
      'V2_SOURCE_SET_INCOMPLETE',
      `V2 source set incomplete: reuse=${reuse.reuseCount} rebuild=${reuse.rebuildCount}`,
    );
  }
  const sources: ValidatedSpeechSource[] = [];
  for (const unit of plan.units) {
    if (unit.kind !== 'speech') continue;
    const decision = reuse.decisions.find((item) => item.unitId === unit.id);
    if (!decision) {
      throw new NarrationAudioV2Error('V2_SOURCE_SET_INCOMPLETE', `${unit.id} 缺少 planner decision`);
    }
    sources.push(await validateSelectedSpeechSource({request, unit, decision}));
  }
  const decisionJobIds = sources.map((source) => source.job.id);
  const existing = await findReusableAudioV2(request, decisionJobIds);
  if (existing) {
    return {...existing, reused: true, resolvedSources: sources.length, active, decisions: reuse.decisions};
  }

  const chunks: Buffer[] = [];
  let unitTimelineMs = 0;
  for (const unit of plan.units) {
    if (unit.kind === 'silence') {
      chunks.push(silencePcm(unit.durationMs));
      unitTimelineMs += unit.durationMs;
      continue;
    }
    const source = sources.find((item) => item.unit.id === unit.id)!;
    chunks.push(normalizeUnitToPcm(safeAudioPath(source.job.output_path!)!));
    unitTimelineMs += source.job.duration_ms!;
  }
  const masterWav = wrapPcmAsWav(Buffer.concat(chunks));
  const materializationId = crypto.randomUUID();
  const relMaster = path.posix.join(
    'projects', request.projectId, 'audio',
    `narration-master-v2-${artifact.id}@${artifact.version}-${request.provider.name}-${request.voiceProfile.id}@${request.voiceProfile.revision}-${materializationId}.wav`,
  );
  const absMaster = safeAudioPath(relMaster)!;
  const absTmp = `${absMaster}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(absMaster), {recursive: true});
  fs.writeFileSync(absTmp, masterWav);
  let finalOwned = false;
  try {
    const tmpProbe = probeAudio(absTmp, 'wav');
    if (
      tmpProbe.sampleRate !== MASTER_SAMPLE_RATE ||
      tmpProbe.channels !== MASTER_CHANNELS ||
      Math.abs(tmpProbe.durationMs - unitTimelineMs) > AUDIO_TIMELINE_TOLERANCE_MS_V2
    ) {
      throw new NarrationAudioV2Error(
        'V2_MASTER_INVALID',
        `master probe=${tmpProbe.durationMs}ms 与 unit timeline=${unitTimelineMs}ms 不一致`,
      );
    }
    const masterSha = await sha256FileBytes(absTmp);
    const manifest = narrationAudioManifestV2Schema.parse({
      schemaVersion: NARRATION_AUDIO_V2_SCHEMA_VERSION,
      source: {
        narrationPlanV2ArtifactId: artifact.id,
        narrationPlanV2ArtifactVersion: artifact.version,
        scriptV2VersionId: plan.source.scriptV2VersionId,
        scriptV2Version: plan.source.scriptV2Version,
        narrationCompilerVersion: plan.compilerVersion,
      },
      provider: {
        ...request.provider,
        voiceProfile: request.voiceProfile,
        useRandom: false,
      },
      units: plan.units.map((unit) => {
        if (unit.kind === 'silence') {
          return {unitId: unit.id, kind: 'silence' as const, durationMs: unit.durationMs, reason: unit.reason};
        }
        const source = sources.find((item) => item.unit.id === unit.id)!;
        return {
          unitId: unit.id,
          kind: 'speech' as const,
          spokenText: unit.spokenText,
          delivery: unit.delivery,
          ttsInputFingerprint: source.decision.ttsInputFingerprint,
          filePath: source.job.output_path!,
          durationMs: source.job.duration_ms!,
          sampleRate: source.result.audio.sampleRate,
          channels: source.result.audio.channels,
          sha256: source.job.audio_sha256!,
          ttsJobId: source.job.id,
        };
      }),
      master: {
        filePath: relMaster,
        durationMs: tmpProbe.durationMs,
        sha256: masterSha,
        sampleRate: tmpProbe.sampleRate,
        channels: tmpProbe.channels,
      },
    });

    type Outcome = {kind: 'inserted'; artifact: {id: string; version: number}} | {kind: 'reuse'; artifact: NarrationAudioV2Artifact};
    const tx = db.transaction((): Outcome => {
      const planAgain = getNarrationPlanV2Artifact(request.projectId, request.narrationPlanV2ArtifactId);
      if (!planAgain || planAgain.artifact.version !== request.narrationPlanV2ArtifactVersion) {
        throw new NarrationAudioV2Error('NARRATION_PLAN_V2_NOT_FOUND', 'exact plan 在提交前消失或 version 改变');
      }
      const rows = db.prepare(
        `SELECT id, project_id, kind, version, content_json FROM artifacts
         WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
      ).all(request.projectId, NARRATION_AUDIO_V2_ARTIFACT_KIND) as AudioV2ArtifactRow[];
      for (const row of rows) {
        let raw: unknown;
        try { raw = JSON.parse(row.content_json); } catch { continue; }
        const parsed = narrationAudioManifestV2Schema.safeParse(raw);
        if (!parsed.success) continue;
        const m = parsed.data;
        const ids = m.units.filter((unit) => unit.kind === 'speech').map((unit) => unit.ttsJobId);
        if (
          m.source.narrationPlanV2ArtifactId === request.narrationPlanV2ArtifactId &&
          m.source.narrationPlanV2ArtifactVersion === request.narrationPlanV2ArtifactVersion &&
          m.provider.name === request.provider.name &&
          m.provider.model === request.provider.model &&
          m.provider.providerVersion === request.provider.providerVersion &&
          m.provider.providerCommit === request.provider.providerCommit &&
          m.provider.voiceProfile.id === request.voiceProfile.id &&
          m.provider.voiceProfile.revision === request.voiceProfile.revision &&
          JSON.stringify(ids) === JSON.stringify(decisionJobIds)
        ) return {kind: 'reuse', artifact: {artifact: {id: row.id, version: row.version}, manifest: m}};
      }
      if (fs.existsSync(absMaster)) {
        const referenced = rows.some((row) => {
          try { return (JSON.parse(row.content_json) as {master?: {filePath?: string}}).master?.filePath === relMaster; }
          catch { return false; }
        });
        if (referenced) throw new NarrationAudioV2Error('MASTER_PATH_CONFLICT', `V2 master 路径已被历史 artifact 引用: ${relMaster}`);
        fs.rmSync(absMaster, {force: true});
      }
      fs.renameSync(absTmp, absMaster);
      finalOwned = true;
      const finalProbe = probeAudio(absMaster, 'wav');
      const finalSha = crypto.createHash('sha256').update(fs.readFileSync(absMaster)).digest('hex');
      if (
        finalSha !== masterSha ||
        finalProbe.durationMs !== manifest.master.durationMs ||
        finalProbe.sampleRate !== manifest.master.sampleRate ||
        finalProbe.channels !== manifest.master.channels
      ) {
        throw new NarrationAudioV2Error('V2_MASTER_INVALID', 'rename 后 final master media facts 与 manifest 不一致');
      }
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
           ?, NULL, ?)`,
      ).run(
        id, request.projectId, NARRATION_AUDIO_V2_ARTIFACT_KIND,
        request.projectId, NARRATION_AUDIO_V2_ARTIFACT_KIND,
        JSON.stringify(manifest), new Date().toISOString(),
      );
      const inserted = db.prepare('SELECT version FROM artifacts WHERE id = ?').get(id) as {version: number};
      return {kind: 'inserted', artifact: {id, version: inserted.version}};
    });
    const outcome = tx.immediate();
    if (outcome.kind === 'reuse') {
      fs.rmSync(absTmp, {force: true});
      return {...outcome.artifact, reused: true, resolvedSources: sources.length, active, decisions: reuse.decisions};
    }
    return {
      artifact: outcome.artifact,
      manifest,
      reused: false,
      resolvedSources: sources.length,
      active,
      decisions: reuse.decisions,
    };
  } catch (error) {
    if (finalOwned) fs.rmSync(absMaster, {force: true});
    fs.rmSync(absTmp, {force: true});
    throw error;
  }
}

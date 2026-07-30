import {getDb} from '../db';
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
  type TtsJobRow,
} from '../tts-jobs';
import {DEFAULT_VOICE_PROFILE, getTtsProvider} from '../tts';
import {describeLeakage, findDirectiveLeakage} from './leakage';
import {classifyNarrationPlanV2Candidate, getNarrationPlanV2Artifact} from './plan-v2';
import type {NarrationPlanV2, SpeechUnitV2} from './schema-v2';

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
      | 'DIRECTIVE_LEAKAGE',
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

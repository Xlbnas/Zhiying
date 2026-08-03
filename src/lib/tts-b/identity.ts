/**
 * TTS-B buildPerformanceInputIdentity（设计文档 §10）。
 *
 * 纯函数：稳定计算 (exact Narration Plan identity + unitId + exact Assignment
 * identity + Performance Plan identity) 的确定性 identity，供对账/缓存 key 分析。
 * **不得命名为 ttsInputFingerprint**——最终 fingerprint 必须留给 TTS-C，并满足
 * 冻结公式（normalizedSpokenText + voiceIdentity + referenceAudioHash +
 * ttsModelVersion + resolvedDelivery + resolvedSpeed + resolvedSynthesisParameters +
 * normalizationVersion）。禁止仅按文本、unitId 或 voiceProfileId 复用。
 */
import crypto from 'node:crypto';

function lengthPrefixed(fields: string[]): string {
  return fields.map((f) => `${f.length}:${f}`).join('|');
}

export interface PerformanceInputIdentityInput {
  narrationPlanArtifactId: string;
  narrationPlanContentHash: string;
  unitId: string;
  assignmentArtifactId: string;
  assignmentContentHash: string;
  performancePlanArtifactId: string;
  performancePlanContentHash: string;
}

export function buildPerformanceInputIdentity(input: PerformanceInputIdentityInput): string {
  const canonical = lengthPrefixed([
    input.narrationPlanArtifactId,
    input.narrationPlanContentHash,
    input.unitId,
    input.assignmentArtifactId,
    input.assignmentContentHash,
    input.performancePlanArtifactId,
    input.performancePlanContentHash,
  ]);
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

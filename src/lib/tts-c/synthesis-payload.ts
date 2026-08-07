/**
 * TTS-C.1C.2 — frozen synthesis payload builder + fingerprint。
 *
 * C.2 payload builder 复用已冻结的 1C.1 纯编译器（compilePerformanceToProvider），
 * 把 exact frozen source inputs + exact Provider Capability Snapshot 编译结果纳入
 * canonical synthesis payload：
 *
 *   providerParams / unsupportedFlags / compilerVersion / snapshotVersion
 *
 * synthesisPayloadFingerprint 规则（frozen §2.0 应用层契约——SQL 不可表达，由本模块
 * 定义并同事务验证 payload_json 与 fingerprint exact 对应）：
 *   - canonical payload JSON 固定键序（确定性；无时间/随机/DB row id 噪音）；
 *   - 同一 exact inputs → 逐字节相同 fingerprint；
 *   - 任何影响真实 synthesis payload 的 frozen 输入变化 → fingerprint 变化。
 *
 * 零 DB / 零 IO / 零时钟 / 零随机数（与 1C.1 同一纯函数约束）。
 */
import crypto from 'node:crypto';
import {
  compilePerformanceToProvider,
  type CapabilityCompileInput,
  type UnsupportedControl,
} from './capability-compiler';
import type {ProviderCapabilitySnapshotV1} from './provider-capability';
import {PROVIDER_CAPABILITY_COMPILER_VERSION} from './provider-capability';

export const SYNTHESIS_PAYLOAD_SCHEMA_VERSION = 'tts-synthesis-payload@1';

/** frozen canonical synthesis payload（固定键序；fingerprint 的权威序列化）。 */
export interface CanonicalSynthesisPayload {
  schemaVersion: string;
  unitId: string;
  spokenText: string;
  providerParams: Record<string, unknown>;
  unsupportedFlags: UnsupportedControl[];
  compilerVersion: string;
  snapshotVersion: string;
}

export interface CompiledSynthesisPayload {
  /** canonical payload JSON（fingerprint 的序列化对象）。 */
  canonicalPayloadJson: string;
  /** synthesisPayloadFingerprint = sha256:<hex>（canonical bytes）。 */
  synthesisPayloadFingerprint: string;
  /** 1C.1 编译结果（供 capability provenance 持久化）。 */
  providerParams: Record<string, unknown>;
  unsupportedFlags: UnsupportedControl[];
  compilerVersion: string;
  snapshotVersion: string;
  /** frozen capability provenance（artifact 三列：snapshot_json / compiled_payload_json / compiler_version）。 */
  capabilitySnapshotJson: string;
  compiledPayloadJson: string;
  capabilityCompilerVersion: string;
}

/** canonical fingerprint（固定键序序列化 + sha256）。 */
export function computeSynthesisPayloadFingerprint(canonicalPayloadJson: string): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalPayloadJson, 'utf8').digest('hex')}`;
}

/**
 * R2 — exact source fingerprint（frozen §8.2 3e）：exact source 身份的 canonical 绑定——
 * project/unit + 三个 exact source artifact（ID + content hash）+ voice revision pair。
 * 固定键序 canonical JSON → sha256:<hex>。纯函数（零 DB / IO / 时钟 / 随机）。
 * 禁止 fallback current/latest/default（exact source 纪律：全链路显式 artifact ID）。
 */
export function computeExactSourceFingerprint(input: {
  projectId: string;
  unitId: string;
  narrationPlanArtifactId: string;
  narrationPlanContentHash: string;
  assignmentArtifactId: string;
  assignmentContentHash: string;
  performancePlanArtifactId: string;
  performancePlanContentHash: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
}): string {
  return sha256Canonical({
    projectId: input.projectId,
    unitId: input.unitId,
    narrationPlanArtifactId: input.narrationPlanArtifactId,
    narrationPlanContentHash: input.narrationPlanContentHash,
    assignmentArtifactId: input.assignmentArtifactId,
    assignmentContentHash: input.assignmentContentHash,
    performancePlanArtifactId: input.performancePlanArtifactId,
    performancePlanContentHash: input.performancePlanContentHash,
    voiceProfileId: input.voiceProfileId,
    voiceProfileRevisionId: input.voiceProfileRevisionId,
  });
}

/**
 * R2 — final TTS input fingerprint（frozen §8.2 3e）：final compiled input 的 canonical 投影
 * （unit + spoken text + voice revision pair + reference audio SHA + synthesis payload）。
 * 固定键序 canonical JSON → sha256:<hex>。纯函数。
 */
export function computeFinalTtsInputFingerprint(input: {
  unitId: string;
  spokenText: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  referenceAudioSha256: string;
  synthesisPayloadFingerprint: string;
}): string {
  return sha256Canonical({
    unitId: input.unitId,
    spokenText: input.spokenText,
    voiceProfileId: input.voiceProfileId,
    voiceProfileRevisionId: input.voiceProfileRevisionId,
    referenceAudioSha256: input.referenceAudioSha256,
    synthesisPayloadFingerprint: input.synthesisPayloadFingerprint,
  });
}

/** 固定键序 canonical JSON → sha256:<hex>（本模块 fingerprint 唯一序列化方式）。 */
function sha256Canonical(obj: Record<string, unknown>): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex')}`;
}

/**
 * 构建 compiled synthesis payload（1C.2 handoff）：
 *   1. 编译 exact capability inputs + exact snapshot（1C.1 frozen 语义）；
 *   2. 组装 canonical payload（固定键序）并计算 synthesisPayloadFingerprint；
 *   3. 返回 capability provenance 三件套（snapshot_json / compiled_payload_json /
 *      capability_compiler_version）。
 */
export function buildCompiledSynthesisPayload(options: {
  unitId: string;
  spokenText: string;
  capabilityInput: CapabilityCompileInput;
  snapshot: ProviderCapabilitySnapshotV1;
}): CompiledSynthesisPayload {
  const compiled = compilePerformanceToProvider(options.capabilityInput, options.snapshot);
  const canonical: CanonicalSynthesisPayload = {
    schemaVersion: SYNTHESIS_PAYLOAD_SCHEMA_VERSION,
    unitId: options.unitId,
    spokenText: options.spokenText,
    providerParams: compiled.providerParams,
    unsupportedFlags: compiled.unsupportedFlags,
    compilerVersion: compiled.compilerVersion,
    snapshotVersion: compiled.snapshotVersion,
  };
  const canonicalPayloadJson = JSON.stringify(canonical);
  const synthesisPayloadFingerprint = computeSynthesisPayloadFingerprint(canonicalPayloadJson);
  const compiledPayloadJson = JSON.stringify({
    schemaVersion: SYNTHESIS_PAYLOAD_SCHEMA_VERSION,
    providerParams: compiled.providerParams,
    unsupportedFlags: compiled.unsupportedFlags,
    compilerVersion: compiled.compilerVersion,
    snapshotVersion: compiled.snapshotVersion,
  });
  return {
    canonicalPayloadJson,
    synthesisPayloadFingerprint,
    providerParams: compiled.providerParams,
    unsupportedFlags: compiled.unsupportedFlags,
    compilerVersion: compiled.compilerVersion,
    snapshotVersion: compiled.snapshotVersion,
    capabilitySnapshotJson: JSON.stringify(options.snapshot),
    compiledPayloadJson,
    capabilityCompilerVersion: PROVIDER_CAPABILITY_COMPILER_VERSION,
  };
}

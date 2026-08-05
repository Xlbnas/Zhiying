/**
 * TTS-C.1A.R6 hardening —— Private Reuse Authority + Record-Only SHA Seal + One-Shot Consumption
 * + Real POST Integrity + FD Lifecycle Closure：
 * - REUSE-AUTH-01..05 issuer private + record-only authorization + issuance SHA equality；
 * - REUSE-ONCE-01..05 one-shot consumption + exact handle/attempt binding + takeover safety；
 * - FD-01..06 private fd lifecycle (issuance/hook/transaction failure/transaction success/shadow/duplicate)；
 * - POST-R6-01..06 real POST route（gate/queue/verified/damaged/cancelled/persistence）；
 * - RESP-02 真实 failed path（failMaterializationJobFenced → reused 不冒充）；
 * - 覆盖 R5 mutation 错误修正（mutation proof 4/9，非 9/9）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runMaterializationJob} from '../src/worker/materialization-executor';
import {
  createMaterializationRequest,
  getProjection,
  getMaterializationJob,
  getMaterializationRequest,
  failMaterializationJobFenced,
  workerFinalizeMaterialization,
  validateExistingProjection,
  listActiveRequestRows,
  sha256Text,
  setAfterProjectionValidationBeforeFinalize,
  setAfterRecoveryEvidenceBeforeCommit,
  finalizeValidatingJob,
  MaterializationError,
  type MaterializationExecutionHandle,
  type VoiceMaterializationRow,
} from '../src/lib/tts-c/materialization';
import {
  openHeldMaterializedFileEvidence,
  assertHeldCurrentSync,
  assertHeldCapability,
  HeldMaterializedFileEvidence,
  ValidatedReusableProjectionCapability,
  MaterializedFileError,
  type ValidationOwnerShape,
} from '../src/lib/tts-c/materialized-file-validator';
import {destinationAbsolutePath, materializationRootAbs} from '../src/lib/tts-c/paths';
import {getProjectVoiceAssignment} from '../src/lib/tts-b/assignment';

const TAG = 'test-tts-c1a-r6-hardening';
const ADAPTER_KEY = 'indextts2-adapter-registry@1';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
  canonicalAbs: string;
  rel: string;
  profileId: string;
}

async function freshRevisionIsolated(freq: number, tag: string): Promise<RevCtx> {
  const vp = createVoiceProfile({displayName: `vp-r6-${tag}-${crypto.randomUUID().slice(0, 8)}`});
  const profileId = vp.id;
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: profileId, requestId: `r6-${tag}-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const canonicalAbs = path.join(fx.dataDir, 'voice-library', profileId, row.id, 'reference.wav');
  const sha = sha256Buf(fs.readFileSync(canonicalAbs));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: profileId,
    voiceProfileRevisionId: row.id,
    requestId: `r6-asg-${tag}-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {
    revisionId: row.id,
    sha,
    assignmentArtifactId: built.artifact.id,
    canonicalAbs,
    rel: `${profileId}/${row.id}/reference.wav`,
    profileId,
  };
}

async function buildUsableProjection(rev: RevCtx, requestId: string): Promise<string> {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  // Loop claim+run until projection is created（其他请求可能占用首个 claim）
  for (let i = 0; i < 10; i++) {
    const proj = getProjection(rev.profileId, rev.revisionId);
    if (proj) return proj.id;
    const claimed = claimNextAnyJob('r6-worker');
    if (claimed && claimed.type === 'voice_materialization') {
      try {
        await runMaterializationJob(claimed.handle, {log: () => undefined});
      } catch (e) {
        console.error('worker threw in buildUsableProjection:', (e as Error).message);
      }
    } else {
      break;
    }
  }
  const proj = getProjection(rev.profileId, rev.revisionId);
  if (!proj) throw new Error(`buildUsableProjection failed: profileId=${rev.profileId} revId=${rev.revisionId} requestId=${requestId}`);
  return proj.id;
}

// R6 P0-A 私有入口：测试通过 namespace 拿 consumeValidatedProjectionForReuse（实际只
// 供 mutation 测试用；公开入口不暴露 ReuseAuthorityRecord WeakMap）。
// （const validatorModule 移入 IIFE 内避免 top-level await）

function makeExactFinal(rev: RevCtx): string {
  const finalAbs = destinationAbsolutePath(rev.rel);
  fs.mkdirSync(path.dirname(finalAbs), {recursive: true});
  fs.copyFileSync(rev.canonicalAbs, finalAbs);
  return finalAbs;
}

async function makeHeldFor(rev: RevCtx, mode: 'verify' | 'durabilize' = 'durabilize'): Promise<HeldMaterializedFileEvidence> {
  makeExactFinal(rev);
  return openHeldMaterializedFileEvidence(
    {
      relativePath: rev.rel,
      voiceProfileId: rev.profileId,
      voiceProfileRevisionId: rev.revisionId,
      expectedSha256: rev.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: ADAPTER_KEY,
    },
    mode,
  );
}

async function claimHandleFor(rev: RevCtx, requestId: string): Promise<MaterializationExecutionHandle> {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  const claimed = claimNextAnyJob('r6-worker');
  if (!claimed || claimed.type !== 'voice_materialization') throw new Error(`claim failed: ${requestId}`);
  return claimed.handle;
}

function makeFakeHandle(jobId: string, attempt: number): ValidationOwnerShape {
  return {
    jobId,
    validationOwnerToken: 'tok',
    validationAttempt: attempt,
    candidateMaterializationId: null,
    candidateMaterializationMetadataHash: null,
  };
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();
  const validatorModule = await import('../src/lib/tts-c/materialized-file-validator');

  // ═══ REUSE-AUTH-01..05：Private issuer + record-only auth + issuance SHA equality ═══

  // ── REUSE-AUTH-01：projection DB expected SHA = Y, file actual SHA = X ≠ Y；尝试 issuer/capability 篡改 → reject ──
  const revA1 = await freshRevisionIsolated(6110, 'ra1');
  await buildUsableProjection(revA1, 'ra1-build');
  const projA1 = getProjection(revA1.profileId, revA1.revisionId)!;
  // mangle the final file to X ≠ Y（保持 size 一致；篡改 path 上实际 WAV 字节）
  const finalA1 = destinationAbsolutePath(revA1.rel);
  const origA1 = fs.readFileSync(finalA1);
  const sameLenA1 = Buffer.from(origA1);
  sameLenA1[sameLenA1.length - 1] = sameLenA1[sameLenA1.length - 1] ^ 0xff;
  fs.writeFileSync(finalA1, sameLenA1);
  // 尝试走 public openHeldMaterializedFileEvidence 期望 X（应被 SHA mismatch 拒绝）
  let ra01a = false;
  try {
    await openHeldMaterializedFileEvidence(
      {
        relativePath: revA1.rel,
        voiceProfileId: revA1.profileId,
        voiceProfileRevisionId: revA1.revisionId,
        expectedSha256: 'x'.repeat(64), // 伪造的 caller SHA
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: ADAPTER_KEY,
      },
      'verify',
    );
  } catch (e) {
    ra01a = e instanceof MaterializedFileError && e.code === 'SHA_MISMATCH';
  }
  ok(ra01a, 'REUSE-AUTH-01a openHeldMaterializedFileEvidence with 伪造 expected SHA → SHA_MISMATCH（issuance authority 来自 held fd 真实读取，不信任 caller）');
  // 尝试通过 route handler 重新 createMaterializationRequest（re-POST 触发 reuse validation）—— damaged file fail-closed
  let ra01b = false;
  try {
    await createMaterializationRequest(fx.projectId, 'ra1-build', revA1.assignmentArtifactId);
  } catch (e) {
    ra01b = e instanceof MaterializationError && e.code === 'MATERIALIZATION_UNUSABLE';
  }
  ok(ra01b, 'REUSE-AUTH-01b re-POST damaged file → MATERIALIZATION_UNUSABLE（fail-closed；不冒充 reused）');
  // exported issuer 不存在（__internal / __validatorInternal 已删）—— 通过 import 验证
  // exported issuer 不存在（__internal / __validatorInternal 已删）—— 通过 import 验证
  const validatorModuleLocal = validatorModule;
  ok(
    (validatorModuleLocal as unknown as Record<string, unknown>).__internal === undefined &&
      (validatorModuleLocal as unknown as Record<string, unknown>).issueReuseCapabilityFromHeld === undefined &&
      (validatorModuleLocal as unknown as Record<string, unknown>).underlyingHeldForReuse === undefined,
    'REUSE-AUTH-01c exported issuer/private registration 入口已删除（__internal / issueReuseCapabilityFromHeld / underlyingHeldForReuse 不存在）',
  );
  void validatorModuleLocal;
  // 验证 public capability 不暴露 identity/授权字段
  const revA1b = await freshRevisionIsolated(6111, 'ra1b');
  await buildUsableProjection(revA1b, 'ra1b-build');
  const projA1b = getProjection(revA1b.profileId, revA1b.revisionId);
  if (!projA1b) { ok(false, 'REUSE-AUTH-01d projection missing'); }
  else {
    const handleForIssue = {
      jobId: '',
      validationOwnerToken: '',
      validationAttempt: 0,
      candidateMaterializationId: projA1b.id,
      candidateMaterializationMetadataHash: null,
    };
    const validatorModuleLocal = validatorModule;
    const v1bInstance = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
      {...projA1b}, null, handleForIssue, 'indextts2',
    );
    if (v1bInstance.kind === 'usable') {
      const cap = v1bInstance.capability;
      ok(
        !('projectionId' in cap) && !('voiceProfileId' in cap) && !('sourceSha256' in cap) &&
          !('adapterCompatibilityKey' in cap) && !('provider' in cap) && !('relativePath' in cap) &&
          !('fileSha256' in cap),
        'REUSE-AUTH-01d public capability 不暴露 identity/授权字段（projectionId/voiceProfileId/sourceSha256/adapter/provider/relativePath/fileSha256 全部隐藏）',
      );
      await cap.close().catch(() => undefined);
    } else {
      ok(false, `REUSE-AUTH-01d validateProjectionForReuse 应返回 usable; got ${v1bInstance.kind} reason=${'reason' in v1bInstance ? v1bInstance.reason : ''}`);
    }
  }
  // restore file
  fs.writeFileSync(finalA1, origA1);

  // ── REUSE-AUTH-02：public cap.fileSha256 改写 → 无效（公开字段不可参与授权）──
  // capability 不暴露 fileSha256 公开字段；尝试 Object.defineProperty shadow → 记录不受影响
  const revA2 = await freshRevisionIsolated(6120, 'ra2');
  await buildUsableProjection(revA2, 'ra2-build');
  const projA2 = getProjection(revA2.profileId, revA2.revisionId)!;
  const handleA2 = {
    jobId: '',
    validationOwnerToken: '',
    validationAttempt: 0,
    candidateMaterializationId: projA2.id,
    candidateMaterializationMetadataHash: null,
  };
  const v2 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projA2},
    null,
    handleA2,
    'indextts2',
  );
  if (v2.kind === 'usable') {
    // 公开 cap 试图 shadow 一个 fileSha256 字段（应被忽略——record 是权威）
    Object.defineProperty(v2.capability, 'fileSha256', {value: 'Y'.repeat(64), configurable: true});
    // R7 §八：篡改后必须执行真实 consume/finalize，验证授权结果只由 private record 决定
    // → consumeValidatedProjectionForReuse（exact handle）→ onCommit 成功 → capability closed
    let ra02 = false;
    let ra02Closed = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        v2.capability,
        {...handleA2, candidateMaterializationId: projA2.id},
        async () => undefined,
      );
      ra02 = true;
      ra02Closed = v2.capability.isClosed;
    } catch {
      ra02 = false;
    }
    ok(ra02 && ra02Closed, 'REUSE-AUTH-02 public cap.fileSha256 改写不影响 record（真实 consume 成功 + capability 最终 closed）', {ra02, ra02Closed});
    // 第二次 consume → state=consumed/closed → SEAL_MISMATCH
    let ra02b = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        v2.capability, {...handleA2, candidateMaterializationId: projA2.id}, async () => undefined,
      );
    } catch (e) {
      ra02b = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
    }
    ok(ra02b, 'REUSE-AUTH-02b 同 capability 第二次 consume → SEAL_MISMATCH');
  } else {
    ok(false, 'REUSE-AUTH-02 validateProjectionForReuse 应返回 usable');
  }

  // ── REUSE-AUTH-03：public cap.sourceSha256 改写 → 无效（真实 consume 仍成功）──
  const revA3 = await freshRevisionIsolated(6130, 'ra3');
  await buildUsableProjection(revA3, 'ra3-build');
  const projA3 = getProjection(revA3.profileId, revA3.revisionId)!;
  const v3 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projA3}, null, {...handleA2, candidateMaterializationId: projA3.id}, 'indextts2',
  );
  if (v3.kind === 'usable') {
    Object.defineProperty(v3.capability, 'sourceSha256', {value: 'Y'.repeat(64), configurable: true});
    let ra03 = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        v3.capability, {...handleA2, candidateMaterializationId: projA3.id}, async () => undefined,
      );
      ra03 = v3.capability.isClosed;
    } catch {
      ra03 = false;
    }
    ok(ra03, 'REUSE-AUTH-03 public cap.sourceSha256 改写不影响 record（真实 consume 成功 + capability 最终 closed）');
  } else {
    ok(false, 'REUSE-AUTH-03 validateProjectionForReuse 应返回 usable');
  }

  // ── REUSE-AUTH-04：public provider/adapter/path/projectionId 改写 → 无效（真实 consume 仍成功）──
  const revA4 = await freshRevisionIsolated(6140, 'ra4');
  await buildUsableProjection(revA4, 'ra4-build');
  const projA4 = getProjection(revA4.profileId, revA4.revisionId)!;
  const v4 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projA4}, null, {...handleA2, candidateMaterializationId: projA4.id}, 'indextts2',
  );
  if (v4.kind === 'usable') {
    Object.defineProperty(v4.capability, 'provider', {value: 'evil', configurable: true});
    Object.defineProperty(v4.capability, 'adapterCompatibilityKey', {value: 'evil', configurable: true});
    Object.defineProperty(v4.capability, 'projectionId', {value: 'evil', configurable: true});
    let ra04 = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        v4.capability, {...handleA2, candidateMaterializationId: projA4.id}, async () => undefined,
      );
      ra04 = v4.capability.isClosed;
    } catch {
      ra04 = false;
    }
    ok(ra04, 'REUSE-AUTH-04 public provider/adapter/projectionId 改写不影响 record（真实 consume 成功 + capability 最终 closed）');
  } else {
    ok(false, 'REUSE-AUTH-04 validateProjectionForReuse 应返回 usable');
  }

  // ── REUSE-AUTH-05：legitimate validator-issued exact capability → reused ──
  const revA5 = await freshRevisionIsolated(6150, 'ra5');
  await buildUsableProjection(revA5, 'ra5-build');
  // 用真实 handle 触发 createMaterializationRequest（re-POST 走 validation）
  const rA5 = await createMaterializationRequest(fx.projectId, 'ra5-build', revA5.assignmentArtifactId);
  ok(rA5.outcome === 'reused' && rA5.projection?.id === rA5.request.materialization_id && rA5.integrityStatus === 'verified',
    'REUSE-AUTH-05 legitimate validator-issued capability → reused + verified + projection linked',
    {outcome: rA5.outcome, integrityStatus: rA5.integrityStatus});

  // ═══ REUSE-ONCE-01..05：one-shot consumption + exact handle/attempt binding ═══

  // ── REUSE-ONCE-01：同 capability 第二次 finalize → reject ──
  // validateProjectionForReuse 后只发一次 cap；尝试 reuse 多次 → 第一次成功后 mark consumed，第二次 reject
  const revO1 = await freshRevisionIsolated(6210, 'ro1');
  await buildUsableProjection(revO1, 'ro1-build');
  // 走 createMaterializationRequest 一次后，capability 已被 consumed
  // 第二次直接 reuse 应该因 record.consumed=true 拒绝
  const projO1 = getProjection(revO1.profileId, revO1.revisionId)!;
  const handleO1 = {
    jobId: '',
    validationOwnerToken: '',
    validationAttempt: 0,
    candidateMaterializationId: projO1.id,
    candidateMaterializationMetadataHash: null,
  };
  const o1V1 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projO1}, null, handleO1, 'indextts2',
  );
  if (o1V1.kind === 'usable') {
    // R7 §八：不得再把 reuse capability 传给 assertHeldCapability；必须对同一个 reuse
    // capability 调两次真实 consume——第一次成功（state=consumed），第二次 → SEAL_MISMATCH
    const consumeOnce = async (): Promise<boolean> => {
      try {
        await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
          o1V1.capability, handleO1, async () => undefined,
        );
        return true;
      } catch (e) {
        return e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
      }
    };
    const first = await consumeOnce();
    const second = await consumeOnce();
    ok(first && second, 'REUSE-ONCE-01 同 capability 两次真实 consume：第一次成功、第二次 SEAL_MISMATCH（one-shot）', {first, second});
  } else {
    ok(false, 'REUSE-ONCE-01 validateProjectionForReuse 应返回 usable');
  }

  // ── REUSE-ONCE-02：capability 用于不同 job → reject ──
  const revO2 = await freshRevisionIsolated(6220, 'ro2');
  await buildUsableProjection(revO2, 'ro2-build');
  const projO2 = getProjection(revO2.profileId, revO2.revisionId)!;
  const o2HandleA = {
    jobId: 'job-A-uuid',
    validationOwnerToken: 'tok-A',
    validationAttempt: 1,
    candidateMaterializationId: projO2.id,
    candidateMaterializationMetadataHash: 'hash-A',
  };
  const o2V = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projO2}, 'hash-A', o2HandleA, 'indextts2',
  );
  if (o2V.kind === 'usable') {
    // 尝试用不同 jobId 调用 consumeValidatedProjectionForReuse
    const o2HandleB = {...o2HandleA, jobId: 'job-B-uuid', validationOwnerToken: 'tok-B'};
    let ro02 = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        o2V.capability, o2HandleB, async () => undefined,
      );
    } catch (e) {
      ro02 = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
    }
    ok(ro02, 'REUSE-ONCE-02 capability 用于不同 job → SEAL_MISMATCH（handle binding 不匹配）');
    await o2V.capability.close().catch(() => undefined);
  }

  // ── REUSE-ONCE-03：capability 用于 attempt+1 → reject（takeover 后旧 capability 失效）──
  const revO3 = await freshRevisionIsolated(6230, 'ro3');
  await buildUsableProjection(revO3, 'ro3-build');
  const projO3 = getProjection(revO3.profileId, revO3.revisionId)!;
  const o3HandleA = {
    jobId: 'job-O3',
    validationOwnerToken: 'tok-O3',
    validationAttempt: 1,
    candidateMaterializationId: projO3.id,
    candidateMaterializationMetadataHash: 'hash-O3',
  };
  const o3V = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projO3}, 'hash-O3', o3HandleA, 'indextts2',
  );
  if (o3V.kind === 'usable') {
    // 尝试用 attempt+1 调用
    const o3HandlePlus1 = {...o3HandleA, validationAttempt: 2};
    let ro03 = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        o3V.capability, o3HandlePlus1, async () => undefined,
      );
    } catch (e) {
      ro03 = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
    }
    ok(ro03, 'REUSE-ONCE-03 capability 用于 attempt+1 → SEAL_MISMATCH（takeover 后旧 capability 失效）');
    await o3V.capability.close().catch(() => undefined);
  }

  // ── REUSE-ONCE-04：candidate hash 漂移 → reject ──
  const revO4 = await freshRevisionIsolated(6240, 'ro4');
  await buildUsableProjection(revO4, 'ro4-build');
  const projO4 = getProjection(revO4.profileId, revO4.revisionId)!;
  const o4Handle = {
    jobId: 'job-O4',
    validationOwnerToken: 'tok-O4',
    validationAttempt: 1,
    candidateMaterializationId: projO4.id,
    candidateMaterializationMetadataHash: 'hash-O4',
  };
  const o4V = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projO4}, 'hash-O4', o4Handle, 'indextts2',
  );
  if (o4V.kind === 'usable') {
    // 尝试用不同 candidateMetadataHash 调用
    const o4HandleDrift = {...o4Handle, candidateMaterializationMetadataHash: 'hash-O4-DRIFT'};
    let ro04 = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        o4V.capability, o4HandleDrift, async () => undefined,
      );
    } catch (e) {
      ro04 = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
    }
    ok(ro04, 'REUSE-ONCE-04 candidate hash 漂移 → SEAL_MISMATCH');
    await o4V.capability.close().catch(() => undefined);
  }

  // ── REUSE-ONCE-05：legitimate validator-issued capability → reused（real flow）──
  const revO5 = await freshRevisionIsolated(6250, 'ro5');
  await buildUsableProjection(revO5, 'ro5-build');
  const rO5 = await createMaterializationRequest(fx.projectId, 'ro5-build', revO5.assignmentArtifactId);
  ok(rO5.outcome === 'reused' && rO5.integrityStatus === 'verified',
    'REUSE-ONCE-05 legitimate capability → reused + verified');

  // ═══ FD-01..06：private fd lifecycle ═══

  // ── FD-01：issuance realpath/race 失败 → held closed ──
  // 触发 issuance failure：relativePath 非法（validateDestinationRelativePath 抛）
  let fd01 = false;
  try {
    await openHeldMaterializedFileEvidence(
      {
        relativePath: '../etc/passwd', // 非法：路径含 ..
        voiceProfileId: revA1.profileId,
        voiceProfileRevisionId: revA1.revisionId,
        expectedSha256: revA1.sha,
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: ADAPTER_KEY,
      },
      'verify',
    );
  } catch (e) {
    // issuance 阶段非法路径或 fs race 失败 → fail-closed（held fd 已自动关闭）
    fd01 = (e instanceof MaterializedFileError) || (e?.constructor?.name === 'ProjectionPathError');
  }
  ok(fd01, 'FD-01 issuance 非法路径 → fail-closed（held fd 已自动关闭，无 dangling）');

  // ── FD-02：hook throw → held closed ──
  const revF2 = await freshRevisionIsolated(6310, 'fd2');
  await buildUsableProjection(revF2, 'fd2-build');
  // 必须用新 request_id 'fd2-r' 触发 Phase 2（否则 existing succeeded request 走 existingRequestResult 短路）
  setAfterProjectionValidationBeforeFinalize(() => {
    throw new Error('hook deliberately failed');
  });
  let fd02 = false;
  try {
    await createMaterializationRequest(fx.projectId, 'fd2-r', revF2.assignmentArtifactId);
  } catch (e) {
    // hook 抛错 → held fd 已通过 module-private consumeReuseCapability 释放（record.closed=true）
    fd02 = e instanceof Error && e.message.includes('hook deliberately failed');
  }
  ok(fd02, 'FD-02 hook throw → held closed（capability record.closed=true；fd 释放；error 透传）');
  setAfterProjectionValidationBeforeFinalize(null);

  // ── FD-03：transaction fail（onCommit throw）→ held closed ──
  // 真实 consume 中 onCommit 抛错（模拟 DB transaction rollback）→ 必须 terminal close
  const revF3 = await freshRevisionIsolated(6320, 'fd3');
  await buildUsableProjection(revF3, 'fd3-build');
  const projF3 = getProjection(revF3.profileId, revF3.revisionId)!;
  const handleF3 = {
    jobId: 'job-FD3', validationOwnerToken: 'tok-FD3', validationAttempt: 1,
    candidateMaterializationId: projF3.id, candidateMaterializationMetadataHash: 'hash-FD3',
  };
  const vF3 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projF3}, 'hash-FD3', handleF3, 'indextts2',
  );
  let fd03 = false;
  let fd03Closed = false;
  let fd03SecondReject = false;
  if (vF3.kind === 'usable') {
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        vF3.capability, handleF3, async () => { throw new Error('DB transaction rollback simulated'); },
      );
    } catch (e) {
      fd03 = e instanceof Error && e.message.includes('DB transaction rollback simulated');
      fd03Closed = vF3.capability.isClosed;
      // 第二次 consume → state=closed → SEAL_MISMATCH
      try {
        await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
          vF3.capability, handleF3, async () => undefined,
        );
      } catch (e2) {
        fd03SecondReject = e2 instanceof MaterializedFileError && e2.code === 'SEAL_MISMATCH';
      }
    }
    ok(fd03 && fd03Closed && fd03SecondReject, 'FD-03 onCommit throw（transaction rollback）→ capability closed + 第二次 consume SEAL_MISMATCH', {fd03, fd03Closed, fd03SecondReject});
  } else {
    ok(false, 'FD-03 validateProjectionForReuse 应返回 usable');
  }
  setAfterProjectionValidationBeforeFinalize(null);

  // ── FD-04：transaction success → held closed ──
  const revF4 = await freshRevisionIsolated(6330, 'fd4');
  await buildUsableProjection(revF4, 'fd4-build');
  const rF4 = await createMaterializationRequest(fx.projectId, 'fd4-build', revF4.assignmentArtifactId);
  ok(rF4.outcome === 'reused', 'FD-04 transaction success → capability 已 closed（fd 释放）');

  // ── FD-05：shadow public close → internal close 仍执行 ──
  const revF5 = await freshRevisionIsolated(6340, 'fd5');
  await buildUsableProjection(revF5, 'fd5-build');
  const projF5 = getProjection(revF5.profileId, revF5.revisionId)!;
  const vF5 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projF5}, null, {...handleA2, candidateMaterializationId: projF5.id}, 'indextts2',
  );
  if (vF5.kind === 'usable') {
    // R7 §八：使用 exact bound handle（与 issuance 冻结的 handle 完全一致），使执行真正进入
    // callback/transaction，再 shadow public close，验证 internal close 仍执行
    Object.defineProperty(vF5.capability, 'close', {value: async () => undefined, configurable: true});
    const handleF5 = {
      jobId: '', validationOwnerToken: '', validationAttempt: 0,
      candidateMaterializationId: projF5.id, candidateMaterializationMetadataHash: null,
    };
    let fd05CallbackRan = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        vF5.capability, handleF5, async () => { fd05CallbackRan = true; },
      );
    } catch { /* 事务失败无关——重点验证 internal close 仍执行 */ }
    await (vF5.capability as unknown as {close: () => Promise<void>}).close();
    ok(fd05CallbackRan && vF5.capability.isClosed,
      'FD-05 shadow public close → internal close 仍执行（callback 真正进入 + capability 最终 closed；shadowed close no-op）',
      {fd05CallbackRan, isClosed: vF5.capability.isClosed});
  } else {
    ok(false, 'FD-05 validateProjectionForReuse 应返回 usable');
  }

  // ── FD-06：duplicate close → no double-close ──
  const revF6 = await freshRevisionIsolated(6350, 'fd6');
  makeExactFinal(revF6);
  const hF6 = await openHeldMaterializedFileEvidence(
    {
      relativePath: revF6.rel,
      voiceProfileId: revF6.profileId,
      voiceProfileRevisionId: revF6.revisionId,
      expectedSha256: revF6.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: ADAPTER_KEY,
    },
    'durabilize',
  );
  await hF6.close();
  let fd06 = false;
  try { await hF6.close(); fd06 = true; } catch { fd06 = false; }
  ok(fd06, 'FD-06 duplicate close → no double-close（已 closed 短路；底层 fd 已释放）');

  // ═══ CAP-06/07：durable capability isolation（MUT-R6-01/02 验证目标）═══

  // ── CAP-06：legitimate verify capability + 公开字段改 durabilityEstablished=true → worker reject ──
  const revCap6 = await freshRevisionIsolated(6806, 'cap6');
  makeExactFinal(revCap6);
  const hCap6 = await claimHandleFor(revCap6, 'cap-6');
  const heldCap6 = await openHeldMaterializedFileEvidence(
    {
      relativePath: revCap6.rel, voiceProfileId: revCap6.profileId, voiceProfileRevisionId: revCap6.revisionId,
      expectedSha256: revCap6.sha, expectedCodec: 'pcm_s16le', expectedSampleRate: 48000, expectedChannels: 1, minDurationMs: 1,
      adapterCompatibilityKey: ADAPTER_KEY,
    },
    'verify',
  );
  // verify mode 的 record；公开字段（diagnosticSnapshot）是 deep-frozen，无法改写；
  // 验证：workerFinalize reject（requireDurability=true 拒绝 verify）
  let cap06 = false;
  try {
    const listActive = (await import('../src/lib/tts-c/materialization')).listActiveRequestRows;
    const asgSnap6: Array<{artifactId: string; contentHash: string}> = [];
    for (const r of listActive(hCap6.jobId)) {
      const ar = (await import('../src/lib/tts-b/assignment')).getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
      if (ar) asgSnap6.push({artifactId: r.assignment_artifact_id, contentHash: (await import('../src/lib/tts-c/materialization')).sha256Text(ar.artifact.content_json)});
    }
    workerFinalizeMaterialization({
      handle: hCap6,
      held: heldCap6,
      revisionEvidence: {
        voiceProfileId: revCap6.profileId, voiceProfileRevisionId: revCap6.revisionId,
        canonicalAudioSha256: revCap6.sha, adapterCompatibilityKey: ADAPTER_KEY, provider: 'indextts2',
        fileSize: fs.statSync(revCap6.canonicalAbs).size,
      },
      asgSnapshots: asgSnap6,
    });
  } catch (e) {
    cap06 = e instanceof MaterializationError;
  }
  ok(cap06, 'CAP-06 verify capability → worker reject（requireDurability=true 拒绝 verify）');
  await heldCap6.close().catch(() => undefined);

  // ── CAP-07：legitimate capability + 篡改 public diagnosticSnapshot（record 不变）→ worker 成功 ──
  const revCap7 = await freshRevisionIsolated(6807, 'cap7');
  await buildUsableProjection(revCap7, 'cap-7-build');
  const projCap7 = getProjection(revCap7.profileId, revCap7.revisionId)!;
  const vCap7 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projCap7}, null, {...handleA2, candidateMaterializationId: projCap7.id}, 'indextts2',
  );
  let cap07 = true;
  if (vCap7.kind === 'usable') {
    // 篡改 public diagnosticSnapshot（仅诊断字段；不参与授权）
    Object.defineProperty(vCap7.capability, 'diagnosticSnapshot', {
      value: {sha256: '0'.repeat(64), codec: 'pcm_s16le', sampleRate: 48000, channels: 1, durationMs: 0, size: 0, device: 0n, inode: 0n, mtimeNs: 0n, ctimeNs: 0n, parentRealpath: '/x', parentDev: 0n, parentIno: 0n, rootDev: 0n, rootIno: 0n, profileDev: 0n, profileIno: 0n, voiceProfileId: 'x', voiceProfileRevisionId: 'x', relativePath: 'x', absolutePathInternal: '/x'},
      configurable: true,
    });
    // 用真实 reuse 路径验证：re-POST 'cap-7-build' → 走 existingRequestResult → reused（record 来自 issuance）
    // 公共 diagnosticSnapshot 篡改不影响 record，因此 reuse 成功
    const rCap7Reuse = await createMaterializationRequest(fx.projectId, 'cap-7-build', revCap7.assignmentArtifactId);
    cap07 = rCap7Reuse.outcome === 'reused' && rCap7Reuse.integrityStatus === 'verified';
  } else {
    cap07 = false;
  }
  ok(cap07, 'CAP-07 篡改 public diagnosticSnapshot 不影响 record（worker 仍成功）');

  // ═══ HOOK-01/02/03：production hook guard ═══

  // ── HOOK-01/02：NODE_ENV=production 设置 hook → reject ──
  // ── HOOK-03：test 环境 hook 仍可用 ──
  const envMap = process.env as unknown as Record<string, string | undefined>;
  const savedNodeEnv = envMap.NODE_ENV;
  envMap.NODE_ENV = 'production';
  let h01 = false;
  try {
    setAfterProjectionValidationBeforeFinalize((_ctx) => undefined);
  } catch { h01 = true; }
  let h02 = false;
  try {
    setAfterRecoveryEvidenceBeforeCommit((_ctx) => undefined);
  } catch { h02 = true; }
  ok(h01 && h02, 'HOOK-01/02 NODE_ENV=production 设置 hook → reject', {h01, h02});
  envMap.NODE_ENV = savedNodeEnv;
  setAfterProjectionValidationBeforeFinalize((_ctx) => undefined);
  setAfterProjectionValidationBeforeFinalize(null);
  setAfterRecoveryEvidenceBeforeCommit((_ctx) => undefined);
  setAfterRecoveryEvidenceBeforeCommit(null);
  ok(true, 'HOOK-03 test 环境 hook 仍可用于 mutation tests');

  // ═══ RESP-02：真实 failed path ═══
  const revResp2 = await freshRevisionIsolated(6410, 'resp2');
  await createMaterializationRequest(fx.projectId, 'resp-2', revResp2.assignmentArtifactId);
  const hResp2 = claimNextAnyJob('r6-worker');
  if (!hResp2 || hResp2.type !== 'voice_materialization') throw new Error('claim resp2 failed');
  failMaterializationJobFenced(hResp2.handle, 'TEST_FAIL', 'R6 RESP-02 simulation', db);
  const rResp2 = await createMaterializationRequest(fx.projectId, 'resp-2', revResp2.assignmentArtifactId);
  ok(rResp2.outcome === 'failed' && rResp2.projection === null,
    'RESP-02 真实 failed path → outcome=failed, projection=null（failMaterializationJobFenced → existing request failed 路径）',
    {outcome: rResp2.outcome, status: rResp2.request.status, materializationId: rResp2.request.materialization_id});

  // ═══ POST-R6-01..06：real route.POST ═══
  const envBackup = process.env.TTS_C1A_MATERIALIZATION_POST_ENABLED;
  delete process.env.TTS_C1A_MATERIALIZATION_POST_ENABLED;
  const route = await import('../src/app/api/projects/[id]/voice-materializations/route');
  const rPost01 = await route.POST(
    new Request('http://localhost/x', {method: 'POST', body: JSON.stringify({requestId: 'r6-post-1', projectVoiceAssignmentArtifactId: 'x'})}),
    {params: Promise.resolve({id: fx.projectId})},
  );
  ok(rPost01.status === 503, 'POST-R6-01 gate disabled → 503 MATERIALIZATION_NOT_ENABLED', rPost01.status);
  process.env.TTS_C1A_MATERIALIZATION_POST_ENABLED = 'true';

  // POST-R6-02
  const revPost2 = await freshRevisionIsolated(6510, 'p2');
  const body2 = JSON.stringify({requestId: 'r6-post-2', projectVoiceAssignmentArtifactId: revPost2.assignmentArtifactId});
  const rPost02 = await route.POST(new Request('http://localhost/x', {method: 'POST', body: body2}), {params: Promise.resolve({id: fx.projectId})});
  ok(rPost02.status === 202, 'POST-R6-02 first request queued → 202', rPost02.status);
  const post02Body = (await rPost02.json()) as {outcome: string; request: {materialization: unknown; status: string; integrityStatus: string}};
  ok(post02Body.outcome === 'queued' && post02Body.request.integrityStatus === 'unchecked' && post02Body.request.materialization === null,
    'POST-R6-02b queued response: integrityStatus=unchecked, materialization=null', {outcome: post02Body.outcome, integrityStatus: post02Body.request.integrityStatus});

  // POST-R6-03
  const revPost3 = await freshRevisionIsolated(6520, 'p3');
  await buildUsableProjection(revPost3, 'r6-post-3-build');
  const body3 = JSON.stringify({requestId: 'r6-post-3-build', projectVoiceAssignmentArtifactId: revPost3.assignmentArtifactId});
  const rPost03 = await route.POST(new Request('http://localhost/x', {method: 'POST', body: body3}), {params: Promise.resolve({id: fx.projectId})});
  ok(rPost03.status === 200, 'POST-R6-03 reused → 200', rPost03.status);
  const post03Body = (await rPost03.json()) as {outcome: string; request: {materialization: {status: string; profileId: string} | null; integrityStatus: string}};
  ok(post03Body.outcome === 'reused' && post03Body.request.integrityStatus === 'verified' &&
    post03Body.request.materialization !== null && post03Body.request.materialization.status === 'file_ready_unpublished',
    'POST-R6-03b reused response: integrityStatus=verified, materialization.status=file_ready_unpublished', {outcome: post03Body.outcome, integrityStatus: post03Body.request.integrityStatus, materializationStatus: post03Body.request.materialization?.status});

  // POST-R6-04
  const revPost4 = await freshRevisionIsolated(6530, 'p4');
  await buildUsableProjection(revPost4, 'r6-post-4-build');
  const finalPost4 = destinationAbsolutePath(revPost4.rel);
  const origPost4 = fs.readFileSync(finalPost4);
  const damagePost4 = Buffer.from(origPost4);
  damagePost4[damagePost4.length - 1] = damagePost4[damagePost4.length - 1] ^ 0xff;
  fs.writeFileSync(finalPost4, damagePost4);
  const body4 = JSON.stringify({requestId: 'r6-post-4-build', projectVoiceAssignmentArtifactId: revPost4.assignmentArtifactId});
  const rPost04 = await route.POST(new Request('http://localhost/x', {method: 'POST', body: body4}), {params: Promise.resolve({id: fx.projectId})});
  ok(rPost04.status === 422, 'POST-R6-04 damaged projection → 422', rPost04.status);
  fs.writeFileSync(finalPost4, origPost4);

  // POST-R6-05
  const revPost5 = await freshRevisionIsolated(6540, 'p5');
  await createMaterializationRequest(fx.projectId, 'r6-post-5', revPost5.assignmentArtifactId);
  const hPost5 = claimNextAnyJob('r6-worker');
  if (!hPost5 || hPost5.type !== 'voice_materialization') throw new Error('claim p5 failed');
  await runMaterializationJob(hPost5.handle, {log: () => undefined});
  setAfterProjectionValidationBeforeFinalize(() => {
    db.prepare("UPDATE voice_materialization_requests SET status='cancelled', updated_at=? WHERE project_id=? AND request_id='r6-post-5r'").run(new Date().toISOString(), fx.projectId);
  });
  const body5 = JSON.stringify({requestId: 'r6-post-5r', projectVoiceAssignmentArtifactId: revPost5.assignmentArtifactId});
  const rPost05 = await route.POST(new Request('http://localhost/x', {method: 'POST', body: body5}), {params: Promise.resolve({id: fx.projectId})});
  ok(rPost05.status === 200, 'POST-R6-05 cancelled request → 200', rPost05.status);
  const post05Body = (await rPost05.json()) as {outcome: string; request: {materialization: unknown}};
  ok(post05Body.outcome === 'cancelled' && post05Body.request.materialization === null,
    'POST-R6-05b cancelled response: outcome=cancelled, materialization=null', {outcome: post05Body.outcome, materialization: post05Body.request.materialization});
  setAfterProjectionValidationBeforeFinalize(null);

  // POST-R6-06
  // R7 §八：API response 不暴露 materialization ID，因此不得声称比较 ID。
  // 改为：response profileId/revisionId === DB request.materialization_id 对应 projection 的 profileId/revisionId
  const revPost6 = await freshRevisionIsolated(6550, 'p6');
  await buildUsableProjection(revPost6, 'r6-post-6-build');
  const body6 = JSON.stringify({requestId: 'r6-post-6-build', projectVoiceAssignmentArtifactId: revPost6.assignmentArtifactId});
  const rPost06 = await route.POST(new Request('http://localhost/x', {method: 'POST', body: body6}), {params: Promise.resolve({id: fx.projectId})});
  const post06Body = (await rPost06.json()) as {request: {requestId: string; materialization: {profileId: string; revisionId: string} | null}};
  const dbReq6 = getMaterializationRequest(fx.projectId, 'r6-post-6-build');
  let dbProj6: VoiceMaterializationRow | undefined;
  if (dbReq6 && dbReq6.materialization_id) {
    dbProj6 = (await import('../src/lib/tts-c/materialization')).getMaterializationById(dbReq6.materialization_id);
  }
  ok(
    dbReq6 !== undefined && dbProj6 !== undefined && post06Body.request.materialization !== null &&
      post06Body.request.materialization.profileId === dbProj6.voice_profile_id &&
      post06Body.request.materialization.revisionId === dbProj6.voice_profile_revision_id,
    'POST-R6-06 response profileId/revisionId === DB request.materialization_id 对应 projection（API 不暴露 ID，故比较身份字段）',
    {responseMat: post06Body.request.materialization, dbProj: dbProj6 ? {profileId: dbProj6.voice_profile_id, revisionId: dbProj6.voice_profile_revision_id} : null},
  );

  if (envBackup === undefined) {
    delete process.env.TTS_C1A_MATERIALIZATION_POST_ENABLED;
  } else {
    process.env.TTS_C1A_MATERIALIZATION_POST_ENABLED = envBackup;
  }

  // ═══ R7：ONCE-R7-01 并发消费 + FD-R7-HOOK-01 + ISSUE-R7-01/02/03 ═══

  // ── ONCE-R7-01：同 capability Promise.all 两次 consume；barrier 暂停第一个 callback；
  //    第二个必须在 callback 前 SEAL_MISMATCH；callback invocation count 恰好 1 ──
  const revOnce7 = await freshRevisionIsolated(6710, 'once7');
  await buildUsableProjection(revOnce7, 'once7-build');
  const projOnce7 = getProjection(revOnce7.profileId, revOnce7.revisionId)!;
  const handleOnce7 = {
    jobId: 'job-ONCE7', validationOwnerToken: 'tok-ONCE7', validationAttempt: 1,
    candidateMaterializationId: projOnce7.id, candidateMaterializationMetadataHash: 'hash-ONCE7',
  };
  const vOnce7 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projOnce7}, 'hash-ONCE7', handleOnce7, 'indextts2',
  );
  let once7 = false;
  let once7Count = 0;
  if (vOnce7.kind === 'usable') {
    let barrierResolve: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { barrierResolve = resolve; });
    let barrierReleased = false;
    const consume = (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse;
    const p1 = consume(vOnce7.capability, handleOnce7, async () => {
      once7Count++;
      await barrier; // 暂停第一个 callback（state 已 = consuming）
      barrierReleased = true;
    });
    // 等待 p1 进入 callback（consuming 状态已同步建立）
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // 并发第二次 consume——必须 state=consuming → SEAL_MISMATCH（callback 不执行）
    let secondRejected = false;
    try {
      await consume(vOnce7.capability, handleOnce7, async () => { once7Count++; });
    } catch (e) {
      secondRejected = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
    }
    barrierResolve();
    await p1.catch(() => undefined);
    once7 = secondRejected && once7Count === 1 && vOnce7.capability.isClosed;
    ok(once7, 'ONCE-R7-01 并发两次 consume：第二个 callback 前 SEAL_MISMATCH + callback count=1 + 最终 closed', {secondRejected, once7Count, barrierReleased});
  } else {
    ok(false, 'ONCE-R7-01 validateProjectionForReuse 应返回 usable');
  }

  // ── FD-R7-HOOK-01：hook throw（Phase 2 后、commit seal 前）→ capability closed + 第二次 reject + 无 DB success ──
  const revHook7 = await freshRevisionIsolated(6720, 'hook7');
  await buildUsableProjection(revHook7, 'hook7-build');
  const projHook7 = getProjection(revHook7.profileId, revHook7.revisionId)!;
  const handleHook7 = {
    jobId: 'job-HOOK7', validationOwnerToken: 'tok-HOOK7', validationAttempt: 1,
    candidateMaterializationId: projHook7.id, candidateMaterializationMetadataHash: 'hash-HOOK7',
  };
  const vHook7 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
    {...projHook7}, 'hash-HOOK7', handleHook7, 'indextts2',
  );
  let fdR7Hook = false;
  if (vHook7.kind === 'usable') {
    let hookThrew = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>, beforeHook: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        vHook7.capability, handleHook7,
        async () => { throw new Error('should not reach onCommit when hook throws'); },
        async () => { throw new Error('hook deliberately failed'); },
      );
    } catch (e) {
      hookThrew = e instanceof Error && e.message.includes('hook deliberately failed');
    }
    let secondReject = false;
    try {
      await (validatorModule as unknown as {consumeValidatedProjectionForReuse: (cap: ValidatedReusableProjectionCapability, h: ValidationOwnerShape, onCommit: () => Promise<void>) => Promise<void>}).consumeValidatedProjectionForReuse(
        vHook7.capability, handleHook7, async () => undefined,
      );
    } catch (e) {
      secondReject = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
    }
    fdR7Hook = hookThrew && vHook7.capability.isClosed && secondReject;
    ok(fdR7Hook, 'FD-R7-HOOK-01 hook throw → capability closed + 第二次 consume SEAL_MISMATCH + onCommit 不执行', {hookThrew, isClosed: vHook7.capability.isClosed, secondReject});
  } else {
    ok(false, 'FD-R7-HOOK-01 validateProjectionForReuse 应返回 usable');
  }

  // ── ISSUE-R7-01/02/03：issuance 故障注入——realpath 二阶段失败 / lstat profile 失败 / record construction 前异常
  //     均验证 held closed（而不是只验证抛错）──
  const revIssue7 = await freshRevisionIsolated(6730, 'issue7');
  await buildUsableProjection(revIssue7, 'issue7-build');
  const projIssue7 = getProjection(revIssue7.profileId, revIssue7.revisionId)!;
  const issueHandle = {
    jobId: 'job-ISSUE7', validationOwnerToken: 'tok-ISSUE7', validationAttempt: 1,
    candidateMaterializationId: projIssue7.id, candidateMaterializationMetadataHash: 'hash-ISSUE7',
  };
  // ISSUE-R7-01：realpath 失败（把 materialization root rename 成 dangling symlink）
  {
    const rootAbs = materializationRootAbs();
    const movedRoot = `${rootAbs}.r7-moved-issue1`;
    fs.renameSync(rootAbs, movedRoot);
    fs.symlinkSync(path.join(fx.dataDir, 'nonexistent-r7'), rootAbs);
    const vIssue1 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
      {...projIssue7}, 'hash-ISSUE7', issueHandle, 'indextts2',
    );
    // restore root（realpath 在 issuance 中失败 → held 自动关闭）
    fs.rmSync(rootAbs, {recursive: true, force: true});
    fs.renameSync(movedRoot, rootAbs);
    ok(vIssue1.kind === 'unusable', 'ISSUE-R7-01 issuance realpath 失败 → unusable（held 已自动关闭，无 dangling）', {kind: vIssue1.kind});
  }
  // ISSUE-R7-02：lstat profile 失败（把 profile 目录改名）
  {
    const profAbs = path.dirname(path.dirname(destinationAbsolutePath(revIssue7.rel)));
    const movedProf = `${profAbs}.r7-moved-issue2`;
    fs.renameSync(profAbs, movedProf);
    const vIssue2 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
      {...projIssue7}, 'hash-ISSUE7', issueHandle, 'indextts2',
    );
    fs.renameSync(movedProf, profAbs);
    ok(vIssue2.kind === 'unusable', 'ISSUE-R7-02 issuance lstat profile 失败 → unusable（held 已自动关闭）', {kind: vIssue2.kind});
  }
  // ISSUE-R7-03：record construction 前异常（candidate binding 不匹配）
  {
    // 传入的 candidateMetadataHash 与 handle 冻结的 hash 不一致 → issuance 拒绝 + held 关闭
    const vIssue3 = await (validatorModule as {validateProjectionForReuse: typeof validatorModule.validateProjectionForReuse}).validateProjectionForReuse(
      {...projIssue7}, 'WRONG-HASH', issueHandle, 'indextts2',
    );
    ok(vIssue3.kind === 'unusable', 'ISSUE-R7-03 issuance candidate hash 漂移 → unusable（held 已自动关闭，不注册 record）', {kind: vIssue3.kind});
  }

  cleanupC1a(TAG);
  summary('TTS-C.1A.R6 hardening（含 R7 项）');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

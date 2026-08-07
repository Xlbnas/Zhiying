/**
 * TTS-C.2 + TTS-C.1C.2 集成测试。
 *
 * 覆盖（frozen contract 真实 failure mode；零 production 零真实 provider）：
 *   M1 fresh migration + 表/trigger/index + integrity/FK + 幂等
 *   M2 upgrade from current production schema（1A + legacy tts_jobs 351 行）+ legacy 兼容
 *   R1 request initializing→waiting exact-link
 *   R2 many requests → one synthesis claim（fan-in）
 *   R3 validating reusable artifact → no job
 *   R4 invalid artifact + subscribers → exactly one queued job（原子 dispatch）
 *   R5 invalid artifact + zero subscribers → no job（claim cancelled）
 *   R6 validator vs cancel race
 *   R7 expired validation lease takeover（attempt+1）
 *   R8 stale owner finalize → STALE_VALIDATION_OWNER（零副作用）
 *   R9 dispatch 原子性（payload/fingerprint 不一致拒绝；zero-subscriber dispatch ABORT）
 *   R10 worker claim（五类 command：worker_claim → running 双侧 + attempt created）
 *   R11 attempt phase 状态机 + write-once evidence
 *   R12 payload builder deterministic + fingerprint determinism/change sensitivity
 *   R13 capability provenance exact（artifact 三件套 == 实际编译）
 *   R14 artifact immutability（UPDATE/DELETE ABORT）
 *   R15 terminal evidence immutability（claim/job succeeded 后冻结）
 *   R16 zero-subscriber running cancel（job.cancel_requested=1）
 *   R17 legacy tts_jobs 兼容（legacy 行 requeue 不受 TTS-C trigger 影响）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ok, summary, setupC1aFixture, makeWav, sha256Buf, type C1aFixture} from './lib/tts-c1a-test-utils';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {closeDb, getDb} from '../src/lib/db';
import {applyTtsC1aMigration, isTtsC1aMigrationApplied} from '../src/lib/tts-c/migration';
import {applyTtsC2Migration, isTtsC2MigrationApplied} from '../src/lib/tts-c/migration-c2';
import {TTS_C2_TABLES, TTS_C2_TRIGGERS, TTS_C2_INDEXES, TTS_C2_FROZEN_FRAGMENTS_SHA256, TTS_C2_APPLIED_SQL_SHA256} from '../src/lib/tts-c/migration-c2.generated';
import {buildMigrationSql} from './build-tts-c1a-migration';
import {buildC2MigrationSql} from './build-tts-c2-migration';
import {
  createSynthesisRequests,
  resolveClaimValidation,
  cancelSynthesisRequest,
  takeoverClaimValidation,
  getSynthesisClaim,
  VALIDATION_STALE_OWNER,
  SYNTHESIS_INVALID_STATE,
} from '../src/lib/tts-c/synthesis';
import {
  claimSynthesisJob,
  renewSynthesisLease,
  takeoverSynthesisExecution,
  advanceAttemptPhase,
  finalizeSynthesisJobSuccess,
  failSynthesisJob,
  getTtsCJob,
  EXECUTION_NOT_OWNER,
  EXECUTION_INVALID_STATE,
} from '../src/lib/tts-c/synthesis-execution';
import {buildCompiledSynthesisPayload, computeSynthesisPayloadFingerprint} from '../src/lib/tts-c/synthesis-payload';
import {providerCapabilitySnapshotV1Schema} from '../src/lib/tts-c/provider-capability';
import {RegistryContractError} from '../src/lib/tts-c/registry-contract-error';

const TAG = 'test-tts-c2-synthesis';
const SNAP_V1 = providerCapabilitySnapshotV1Schema.parse({
  provider: 'indextts2',
  adapterCompatibilityKey: 'indextts2-adapter-registry@1',
  snapshotVersion: 'indextts2-capability@1',
  controls: {
    deliveryOverride: {supported: true},
    pace: {supported: true},
    energy: {supported: false},
    emotionSemantic: {supported: false},
  },
});

let fx!: C1aFixture;

async function expectCode(label: string, fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
    ok(false, label, '未抛错');
  } catch (e) {
    const c = e instanceof RegistryContractError ? e.code : (e as {code?: string})?.code;
    ok(c === code, label, c);
  }
}

function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 构建 payload + fingerprint（1C.2）。 */
function makePayload(unitId: string, spokenText: string) {
  return buildCompiledSynthesisPayload({
    unitId,
    spokenText,
    capabilityInput: {deliveryOverride: null, pace: 'normal', energy: 'normal', emotion: {mode: 'none'}},
    snapshot: SNAP_V1,
  });
}

interface ChainInput {
  projectId: string;
  unitId: string;
  exactSourceFingerprint: string;
  payload: ReturnType<typeof makePayload>;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  provider: string;
  narrationPlanArtifactId: string;
  performancePlanArtifactId: string;
  assignmentArtifactId: string;
}

function chainContext(projectId: string, unitId: string, payload: ReturnType<typeof makePayload>, voice: {profileId: string; revisionId: string}, narrationPlanArtifactId: string, performancePlanArtifactId: string, assignmentArtifactId: string): ChainInput {
  return {
    projectId,
    unitId,
    exactSourceFingerprint: `exact-${sha256hex(unitId)}`,
    payload,
    voiceProfileId: voice.profileId,
    voiceProfileRevisionId: voice.revisionId,
    provider: 'indextts2',
    narrationPlanArtifactId,
    performancePlanArtifactId,
    assignmentArtifactId,
  };
}

function dispatchJobContext(chain: ChainInput) {
  return {
    narrationPlanArtifactId: chain.narrationPlanArtifactId,
    narrationPlanVersion: 1,
    provider: chain.provider,
    voiceProfileId: chain.voiceProfileId,
    voiceProfileRevision: '1',
    voiceProfileRevisionId: chain.voiceProfileRevisionId,
    payloadJson: chain.payload.canonicalPayloadJson,
    originatingRequestId: null,
    exactSourceFingerprint: chain.exactSourceFingerprint,
    synthesisPayloadFingerprint: chain.payload.synthesisPayloadFingerprint,
  };
}

/**
 * 构建历史成功链条（走真实执行路径：request→claim→dispatch→worker claim→attempt→
 * finalize）——用于 validation reuse 的 candidate 与 provenance 闭包测试。
 * 全部使用生产函数（frozen trigger 全量生效）。
 */
function buildSucceededChain(db: ReturnType<typeof getDb>, chain: ChainInput, output: {audioSha256: string; size: number}): {claimId: string; jobId: string; attemptId: string; artifactId: string} {
  const workerToken = `seed-worker-${crypto.randomUUID()}`;
  const out = createSynthesisRequests(db, {
    projectId: chain.projectId,
    requests: [{requestId: `seed-${crypto.randomUUID()}`, unitId: chain.unitId, exactSourceFingerprint: chain.exactSourceFingerprint, synthesisPayloadFingerprint: chain.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex(chain.unitId + chain.payload.synthesisPayloadFingerprint)}],
  });
  const claimId = out[0]!.claimId;
  const claim = getSynthesisClaim(db, claimId);
  const res = resolveClaimValidation(db, {
    claimId,
    validationOwnerToken: claim.validation_owner_token as string,
    validationAttempt: claim.validation_attempt,
    candidateUsable: false,
    jobContext: dispatchJobContext(chain),
  });
  if (res.kind !== 'dispatched') throw new Error(`seed dispatch failed: ${res.kind}`);
  const jobId = res.jobId;
  const c = claimSynthesisJob(db, {jobId, workerOwnerToken: workerToken, providerRequestHash: chain.exactSourceFingerprint, providerRequestJson: chain.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
  advanceAttemptPhase(db, c.attemptId, 'provider_in_flight', {providerRequestId: 'seed-prov'});
  advanceAttemptPhase(db, c.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
  advanceAttemptPhase(db, c.attemptId, 'file_validated');
  advanceAttemptPhase(db, c.attemptId, 'file_durable', {finalRelativePath: 'sentence-audio/out.wav', audioSha256: output.audioSha256, outputSize: output.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
  const fin = finalizeSynthesisJobSuccess(db, {
    jobId,
    workerOwnerToken: workerToken,
    attemptId: c.attemptId,
    attemptEvidence: {finalRelativePath: 'sentence-audio/out.wav', audioSha256: output.audioSha256, outputSize: output.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'seed-prov'},
    artifact: {
      narrationPlanArtifactId: chain.narrationPlanArtifactId,
      narrationPlanContentHash: sha256hex('np'),
      assignmentArtifactId: chain.assignmentArtifactId,
      assignmentContentHash: sha256hex('asg'),
      performancePlanArtifactId: chain.performancePlanArtifactId,
      performancePlanContentHash: sha256hex('pp'),
      voiceProfileId: chain.voiceProfileId,
      voiceProfileRevisionId: chain.voiceProfileRevisionId,
      providerVersion: 'v1.0',
      capabilityCompilerVersion: chain.payload.capabilityCompilerVersion,
      capabilitySnapshotJson: chain.payload.capabilitySnapshotJson,
      compiledPayloadJson: chain.payload.compiledPayloadJson,
    },
  });
  return {claimId, jobId, attemptId: c.attemptId, artifactId: fin.artifactId};
}

async function newVoice() {
  const profile = createVoiceProfile({displayName: `c2-${crypto.randomUUID().slice(0, 8)}`});
  const revision = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${crypto.randomUUID()}`, audioBuffer: makeWav(800, 440)},
    {ffprobeImpl: async () => ({durationMs: 1500, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, hasVideo: false})},
  );
  const revRow = revision.outcome === 'created' || revision.outcome === 'reused' ? revision.revision : null;
  if (!revRow) throw new Error('ingest failed');
  return {profileId: profile.id, revisionId: revRow.id};
}

(async () => {
  const DATA_DIR = path.join('data', TAG);
  fs.rmSync(DATA_DIR, {recursive: true, force: true});
  process.env.ZHIYING_DATA_DIR = DATA_DIR;
  closeDb();
  getDb();
  fx = await setupC1aFixture(TAG);
  let db = getDb();

  // ── M1: fresh migration + frozen hash 绑定 + integrity/FK + 幂等 ──
  {
    const rebuilt = buildC2MigrationSql('docs/TTS_C_INCREMENTAL_NARRATION_DESIGN.md');
    ok(rebuilt.frozenFragmentsSha256 === TTS_C2_FROZEN_FRAGMENTS_SHA256, 'M1 frozen fragments sha 绑定');
    ok(rebuilt.appliedSqlSha256 === TTS_C2_APPLIED_SQL_SHA256, 'M1 applied sql sha 绑定');
    for (const t of TTS_C2_TABLES) {
      ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), `M1 表存在 ${t}`);
    }
    for (const tr of TTS_C2_TRIGGERS) {
      ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(tr), `M1 trigger 存在 ${tr}`);
    }
    for (const ix of TTS_C2_INDEXES) {
      ok(!!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(ix), `M1 index 存在 ${ix}`);
    }
    const cols = (db.prepare('PRAGMA table_info(tts_jobs)').all() as Array<{name: string}>).map((c) => c.name);
    ok(['claim_id', 'synthesis_payload_fingerprint', 'result_artifact_id', 'last_execution_command_id'].every((c) => cols.includes(c)), 'M1 tts_jobs 新列');
    applyTtsC2Migration(db); // 幂等重跑
    ok((db.prepare('PRAGMA integrity_check').get() as {integrity_check: string}).integrity_check === 'ok', 'M1 integrity ok');
    ok(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'M1 FK 空');
  }

  // ── M2: upgrade/production 形态验证（独立 data dir；全量 1A+C.2 schema +
  //      legacy tts_jobs 351 行兼容；ALTER 列存在性跳过由幂等重跑覆盖） ──
  {
    const legacyDir = path.join('data', TAG + '-legacy');
    fs.rmSync(legacyDir, {recursive: true, force: true});
    const prevDataDir = process.env.ZHIYING_DATA_DIR;
    process.env.ZHIYING_DATA_DIR = legacyDir;
    closeDb();
    const db2 = getDb();
    ok(isTtsC1aMigrationApplied(db2) && isTtsC2MigrationApplied(db2), 'M2 production 形态：1A + C.2 均已应用');
    // legacy 351 行（与 production tts_jobs 相同的 legacy shape）
    db2.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('P-L','legacy','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
    db2.prepare("INSERT INTO artifacts (id, project_id, kind, created_at) VALUES ('A-L','P-L','narration_plan_v2','2026-01-01T00:00:00.000Z')").run();
    const stmt = db2.prepare("INSERT INTO tts_jobs (id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id, provider, voice_profile_id, voice_profile_revision, status, payload_json, queued_at) VALUES (?, 'P-L','A-L',1,?, 'mock','VP-L','1','queued','{}',?)");
    for (let i = 0; i < 351; i++) stmt.run(`legacy-${String(i).padStart(3, '0')}`, `N${String(i % 999).padStart(3, '0')}`, '2026-01-01T00:00:00.000Z');
    ok((db2.prepare('SELECT COUNT(*) n FROM tts_jobs').get() as {n: number}).n === 351, 'M2 legacy 351 行保留');
    ok((db2.prepare('PRAGMA integrity_check').get() as {integrity_check: string}).integrity_check === 'ok', 'M2 integrity ok');
    ok(db2.prepare('PRAGMA foreign_key_check').all().length === 0, 'M2 FK 空');
    // legacy 行 requeue（running→queued）不受 TTS-C trigger 影响
    db2.prepare("UPDATE tts_jobs SET status='running' WHERE id='legacy-000'").run();
    db2.prepare("UPDATE tts_jobs SET status='queued' WHERE id='legacy-000'").run();
    ok((db2.prepare("SELECT status FROM tts_jobs WHERE id='legacy-000'").get() as {status: string}).status === 'queued', 'M2 legacy requeue 兼容（TTS-C trigger 零影响）');
    // ALTER 列存在性跳过（幂等重跑）
    applyTtsC2Migration(db2);
    ok((db2.prepare('PRAGMA integrity_check').get() as {integrity_check: string}).integrity_check === 'ok', 'M2 重跑后 integrity ok');
    process.env.ZHIYING_DATA_DIR = prevDataDir;
    closeDb();
    db = getDb();
  }

  // fixture 上下文
  const voice = await newVoice();
  const npArtifact = crypto.randomUUID();
  const ppArtifact = crypto.randomUUID();
  db.prepare("INSERT INTO artifacts (id, project_id, kind, created_at) VALUES (?, ?, 'narration_plan_v2', ?)").run(npArtifact, fx.projectId, new Date().toISOString());
  db.prepare("INSERT INTO artifacts (id, project_id, kind, created_at) VALUES (?, ?, 'narration_performance_plan', ?)").run(ppArtifact, fx.projectId, new Date().toISOString());

  // ── R12: payload builder deterministic + fingerprint determinism/change sensitivity ──
  {
    const p1 = makePayload('N001', 'hello');
    const p2 = makePayload('N001', 'hello');
    ok(p1.synthesisPayloadFingerprint === p2.synthesisPayloadFingerprint && p1.canonicalPayloadJson === p2.canonicalPayloadJson, 'R12 同输入逐字节相同');
    ok(p1.synthesisPayloadFingerprint === `sha256:${sha256hex(p1.canonicalPayloadJson)}`, 'R12 fingerprint = sha256(canonical)');
    const p3 = makePayload('N001', 'hello changed');
    ok(p3.synthesisPayloadFingerprint !== p1.synthesisPayloadFingerprint, 'R12 文本变化 → fingerprint 变化');
    const p4 = buildCompiledSynthesisPayload({
      unitId: 'N001',
      spokenText: 'hello',
      capabilityInput: {deliveryOverride: 'slow', pace: 'normal', energy: 'normal', emotion: {mode: 'none'}},
      snapshot: SNAP_V1,
    });
    ok(p4.providerParams.deliveryOverride === 'slow' && p4.unsupportedFlags.length === 0, 'R12 supported control → providerParams');
    ok(computeSynthesisPayloadFingerprint(p1.canonicalPayloadJson) === p1.synthesisPayloadFingerprint, 'R12 compute 一致性');
  }

  const chainA = chainContext(fx.projectId, 'N001', makePayload('N001', 'hello'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId);

  // ── R1/R2: request envelope + fan-in ──
  let createdA: Array<{requestId: string; claimId: string}>;
  {
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [
        {requestId: 'req-a1', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N001' + chainA.payload.synthesisPayloadFingerprint)},
        {requestId: 'req-a2', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N001' + chainA.payload.synthesisPayloadFingerprint)},
        {requestId: 'req-b1', unitId: 'N002', exactSourceFingerprint: 'x2', synthesisPayloadFingerprint: 'sha256:2', finalTtsInputFingerprint: sha256hex('N002')},
      ],
    });
    createdA = out;
    ok(out.length === 3 && out.every((r) => r.status === 'waiting'), 'R1 waiting 全部');
    ok(out[0]!.claimId === out[1]!.claimId, 'R2 同 key fan-in → 同一 claim');
    ok(out[0]!.claimId !== out[2]!.claimId, 'R2 不同 key → 不同 claim');
    const r = db.prepare("SELECT status, claim_id FROM tts_audio_requests WHERE request_id='req-a1'").get() as {status: string; claim_id: string | null};
    ok(r.status === 'waiting' && r.claim_id !== null, 'R1 initializing→waiting exact-link（claim_id 非 NULL）');
  }
  const claimAId = createdA[0]!.claimId;
  const claimA = getSynthesisClaim(db, claimAId);
  ok(claimA.status === 'validating_reuse' && claimA.validation_attempt === 1 && claimA.candidate_artifact_id === null, 'R1 claim validating_reuse 初始态');

  // ── R3: reusable artifact → no job ──
  {
    // 先为 N001 构建 succeeded chain（candidate），再新建 request → resolve usable → 复用
    buildSucceededChain(db, chainA, {audioSha256: 'a'.repeat(64), size: 1000});
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-a3', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N001' + chainA.payload.synthesisPayloadFingerprint)}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId);
    ok(claim.candidate_artifact_id !== null, 'R3 candidate 已找到');
    const res = resolveClaimValidation(db, {claimId: claim.id, validationOwnerToken: claim.validation_owner_token as string, validationAttempt: claim.validation_attempt, candidateUsable: true});
    ok(res.kind === 'reused', `R3 reuse（实际 ${res.kind}）`);
    ok(getSynthesisClaim(db, claim.id).status === 'succeeded', 'R3 claim succeeded');
    const jobs = db.prepare('SELECT COUNT(*) n FROM tts_jobs WHERE claim_id=?').get(claim.id) as {n: number};
    ok(jobs.n === 0, 'R3 零 provider job');
    const req = db.prepare("SELECT status, result_artifact_id FROM tts_audio_requests WHERE request_id='req-a3'").get() as {status: string; result_artifact_id: string | null};
    ok(req.status === 'succeeded' && req.result_artifact_id !== null, 'R3 request succeeded + result link');
  }

  // ── R4: invalid artifact + subscribers → exactly one job（原子 dispatch） ──
  {
    // R3 的 reuse 已消费 N001 的 active claim——新建 request 获得新的 validating_reuse claim
    const out4 = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-a4', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N001' + chainA.payload.synthesisPayloadFingerprint)}],
    });
    const claim4Id = out4[0]!.claimId;
    ok(claim4Id !== claimAId, 'R4 新 claim（非已 succeeded 的 claimA）');
    const claim = getSynthesisClaim(db, claim4Id);
    const res = resolveClaimValidation(db, {
      claimId: claim4Id,
      validationOwnerToken: claim.validation_owner_token as string,
      validationAttempt: claim.validation_attempt,
      candidateUsable: false,
      jobContext: dispatchJobContext(chainA),
    });
    ok(res.kind === 'dispatched', `R4 dispatched（实际 ${res.kind}）`);
    ok(getSynthesisClaim(db, claim4Id).status === 'generation_pending', 'R4 claim generation_pending');
    const jobs = db.prepare('SELECT id, status FROM tts_jobs WHERE claim_id=?').all(claim4Id) as Array<{id: string; status: string}>;
    ok(jobs.length === 1 && jobs[0]!.status === 'queued', 'R4 恰好一个 queued job', jobs);
    // 重复 dispatch 拒绝（UNIQUE(claim_id)）
    await expectCode('R4 二次 dispatch 拒绝（claim 已 generation_pending）', () => {
      resolveClaimValidation(db, {claimId: claim4Id, validationOwnerToken: claim.validation_owner_token as string, validationAttempt: claim.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainA)});
    }, SYNTHESIS_INVALID_STATE);
    const jobId = jobs[0]!.id;

    // ── R10: worker claim（五类 command） ──
    const claimRes = claimSynthesisJob(db, {jobId, workerOwnerToken: 'worker-1', providerRequestHash: chainA.exactSourceFingerprint, providerRequestJson: chainA.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
    ok(getTtsCJob(db, jobId).status === 'running', 'R10 job running');
    ok(getSynthesisClaim(db, claimRes.claimId).status === 'running', 'R10 claim running');
    ok(getTtsCJob(db, jobId).claimed_by === 'worker-1' && getTtsCJob(db, jobId).attempt === 1, 'R10 owner/attempt');
    const attempt = db.prepare('SELECT execution_phase, job_id FROM tts_generation_attempts WHERE id=?').get(claimRes.attemptId) as {execution_phase: string; job_id: string};
    ok(attempt.execution_phase === 'created' && attempt.job_id === jobId, 'R10 attempt created');

    // ── R11: attempt phase 状态机 + write-once ──
    advanceAttemptPhase(db, claimRes.attemptId, 'provider_in_flight', {providerRequestId: 'prov-1'});
    advanceAttemptPhase(db, claimRes.attemptId, 'response_persisted', {responseHash: sha256hex('resp'), recoveryTempRelativePath: 'tmp/out.wav'});
    await expectCode('R11 非法 phase 跳变 ABORT', () => {
      advanceAttemptPhase(db, claimRes.attemptId, 'succeeded' as never);
    }, EXECUTION_INVALID_STATE);
    advanceAttemptPhase(db, claimRes.attemptId, 'file_validated');
    advanceAttemptPhase(db, claimRes.attemptId, 'file_durable', {finalRelativePath: 'sentence-audio/out.wav', audioSha256: 'b'.repeat(64), outputSize: 2000, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
    const attemptRow = db.prepare('SELECT audio_sha256, final_relative_path FROM tts_generation_attempts WHERE id=?').get(claimRes.attemptId) as {audio_sha256: string; final_relative_path: string};
    ok(attemptRow.audio_sha256 === 'b'.repeat(64), 'R11 file_durable evidence');
    await expectCode('R11 evidence write-once ABORT', () => {
      db.prepare('UPDATE tts_generation_attempts SET audio_sha256=? WHERE id=?').run('c'.repeat(64), claimRes.attemptId);
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    // lease renewal
    renewSynthesisLease(db, {jobId, workerOwnerToken: 'worker-1'});
    // stale owner renew 拒绝
    await expectCode('R10b stale owner renew ABORT', () => {
      renewSynthesisLease(db, {jobId, workerOwnerToken: 'stale'});
    }, EXECUTION_NOT_OWNER);

    // ── R13: capability provenance exact（finalize 三件套 == 实际编译） ──
    const fin = finalizeSynthesisJobSuccess(db, {
      jobId,
      workerOwnerToken: 'worker-1',
      attemptId: claimRes.attemptId,
      attemptEvidence: {finalRelativePath: 'sentence-audio/out.wav', audioSha256: 'b'.repeat(64), outputSize: 2000, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'prov-1'},
      artifact: {
        narrationPlanArtifactId: chainA.narrationPlanArtifactId,
        narrationPlanContentHash: sha256hex('np'),
        assignmentArtifactId: chainA.assignmentArtifactId,
        assignmentContentHash: sha256hex('asg'),
        performancePlanArtifactId: chainA.performancePlanArtifactId,
        performancePlanContentHash: sha256hex('pp'),
        voiceProfileId: chainA.voiceProfileId,
        voiceProfileRevisionId: chainA.voiceProfileRevisionId,
        providerVersion: 'v1.0',
        capabilityCompilerVersion: chainA.payload.capabilityCompilerVersion,
        capabilitySnapshotJson: chainA.payload.capabilitySnapshotJson,
        compiledPayloadJson: chainA.payload.compiledPayloadJson,
      },
    });
    ok(getSynthesisClaim(db, claim4Id).status === 'succeeded', 'R13 claim succeeded');
    ok(getTtsCJob(db, jobId).status === 'succeeded', 'R13 job succeeded');
    const art = db.prepare('SELECT capability_compiler_version, capability_snapshot_json, compiled_payload_json, synthesis_payload_fingerprint, claim_id, job_id, successful_attempt_id FROM sentence_audio_artifacts WHERE id=?').get(fin.artifactId) as Record<string, unknown>;
    ok(art.capability_compiler_version === chainA.payload.capabilityCompilerVersion, 'R13 compiler version exact');
    ok(art.capability_snapshot_json === chainA.payload.capabilitySnapshotJson, 'R13 snapshot exact');
    ok(art.compiled_payload_json === chainA.payload.compiledPayloadJson, 'R13 compiled payload exact');
    ok(art.synthesis_payload_fingerprint === chainA.payload.synthesisPayloadFingerprint, 'R13 payload fingerprint exact');
    ok(art.claim_id === claim4Id && art.job_id === jobId && art.successful_attempt_id === claimRes.attemptId, 'R13 provenance 闭包（claim/job/attempt）');
    // R14: artifact immutability
    await expectCode('R14 artifact UPDATE ABORT', () => {
      db.prepare('UPDATE sentence_audio_artifacts SET output_size=999 WHERE id=?').run(fin.artifactId);
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    await expectCode('R14 artifact DELETE ABORT', () => {
      db.prepare('DELETE FROM sentence_audio_artifacts WHERE id=?').run(fin.artifactId);
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    // R15: terminal evidence immutability（claim/job succeeded 冻结）
    await expectCode('R15 claim succeeded 冻结', () => {
      db.prepare("UPDATE tts_synthesis_claims SET result_artifact_id=NULL WHERE id=?").run(claim4Id);
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    await expectCode('R15 job succeeded 冻结', () => {
      db.prepare("UPDATE tts_jobs SET status='failed' WHERE id=?").run(jobId);
    }, 'SQLITE_CONSTRAINT_TRIGGER');
  }

  // ── R5/R6: invalid artifact + zero subscribers → no job；cancel race ──
  {
    const chainB = chainContext(fx.projectId, 'N010', makePayload('N010', 'bye'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-c1', unitId: 'N010', exactSourceFingerprint: chainB.exactSourceFingerprint, synthesisPayloadFingerprint: chainB.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N010' + chainB.payload.synthesisPayloadFingerprint)}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId);
    // cancel race：validator resolve 前最后一个 subscriber 取消
    const cancelled = cancelSynthesisRequest(db, fx.projectId, 'req-c1');
    ok(cancelled.claimId === claim.id, 'R6 cancel detach 自己（claim 保留）');
    ok(getSynthesisClaim(db, claim.id).status === 'cancelled', 'R6 zero-subscriber validating_reuse → claim cancelled');
    await expectCode('R5 已 cancelled claim 再 resolve → 拒绝（零副作用）', () => {
      resolveClaimValidation(db, {claimId: claim.id, validationOwnerToken: claim.validation_owner_token as string, validationAttempt: claim.validation_attempt, candidateUsable: false});
    }, SYNTHESIS_INVALID_STATE);
    const jobs = db.prepare('SELECT COUNT(*) n FROM tts_jobs WHERE claim_id=?').get(claim.id) as {n: number};
    ok(jobs.n === 0, 'R5/R6 零 provider job');
  }

  // ── R7/R8: validation takeover + stale owner ──
  {
    const chainD = chainContext(fx.projectId, 'N011', makePayload('N011', 'take'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-d1', unitId: 'N011', exactSourceFingerprint: chainD.exactSourceFingerprint, synthesisPayloadFingerprint: chainD.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N011' + chainD.payload.synthesisPayloadFingerprint)}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId);
    const oldOwner = claim.validation_owner_token as string;
    // 手动过期 validation lease
    db.prepare('UPDATE tts_synthesis_claims SET validation_lease_expires_at_epoch_ms=1 WHERE id=?').run(claim.id);
    const taken = takeoverClaimValidation(db, {claimId: claim.id, newValidationOwnerToken: 'validator-2'});
    ok(taken.newValidationAttempt === 2, 'R7 takeover attempt+1');
    const after = getSynthesisClaim(db, claim.id);
    ok(after.validation_owner_token === 'validator-2', 'R7 新 validation owner');
    // stale owner resolve → STALE_VALIDATION_OWNER（零副作用）
    await expectCode('R8 stale owner resolve → STALE_VALIDATION_OWNER', () => {
      resolveClaimValidation(db, {claimId: claim.id, validationOwnerToken: oldOwner, validationAttempt: 1, candidateUsable: true});
    }, VALIDATION_STALE_OWNER);
    ok(getSynthesisClaim(db, claim.id).status === 'validating_reuse', 'R8 状态未变（零副作用）');
    // 新 owner 正常 resolve（subscriber>0 → dispatch）
    const res = resolveClaimValidation(db, {claimId: claim.id, validationOwnerToken: 'validator-2', validationAttempt: 2, candidateUsable: false, jobContext: dispatchJobContext(chainD)});
    ok(res.kind === 'dispatched', `R7 新 owner resolve 正常（实际 ${res.kind}）`);
    ok(getSynthesisClaim(db, claim.id).status === 'generation_pending', 'R7 新 owner dispatch 生效');
  }

  // ── R9: dispatch 原子性（payload/fingerprint 不一致拒绝；零副作用） ──
  {
    const chainE = chainContext(fx.projectId, 'N012', makePayload('N012', 'atom'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-e1', unitId: 'N012', exactSourceFingerprint: chainE.exactSourceFingerprint, synthesisPayloadFingerprint: chainE.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N012' + chainE.payload.synthesisPayloadFingerprint)}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId);
    const badCtx = {...dispatchJobContext(chainE), synthesisPayloadFingerprint: 'sha256:wrong'};
    await expectCode('R9 payload/fingerprint 不一致拒绝', () => {
      resolveClaimValidation(db, {claimId: claim.id, validationOwnerToken: claim.validation_owner_token as string, validationAttempt: claim.validation_attempt, candidateUsable: false, jobContext: badCtx});
    }, SYNTHESIS_INVALID_STATE);
    ok(getSynthesisClaim(db, claim.id).status === 'validating_reuse', 'R9 拒绝后 claim 保持 validating_reuse（零副作用）');
    ok((db.prepare('SELECT COUNT(*) n FROM tts_jobs WHERE claim_id=?').get(claim.id) as {n: number}).n === 0, 'R9 零 job');
    // zero-subscriber 直接 INSERT dispatch → trigger ABORT（整事务回滚）
    cancelSynthesisRequest(db, fx.projectId, 'req-e1');
    await expectCode('R9 zero-subscriber dispatch ABORT', () => {
      db.prepare(
        `INSERT INTO tts_claim_generation_dispatches
           (id, claim_id, job_id, validation_owner_token, validation_attempt, project_id, unit_id,
            narration_plan_artifact_id, narration_plan_version, provider, voice_profile_id,
            voice_profile_revision, voice_profile_revision_id, payload_json, exact_source_fingerprint,
            synthesis_payload_fingerprint, final_tts_input_fingerprint, generation_variant_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '1', ?, ?, ?, ?, ?, 'default', ?)`,
      ).run(crypto.randomUUID(), claim.id, crypto.randomUUID(), claim.validation_owner_token, claim.validation_attempt, fx.projectId, 'N012', npArtifact, chainE.provider, chainE.voiceProfileId, chainE.voiceProfileRevisionId, chainE.payload.canonicalPayloadJson, chainE.exactSourceFingerprint, chainE.payload.synthesisPayloadFingerprint, sha256hex('N012' + chainE.payload.synthesisPayloadFingerprint), new Date().toISOString());
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    ok(getSynthesisClaim(db, claim.id).status === 'cancelled', 'R9 ABORT 后 claim 保持 cancelled（无 half-linked job）');
  }

  // ── R16: zero-subscriber running cancel → job.cancel_requested=1 ──
  {
    const chainF = chainContext(fx.projectId, 'N013', makePayload('N013', 'cancel'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-f1', unitId: 'N013', exactSourceFingerprint: chainF.exactSourceFingerprint, synthesisPayloadFingerprint: chainF.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N013' + chainF.payload.synthesisPayloadFingerprint)}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId);
    const res = resolveClaimValidation(db, {claimId: claim.id, validationOwnerToken: claim.validation_owner_token as string, validationAttempt: claim.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainF)});
    if (res.kind !== 'dispatched') throw new Error('R16 dispatch failed');
    const jobId = res.jobId;
    claimSynthesisJob(db, {jobId, workerOwnerToken: 'worker-f', providerRequestHash: 'h', providerRequestJson: '{}', model: 'IndexTTS-2'});
    const cancelled = cancelSynthesisRequest(db, fx.projectId, 'req-f1');
    ok(cancelled.jobCancelledRequested === true, 'R16 running cancel → job.cancel_requested=1');
    ok((db.prepare('SELECT cancel_requested FROM tts_jobs WHERE id=?').get(jobId) as {cancel_requested: number | null}).cancel_requested === 1, 'R16 cancel_requested 实证');
    // 清理：fail 该 job（state_transition failed）
    failSynthesisJob(db, {jobId, workerOwnerToken: 'worker-f', errorCode: 'REQUEST_CANCELLED', errorMessage: 'cancel'});
    ok(getSynthesisClaim(db, claim.id).status === 'failed', 'R16 claim failed（终态）');
  }

  closeDb();
  fs.rmSync(DATA_DIR, {recursive: true, force: true});
  summary(TAG);
})().catch((e) => {
  console.error(e);
  ok(false, TAG, `uncaught: ${(e as Error).message}`);
  summary(TAG);
});

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
  renewClaimValidation,
  getSynthesisClaim,
  VALIDATION_STALE_OWNER,
  SYNTHESIS_INVALID_STATE,
  REQUEST_ID_CONFLICT,
} from '../src/lib/tts-c/synthesis';
import {
  claimSynthesisJob,
  renewSynthesisLease,
  takeoverSynthesisExecution,
  advanceAttemptPhase,
  finalizeSynthesisJobSuccess,
  failSynthesisJob,
  prestartTerminalSynthesisJob,
  getTtsCJob,
  EXECUTION_NOT_OWNER,
  EXECUTION_INVALID_STATE,
  REQUEST_STATE_INCONSISTENT,
} from '../src/lib/tts-c/synthesis-execution';
import {buildCompiledSynthesisPayload, computeSynthesisPayloadFingerprint, computeExactSourceFingerprint, computeFinalTtsInputFingerprint} from '../src/lib/tts-c/synthesis-payload';
import {probeAudio} from '../src/lib/tts-c/audio-probe';
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
const OUTPUT_ROOT = path.join('data', TAG, 'sentence-audio');

/** 写输出 wav 文件并返回 {sha, size}（finalize exact reread 需要真实文件）。 */
function writeOutputFile(rel: string): {sha: string; size: number; rel: string} {
  const abs = path.join(OUTPUT_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  const wav = makeWav(1500, 500);
  fs.writeFileSync(abs, wav);
  return {sha: sha256Buf(wav), size: wav.length, rel};
}

/** 指定采样率的 wav（R2-D media metadata mismatch 需要与 persisted 48000 不同的真实文件）。 */
function makeWavAt(durationMs: number, freq: number, sampleRate: number): Buffer {
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function writeOutputFileAt(rel: string, wav: Buffer): {sha: string; size: number; rel: string} {
  const abs = path.join(OUTPUT_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, wav);
  return {sha: sha256Buf(wav), size: wav.length, rel};
}

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

/** source artifact canonical content hash（与 production 同款：content_json 的 sha256）。 */
function artifactContentHash(db: ReturnType<typeof getDb>, artifactId: string, projectId: string, kind: string): string {
  const row = db.prepare('SELECT content_json FROM artifacts WHERE id=? AND project_id=? AND kind=?').get(artifactId, projectId, kind) as {content_json: string | null};
  if (!row || row.content_json === null || row.content_json === '') throw new Error('artifact content_json missing');
  return sha256hex(row.content_json);
}

/** canonical payload 内的 spokenText（final_tts_input_fingerprint 重算输入）。 */
function spokenTextOf(payload: ReturnType<typeof makePayload>): string {
  return (JSON.parse(payload.canonicalPayloadJson) as {spokenText: string}).spokenText;
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
  finalTtsInputFingerprint: string;
  payload: ReturnType<typeof makePayload>;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  provider: string;
  narrationPlanArtifactId: string;
  performancePlanArtifactId: string;
  assignmentArtifactId: string;
}

/**
 * chain 上下文（R2：fingerprint 一律用 production 纯 helper 计算——exact_source 由
 * exact source artifact（ID + content_json hash）+ voice revision pair 派生；final_tts_input
 * 由 final compiled input 投影派生。禁止测试内临时算法作为权威）。
 */
function chainContext(projectId: string, unitId: string, payload: ReturnType<typeof makePayload>, voice: {profileId: string; revisionId: string; canonicalSha256: string}, narrationPlanArtifactId: string, performancePlanArtifactId: string, assignmentArtifactId: string, contentHashes: {np: string; asg: string; pp: string}): ChainInput {
  return {
    projectId,
    unitId,
    exactSourceFingerprint: computeExactSourceFingerprint({
      projectId,
      unitId,
      narrationPlanArtifactId,
      narrationPlanContentHash: contentHashes.np,
      assignmentArtifactId,
      assignmentContentHash: contentHashes.asg,
      performancePlanArtifactId,
      performancePlanContentHash: contentHashes.pp,
      voiceProfileId: voice.profileId,
      voiceProfileRevisionId: voice.revisionId,
    }),
    finalTtsInputFingerprint: computeFinalTtsInputFingerprint({
      unitId,
      spokenText: spokenTextOf(payload),
      voiceProfileId: voice.profileId,
      voiceProfileRevisionId: voice.revisionId,
      referenceAudioSha256: voice.canonicalSha256,
      synthesisPayloadFingerprint: payload.synthesisPayloadFingerprint,
    }),
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
    requests: [{requestId: `seed-${crypto.randomUUID()}`, unitId: chain.unitId, exactSourceFingerprint: chain.exactSourceFingerprint, synthesisPayloadFingerprint: chain.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chain.finalTtsInputFingerprint}],
  });
  const claimId = out[0]!.claimId!;
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
  const outFile = writeOutputFile('out.wav');
  advanceAttemptPhase(db, c.attemptId, 'provider_in_flight', {providerRequestId: 'seed-prov'});
  advanceAttemptPhase(db, c.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
  advanceAttemptPhase(db, c.attemptId, 'file_validated');
  advanceAttemptPhase(db, c.attemptId, 'file_durable', {finalRelativePath: outFile.rel, audioSha256: outFile.sha, outputSize: outFile.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
  const fin = finalizeSynthesisJobSuccess(db, {
    jobId,
    workerOwnerToken: workerToken,
    attemptId: c.attemptId,
    outputRootDir: OUTPUT_ROOT,
    attemptEvidence: {finalRelativePath: outFile.rel, audioSha256: outFile.sha, outputSize: outFile.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'seed-prov'},
    artifact: {
      narrationPlanArtifactId: chain.narrationPlanArtifactId,
      narrationPlanContentHash: artifactContentHash(db, chain.narrationPlanArtifactId, chain.projectId, 'narration_plan_v2'),
      assignmentArtifactId: chain.assignmentArtifactId,
      assignmentContentHash: artifactContentHash(db, chain.assignmentArtifactId, chain.projectId, 'project_voice_assignment'),
      performancePlanArtifactId: chain.performancePlanArtifactId,
      performancePlanContentHash: artifactContentHash(db, chain.performancePlanArtifactId, chain.projectId, 'narration_performance_plan'),
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

async function newVoice(): Promise<{profileId: string; revisionId: string; canonicalSha256: string}> {
  const profile = createVoiceProfile({displayName: `c2-${crypto.randomUUID().slice(0, 8)}`});
  const revision = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${crypto.randomUUID()}`, audioBuffer: makeWav(800, 440)},
    {ffprobeImpl: async () => ({durationMs: 1500, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, hasVideo: false})},
  );
  const revRow = revision.outcome === 'created' || revision.outcome === 'reused' ? revision.revision : null;
  if (!revRow) throw new Error('ingest failed');
  const shaRow = getDb().prepare('SELECT canonical_audio_sha256 FROM voice_profile_revisions WHERE id=?').get(revRow.id) as {canonical_audio_sha256: string};
  return {profileId: profile.id, revisionId: revRow.id, canonicalSha256: shaRow.canonical_audio_sha256};
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

  // fixture 上下文（artifacts 带 content_json——source content hash 的权威输入）
  const voice = await newVoice();
  const npArtifact = crypto.randomUUID();
  const ppArtifact = crypto.randomUUID();
  const NP_CONTENT = JSON.stringify({kind: 'narration_plan_v2', unitId: 'N001', text: 'hello world'});
  const PP_CONTENT = JSON.stringify({kind: 'narration_performance_plan', unitId: 'N001', pacing: 'normal'});
  db.prepare("INSERT INTO artifacts (id, project_id, kind, content_json, created_at) VALUES (?, ?, 'narration_plan_v2', ?, ?)").run(npArtifact, fx.projectId, NP_CONTENT, new Date().toISOString());
  db.prepare("INSERT INTO artifacts (id, project_id, kind, content_json, created_at) VALUES (?, ?, 'narration_performance_plan', ?, ?)").run(ppArtifact, fx.projectId, PP_CONTENT, new Date().toISOString());
  // 三个 source artifact 的 canonical content hash（constant per run；chainContext 输入）
  const FIXED_CONTENT_HASHES = {
    np: artifactContentHash(db, npArtifact, fx.projectId, 'narration_plan_v2'),
    asg: artifactContentHash(db, fx.assignmentArtifactId, fx.projectId, 'project_voice_assignment'),
    pp: artifactContentHash(db, ppArtifact, fx.projectId, 'narration_performance_plan'),
  };

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

  const chainA = chainContext(fx.projectId, 'N001', makePayload('N001', 'hello'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);

  // ── R1/R2: request envelope + fan-in ──
  let createdA: Array<{requestId: string; claimId: string | null}>;
  {
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [
        {requestId: 'req-a1', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainA.finalTtsInputFingerprint},
        {requestId: 'req-a2', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainA.finalTtsInputFingerprint},
        {requestId: 'req-b1', unitId: 'N002', exactSourceFingerprint: 'x2', synthesisPayloadFingerprint: 'sha256:2', finalTtsInputFingerprint: sha256hex('N002')},
      ],
    });
    createdA = out as Array<{requestId: string; claimId: string}>;
    ok(out.length === 3 && out.every((r) => r.status === 'waiting'), 'R1 waiting 全部');
    ok(out[0]!.claimId! === out[1]!.claimId!, 'R2 同 key fan-in → 同一 claim');
    ok(out[0]!.claimId! !== out[2]!.claimId!, 'R2 不同 key → 不同 claim');
    const r = db.prepare("SELECT status, claim_id FROM tts_audio_requests WHERE request_id='req-a1'").get() as {status: string; claim_id: string | null};
    ok(r.status === 'waiting' && r.claim_id !== null, 'R1 initializing→waiting exact-link（claim_id 非 NULL）');
  }
  const claimAId = createdA[0]!.claimId!;
  const claimA = getSynthesisClaim(db, claimAId);
  ok(claimA.status === 'validating_reuse' && claimA.validation_attempt === 1 && claimA.candidate_artifact_id === null, 'R1 claim validating_reuse 初始态');

  // ── R3: reusable artifact → no job ──
  {
    // 先为 N001 构建 succeeded chain（candidate），再新建 request → resolve usable → 复用
    buildSucceededChain(db, chainA, {audioSha256: 'a'.repeat(64), size: 1000});
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-a3', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainA.finalTtsInputFingerprint}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId!);
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
      requests: [{requestId: 'req-a4', unitId: 'N001', exactSourceFingerprint: chainA.exactSourceFingerprint, synthesisPayloadFingerprint: chainA.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainA.finalTtsInputFingerprint}],
    });
    const claim4Id = out4[0]!.claimId!!;
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
    const outFileR4 = writeOutputFile('r4-out.wav');
    advanceAttemptPhase(db, claimRes.attemptId, 'file_durable', {finalRelativePath: outFileR4.rel, audioSha256: outFileR4.sha, outputSize: outFileR4.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
    const attemptRow = db.prepare('SELECT audio_sha256, final_relative_path FROM tts_generation_attempts WHERE id=?').get(claimRes.attemptId) as {audio_sha256: string; final_relative_path: string};
    ok(attemptRow.audio_sha256 === outFileR4.sha, 'R11 file_durable evidence');
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
      outputRootDir: OUTPUT_ROOT,
      attemptEvidence: {finalRelativePath: outFileR4.rel, audioSha256: outFileR4.sha, outputSize: outFileR4.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'prov-1'},
      artifact: {
        narrationPlanArtifactId: chainA.narrationPlanArtifactId,
        narrationPlanContentHash: artifactContentHash(db, chainA.narrationPlanArtifactId, chainA.projectId, 'narration_plan_v2'),
        assignmentArtifactId: chainA.assignmentArtifactId,
        assignmentContentHash: artifactContentHash(db, chainA.assignmentArtifactId, chainA.projectId, 'project_voice_assignment'),
        performancePlanArtifactId: chainA.performancePlanArtifactId,
        performancePlanContentHash: artifactContentHash(db, chainA.performancePlanArtifactId, chainA.projectId, 'narration_performance_plan'),
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
    const chainB = chainContext(fx.projectId, 'N010', makePayload('N010', 'bye'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-c1', unitId: 'N010', exactSourceFingerprint: chainB.exactSourceFingerprint, synthesisPayloadFingerprint: chainB.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainB.finalTtsInputFingerprint}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId!);
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
    const chainD = chainContext(fx.projectId, 'N011', makePayload('N011', 'take'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-d1', unitId: 'N011', exactSourceFingerprint: chainD.exactSourceFingerprint, synthesisPayloadFingerprint: chainD.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainD.finalTtsInputFingerprint}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId!);
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
    const chainE = chainContext(fx.projectId, 'N012', makePayload('N012', 'atom'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-e1', unitId: 'N012', exactSourceFingerprint: chainE.exactSourceFingerprint, synthesisPayloadFingerprint: chainE.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainE.finalTtsInputFingerprint}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId!);
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
      ).run(crypto.randomUUID(), claim.id, crypto.randomUUID(), claim.validation_owner_token, claim.validation_attempt, fx.projectId, 'N012', npArtifact, chainE.provider, chainE.voiceProfileId, chainE.voiceProfileRevisionId, chainE.payload.canonicalPayloadJson, chainE.exactSourceFingerprint, chainE.payload.synthesisPayloadFingerprint, chainE.finalTtsInputFingerprint, new Date().toISOString());
    }, 'SQLITE_CONSTRAINT_TRIGGER');
    ok(getSynthesisClaim(db, claim.id).status === 'cancelled', 'R9 ABORT 后 claim 保持 cancelled（无 half-linked job）');
  }

  // ── R16: zero-subscriber running cancel → job.cancel_requested=1 ──
  {
    const chainF = chainContext(fx.projectId, 'N013', makePayload('N013', 'cancel'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
    const out = createSynthesisRequests(db, {
      projectId: fx.projectId,
      requests: [{requestId: 'req-f1', unitId: 'N013', exactSourceFingerprint: chainF.exactSourceFingerprint, synthesisPayloadFingerprint: chainF.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainF.finalTtsInputFingerprint}],
    });
    const claim = getSynthesisClaim(db, out[0]!.claimId!);
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

  // ══════════════ R1. P1 blocker-specific ══════════════
  {
    // ── R1-A: atomic success request fan-out（多 subscriber 同一 claim → 全部 succeeded + 同一 artifact） ──
    {
      const chainA1 = chainContext(fx.projectId, 'N030', makePayload('N030', 'fanout'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outA = createSynthesisRequests(db, {
        projectId: fx.projectId,
        requests: [
          {requestId: 'r1a-req1', unitId: 'N030', exactSourceFingerprint: chainA1.exactSourceFingerprint, synthesisPayloadFingerprint: chainA1.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainA1.finalTtsInputFingerprint},
          {requestId: 'r1a-req2', unitId: 'N030', exactSourceFingerprint: chainA1.exactSourceFingerprint, synthesisPayloadFingerprint: chainA1.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainA1.finalTtsInputFingerprint},
        ],
      });
      ok(outA.length === 2 && outA[0]!.claimId === outA[1]!.claimId, 'R1-A 两个 request 同一 claim（fan-in）');
      const claimA1 = getSynthesisClaim(db, outA[0]!.claimId!);
      const resA = resolveClaimValidation(db, {claimId: claimA1.id, validationOwnerToken: claimA1.validation_owner_token as string, validationAttempt: claimA1.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainA1)});
      if (resA.kind !== 'dispatched') throw new Error('R1-A dispatch failed');
      const claimARes = claimSynthesisJob(db, {jobId: resA.jobId, workerOwnerToken: 'worker-r1a', providerRequestHash: chainA1.exactSourceFingerprint, providerRequestJson: chainA1.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileA = writeOutputFile('r1a-out.wav');
      advanceAttemptPhase(db, claimARes.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, claimARes.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, claimARes.attemptId, 'file_validated');
      advanceAttemptPhase(db, claimARes.attemptId, 'file_durable', {finalRelativePath: fileA.rel, audioSha256: fileA.sha, outputSize: fileA.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      const finA = finalizeSynthesisJobSuccess(db, {
        jobId: resA.jobId,
        workerOwnerToken: 'worker-r1a',
        attemptId: claimARes.attemptId,
        outputRootDir: OUTPUT_ROOT,
        attemptEvidence: {finalRelativePath: fileA.rel, audioSha256: fileA.sha, outputSize: fileA.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
        artifact: {
          narrationPlanArtifactId: chainA1.narrationPlanArtifactId,
          narrationPlanContentHash: artifactContentHash(db, chainA1.narrationPlanArtifactId, chainA1.projectId, 'narration_plan_v2'),
          assignmentArtifactId: chainA1.assignmentArtifactId,
          assignmentContentHash: artifactContentHash(db, chainA1.assignmentArtifactId, chainA1.projectId, 'project_voice_assignment'),
          performancePlanArtifactId: chainA1.performancePlanArtifactId,
          performancePlanContentHash: artifactContentHash(db, chainA1.performancePlanArtifactId, chainA1.projectId, 'narration_performance_plan'),
          voiceProfileId: chainA1.voiceProfileId,
          voiceProfileRevisionId: chainA1.voiceProfileRevisionId,
          capabilityCompilerVersion: chainA1.payload.capabilityCompilerVersion,
          capabilitySnapshotJson: chainA1.payload.capabilitySnapshotJson,
          compiledPayloadJson: chainA1.payload.compiledPayloadJson,
        },
      });
      const r1aReqs = db.prepare("SELECT request_id, status, result_artifact_id FROM tts_audio_requests WHERE claim_id=? ORDER BY request_id").all(outA[0]!.claimId!) as Array<{request_id: string; status: string; result_artifact_id: string | null}>;
      ok(r1aReqs.length === 2 && r1aReqs.every((r) => r.status === 'succeeded' && r.result_artifact_id !== null), 'R1-A 同一 claim 全部 request succeeded + result（fan-out 原子完成）', r1aReqs);
      const sameArtifact = new Set(r1aReqs.map((r) => r.result_artifact_id));
      ok(sameArtifact.size === 1 && [...sameArtifact][0] === finA.artifactId, 'R1-A 全部指向同一 result artifact（== 本事务 artifact）');
      const leftover = (db.prepare("SELECT COUNT(*) n FROM tts_audio_requests WHERE claim_id=? AND status IN ('waiting','running')").get(outA[0]!.claimId!) as {n: number}).n;
      ok(leftover === 0, 'R1-A 无 claim succeeded 而 request 仍 active');
      const dangling = (db.prepare("SELECT COUNT(*) n FROM tts_audio_requests r JOIN tts_synthesis_claims c ON c.id=r.claim_id WHERE c.status='succeeded' AND r.status IN ('waiting','running')").get() as {n: number}).n;
      ok(dangling === 0, 'R1-A 全库无 claim succeeded 而 request 仍 active');
    }

    // ── R1-B: success rollback if exact reread fails（输出文件缺失 → 整事务回滚） ──
    {
      const chainB = chainContext(fx.projectId, 'N020', makePayload('N020', 'rollback'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outB = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r1b-req', unitId: 'N020', exactSourceFingerprint: chainB.exactSourceFingerprint, synthesisPayloadFingerprint: chainB.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainB.finalTtsInputFingerprint}]});
      const claimB = getSynthesisClaim(db, outB[0]!.claimId!);
      const resB = resolveClaimValidation(db, {claimId: claimB.id, validationOwnerToken: claimB.validation_owner_token as string, validationAttempt: claimB.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainB)});
      if (resB.kind !== 'dispatched') throw new Error('R1-B dispatch failed');
      const claimB2 = claimSynthesisJob(db, {jobId: resB.jobId, workerOwnerToken: 'worker-b', providerRequestHash: 'h', providerRequestJson: chainB.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileB = writeOutputFile('r1b-out.wav');
      advanceAttemptPhase(db, claimB2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, claimB2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, claimB2.attemptId, 'file_validated');
      advanceAttemptPhase(db, claimB2.attemptId, 'file_durable', {finalRelativePath: fileB.rel, audioSha256: fileB.sha, outputSize: fileB.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      // 删除输出文件 → exact reread 失败 → 整事务回滚
      fs.rmSync(path.join(OUTPUT_ROOT, fileB.rel));
      await expectCode('R1-B exact reread 失败 → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resB.jobId,
          workerOwnerToken: 'worker-b',
          attemptId: claimB2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileB.rel, audioSha256: fileB.sha, outputSize: fileB.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainB.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainB.narrationPlanArtifactId, chainB.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainB.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainB.assignmentArtifactId, chainB.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainB.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainB.performancePlanArtifactId, chainB.projectId, 'narration_performance_plan'),
            voiceProfileId: chainB.voiceProfileId,
            voiceProfileRevisionId: chainB.voiceProfileRevisionId,
            capabilityCompilerVersion: chainB.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainB.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainB.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok(getTtsCJob(db, resB.jobId).status === 'running', 'R1-B rollback：job 保持 running');
      ok(getSynthesisClaim(db, claimB.id).status === 'running', 'R1-B rollback：claim 保持 running');
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(claimB2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R1-B rollback：attempt 保持 file_durable');
      ok((db.prepare('SELECT COUNT(*) n FROM sentence_audio_artifacts WHERE job_id=?').get(resB.jobId) as {n: number}).n === 0, 'R1-B rollback：零 artifact');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r1b-req'").get() as {status: string}).status === 'waiting', 'R1-B rollback：request 保持 waiting');
      failSynthesisJob(db, {jobId: resB.jobId, workerOwnerToken: 'worker-b', errorCode: 'TEST', errorMessage: 'release R1-B'});
    }

    // ── R1-C: expired validator cannot usable-finalize（lease fence 不命中 → STALE 零副作用） ──
    {
      // 先造一个 succeeded candidate（N021）
      const chainC = chainContext(fx.projectId, 'N021', makePayload('N021', 'fence'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      buildSucceededChain(db, chainC, {audioSha256: 'a'.repeat(64), size: 1000});
      const outC = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r1c-req', unitId: 'N021', exactSourceFingerprint: chainC.exactSourceFingerprint, synthesisPayloadFingerprint: chainC.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainC.finalTtsInputFingerprint}]});
      const claimC = getSynthesisClaim(db, outC[0]!.claimId!);
      ok(claimC.candidate_artifact_id !== null, 'R1-C candidate 存在');
      db.prepare('UPDATE tts_synthesis_claims SET validation_lease_expires_at_epoch_ms=1 WHERE id=?').run(claimC.id);
      await expectCode('R1-C lease 过期 usable-finalize → STALE_VALIDATION_OWNER', () => {
        resolveClaimValidation(db, {claimId: claimC.id, validationOwnerToken: claimC.validation_owner_token as string, validationAttempt: claimC.validation_attempt, candidateUsable: true, candidateArtifactId: claimC.candidate_artifact_id, candidateMetadataHash: claimC.candidate_artifact_metadata_hash});
      }, VALIDATION_STALE_OWNER);
      ok(getSynthesisClaim(db, claimC.id).status === 'validating_reuse', 'R1-C 零副作用（仍 validating_reuse）');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r1c-req'").get() as {status: string}).status === 'waiting', 'R1-C request 未推进');
      cancelSynthesisRequest(db, fx.projectId, 'r1c-req');
    }

    // ── R1-D: candidate/hash mismatch cannot finalize ──
    {
      const chainD = chainContext(fx.projectId, 'N022', makePayload('N022', 'hash'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      buildSucceededChain(db, chainD, {audioSha256: 'a'.repeat(64), size: 1000});
      const outD = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r1d-req', unitId: 'N022', exactSourceFingerprint: chainD.exactSourceFingerprint, synthesisPayloadFingerprint: chainD.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainD.finalTtsInputFingerprint}]});
      const claimD = getSynthesisClaim(db, outD[0]!.claimId!);
      await expectCode('R1-D candidate/hash mismatch → STALE_VALIDATION_OWNER', () => {
        resolveClaimValidation(db, {claimId: claimD.id, validationOwnerToken: claimD.validation_owner_token as string, validationAttempt: claimD.validation_attempt, candidateUsable: true, candidateArtifactId: claimD.candidate_artifact_id, candidateMetadataHash: 'deadbeef'});
      }, VALIDATION_STALE_OWNER);
      ok(getSynthesisClaim(db, claimD.id).status === 'validating_reuse', 'R1-D 零副作用');
      cancelSynthesisRequest(db, fx.projectId, 'r1d-req');
    }

    // ── R1-E: validation renewal current owner only ──
    {
      const chainE = chainContext(fx.projectId, 'N023', makePayload('N023', 'renew'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outE = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r1e-req', unitId: 'N023', exactSourceFingerprint: chainE.exactSourceFingerprint, synthesisPayloadFingerprint: chainE.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainE.finalTtsInputFingerprint}]});
      const claimE = getSynthesisClaim(db, outE[0]!.claimId!);
      const renewed = renewClaimValidation(db, {claimId: claimE.id, validationOwnerToken: claimE.validation_owner_token as string, validationAttempt: claimE.validation_attempt});
      const leaseAfter = db.prepare(`SELECT validation_lease_expires_at_epoch_ms AS lease,
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS db_now FROM tts_synthesis_claims WHERE id=?`).get(claimE.id) as {lease: number; db_now: number};
      ok(leaseAfter.lease === renewed.newLease && leaseAfter.lease > leaseAfter.db_now, 'R1-E renew 新 lease > DB now');
      await expectCode('R1-E 旧 owner renew → STALE_VALIDATION_OWNER', () => {
        renewClaimValidation(db, {claimId: claimE.id, validationOwnerToken: 'stale', validationAttempt: claimE.validation_attempt});
      }, VALIDATION_STALE_OWNER);
      ok(getSynthesisClaim(db, claimE.id).validation_owner_token === claimE.validation_owner_token, 'R1-E 零副作用');
      cancelSynthesisRequest(db, fx.projectId, 'r1e-req');
    }

    // ── R1-F: takeover refreshes validation_started_at ──
    {
      const chainF = chainContext(fx.projectId, 'N024', makePayload('N024', 'take2'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outF = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r1f-req', unitId: 'N024', exactSourceFingerprint: chainF.exactSourceFingerprint, synthesisPayloadFingerprint: chainF.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainF.finalTtsInputFingerprint}]});
      const claimF = getSynthesisClaim(db, outF[0]!.claimId!);
      // 让 claim 创建与 takeover 落在不同毫秒（ISO 毫秒时间戳语义下同毫秒无法区分刷新）——消除竞态
      await new Promise((r) => setTimeout(r, 5));
      const startedBefore = claimF.validation_started_at;
      db.prepare('UPDATE tts_synthesis_claims SET validation_lease_expires_at_epoch_ms=1 WHERE id=?').run(claimF.id);
      const taken = takeoverClaimValidation(db, {claimId: claimF.id, newValidationOwnerToken: 'v2'});
      const afterF = getSynthesisClaim(db, claimF.id);
      ok(taken.newValidationAttempt === 2, 'R1-F takeover attempt+1');
      ok(afterF.validation_started_at !== startedBefore && afterF.validation_started_at !== null, 'R1-F validation_started_at 刷新为当前 attempt 开始时间');
      // ── R1-G: takeover attempt 2 → dispatch → worker claim（attempt 传播） ──
      const resG = resolveClaimValidation(db, {claimId: claimF.id, validationOwnerToken: 'v2', validationAttempt: 2, candidateUsable: false, jobContext: dispatchJobContext(chainF)});
      if (resG.kind !== 'dispatched') throw new Error('R1-G dispatch failed');
      const claimG = claimSynthesisJob(db, {jobId: resG.jobId, workerOwnerToken: 'worker-g', providerRequestHash: 'h', providerRequestJson: chainF.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const jobG = getTtsCJob(db, resG.jobId);
      ok(jobG.attempt === 2, 'R1-G job.attempt = 2（validation attempt 传播）');
      ok(getSynthesisClaim(db, claimF.id).validation_attempt === 2, 'R1-G claim.validation_attempt = 2');
      ok((db.prepare('SELECT attempt_number FROM tts_generation_attempts WHERE id=?').get(claimG.attemptId) as {attempt_number: number}).attempt_number === 2, 'R1-G generation_attempt.attempt_number = 2');
      const cmdG = db.prepare('SELECT worker_attempt FROM tts_job_execution_transitions WHERE claim_id=? AND command_kind=?').get(claimF.id, 'worker_claim') as {worker_attempt: number};
      ok(cmdG.worker_attempt === 2, 'R1-G command.worker_attempt = 2');
      failSynthesisJob(db, {jobId: resG.jobId, workerOwnerToken: 'worker-g', errorCode: 'TEST', errorMessage: 'release R1-G'});
    }

    // ── R1-H: takeover attempt 2 → dispatch → prestart terminal（job.attempt 保持 0） ──
    {
      const chainH = chainContext(fx.projectId, 'N025', makePayload('N025', 'pre'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outH = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r1h-req', unitId: 'N025', exactSourceFingerprint: chainH.exactSourceFingerprint, synthesisPayloadFingerprint: chainH.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainH.finalTtsInputFingerprint}]});
      const claimH = getSynthesisClaim(db, outH[0]!.claimId!);
      db.prepare('UPDATE tts_synthesis_claims SET validation_lease_expires_at_epoch_ms=1 WHERE id=?').run(claimH.id);
      takeoverClaimValidation(db, {claimId: claimH.id, newValidationOwnerToken: 'v2'});
      const resH = resolveClaimValidation(db, {claimId: claimH.id, validationOwnerToken: 'v2', validationAttempt: 2, candidateUsable: false, jobContext: dispatchJobContext(chainH)});
      if (resH.kind !== 'dispatched') throw new Error('R1-H dispatch failed');
      prestartTerminalSynthesisJob(db, {jobId: resH.jobId, terminal: 'cancelled', reason: 'prestart'});
      const cmdH = db.prepare('SELECT worker_attempt FROM tts_job_execution_transitions WHERE claim_id=? AND command_kind=?').get(claimH.id, 'prestart_terminal') as {worker_attempt: number};
      ok(cmdH.worker_attempt === 2, 'R1-H prestart command.worker_attempt = 2（claim.validation_attempt）');
      ok(getSynthesisClaim(db, claimH.id).validation_attempt === 2, 'R1-H claim.validation_attempt = 2');
      const jobH = getTtsCJob(db, resH.jobId);
      ok(jobH.attempt === 0, 'R1-H job.attempt = 0（prestart 无 Worker execution，frozen D5）');
      ok(jobH.status === 'cancelled', 'R1-H job cancelled');
      ok(getSynthesisClaim(db, claimH.id).status === 'cancelled', 'R1-H claim cancelled');
    }

    // ── R1-I/R1-J: requestId replay / conflict ──
    {
      const chainI = chainContext(fx.projectId, 'N026', makePayload('N026', 'replay'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const beforeReq = (db.prepare('SELECT COUNT(*) n FROM tts_audio_requests WHERE project_id=?').get(fx.projectId) as {n: number}).n;
      const beforeClaim = (db.prepare('SELECT COUNT(*) n FROM tts_synthesis_claims WHERE project_id=?').get(fx.projectId) as {n: number}).n;
      const outI1 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'req-replay', unitId: 'N026', exactSourceFingerprint: chainI.exactSourceFingerprint, synthesisPayloadFingerprint: chainI.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainI.finalTtsInputFingerprint}]});
      const outI2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'req-replay', unitId: 'N026', exactSourceFingerprint: chainI.exactSourceFingerprint, synthesisPayloadFingerprint: chainI.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainI.finalTtsInputFingerprint}]});
      ok(outI2.length === 1 && outI2[0]!.replayed === true && outI2[0]!.claimId === outI1[0]!.claimId, 'R1-I 同 requestId + 同 identity → replay（同一 claim）');
      ok((db.prepare('SELECT COUNT(*) n FROM tts_audio_requests WHERE project_id=?').get(fx.projectId) as {n: number}).n === beforeReq + 1, 'R1-I request 行数不变（+1 仅为本次新增）');
      ok((db.prepare('SELECT COUNT(*) n FROM tts_synthesis_claims WHERE project_id=?').get(fx.projectId) as {n: number}).n === beforeClaim + 1, 'R1-I claim 数不变');
      await expectCode('R1-J 同 requestId + 不同 fingerprint → REQUEST_ID_CONFLICT', () => {
        createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'req-replay', unitId: 'N026', exactSourceFingerprint: chainI.exactSourceFingerprint, synthesisPayloadFingerprint: 'sha256:DIFFERENT', finalTtsInputFingerprint: sha256hex('N026')}]});
      }, REQUEST_ID_CONFLICT);
      await expectCode('R1-J 同 requestId + 不同 unit → REQUEST_ID_CONFLICT', () => {
        createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'req-replay', unitId: 'N999', exactSourceFingerprint: chainI.exactSourceFingerprint, synthesisPayloadFingerprint: chainI.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: sha256hex('N999')}]});
      }, REQUEST_ID_CONFLICT);
      cancelSynthesisRequest(db, fx.projectId, 'req-replay');
    }
  }

  // ══════════════ R2. final exact-reread closure（frozen §8.2） ══════════════
  {
    // ── R2-A: source content_json hash exact（TTS-B canonical 约定，非行元数据） ──
    {
      const npRow = db.prepare('SELECT content_json FROM artifacts WHERE id=?').get(npArtifact) as {content_json: string};
      ok(artifactContentHash(db, npArtifact, fx.projectId, 'narration_plan_v2') === sha256hex(npRow.content_json), 'R2-A narration content hash == sha256(content_json)');
      const asgRow = db.prepare('SELECT content_json FROM artifacts WHERE id=?').get(fx.assignmentArtifactId) as {content_json: string};
      ok(artifactContentHash(db, fx.assignmentArtifactId, fx.projectId, 'project_voice_assignment') === sha256hex(asgRow.content_json), 'R2-A assignment content hash == sha256(content_json)');
      const ppRow = db.prepare('SELECT content_json FROM artifacts WHERE id=?').get(ppArtifact) as {content_json: string};
      ok(artifactContentHash(db, ppArtifact, fx.projectId, 'narration_performance_plan') === sha256hex(ppRow.content_json), 'R2-A performance content hash == sha256(content_json)');
    }

    // ── R2-B: caller 直传 source content hash 与 content_json 重算不一致 → 整事务回滚 ──
    {
      const chainB2 = chainContext(fx.projectId, 'N031', makePayload('N031', 'src'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outB2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2b-req', unitId: 'N031', exactSourceFingerprint: chainB2.exactSourceFingerprint, synthesisPayloadFingerprint: chainB2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainB2.finalTtsInputFingerprint}]});
      const claimB2 = getSynthesisClaim(db, outB2[0]!.claimId!);
      const resB2 = resolveClaimValidation(db, {claimId: claimB2.id, validationOwnerToken: claimB2.validation_owner_token as string, validationAttempt: claimB2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainB2)});
      if (resB2.kind !== 'dispatched') throw new Error('R2-B dispatch failed');
      const cB2 = claimSynthesisJob(db, {jobId: resB2.jobId, workerOwnerToken: 'worker-r2b', providerRequestHash: chainB2.exactSourceFingerprint, providerRequestJson: chainB2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileB2 = writeOutputFile('r2b-out.wav');
      advanceAttemptPhase(db, cB2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cB2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cB2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cB2.attemptId, 'file_durable', {finalRelativePath: fileB2.rel, audioSha256: fileB2.sha, outputSize: fileB2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-B caller content hash 与 content_json 重算不一致 → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resB2.jobId,
          workerOwnerToken: 'worker-r2b',
          attemptId: cB2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileB2.rel, audioSha256: fileB2.sha, outputSize: fileB2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainB2.narrationPlanArtifactId,
            narrationPlanContentHash: 'deadbeef',
            assignmentArtifactId: chainB2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainB2.assignmentArtifactId, chainB2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainB2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainB2.performancePlanArtifactId, chainB2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainB2.voiceProfileId,
            voiceProfileRevisionId: chainB2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainB2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainB2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainB2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok(getTtsCJob(db, resB2.jobId).status === 'running', 'R2-B rollback：job running');
      ok(getSynthesisClaim(db, claimB2.id).status === 'running', 'R2-B rollback：claim running');
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cB2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-B rollback：attempt 保持 file_durable');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2b-req'").get() as {status: string}).status === 'waiting', 'R2-B rollback：request waiting');
      ok((db.prepare('SELECT COUNT(*) n FROM sentence_audio_artifacts WHERE job_id=?').get(resB2.jobId) as {n: number}).n === 0, 'R2-B rollback：零 artifact');
      failSynthesisJob(db, {jobId: resB2.jobId, workerOwnerToken: 'worker-r2b', errorCode: 'TEST', errorMessage: 'release R2-B'});
    }

    // ── R2-C: 实际 media metadata（ffprobe）== persisted attempt → PASS ──
    {
      const chainC2 = chainContext(fx.projectId, 'N032', makePayload('N032', 'media'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outC2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2c-req', unitId: 'N032', exactSourceFingerprint: chainC2.exactSourceFingerprint, synthesisPayloadFingerprint: chainC2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainC2.finalTtsInputFingerprint}]});
      const claimC2 = getSynthesisClaim(db, outC2[0]!.claimId!);
      const resC2 = resolveClaimValidation(db, {claimId: claimC2.id, validationOwnerToken: claimC2.validation_owner_token as string, validationAttempt: claimC2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainC2)});
      if (resC2.kind !== 'dispatched') throw new Error('R2-C dispatch failed');
      const cC2 = claimSynthesisJob(db, {jobId: resC2.jobId, workerOwnerToken: 'worker-r2c', providerRequestHash: chainC2.exactSourceFingerprint, providerRequestJson: chainC2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileC2 = writeOutputFile('r2c-out.wav');
      advanceAttemptPhase(db, cC2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cC2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cC2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cC2.attemptId, 'file_durable', {finalRelativePath: fileC2.rel, audioSha256: fileC2.sha, outputSize: fileC2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      const finC2 = finalizeSynthesisJobSuccess(db, {
        jobId: resC2.jobId,
        workerOwnerToken: 'worker-r2c',
        attemptId: cC2.attemptId,
        outputRootDir: OUTPUT_ROOT,
        attemptEvidence: {finalRelativePath: fileC2.rel, audioSha256: fileC2.sha, outputSize: fileC2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
        artifact: {
          narrationPlanArtifactId: chainC2.narrationPlanArtifactId,
          narrationPlanContentHash: artifactContentHash(db, chainC2.narrationPlanArtifactId, chainC2.projectId, 'narration_plan_v2'),
          assignmentArtifactId: chainC2.assignmentArtifactId,
          assignmentContentHash: artifactContentHash(db, chainC2.assignmentArtifactId, chainC2.projectId, 'project_voice_assignment'),
          performancePlanArtifactId: chainC2.performancePlanArtifactId,
          performancePlanContentHash: artifactContentHash(db, chainC2.performancePlanArtifactId, chainC2.projectId, 'narration_performance_plan'),
          voiceProfileId: chainC2.voiceProfileId,
          voiceProfileRevisionId: chainC2.voiceProfileRevisionId,
          capabilityCompilerVersion: chainC2.payload.capabilityCompilerVersion,
          capabilitySnapshotJson: chainC2.payload.capabilitySnapshotJson,
          compiledPayloadJson: chainC2.payload.compiledPayloadJson,
        },
      });
      const probeC2 = probeAudio(path.join(OUTPUT_ROOT, fileC2.rel), 'wav');
      ok(probeC2.codec === 'pcm_s16le' && probeC2.sampleRate === 48000 && probeC2.channels === 1 && probeC2.durationMs === 1500, 'R2-C 实际 media metadata 符合预期', probeC2);
      const attC2 = db.prepare('SELECT codec, sample_rate, channels, ffprobe_duration_ms FROM tts_generation_attempts WHERE id=?').get(cC2.attemptId) as {codec: string; sample_rate: number; channels: number; ffprobe_duration_ms: number};
      ok(attC2.codec === 'pcm_s16le' && attC2.sample_rate === 48000 && attC2.channels === 1 && attC2.ffprobe_duration_ms === 1500, 'R2-C persisted attempt media 证据');
      ok(probeC2.codec === attC2.codec && probeC2.sampleRate === attC2.sample_rate && probeC2.channels === attC2.channels && probeC2.durationMs === attC2.ffprobe_duration_ms, 'R2-C probe == persisted attempt（逐项）');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2c-req'").get() as {status: string}).status === 'succeeded', 'R2-C request succeeded');
      ok(finC2.artifactId !== null, 'R2-C artifact 落库');
    }

    // ── R2-D: 实际 media metadata 与 persisted 不一致（sampleRate 22050 vs 48000）→ 回滚 ──
    {
      const chainD2 = chainContext(fx.projectId, 'N033', makePayload('N033', 'media-bad'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outD2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2d-req', unitId: 'N033', exactSourceFingerprint: chainD2.exactSourceFingerprint, synthesisPayloadFingerprint: chainD2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainD2.finalTtsInputFingerprint}]});
      const claimD2 = getSynthesisClaim(db, outD2[0]!.claimId!);
      const resD2 = resolveClaimValidation(db, {claimId: claimD2.id, validationOwnerToken: claimD2.validation_owner_token as string, validationAttempt: claimD2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainD2)});
      if (resD2.kind !== 'dispatched') throw new Error('R2-D dispatch failed');
      const cD2 = claimSynthesisJob(db, {jobId: resD2.jobId, workerOwnerToken: 'worker-r2d', providerRequestHash: chainD2.exactSourceFingerprint, providerRequestJson: chainD2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      // 真实文件是 22050Hz，但 evidence 声称 48000（SHA/size 与文件一致，仅 media metadata 不符）
      const fileD2 = writeOutputFileAt('r2d-out.wav', makeWavAt(1500, 500, 22050));
      advanceAttemptPhase(db, cD2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cD2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cD2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cD2.attemptId, 'file_durable', {finalRelativePath: fileD2.rel, audioSha256: fileD2.sha, outputSize: fileD2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-D media metadata（sampleRate）≠ persisted → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resD2.jobId,
          workerOwnerToken: 'worker-r2d',
          attemptId: cD2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileD2.rel, audioSha256: fileD2.sha, outputSize: fileD2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainD2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainD2.narrationPlanArtifactId, chainD2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainD2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainD2.assignmentArtifactId, chainD2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainD2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainD2.performancePlanArtifactId, chainD2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainD2.voiceProfileId,
            voiceProfileRevisionId: chainD2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainD2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainD2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainD2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cD2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-D rollback：attempt file_durable');
      ok(getTtsCJob(db, resD2.jobId).status === 'running', 'R2-D rollback：job running');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2d-req'").get() as {status: string}).status === 'waiting', 'R2-D rollback：request waiting');
      ok((db.prepare('SELECT COUNT(*) n FROM sentence_audio_artifacts WHERE job_id=?').get(resD2.jobId) as {n: number}).n === 0, 'R2-D rollback：零 artifact');
      failSynthesisJob(db, {jobId: resD2.jobId, workerOwnerToken: 'worker-r2d', errorCode: 'TEST', errorMessage: 'release R2-D'});
    }

    // ── R2-E: caller evidence 与 persisted file_durable evidence 不一致 → 回滚 ──
    {
      const chainE2 = chainContext(fx.projectId, 'N034', makePayload('N034', 'ev'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outE2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2e-req', unitId: 'N034', exactSourceFingerprint: chainE2.exactSourceFingerprint, synthesisPayloadFingerprint: chainE2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainE2.finalTtsInputFingerprint}]});
      const claimE2 = getSynthesisClaim(db, outE2[0]!.claimId!);
      const resE2 = resolveClaimValidation(db, {claimId: claimE2.id, validationOwnerToken: claimE2.validation_owner_token as string, validationAttempt: claimE2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainE2)});
      if (resE2.kind !== 'dispatched') throw new Error('R2-E dispatch failed');
      const cE2 = claimSynthesisJob(db, {jobId: resE2.jobId, workerOwnerToken: 'worker-r2e', providerRequestHash: chainE2.exactSourceFingerprint, providerRequestJson: chainE2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileE2 = writeOutputFile('r2e-out.wav');
      advanceAttemptPhase(db, cE2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cE2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cE2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cE2.attemptId, 'file_durable', {finalRelativePath: fileE2.rel, audioSha256: fileE2.sha, outputSize: fileE2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-E caller audioSha256 ≠ persisted → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resE2.jobId,
          workerOwnerToken: 'worker-r2e',
          attemptId: cE2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileE2.rel, audioSha256: 'f'.repeat(64), outputSize: fileE2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainE2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainE2.narrationPlanArtifactId, chainE2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainE2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainE2.assignmentArtifactId, chainE2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainE2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainE2.performancePlanArtifactId, chainE2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainE2.voiceProfileId,
            voiceProfileRevisionId: chainE2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainE2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainE2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainE2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cE2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-E rollback：attempt file_durable');
      ok(getTtsCJob(db, resE2.jobId).status === 'running', 'R2-E rollback：job running');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2e-req'").get() as {status: string}).status === 'waiting', 'R2-E rollback：request waiting');
      ok((db.prepare('SELECT COUNT(*) n FROM sentence_audio_artifacts WHERE job_id=?').get(resE2.jobId) as {n: number}).n === 0, 'R2-E rollback：零 artifact');
      failSynthesisJob(db, {jobId: resE2.jobId, workerOwnerToken: 'worker-r2e', errorCode: 'TEST', errorMessage: 'release R2-E'});
    }

    // ── R2-F: exact_source_fingerprint 语义重算与 persisted 不一致 → 回滚 ──
    {
      const baseF2 = chainContext(fx.projectId, 'N035', makePayload('N035', 'exact'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const chainF2 = {...baseF2, exactSourceFingerprint: `sha256:${'0'.repeat(64)}`};
      const outF2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2f-req', unitId: 'N035', exactSourceFingerprint: chainF2.exactSourceFingerprint, synthesisPayloadFingerprint: chainF2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainF2.finalTtsInputFingerprint}]});
      const claimF2 = getSynthesisClaim(db, outF2[0]!.claimId!);
      const resF2 = resolveClaimValidation(db, {claimId: claimF2.id, validationOwnerToken: claimF2.validation_owner_token as string, validationAttempt: claimF2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainF2)});
      if (resF2.kind !== 'dispatched') throw new Error('R2-F dispatch failed');
      const cF2 = claimSynthesisJob(db, {jobId: resF2.jobId, workerOwnerToken: 'worker-r2f', providerRequestHash: chainF2.exactSourceFingerprint, providerRequestJson: chainF2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileF2 = writeOutputFile('r2f-out.wav');
      advanceAttemptPhase(db, cF2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cF2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cF2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cF2.attemptId, 'file_durable', {finalRelativePath: fileF2.rel, audioSha256: fileF2.sha, outputSize: fileF2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-F exact_source 语义重算 ≠ persisted → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resF2.jobId,
          workerOwnerToken: 'worker-r2f',
          attemptId: cF2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileF2.rel, audioSha256: fileF2.sha, outputSize: fileF2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainF2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainF2.narrationPlanArtifactId, chainF2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainF2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainF2.assignmentArtifactId, chainF2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainF2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainF2.performancePlanArtifactId, chainF2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainF2.voiceProfileId,
            voiceProfileRevisionId: chainF2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainF2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainF2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainF2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok(getTtsCJob(db, resF2.jobId).status === 'running', 'R2-F rollback：job running');
      ok(getSynthesisClaim(db, claimF2.id).status === 'running', 'R2-F rollback：claim running');
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cF2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-F rollback：attempt file_durable');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2f-req'").get() as {status: string}).status === 'waiting', 'R2-F rollback：request waiting');
      failSynthesisJob(db, {jobId: resF2.jobId, workerOwnerToken: 'worker-r2f', errorCode: 'TEST', errorMessage: 'release R2-F'});
    }

    // ── R2-G: final_tts_input_fingerprint 语义重算与 persisted 不一致 → 回滚 ──
    {
      const baseG2 = chainContext(fx.projectId, 'N036', makePayload('N036', 'final'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const chainG2 = {...baseG2, finalTtsInputFingerprint: `sha256:${'1'.repeat(64)}`};
      const outG2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2g-req', unitId: 'N036', exactSourceFingerprint: chainG2.exactSourceFingerprint, synthesisPayloadFingerprint: chainG2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainG2.finalTtsInputFingerprint}]});
      const claimG2 = getSynthesisClaim(db, outG2[0]!.claimId!);
      const resG2 = resolveClaimValidation(db, {claimId: claimG2.id, validationOwnerToken: claimG2.validation_owner_token as string, validationAttempt: claimG2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainG2)});
      if (resG2.kind !== 'dispatched') throw new Error('R2-G dispatch failed');
      const cG2 = claimSynthesisJob(db, {jobId: resG2.jobId, workerOwnerToken: 'worker-r2g', providerRequestHash: chainG2.exactSourceFingerprint, providerRequestJson: chainG2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileG2 = writeOutputFile('r2g-out.wav');
      advanceAttemptPhase(db, cG2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cG2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cG2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cG2.attemptId, 'file_durable', {finalRelativePath: fileG2.rel, audioSha256: fileG2.sha, outputSize: fileG2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-G final_tts_input 语义重算 ≠ persisted → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resG2.jobId,
          workerOwnerToken: 'worker-r2g',
          attemptId: cG2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileG2.rel, audioSha256: fileG2.sha, outputSize: fileG2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainG2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainG2.narrationPlanArtifactId, chainG2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainG2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainG2.assignmentArtifactId, chainG2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainG2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainG2.performancePlanArtifactId, chainG2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainG2.voiceProfileId,
            voiceProfileRevisionId: chainG2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainG2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainG2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainG2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok(getTtsCJob(db, resG2.jobId).status === 'running', 'R2-G rollback：job running');
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cG2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-G rollback：attempt file_durable');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2g-req'").get() as {status: string}).status === 'waiting', 'R2-G rollback：request waiting');
      failSynthesisJob(db, {jobId: resG2.jobId, workerOwnerToken: 'worker-r2g', errorCode: 'TEST', errorMessage: 'release R2-G'});
    }

    // ── R2-H: generation_variant 非 Phase-1 canonical（default）→ 回滚 ──
    {
      const chainH2 = chainContext(fx.projectId, 'N037', makePayload('N037', 'variant'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outH2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2h-req', unitId: 'N037', exactSourceFingerprint: chainH2.exactSourceFingerprint, synthesisPayloadFingerprint: chainH2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainH2.finalTtsInputFingerprint, generationVariantId: 'x'}]});
      const claimH2 = getSynthesisClaim(db, outH2[0]!.claimId!);
      const resH2 = resolveClaimValidation(db, {claimId: claimH2.id, validationOwnerToken: claimH2.validation_owner_token as string, validationAttempt: claimH2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainH2)});
      if (resH2.kind !== 'dispatched') throw new Error('R2-H dispatch failed');
      const cH2 = claimSynthesisJob(db, {jobId: resH2.jobId, workerOwnerToken: 'worker-r2h', providerRequestHash: chainH2.exactSourceFingerprint, providerRequestJson: chainH2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileH2 = writeOutputFile('r2h-out.wav');
      advanceAttemptPhase(db, cH2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cH2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cH2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cH2.attemptId, 'file_durable', {finalRelativePath: fileH2.rel, audioSha256: fileH2.sha, outputSize: fileH2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-H generation_variant 非 default → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resH2.jobId,
          workerOwnerToken: 'worker-r2h',
          attemptId: cH2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileH2.rel, audioSha256: fileH2.sha, outputSize: fileH2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainH2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainH2.narrationPlanArtifactId, chainH2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainH2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainH2.assignmentArtifactId, chainH2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainH2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainH2.performancePlanArtifactId, chainH2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainH2.voiceProfileId,
            voiceProfileRevisionId: chainH2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainH2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainH2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainH2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok(getTtsCJob(db, resH2.jobId).status === 'running', 'R2-H rollback：job running');
      ok(getSynthesisClaim(db, claimH2.id).status === 'running', 'R2-H rollback：claim running');
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cH2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-H rollback：attempt file_durable');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2h-req'").get() as {status: string}).status === 'waiting', 'R2-H rollback：request waiting');
      failSynthesisJob(db, {jobId: resH2.jobId, workerOwnerToken: 'worker-r2h', errorCode: 'TEST', errorMessage: 'release R2-H'});
    }

    // ── R2-I: voice revision identity（pair）不一致 → 回滚 ──
    {
      const voice2 = await newVoice();
      const chainI2 = chainContext(fx.projectId, 'N038', makePayload('N038', 'voice'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outI2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2i-req', unitId: 'N038', exactSourceFingerprint: chainI2.exactSourceFingerprint, synthesisPayloadFingerprint: chainI2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainI2.finalTtsInputFingerprint}]});
      const claimI2 = getSynthesisClaim(db, outI2[0]!.claimId!);
      const resI2 = resolveClaimValidation(db, {claimId: claimI2.id, validationOwnerToken: claimI2.validation_owner_token as string, validationAttempt: claimI2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainI2)});
      if (resI2.kind !== 'dispatched') throw new Error('R2-I dispatch failed');
      const cI2 = claimSynthesisJob(db, {jobId: resI2.jobId, workerOwnerToken: 'worker-r2i', providerRequestHash: chainI2.exactSourceFingerprint, providerRequestJson: chainI2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileI2 = writeOutputFile('r2i-out.wav');
      advanceAttemptPhase(db, cI2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cI2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cI2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cI2.attemptId, 'file_durable', {finalRelativePath: fileI2.rel, audioSha256: fileI2.sha, outputSize: fileI2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      await expectCode('R2-I voice revision pair 不一致 → REQUEST_STATE_INCONSISTENT', () => {
        finalizeSynthesisJobSuccess(db, {
          jobId: resI2.jobId,
          workerOwnerToken: 'worker-r2i',
          attemptId: cI2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileI2.rel, audioSha256: fileI2.sha, outputSize: fileI2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainI2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainI2.narrationPlanArtifactId, chainI2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainI2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainI2.assignmentArtifactId, chainI2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainI2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainI2.performancePlanArtifactId, chainI2.projectId, 'narration_performance_plan'),
            // 故意换成一个不同 profile 的 revision → pair 校验失败
            voiceProfileId: chainI2.voiceProfileId,
            voiceProfileRevisionId: voice2.revisionId,
            capabilityCompilerVersion: chainI2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainI2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainI2.payload.compiledPayloadJson,
          },
        });
      }, REQUEST_STATE_INCONSISTENT);
      ok(getTtsCJob(db, resI2.jobId).status === 'running', 'R2-I rollback：job running');
      ok((db.prepare('SELECT execution_phase FROM tts_generation_attempts WHERE id=?').get(cI2.attemptId) as {execution_phase: string}).execution_phase === 'file_durable', 'R2-I rollback：attempt file_durable');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2i-req'").get() as {status: string}).status === 'waiting', 'R2-I rollback：request waiting');
      ok((db.prepare('SELECT COUNT(*) n FROM sentence_audio_artifacts WHERE job_id=?').get(resI2.jobId) as {n: number}).n === 0, 'R2-I rollback：零 artifact');
      failSynthesisJob(db, {jobId: resI2.jobId, workerOwnerToken: 'worker-r2i', errorCode: 'TEST', errorMessage: 'release R2-I'});
    }

    // ── R2-J: file_durable→succeeded 不得 SET 任何 byte evidence（trigger 实证） ──
    {
      const chainJ2 = chainContext(fx.projectId, 'N039', makePayload('N039', 'noev'), voice, npArtifact, ppArtifact, fx.assignmentArtifactId, FIXED_CONTENT_HASHES);
      const outJ2 = createSynthesisRequests(db, {projectId: fx.projectId, requests: [{requestId: 'r2j-req', unitId: 'N039', exactSourceFingerprint: chainJ2.exactSourceFingerprint, synthesisPayloadFingerprint: chainJ2.payload.synthesisPayloadFingerprint, finalTtsInputFingerprint: chainJ2.finalTtsInputFingerprint}]});
      const claimJ2 = getSynthesisClaim(db, outJ2[0]!.claimId!);
      const resJ2 = resolveClaimValidation(db, {claimId: claimJ2.id, validationOwnerToken: claimJ2.validation_owner_token as string, validationAttempt: claimJ2.validation_attempt, candidateUsable: false, jobContext: dispatchJobContext(chainJ2)});
      if (resJ2.kind !== 'dispatched') throw new Error('R2-J dispatch failed');
      const cJ2 = claimSynthesisJob(db, {jobId: resJ2.jobId, workerOwnerToken: 'worker-r2j', providerRequestHash: chainJ2.exactSourceFingerprint, providerRequestJson: chainJ2.payload.canonicalPayloadJson, model: 'IndexTTS-2'});
      const fileJ2 = writeOutputFile('r2j-out.wav');
      advanceAttemptPhase(db, cJ2.attemptId, 'provider_in_flight', {providerRequestId: 'p'});
      advanceAttemptPhase(db, cJ2.attemptId, 'response_persisted', {responseHash: sha256hex('r'), recoveryTempRelativePath: 'tmp/o.wav'});
      advanceAttemptPhase(db, cJ2.attemptId, 'file_validated');
      advanceAttemptPhase(db, cJ2.attemptId, 'file_durable', {finalRelativePath: fileJ2.rel, audioSha256: fileJ2.sha, outputSize: fileJ2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500});
      // 实证：file_durable→succeeded 的 UPDATE 若在 SET 中出现任一 byte evidence 列 → ABORT
      db.prepare(
        `CREATE TRIGGER trg_test_r2j_no_byte_rewrite BEFORE UPDATE OF audio_sha256, output_size, codec, sample_rate, channels, ffprobe_duration_ms, final_relative_path ON tts_generation_attempts
         WHEN OLD.execution_phase='file_durable' AND NEW.execution_phase='succeeded'
         BEGIN SELECT RAISE(ABORT, 'R2-J succeeded 不得 SET byte evidence'); END`,
      ).run();
      try {
        const finJ2 = finalizeSynthesisJobSuccess(db, {
          jobId: resJ2.jobId,
          workerOwnerToken: 'worker-r2j',
          attemptId: cJ2.attemptId,
          outputRootDir: OUTPUT_ROOT,
          attemptEvidence: {finalRelativePath: fileJ2.rel, audioSha256: fileJ2.sha, outputSize: fileJ2.size, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, ffprobeDurationMs: 1500, providerRequestId: 'p'},
          artifact: {
            narrationPlanArtifactId: chainJ2.narrationPlanArtifactId,
            narrationPlanContentHash: artifactContentHash(db, chainJ2.narrationPlanArtifactId, chainJ2.projectId, 'narration_plan_v2'),
            assignmentArtifactId: chainJ2.assignmentArtifactId,
            assignmentContentHash: artifactContentHash(db, chainJ2.assignmentArtifactId, chainJ2.projectId, 'project_voice_assignment'),
            performancePlanArtifactId: chainJ2.performancePlanArtifactId,
            performancePlanContentHash: artifactContentHash(db, chainJ2.performancePlanArtifactId, chainJ2.projectId, 'narration_performance_plan'),
            voiceProfileId: chainJ2.voiceProfileId,
            voiceProfileRevisionId: chainJ2.voiceProfileRevisionId,
            capabilityCompilerVersion: chainJ2.payload.capabilityCompilerVersion,
            capabilitySnapshotJson: chainJ2.payload.capabilitySnapshotJson,
            compiledPayloadJson: chainJ2.payload.compiledPayloadJson,
          },
        });
        ok(finJ2.artifactId !== null, 'R2-J succeeded terminal 不触碰 byte evidence（trigger 未触发）');
      } finally {
        db.prepare('DROP TRIGGER trg_test_r2j_no_byte_rewrite').run();
      }
      const attJ2 = db.prepare('SELECT execution_phase, audio_sha256, output_size, codec, sample_rate, channels, ffprobe_duration_ms, final_relative_path FROM tts_generation_attempts WHERE id=?').get(cJ2.attemptId) as Record<string, unknown>;
      ok(attJ2.execution_phase === 'succeeded' && attJ2.audio_sha256 === fileJ2.sha && attJ2.final_relative_path === fileJ2.rel, 'R2-J byte evidence 保持 file_durable 原值');
      ok((db.prepare("SELECT status FROM tts_audio_requests WHERE request_id='r2j-req'").get() as {status: string}).status === 'succeeded', 'R2-J request succeeded');
    }
  }

  closeDb();
  fs.rmSync(DATA_DIR, {recursive: true, force: true});
  summary(TAG);
})().catch((e) => {
  console.error(e);
  ok(false, TAG, `uncaught: ${(e as Error).message}`);
  summary(TAG);
});

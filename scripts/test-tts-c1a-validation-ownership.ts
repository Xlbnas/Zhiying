/**
 * TTS-C.1A.R1 Validation ownership（P0-1）——真实双进程并发 + handle 语义：
 * - VOWN-01 两个 requestId 同 revision 同时进入 → 恰好一个 validation handle；另一 inflight；
 *   validator 调用次数 = 1（validation_attempt=1 无 takeover + 恰好一个 owner outcome）；
 * - VOWN-02 有效 owner 存在时第三个 request 只 fan-in，不运行 validator/finalize；
 * - VOWN-03 expired lease 双进程同时 takeover → 恰好一个 changes=1（赢家 handle）；
 * - VOWN-04 loser 重读 job 后通过公开 API 不得产生 finalize 效果（inflight，零副作用）；
 * - VOWN-05 旧 handle finalize → STALE_VALIDATION_OWNER（job/request/projection 全不变）；
 * - VOWN-06 winner finalize 成功 → active subscriber 正确 fan-out；
 * - VOWN-07 winner validation 期间 lease 过期 → finalize 失败，不得采用 DB 中新 owner 凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {ok, summary, setupC1aFixture, cleanupC1a, createC1aRequest, type C1aFixture} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {
  createMaterializationRequest,
  finalizeValidatingJob,
  takeoverStaleValidatingJob,
  getMaterializationJob,
  getProjection,
  type ValidationLeaseHandle,
  MaterializationError,
} from '../src/lib/tts-c/materialization';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);
const TAG = 'test-tts-c1a-validation-ownership';
let fx: C1aFixture;

/** 启动独立 child 进程（真实并发；独立 SQLite 连接）。 */
async function runChild(requestId: string, assignmentArtifactId: string): Promise<{ok: boolean; outcome?: string; code?: string; message?: string; requestStatus?: string; jobStatus?: string; jobId?: string}> {
  const childPath = path.join(process.cwd(), 'scripts/lib/tts-c1a-request-child.ts');
  const {stdout} = await execFileP(
    process.execPath,
    ['--import', 'tsx', childPath, fx.dataDir, fx.projectId, requestId, assignmentArtifactId],
    {env: {...process.env, ZHIYING_DATA_DIR: fx.dataDir}},
  );
  return JSON.parse(stdout.trim()) as ReturnType<typeof runChild>;
}

function mkHandle(row: {
  id: string;
  validation_owner_token: string | null;
  validation_attempt: number;
  validation_lease_expires_at_epoch_ms: number | null;
  candidate_materialization_id: string | null;
  candidate_materialization_metadata_hash: string | null;
}): ValidationLeaseHandle {
  return {
    jobId: row.id,
    validationOwnerToken: row.validation_owner_token!,
    validationAttempt: row.validation_attempt,
    validationLeaseExpiresAtEpochMs: row.validation_lease_expires_at_epoch_ms!,
    candidateMaterializationId: row.candidate_materialization_id,
    candidateMaterializationMetadataHash: row.candidate_materialization_metadata_hash,
  };
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── VOWN-01：真实双进程并发，恰好一个 owner（validator 恰好一次） ──
  const [va, vb] = await Promise.all([
    runChild('vown-a', fx.assignmentArtifactId),
    runChild('vown-b', fx.assignmentArtifactId),
  ]);
  ok(va.ok && vb.ok, 'VOWN-01 两调用均成功（无 500/异常）', {va: va.code, vb: vb.code});
  const finalizers = [va, vb].filter((r) => r.ok && (r.outcome === 'queued' || r.outcome === 'reused' || r.outcome === 'cancelled'));
  ok(finalizers.length >= 1, 'VOWN-01 至少一个请求获得 validation handle（owner 跑 finalize）', finalizers.map((r) => r.outcome));
  ok(va.jobId === vb.jobId && va.jobId !== undefined, 'VOWN-01 两请求链接同一 job（single-flight）', va.jobId);
  const job1 = getMaterializationJob(va.jobId!)!;
  // 若两个请求都尝试 finalize，第二个必 STALE 失败（ok=false）→ 两调用成功 + attempt=1 证明 finalize 恰好一次
  ok(job1.validation_attempt === 1, 'VOWN-01 validation_attempt=1（无 takeover → validator/finalize 恰好一次）', job1.validation_attempt);
  ok(job1.status === 'queued', 'VOWN-01 job 终态 queued（unusable + subscriber>0）', job1.status);

  // ── VOWN-02：有效 owner 存在时第三个 request 只 fan-in，不运行 validator/finalize ──
  // 前置：VOWN-01 job 置 failed（queued→failed 合法）释放 partial unique；
  // 手动构造 lease 有效的 validating job（确定性场景，不依赖时序）
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='failed', updated_at=? WHERE id=? AND status='queued'`,
  ).run(new Date().toISOString(), job1.id);
  const v2JobId = crypto.randomUUID();
  const v2Token = 'v2-owner';
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', ?, ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(v2JobId, fx.profileId, fx.revisionId, v2Token, Date.now() + 600000, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  const v2ReqId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'vown-pre2', ?, ?, ?, 'fp', 'initializing', ?, ?)`,
  ).run(v2ReqId, fx.projectId, fx.profileId, fx.revisionId, fx.assignmentArtifactId, new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(v2JobId, new Date().toISOString(), v2ReqId);
  const vc = await runChild('vown-c', fx.assignmentArtifactId);
  ok(vc.ok && vc.outcome === 'inflight', 'VOWN-02 有效 owner 存在 → 第三 request inflight（只 fan-in）', vc.outcome);
  ok(vc.jobId === v2JobId, 'VOWN-02 第三 request fan-in 到同一 job', vc.jobId);
  const v2job = getMaterializationJob(v2JobId)!;
  ok(
    v2job.status === 'validating_existing' && v2job.validation_owner_token === v2Token && v2job.validation_attempt === 1,
    'VOWN-02 job 状态/owner/attempt 未变（无 validator/finalize 副作用）',
    {status: v2job.status, attempt: v2job.validation_attempt},
  );
  const reqC = db.prepare("SELECT status FROM voice_materialization_requests WHERE project_id=? AND request_id='vown-c'").get(fx.projectId) as {status: string} | undefined;
  ok(reqC?.status === 'waiting', 'VOWN-02 第三 request 链接为 waiting（fan-in）', reqC?.status);

  // ── VOWN-03：expired lease 双进程同时 takeover，恰好一个赢家 ──
  // 让 v2 job lease 过期（subscriber: vown-pre2 + vown-c）
  db.prepare('UPDATE voice_materialization_jobs SET validation_lease_expires_at_epoch_ms=? WHERE id=?').run(Date.now() - 1000, v2JobId);
  const [vd, ve] = await Promise.all([
    runChild('vown-d', fx.assignmentArtifactId),
    runChild('vown-e', fx.assignmentArtifactId),
  ]);
  ok(vd.ok && ve.ok, 'VOWN-03 双进程 takeover 调用均成功', {vd: vd.code, ve: ve.code});
  const winner = [vd, ve].filter((r) => r.ok && (r.outcome === 'queued' || r.outcome === 'reused' || r.outcome === 'cancelled'));
  const loser = [vd, ve].filter((r) => r.ok && r.outcome === 'inflight');
  // 竞态窗口：后进者可能在赢家 finalize 后看到 queued → outcome=queued（但没跑 finalize）；
  // 精确判定：job.validation_attempt 必须恰好 = 2（只有一次 takeover），且无 STALE 错误
  ok(winner.length >= 1, 'VOWN-03 至少一个 takeover 赢家', winner.map((r) => r.outcome));
  const job3 = getMaterializationJob(v2JobId)!;
  ok(job3.validation_attempt === 2 && job3.validation_owner_token !== v2Token, 'VOWN-03 恰好一次 takeover（attempt 1→2）+ 新 owner', {attempt: job3.validation_attempt, owner: job3.validation_owner_token?.slice(0, 8)});

  // ── VOWN-04/05/06：确定性 handle 场景（独立 job，进程内 takeover 得 handle） ──
  // 前置：VOWN-03 job 置 failed 释放 partial unique
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='failed', updated_at=? WHERE id=? AND status IN ('queued','validating_existing')`,
  ).run(new Date().toISOString(), v2JobId);
  const v4JobId = crypto.randomUUID();
  const v4Token = 'v4-old-owner';
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', ?, ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(v4JobId, fx.profileId, fx.revisionId, v4Token, Date.now() - 1000, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  const v4Req1 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'vown-4a', ?, ?, ?, 'fp', 'initializing', ?, ?)`,
  ).run(v4Req1, fx.projectId, fx.profileId, fx.revisionId, fx.assignmentArtifactId, new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(v4JobId, new Date().toISOString(), v4Req1);
  const v4Winner = takeoverStaleValidatingJob(v4JobId);
  ok(v4Winner !== null, 'VOWN-04 前置：进程内 takeover 得 winner handle', v4Winner !== null);

  // VOWN-04：重读 job 的后续请求（loser 视角）通过公开 API 不得 finalize
  const vf = await runChild('vown-f', fx.assignmentArtifactId);
  ok(vf.ok && vf.outcome === 'inflight', 'VOWN-04 loser 重读后调用 → inflight（无 finalize）', vf.outcome);
  const job4 = getMaterializationJob(v4JobId)!;
  ok(
    job4.status === 'validating_existing' && job4.validation_owner_token === v4Winner!.validationOwnerToken && job4.validation_attempt === 2,
    'VOWN-04 job 零 finalize 副作用（winner owner/attempt/状态不变）',
    {status: job4.status, attempt: job4.validation_attempt},
  );

  // VOWN-05：旧 handle finalize → STALE（零状态更新）
  const oldHandle: ValidationLeaseHandle = {
    jobId: v4JobId,
    validationOwnerToken: v4Token,
    validationAttempt: 1,
    validationLeaseExpiresAtEpochMs: Date.now() - 1000,
    candidateMaterializationId: null,
    candidateMaterializationMetadataHash: null,
  };
  const before05 = db.prepare('SELECT * FROM voice_materialization_requests WHERE job_id=?').all(v4JobId);
  try {
    finalizeValidatingJob(oldHandle, {kind: 'unusable', reason: 'x'});
    ok(false, 'VOWN-05 旧 handle finalize → 抛 STALE', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'STALE_VALIDATION_OWNER', 'VOWN-05 旧 handle finalize → STALE_VALIDATION_OWNER', e);
  }
  const after05 = db.prepare('SELECT * FROM voice_materialization_requests WHERE job_id=?').all(v4JobId);
  ok(JSON.stringify(before05) === JSON.stringify(after05) && getProjection(fx.profileId, fx.revisionId) === undefined, 'VOWN-05 job/request/projection 全不变', {reqs: after05.length});

  // VOWN-06：winner handle finalize 成功 → active subscriber 正确 fan-out
  const oc6 = finalizeValidatingJob(v4Winner!, {kind: 'unusable', reason: 'no projection'});
  ok(oc6 === 'queued', 'VOWN-06 winner finalize（unusable + subscriber>0）→ queued', oc6);
  const job6 = getMaterializationJob(v4JobId)!;
  ok(job6.status === 'queued' && job6.validation_owner_token === null, 'VOWN-06 job→queued + validation owner 清空', job6.status);
  const waiting6 = db.prepare("SELECT count(*) c FROM voice_materialization_requests WHERE job_id=? AND status='waiting'").get(v4JobId) as {c: number};
  ok(waiting6.c === 2, 'VOWN-06 active subscriber（vown-4a + vown-f）正确 fan-out 为 waiting', waiting6.c);

  // ── VOWN-07：winner validation 期间 lease 过期 → finalize 失败（不得采用 DB 中新 owner 凭据） ──
  // 前置：VOWN-06 job 置 failed 释放 partial unique；构造新 stale job + winner handle；
  // validation 期间被 takeover（new owner）；旧 handle finalize → STALE
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='failed', updated_at=? WHERE id=? AND status='queued'`,
  ).run(new Date().toISOString(), v4JobId);
  const staleId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'w7', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(staleId, fx.profileId, fx.revisionId, Date.now() - 1000, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  // winner 的 handle 基于其获得时的凭据（lease 为过期值：Phase 2 期间 lease 已到期）
  const w7Handle = mkHandle(getMaterializationJob(staleId)!);
  // 另一 owner 接管（模拟 winner 的 Phase 2 期间 lease 过期 + takeover）
  const newOwner = takeoverStaleValidatingJob(staleId);
  ok(newOwner !== null, 'VOWN-07 前置：他人 takeover 成功', newOwner !== null);
  try {
    finalizeValidatingJob(w7Handle, {kind: 'unusable', reason: 'x'});
    ok(false, 'VOWN-07 旧 handle（validation 期间被接管）finalize → 抛 STALE', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'STALE_VALIDATION_OWNER', 'VOWN-07 finalize 失败 → STALE（不得采用 DB 新 owner 凭据）', e);
  }
  const job7 = getMaterializationJob(staleId)!;
  ok(job7.validation_owner_token !== 'w7' && job7.validation_attempt === 2, 'VOWN-07 job 保持新 owner 状态（旧 handle 零效果）', {attempt: job7.validation_attempt});

  // ── VOWN-08：winner 的 validation lease 过期但无人接管 → finalize 必须 STALE（lease 条件本身有效） ──
  // 前置：VOWN-07 job 置 failed 释放 partial unique（validating→queued→failed 合法链）
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL,
       validation_lease_expires_at_epoch_ms=NULL, updated_at=? WHERE id=? AND status='validating_existing'`,
  ).run(new Date().toISOString(), staleId);
  db.prepare(`UPDATE voice_materialization_jobs SET status='failed', updated_at=? WHERE id=? AND status='queued'`).run(new Date().toISOString(), staleId);
  const v8JobId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'w8', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(v8JobId, fx.profileId, fx.revisionId, Date.now() - 1000, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  const v8Handle = mkHandle(getMaterializationJob(v8JobId)!);
  try {
    finalizeValidatingJob(v8Handle, {kind: 'unusable', reason: 'x'});
    ok(false, 'VOWN-08 lease 过期（无 takeover）finalize → 抛 STALE', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'STALE_VALIDATION_OWNER', 'VOWN-08 lease 过期 → STALE（lease 条件是独立防线）', e);
  }
  const job8 = getMaterializationJob(v8JobId)!;
  ok(job8.status === 'validating_existing' && job8.validation_owner_token === 'w8', 'VOWN-08 job 零副作用（token 未变）', {status: job8.status});

  cleanupC1a(TAG);
  summary('TTS-C.1A validation-ownership');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

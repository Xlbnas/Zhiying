/**
 * TTS-C.1A.R3 Recovery active-subscriber 与 cancel fence（§七）：
 * - REC-CANCEL-01 expired running + exact final + cancel_requested=1 → cancelled，projection=0（预裁决，不 durabilize）；
 * - REC-CANCEL-02 expired running + exact final + subscriber=0 → cancelled，projection=0；
 * - REC-CANCEL-03 durabilize 后、commit 前 subscriber 归零 → cancelled，projection=0；
 * - REC-CANCEL-04 durabilize 后 cancel_requested 变 1 → cancelled；
 * - REC-CANCEL-05 合法 active subscriber → recovered_success。
 * 使用 hook afterRecoveryEvidenceBeforeCommit（仅测试）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {recoverExpiredMaterializationJobs, setAfterRecoveryEvidenceBeforeCommit, createMaterializationRequest, getProjection, getMaterializationJob} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-recovery-cancellation';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rc-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `rc-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 直插 expired running job + 链接 request（合法转换链）；可选 cancel_requested。 */
function insertExpiredRunning(rev: RevCtx, requestId: string, opts: {cancel?: boolean; noSubscriber?: boolean} = {}): string {
  const db = getDb();
  const jobId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v-seed', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(jobId, fx.profileId, rev.revisionId, Date.now() + 60000, rev.sha, `${fx.profileId}/${rev.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL,
       validation_lease_expires_at_epoch_ms=NULL, updated_at=? WHERE id=?`,
  ).run(new Date().toISOString(), jobId);
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='running', owner_token='dead-worker',
       lease_expires_at_epoch_ms=?, heartbeat_at=?, attempt=1, updated_at=? WHERE id=?`,
  ).run(Date.now() - 5000, new Date().toISOString(), new Date().toISOString(), jobId);
  if (opts.cancel) {
    db.prepare('UPDATE voice_materialization_jobs SET cancel_requested=1 WHERE id=?').run(jobId);
  }
  if (!opts.noSubscriber) {
    const reqId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO voice_materialization_requests
         (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
          request_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'fp', 'initializing', ?, ?)`,
    ).run(reqId, fx.projectId, requestId, fx.profileId, rev.revisionId, rev.assignmentArtifactId, new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(jobId, new Date().toISOString(), reqId);
  }
  return jobId;
}

/** 造 exact final 文件（copy canonical → final，不预先 fsync——recovery 自行 durabilize）。 */
function makeExactFinal(rev: RevCtx): void {
  const finalAbs = destinationAbsolutePath(`${fx.profileId}/${rev.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbs), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev.revisionId, 'reference.wav'), finalAbs);
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── REC-CANCEL-01：cancel_requested=1 → cancelled（预裁决，projection=0） ──
  const rev1 = await freshRevision(2210);
  makeExactFinal(rev1);
  const job1 = insertExpiredRunning(rev1, 'rc-1', {cancel: true});
  const h1 = await recoverExpiredMaterializationJobs(10);
  ok(h1 === 1, 'REC-CANCEL-01 被处理', h1);
  ok(getMaterializationJob(job1)?.status === 'cancelled', 'REC-CANCEL-01 cancel_requested → cancelled', getMaterializationJob(job1)?.status);
  ok(getProjection(fx.profileId, rev1.revisionId) === undefined, 'REC-CANCEL-01 projection=0（不 durabilize 不 INSERT）', undefined);
  const req1 = db.prepare("SELECT status FROM voice_materialization_requests WHERE project_id=? AND request_id='rc-1'").get(fx.projectId) as {status: string} | undefined;
  ok(req1?.status === 'cancelled', 'REC-CANCEL-01 request → cancelled', req1?.status);

  // ── REC-CANCEL-02：subscriber=0 → cancelled（预裁决，不 durabilize——hook 不被调用） ──
  const rev2 = await freshRevision(2220);
  makeExactFinal(rev2);
  const job2 = insertExpiredRunning(rev2, 'rc-2', {noSubscriber: true});
  let durHookCalls = 0;
  setAfterRecoveryEvidenceBeforeCommit(() => {
    durHookCalls++;
  });
  const h2 = await recoverExpiredMaterializationJobs(10);
  setAfterRecoveryEvidenceBeforeCommit(null);
  ok(h2 === 1, 'REC-CANCEL-02 被处理', h2);
  ok(getMaterializationJob(job2)?.status === 'cancelled', 'REC-CANCEL-02 subscriber=0 → cancelled', getMaterializationJob(job2)?.status);
  ok(getProjection(fx.profileId, rev2.revisionId) === undefined, 'REC-CANCEL-02 projection=0', undefined);
  ok(durHookCalls === 0, 'REC-CANCEL-02 预裁决 cancelled → 不调用 durabilize（hook=0）', durHookCalls);

  // ── REC-CANCEL-03：durabilize 后、commit 前 subscriber 归零 → cancelled ──
  const rev3 = await freshRevision(2230);
  makeExactFinal(rev3);
  const job3 = insertExpiredRunning(rev3, 'rc-3');
  setAfterRecoveryEvidenceBeforeCommit(() => {
    // hook 内把唯一 subscriber 置 cancelled（waiting→cancelled 合法）
    db.prepare("UPDATE voice_materialization_requests SET status='cancelled', updated_at=? WHERE project_id=? AND request_id='rc-3'").run(new Date().toISOString(), fx.projectId);
  });
  const h3 = await recoverExpiredMaterializationJobs(10);
  setAfterRecoveryEvidenceBeforeCommit(null);
  ok(h3 === 1, 'REC-CANCEL-03 被处理', h3);
  ok(getMaterializationJob(job3)?.status === 'cancelled', 'REC-CANCEL-03 commit 前 subscriber 归零 → cancelled', getMaterializationJob(job3)?.status);
  ok(getProjection(fx.profileId, rev3.revisionId) === undefined, 'REC-CANCEL-03 projection=0', undefined);

  // ── REC-CANCEL-04：durabilize 后 cancel_requested 变 1 → cancelled ──
  const rev4 = await freshRevision(2240);
  makeExactFinal(rev4);
  const job4 = insertExpiredRunning(rev4, 'rc-4');
  setAfterRecoveryEvidenceBeforeCommit(() => {
    db.prepare('UPDATE voice_materialization_jobs SET cancel_requested=1 WHERE id=?').run(job4);
  });
  const h4 = await recoverExpiredMaterializationJobs(10);
  setAfterRecoveryEvidenceBeforeCommit(null);
  ok(h4 === 1, 'REC-CANCEL-04 被处理', h4);
  ok(getMaterializationJob(job4)?.status === 'cancelled', 'REC-CANCEL-04 durabilize 后 cancel → cancelled', getMaterializationJob(job4)?.status);
  ok(getProjection(fx.profileId, rev4.revisionId) === undefined, 'REC-CANCEL-04 projection=0', undefined);

  // ── REC-CANCEL-05：合法 active subscriber → recovered_success ──
  const rev5 = await freshRevision(2250);
  makeExactFinal(rev5);
  const job5 = insertExpiredRunning(rev5, 'rc-5');
  const h5 = await recoverExpiredMaterializationJobs(10);
  ok(h5 === 1, 'REC-CANCEL-05 被处理', h5);
  ok(getMaterializationJob(job5)?.status === 'succeeded', 'REC-CANCEL-05 合法 active subscriber → recovered_success', getMaterializationJob(job5)?.status);
  const proj5 = getProjection(fx.profileId, rev5.revisionId);
  ok(proj5?.status === 'file_ready_unpublished', 'REC-CANCEL-05 projection 建立', proj5?.status);
  const req5 = db.prepare("SELECT status, materialization_id FROM voice_materialization_requests WHERE project_id=? AND request_id='rc-5'").get(fx.projectId) as {status: string; materialization_id: string | null} | undefined;
  ok(req5?.status === 'succeeded' && req5.materialization_id === proj5?.id, 'REC-CANCEL-05 request → succeeded + materialization_id', req5);

  // ── REC-EXIST-01：existing exact projection → expired job 终结（不重复 INSERT、不悬挂 running） ──
  const revE1 = await freshRevision(2260);
  // 先建 projection（worker 成功）
  const {claimNextAnyJob} = await import('../src/lib/scheduler');
  const {runMaterializationJob} = await import('../src/worker/materialization-executor');
  const rE1 = await createMaterializationRequest(fx.projectId, 're-1', revE1.assignmentArtifactId);
  const cE1 = claimNextAnyJob('rc-worker');
  if (cE1 && cE1.type === 'voice_materialization') await runMaterializationJob(cE1.handle, {log: () => undefined});
  const projE1 = getProjection(fx.profileId, revE1.revisionId)!;
  // 直插 expired running job（同 profile/revision；projection 已存在）
  const jobE1 = insertExpiredRunning(revE1, 're-1b');
  const hE1 = await recoverExpiredMaterializationJobs(10);
  ok(hE1 === 1, 'REC-EXIST-01 被处理', hE1);
  ok(getMaterializationJob(jobE1)?.status === 'succeeded', 'REC-EXIST-01 expired job → succeeded（existing exact 复用）', getMaterializationJob(jobE1)?.status);
  ok(getProjection(fx.profileId, revE1.revisionId)?.id === projE1.id, 'REC-EXIST-01 不重复 INSERT（同 projection id）', getProjection(fx.profileId, revE1.revisionId)?.id);
  const reqE1 = db.prepare("SELECT status, materialization_id FROM voice_materialization_requests WHERE project_id=? AND request_id='re-1b'").get(fx.projectId) as {status: string; materialization_id: string | null} | undefined;
  ok(reqE1?.status === 'succeeded' && reqE1.materialization_id === projE1.id, 'REC-EXIST-01 request → succeeded + 同一 materialization', reqE1);

  // ── REC-EXIST-02：existing projection unusable（failed）→ expired job 稳定终结（不悬挂 running） ──
  const revE2 = await freshRevision(2270);
  const rE2 = await createMaterializationRequest(fx.projectId, 're-2', revE2.assignmentArtifactId);
  const cE2 = claimNextAnyJob('rc-worker');
  if (cE2 && cE2.type === 'voice_materialization') await runMaterializationJob(cE2.handle, {log: () => undefined});
  db.prepare("UPDATE voice_materializations SET status='failed', updated_at=? WHERE voice_profile_id=? AND voice_profile_revision_id=?").run(new Date().toISOString(), fx.profileId, revE2.revisionId);
  const jobE2 = insertExpiredRunning(revE2, 're-2b');
  const hE2 = await recoverExpiredMaterializationJobs(10);
  ok(hE2 === 1, 'REC-EXIST-02 被处理', hE2);
  const jobE2r = getMaterializationJob(jobE2)!;
  ok(jobE2r.status === 'failed', 'REC-EXIST-02 unusable existing projection → job failed（不悬挂 running）', jobE2r.status);

  cleanupC1a(TAG);
  summary('TTS-C.1A recovery-cancellation');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

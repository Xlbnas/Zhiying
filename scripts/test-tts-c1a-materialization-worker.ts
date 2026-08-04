/**
 * TTS-C.1A Worker materialization 测试（Worker claim + durable copy + projection）。
 * - scheduler 只 claim queued；validating_existing 不可见；
 * - Worker claim 后 durable copy：temp→fsync→validate→rename→fsync→dir-fsync；
 * - projection=file_ready_unpublished（唯一终态）；job/requests succeeded；
 * - cancel_requested → cancelled（不写 projection）；
 * - claim 前 active subscriber=0 → cancelled（不 running）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, createC1aRequest, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runMaterializationJob} from '../src/worker/materialization-executor';
import {getProjection, getMaterializationJob, getMaterializationRequest} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';
import {sha256FileBytes} from '../src/lib/tts-c/audio-probe';

const TAG = 'test-tts-c1a-worker';
let fx: C1aFixture;

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // 1) 创建 request → queued
  const r = await createC1aRequest(fx, 'worker-1');
  ok(r.outcome === 'queued', 'outcome=queued', r.outcome);
  const jobId = r.job.id;

  // 2) validating_existing 不被 scheduler claim（先手工把 job 置回 validating 场景单独测）
  //    此处 job 已 queued；scheduler claim
  const claimed = claimNextAnyJob('test-worker');
  ok(claimed !== null && claimed.type === 'voice_materialization' && claimed.job.id === jobId, 'scheduler claim queued materialization job', claimed?.type);
  const claimedVm = claimed as {type: 'voice_materialization'; job: {id: string; status: string; owner_token: string | null; attempt: number}};
  ok(claimedVm.job.status === 'running' && claimedVm.job.owner_token !== null, 'claim 后 running + owner');

  // 3) Worker durable copy 执行
  await runMaterializationJob(
    {jobId, ownerToken: claimedVm.job.owner_token!, attempt: claimedVm.job.attempt},
    {log: () => undefined},
  );
  const proj = getProjection(fx.profileId, fx.revisionId);
  ok(proj !== undefined && proj.status === 'file_ready_unpublished', 'projection=file_ready_unpublished', proj?.status);
  const finalAbs = destinationAbsolutePath(proj!.destination_voice_root_relative_path);
  ok(fs.existsSync(finalAbs), 'final 文件存在');
  const st = fs.lstatSync(finalAbs);
  ok(st.isFile() && !st.isSymbolicLink(), 'final 为 regular file 非 symlink');
  const actual = await sha256FileBytes(finalAbs);
  ok(actual === fx.revisionSha256, 'final 文件 SHA256 与 exact revision 一致', actual.slice(0, 12));
  const jobDone = getMaterializationJob(jobId);
  ok(jobDone?.status === 'succeeded' && jobDone.owner_token === null && jobDone.lease_expires_at_epoch_ms === null, 'job succeeded + owner/lease 清空', jobDone?.status);
  const reqDone = getMaterializationRequest(fx.projectId, 'worker-1');
  ok(reqDone?.status === 'succeeded' && reqDone.materialization_id === proj!.id, 'request succeeded + materialization_id');

  // 4) 重复创建（projection 已 usable）→ reused 零文件写
  const before = fs.statSync(finalAbs).mtimeMs;
  const r2 = await createC1aRequest(fx, 'worker-2');
  ok(r2.outcome === 'reused', '第二 request → reused（零文件写）', r2.outcome);
  ok(Math.abs(fs.statSync(finalAbs).mtimeMs - before) < 1000, 'reuse 未改写文件');

  // 5) validating_existing 不被 scheduler claim（新 job 直插 validating）
  const db2 = getDb();
  const validJobId = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(validJobId, fx.profileId, fx.revisionId, Date.now() + 60000, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  const claimed2 = claimNextAnyJob('test-worker');
  ok(claimed2 === null, 'validating_existing 对 scheduler 不可见', claimed2);

  // 6) claim 前 active subscriber=0 → cancelled（第二个 revision 的 queued job + 无 subscriber）
  const revOrphan = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rev-orphan-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 700)},
    execDeps,
  );
  const revOrphanRow = revOrphan.outcome === 'created' || revOrphan.outcome === 'reused' ? revOrphan.revision : null;
  if (!revOrphanRow) throw new Error('orphan revision failed');
  const orphanSha = crypto.createHash('sha256').update(
    fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, revOrphanRow.id, 'reference.wav')),
  ).digest('hex');
  const orphanJob = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v-o', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(orphanJob, fx.profileId, revOrphanRow.id, Date.now() + 60000, orphanSha, `${fx.profileId}/${revOrphanRow.id}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  db2.prepare(
    `UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL,
       validation_lease_expires_at_epoch_ms=NULL, updated_at=?
     WHERE id=?`,
  ).run(new Date().toISOString(), orphanJob);
  const claimed3 = claimNextAnyJob('test-worker');
  ok(claimed3 === null, 'zero subscriber queued job → claim 前 cancelled（不 running）', claimed3);
  const orphanAfter = getMaterializationJob(orphanJob);
  ok(orphanAfter?.status === 'cancelled', 'zero subscriber job cancelled', orphanAfter?.status);

  // 7) cancel_requested：claim 前取消（scheduler 裁决）+ running 期间取消（Worker commit 裁决）
  const cancelJob = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v-c', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(cancelJob, fx.profileId, revOrphanRow.id, Date.now() + 60000, orphanSha, `${fx.profileId}/${revOrphanRow.id}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  db2.prepare(
    `UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL,
       validation_lease_expires_at_epoch_ms=NULL, updated_at=?
     WHERE id=?`,
  ).run(new Date().toISOString(), cancelJob);
  const cancelReqId = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'cancel-req', ?, ?, ?, 'fp', 'initializing', ?, ?)`,
  ).run(cancelReqId, fx.projectId, fx.profileId, revOrphanRow.id, fx.assignmentArtifactId, new Date().toISOString(), new Date().toISOString());
  db2.prepare(
    `UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=?
     WHERE id=? AND status='initializing'`,
  ).run(cancelJob, new Date().toISOString(), cancelReqId);

  // 7a) claim 前 cancel_requested → scheduler 直接取消（不 running）
  db2.prepare("UPDATE voice_materialization_jobs SET cancel_requested=1 WHERE id=?").run(cancelJob);
  const c4 = claimNextAnyJob('test-worker');
  ok(c4 === null, 'cancel_requested queued job → claim 前取消（不 running）', c4);
  const jCancel = getMaterializationJob(cancelJob);
  ok(jCancel?.status === 'cancelled', 'cancel_requested job cancelled（pre-claim）', jCancel?.status);

  // 7b) running 期间 cancel_requested → Worker commit 裁决 cancelled（不写 projection）
  const cancelJob2 = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v-c2', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(cancelJob2, fx.profileId, revOrphanRow.id, Date.now() + 60000, orphanSha, `${fx.profileId}/${revOrphanRow.id}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  db2.prepare(
    `UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL,
       validation_lease_expires_at_epoch_ms=NULL, updated_at=?
     WHERE id=?`,
  ).run(new Date().toISOString(), cancelJob2);
  const cancelReq2 = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'cancel-req2', ?, ?, ?, 'fp', 'initializing', ?, ?)`,
  ).run(cancelReq2, fx.projectId, fx.profileId, revOrphanRow.id, fx.assignmentArtifactId, new Date().toISOString(), new Date().toISOString());
  db2.prepare(
    `UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=?
     WHERE id=? AND status='initializing'`,
  ).run(cancelJob2, new Date().toISOString(), cancelReq2);
  const c5 = claimNextAnyJob('test-worker');
  ok(c5 !== null && c5.type === 'voice_materialization' && c5.job.id === cancelJob2, 'running 期 job 正常 claim', c5?.type);
  const c5job = c5 as {type: 'voice_materialization'; job: {id: string; owner_token: string | null; attempt: number}};
  db2.prepare("UPDATE voice_materialization_jobs SET cancel_requested=1 WHERE id=?").run(cancelJob2);
  await runMaterializationJob(
    {jobId: cancelJob2, ownerToken: c5job.job.owner_token!, attempt: c5job.job.attempt},
    {log: () => undefined},
  );
  const jCancel2 = getMaterializationJob(cancelJob2);
  ok(jCancel2?.status === 'cancelled', 'running 期 cancel_requested → Worker cancelled', jCancel2?.status);
  const orphanProj = getProjection(fx.profileId, revOrphanRow.id);
  ok(orphanProj === undefined, 'cancel 不写 projection（orphan revision 无 projection）', orphanProj?.status);
  const reqCancel = getMaterializationRequest(fx.projectId, 'cancel-req2');
  ok(reqCancel?.status === 'cancelled', 'cancel 请求 cancelled', reqCancel?.status);

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-worker');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

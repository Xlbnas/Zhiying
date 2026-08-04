/**
 * TTS-C.1A 并发与 validation 阶段测试（C+D）：
 * - 两个 requestId 同 exact Revision → fan-in 到同一 active job（恰好一个 Worker copy）；
 * - 并发 create → 恰好一个 validating job（partial unique single-flight）；
 * - fan-in 到实际执行：4 个 request 全部 succeeded + 同一 materialization；
 * - usable existing projection → reused（零文件写，mtime 不变）；
 * - unusable + subscriber → queued（第二 revision 完整链路）；
 * - zero subscriber → cancelled（不 queue）；
 * - stale validating job lease 过期 → fenced takeover（attempt+1）→ 新 owner finalize OK；
 * - 旧 owner finalize → changes=0（STALE_VALIDATION_OWNER）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, createC1aRequest, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runMaterializationJob} from '../src/worker/materialization-executor';
import {
  createMaterializationRequest,
  getActiveMaterializationJob,
  getMaterializationJob,
  finalizeValidatingJob,
  takeoverStaleValidatingJob,
  getProjection,
  MaterializationError,
} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-concurrency';
let fx: C1aFixture;

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // 1) 两 request 同 revision → 同一 active job
  const a = await createC1aRequest(fx, 'cc-1');
  const b = await createC1aRequest(fx, 'cc-2');
  ok(a.job.id === b.job.id, '两个 requestId fan-in 到同一 active job', a.job.id);
  const activeJobs = db
    .prepare(`SELECT count(*) c FROM voice_materialization_jobs
              WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status IN ('validating_existing','queued','running','indeterminate')`)
    .get(fx.profileId, fx.revisionId) as {c: number};
  ok(activeJobs.c === 1, '恰好一个 active job（single-flight）', activeJobs.c);
  ok(a.request.job_id === b.request.job_id && a.request.job_id === a.job.id, '两 request 链接同一 job');

  // 2) 并发 create（串行模拟两请求竞争）→ 仍恰好一个 active job
  await createC1aRequest(fx, 'cc-3');
  await createC1aRequest(fx, 'cc-4');
  const activeJobs2 = db
    .prepare(`SELECT count(*) c FROM voice_materialization_jobs
              WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status IN ('validating_existing','queued','running','indeterminate')`)
    .get(fx.profileId, fx.revisionId) as {c: number};
  ok(activeJobs2.c === 1, '并发 create 后仍恰好一个 active job', activeJobs2.c);

  // 3) fan-in 到实际执行：claim + Worker copy → 4 个 request 全部 succeeded + 同一 projection
  const claimed = claimNextAnyJob('cc-worker');
  ok(claimed !== null && claimed.type === 'voice_materialization' && claimed.job.id === a.job.id, 'claim fan-in job', claimed?.type);
  const cvm = claimed as {type: 'voice_materialization'; job: {id: string; owner_token: string | null; attempt: number}};
  await runMaterializationJob(
    {jobId: cvm.job.id, ownerToken: cvm.job.owner_token!, attempt: cvm.job.attempt},
    {log: () => undefined},
  );
  const proj = getProjection(fx.profileId, fx.revisionId);
  ok(proj !== undefined && proj.status === 'file_ready_unpublished', 'fan-in 执行后 projection=file_ready_unpublished', proj?.status);
  const reqs = db
    .prepare(`SELECT count(*) c FROM voice_materialization_requests
              WHERE job_id=? AND status='succeeded' AND materialization_id=?`)
    .get(a.job.id, proj!.id) as {c: number};
  ok(reqs.c === 4, '4 个 request 全部 succeeded + 同一 materialization', reqs.c);
  const jobDone = getMaterializationJob(a.job.id);
  ok(jobDone?.status === 'succeeded' && jobDone.owner_token === null, 'job succeeded + owner 清空', jobDone?.status);

  // 4) usable existing projection → reused（零文件写）
  const finalAbs = destinationAbsolutePath(proj!.destination_voice_root_relative_path);
  const before = fs.statSync(finalAbs).mtimeMs;
  const r4 = await createC1aRequest(fx, 'cc-5');
  ok(r4.outcome === 'reused', 'usable existing projection → reused（零文件写）', r4.outcome);
  ok(Math.abs(fs.statSync(finalAbs).mtimeMs - before) < 1000, 'reuse 未改写文件');

  // 5) unusable + subscriber → queued（第二 revision 完整链路：新 assignment → 新 request）
  const rev2 = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rev-cc2-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 700)},
    execDeps,
  );
  const rev2Row = rev2.outcome === 'created' || rev2.outcome === 'reused' ? rev2.revision : null;
  if (!rev2Row) throw new Error('rev2 ingest failed');
  const built2 = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: rev2Row.id,
    requestId: `asg-cc2-${crypto.randomUUID()}`,
  });
  if (built2.kind !== 'created' && built2.kind !== 'reused') throw new Error('assignment rev2 failed');
  const r5 = await createMaterializationRequest(fx.projectId, 'cc-6', built2.artifact.id);
  ok(r5.outcome === 'queued', 'unusable（无 projection）+ subscriber → queued', r5.outcome);
  ok(r5.job.status === 'queued', 'job queued（Scheduler 可见）', r5.job.status);

  // 6) zero subscriber → cancelled（第三 revision 直插 validating job，无 request 链接）
  const rev3 = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rev-cc3-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 900)},
    execDeps,
  );
  const rev3Row = rev3.outcome === 'created' || rev3.outcome === 'reused' ? rev3.revision : null;
  if (!rev3Row) throw new Error('rev3 ingest failed');
  const rev3Sha = sha256Buf(
    fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev3Row.id, 'reference.wav')),
  );
  const orphanJob = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v-o', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(orphanJob, fx.profileId, rev3Row.id, Date.now() + 60000, rev3Sha, `${fx.profileId}/${rev3Row.id}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  const oj = getMaterializationJob(orphanJob)!;
  const oc = finalizeValidatingJob(oj, {kind: 'unusable', reason: 'no projection'});
  ok(oc === 'cancelled', 'zero subscriber → cancelled（不 queue）', oc);

  // 7) stale validating job：lease 过期 → takeover（attempt+1）→ 新 owner finalize OK；
  //    旧 owner finalize → STALE_VALIDATION_OWNER（partial unique 已由 cancelled 释放）
  const staleJob = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'old-owner', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(staleJob, fx.profileId, rev3Row.id, Date.now() - 1000, rev3Sha, `${fx.profileId}/${rev3Row.id}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  const sj = getMaterializationJob(staleJob)!;
  ok(takeoverStaleValidatingJob(sj), 'stale lease → takeover CAS 成功');
  const sj2 = getMaterializationJob(staleJob)!;
  ok(sj2.validation_attempt === 2 && sj2.validation_owner_token !== 'old-owner', 'takeover attempt+1 + 换 owner', sj2.validation_attempt);
  // 新 owner finalize（unusable + 无 subscriber → cancelled）
  const freshOutcome = finalizeValidatingJob(sj2, {kind: 'unusable', reason: 'x'});
  ok(freshOutcome === 'cancelled', '新 owner finalize 成功（zero subscriber → cancelled）', freshOutcome);
  // 旧 owner finalize → STALE（changes=0，不得放行）
  try {
    finalizeValidatingJob({...sj, validation_owner_token: 'old-owner', validation_attempt: 1}, {kind: 'unusable', reason: 'x'});
    ok(false, '旧 owner finalize → 抛 STALE', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'STALE_VALIDATION_OWNER', '旧 owner finalize changes=0 → STALE_VALIDATION_OWNER', e);
  }

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-concurrency');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

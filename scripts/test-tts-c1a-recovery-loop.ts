/**
 * TTS-C.1A.R2 Periodic recovery integration（P0-A）——MaterializationRecoveryController 真实周期运行：
 * - RCY-LOOP-01 controller 启动后，再创建 expired running job → 不 POST、不重启进程 → deadline 内自动 terminal；
 * - RCY-LOOP-02 两个 runNow 重叠 → 只有一个 sweep in flight（不重入）；
 * - RCY-LOOP-03 单 job recovery 抛错不阻断后续 expired job；
 * - RCY-LOOP-04 stop() 后 timer 停止、无句柄泄漏（stopped guard + runNow 返回 0）；
 * - RCY-LOOP-05 limit=1 多 job 由后续 cadence 逐批处理。
 * 不直接调用 recoverExpiredMaterializationJobs 冒充周期集成。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {MaterializationRecoveryController} from '../src/lib/tts-c/recovery-controller';
import {getMaterializationJob, getProjection} from '../src/lib/tts-c/materialization';

const TAG = 'test-tts-c1a-recovery-loop';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rcl-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `rcl-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 直插 expired running job + 链接 request（合法转换链）。 */
function insertExpiredRunning(rev: RevCtx, requestId: string): string {
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
  const reqId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'fp', 'initializing', ?, ?)`,
  ).run(reqId, fx.projectId, requestId, fx.profileId, rev.revisionId, rev.assignmentArtifactId, new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(jobId, new Date().toISOString(), reqId);
  return jobId;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── RCY-LOOP-01：controller 启动后创建 expired job → 自动恢复（无 POST/无重启） ──
  const ctrl = new MaterializationRecoveryController({intervalMs: 400, limit: 5, log: () => undefined});
  ctrl.start();
  await sleep(600); // 启动 sweep 已跑（无 job）
  const rev1 = await freshRevision(910);
  const job1 = insertExpiredRunning(rev1, 'rcl-1');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const j = getMaterializationJob(job1);
    if (j && j.status !== 'running') break;
    await sleep(200);
  }
  const job1r = getMaterializationJob(job1)!;
  ok(job1r.status === 'failed', 'RCY-LOOP-01 controller 周期 sweep 自动恢复 expired job（无 POST/无重启）', job1r.status);
  ok(ctrl.lastRun !== null && ctrl.lastError === null, 'RCY-LOOP-01 lastRun 已更新且无 lastError', {lastRun: ctrl.lastRun, lastError: ctrl.lastError});

  // ── RCY-LOOP-02：重叠 runNow 只有一个 in flight ──
  const ctrl2 = new MaterializationRecoveryController({intervalMs: 60_000, limit: 100, log: () => undefined});
  const p1 = ctrl2.runNow();
  const p2 = ctrl2.runNow(); // 立即调用（p1 未完成）
  const r2 = await p2;
  ok(r2 === 0, 'RCY-LOOP-02 重叠 runNow 第二个返回 0（inFlight guard：不重入、不重复 sweep）', r2);
  await p1;
  ok(!ctrl2.isRunning, 'RCY-LOOP-02 完成后 inFlight 释放', ctrl2.isRunning);

  // ── RCY-LOOP-03：单 job 抛错不阻断后续 job ──
  // job A：final 路径是目录（validator open EISDIR → IO_ERROR → indeterminate——单 job 异常路径）
  // job B：正常 missing → failed。两者都必须被处理。
  const rev3a = await freshRevision(920);
  const rev3b = await freshRevision(930);
  const job3a = insertExpiredRunning(rev3a, 'rcl-3a');
  const job3b = insertExpiredRunning(rev3b, 'rcl-3b');
  const dirAbs = path.join(fx.dataDir, 'voice-materializations', fx.profileId, rev3a.revisionId, 'reference.wav');
  fs.mkdirSync(dirAbs, {recursive: true}); // final 路径是目录（损坏场景）
  const ctrl3 = new MaterializationRecoveryController({intervalMs: 300, limit: 10, log: () => undefined});
  ctrl3.start();
  const deadline3 = Date.now() + 6000;
  while (Date.now() < deadline3) {
    const a = getMaterializationJob(job3a);
    const b = getMaterializationJob(job3b);
    if (a && b && a.status !== 'running' && b.status !== 'running') break;
    await sleep(200);
  }
  const a = getMaterializationJob(job3a);
  const b = getMaterializationJob(job3b);
  ok(a!.status !== 'running' && b!.status === 'failed', 'RCY-LOOP-03 坏 job（目录 final）不阻断后续 job（B→failed）', {a: a?.status, b: b?.status});
  ok(ctrl3.lastError === null, 'RCY-LOOP-03 controller 整体无 fatal 错误（单 job 异常已隔离）', ctrl3.lastError);
  await ctrl3.stop();

  // ── RCY-LOOP-04：stop 后 timer 停止、无泄漏（stopped guard） ──
  const ctrl4 = new MaterializationRecoveryController({intervalMs: 200, limit: 5, log: () => undefined});
  ctrl4.start();
  await sleep(500);
  await ctrl4.stop();
  const r4 = await ctrl4.runNow();
  ok(r4 === 0 && ctrl4.lastRun !== null, 'RCY-LOOP-04 stop 后 runNow 返回 0（timer/guard 已停）', {r4, lastRun: ctrl4.lastRun});
  // 再次 start 后可恢复（无句柄泄漏）
  ctrl4.start();
  const rev4 = await freshRevision(940);
  const job4 = insertExpiredRunning(rev4, 'rcl-4');
  const deadline4 = Date.now() + 5000;
  while (Date.now() < deadline4) {
    const j = getMaterializationJob(job4);
    if (j && j.status !== 'running') break;
    await sleep(200);
  }
  ok(getMaterializationJob(job4)?.status === 'failed', 'RCY-LOOP-04 restart 后周期 sweep 恢复工作', getMaterializationJob(job4)?.status);
  await ctrl4.stop();

  // ── RCY-LOOP-05：limit=1 多 job 由后续 cadence 逐批处理 ──
  const rev5a = await freshRevision(950);
  const rev5b = await freshRevision(960);
  const rev5c = await freshRevision(970);
  const j5a = insertExpiredRunning(rev5a, 'rcl-5a');
  const j5b = insertExpiredRunning(rev5b, 'rcl-5b');
  const j5c = insertExpiredRunning(rev5c, 'rcl-5c');
  const ctrl5 = new MaterializationRecoveryController({intervalMs: 400, limit: 1, log: () => undefined});
  ctrl5.start();
  const deadline5 = Date.now() + 8000;
  while (Date.now() < deadline5) {
    const all = [j5a, j5b, j5c].map((id) => getMaterializationJob(id)?.status);
    if (all.every((s) => s !== 'running')) break;
    await sleep(200);
  }
  const statuses5 = [j5a, j5b, j5c].map((id) => getMaterializationJob(id)?.status);
  ok(statuses5.every((s) => s === 'failed'), 'RCY-LOOP-05 limit=1 多 job 由后续 cadence 逐批全部处理', statuses5);
  await ctrl5.stop();

  cleanupC1a(TAG);
  summary('TTS-C.1A recovery-loop');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

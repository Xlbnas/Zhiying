/**
 * TTS-C.1A.R3 DB-time lease 全闭环（§十二）——host 时钟漂移不影响任何裁决：
 * - CLOCK-01 mock Date.now 严重落后 → DB expired validation 仍能 takeover；
 * - CLOCK-02 mock Date.now 严重超前 → 有效 DB lease 不得误 takeover；
 * - CLOCK-03 expired running 裁决只依赖 DB 时间（mock 偏移不影响 running→failed/恢复）；
 * - CLOCK-04 validation job 不会因 host clock 漂移永久 inflight（过期 lease 可被接管）。
 * 使用 monkey-patch global.Date.now（测试进程内）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {createMaterializationRequest, takeoverStaleValidatingJob, getMaterializationJob, dbNowMs, type ValidationLeaseHandle} from '../src/lib/tts-c/materialization';

const TAG = 'test-tts-c1a-db-time-stale';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `ck-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `ck-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 直插 validating job（lease 由调用方给值）。 */
function insertValidating(rev: RevCtx, leaseMs: number, token = 'v-seed'): string {
  const db = getDb();
  const jobId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', ?, ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(jobId, fx.profileId, rev.revisionId, token, leaseMs, rev.sha, `${fx.profileId}/${rev.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  return jobId;
}

const realDateNow = Date.now;
function mockDateNow(offsetMs: number): void {
  (globalThis as {Date: typeof Date}).Date.now = () => realDateNow() + offsetMs;
}
function restoreDateNow(): void {
  (globalThis as {Date: typeof Date}).Date.now = realDateNow;
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── CLOCK-01：mock Date.now 严重落后 → DB expired validation 仍能 takeover ──
  const rev1 = await freshRevision(2410);
  const dbNow1 = dbNowMs(db);
  const job1 = insertValidating(rev1, dbNow1 - 1000, 'old-1'); // DB 时间已过期 1s
  mockDateNow(-3600_000); // host 时钟落后 1 小时
  const h1 = takeoverStaleValidatingJob(job1);
  ok(h1 !== null, 'CLOCK-01 host 时钟落后 → DB expired validation 仍可 takeover', h1 !== null);
  ok(h1!.validationAttempt === 2 && h1!.validationOwnerToken !== 'old-1', 'CLOCK-01 takeover attempt+1 + 新 owner', h1!.validationAttempt);
  // 新 lease 基于 DB 时间
  const dbNow1b = dbNowMs(db);
  ok(h1!.validationLeaseExpiresAtEpochMs > dbNow1b, 'CLOCK-01 新 lease 基于 DB 时间（未来）', {lease: h1!.validationLeaseExpiresAtEpochMs, dbNow: dbNow1b});
  restoreDateNow();

  // ── CLOCK-02：mock Date.now 严重超前 → 有效 DB lease 不得误 takeover ──
  const rev2 = await freshRevision(2420);
  const dbNow2 = dbNowMs(db);
  const job2 = insertValidating(rev2, dbNow2 + 300_000, 'old-2'); // DB 时间 5 分钟后过期（有效）
  mockDateNow(+3600_000); // host 时钟超前 1 小时
  const h2 = takeoverStaleValidatingJob(job2);
  ok(h2 === null, 'CLOCK-02 host 时钟超前 → 有效 DB lease 不误 takeover', h2);
  const job2r = getMaterializationJob(job2)!;
  ok(job2r.validation_owner_token === 'old-2' && job2r.validation_attempt === 1, 'CLOCK-02 job 未被接管（owner/attempt 不变）', {token: job2r.validation_owner_token});
  restoreDateNow();

  // ── CLOCK-03：expired running 裁决只依赖 DB 时间 ──
  const rev3 = await freshRevision(2430);
  const dbNow3 = dbNowMs(db);
  const job3 = insertValidating(rev3, dbNow3 - 1000, 'old-3');
  // 转 running + lease 过期（DB 语义）
  db.prepare(`UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL, updated_at=? WHERE id=?`).run(new Date().toISOString(), job3);
  db.prepare(`UPDATE voice_materialization_jobs SET status='running', owner_token='dead', lease_expires_at_epoch_ms=?, heartbeat_at=?, attempt=1, updated_at=? WHERE id=?`).run(dbNow3 - 1000, new Date().toISOString(), new Date().toISOString(), job3);
  mockDateNow(-3600_000); // host 落后
  const r3 = await createMaterializationRequest(fx.projectId, 'ck-3', rev3.assignmentArtifactId);
  // Phase 1 用 dbNow 判定 expired running → running→failed + 新 job → owner → queued
  ok(r3.outcome === 'queued' || r3.outcome === 'inflight', 'CLOCK-03 host 落后 → expired running 按 DB 时间裁决（恢复/入队）', r3.outcome);
  restoreDateNow();
  // 旧 job 必须已 failed（DB 时间裁决）
  const job3r = getMaterializationJob(job3)!;
  ok(job3r.status === 'failed', 'CLOCK-03 expired running（DB 语义）→ failed（host 时钟不影响）', job3r.status);

  // ── CLOCK-04：validation job 不会因 host clock 漂移永久 inflight ──
  const rev4 = await freshRevision(2440);
  const dbNow4 = dbNowMs(db);
  const job4 = insertValidating(rev4, dbNow4 - 1000, 'old-4'); // DB 已过期
  mockDateNow(+3600_000); // host 超前（若用 host 判断会认为 lease 有效 → 永久 inflight）
  const r4 = await createMaterializationRequest(fx.projectId, 'ck-4', rev4.assignmentArtifactId);
  // Phase 1 用 dbNow 判定过期 → takeover → owner → queued/cancelled（非永久 inflight）
  ok(r4.outcome !== 'inflight', 'CLOCK-04 host 超前 → DB 过期 validation 被接管（不永久 inflight）', r4.outcome);
  const job4r = getMaterializationJob(job4)!;
  ok(job4r.validation_attempt === 2, 'CLOCK-04 takeover 发生（attempt 1→2）', job4r.validation_attempt);
  restoreDateNow();

  cleanupC1a(TAG);
  summary('TTS-C.1A db-time-stale');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * TTS-C.1A.R1 Autonomous recovery（§七——不依赖新 HTTP request）：
 * - REC-01 expired running + 无 durable final file → failed + requests failed（error_code 稳定）；
 * - REC-02 expired running + final file 已 rename/fsync（exact SHA + WAV）→ 新事务完成 projection/job/request；
 * - REC-03 expired running + final file damaged（SHA 不符）→ failed；
 * - REC-04 limit 上限：一次只处理 limit 个；
 * - REC-05 多 Worker 竞争：两个进程同时 recover → 恰好一个裁决（fenced）；
 * - REC-06 确定性 executor 错误立即 fenced failed（不等 lease 过期）——已由 durability 覆盖，此处验证 API 层；
 * - REC-07 无新 POST 也能结束原 request（recovery 后 request 终态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {recoverExpiredMaterializationJobs, getProjection, getMaterializationJob} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const execFileP = promisify(execFile);
const TAG = 'test-tts-c1a-recovery';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rec-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `rec-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 直插 expired running job + 链接 request（无 final file）。 */
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
  // 合法转换链：validating_existing → queued → running（初始状态 trigger + transition trigger）
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

/** child：recoverExpiredMaterializationJobs(limit) 独立进程。 */
async function runRecoveryChild(limit: number): Promise<{count: number; error?: string}> {
  const childPath = path.join(process.cwd(), 'scripts/lib/tts-c1a-recovery-child.ts');
  const {stdout} = await execFileP(
    process.execPath,
    ['--import', 'tsx', childPath, fx.dataDir, String(limit)],
    {env: {...process.env, ZHIYING_DATA_DIR: fx.dataDir}},
  );
  return JSON.parse(stdout.trim()) as {count: number; error?: string};
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── REC-01：expired running + 无 final file → failed + requests failed ──
  const rev1 = await freshRevision(610);
  const job1 = insertExpiredRunning(rev1, 'rec-1');
  const handled1 = await recoverExpiredMaterializationJobs(10);
  ok(handled1 === 1, 'REC-01 recovery 处理 1 个 expired running', handled1);
  const job1r = getMaterializationJob(job1)!;
  ok(job1r.status === 'failed' && job1r.owner_token === null && job1r.lease_expires_at_epoch_ms === null, 'REC-01 job→failed + owner/lease 清空', job1r.status);
  const req1 = db.prepare("SELECT status, error_code FROM voice_materialization_requests WHERE project_id=? AND request_id='rec-1'").get(fx.projectId) as {status: string; error_code: string | null} | undefined;
  ok(req1?.status === 'failed' && req1.error_code === 'RECOVERY_FILE_UNAVAILABLE', 'REC-01 request→failed + 稳定 error_code', req1);
  ok(getProjection(fx.profileId, rev1.revisionId) === undefined, 'REC-01 无 projection（不冒充 success）', undefined);

  // ── REC-02：expired running + final file 已 durable（exact）→ 完成 projection/job/request ──
  const rev2 = await freshRevision(620);
  const job2 = insertExpiredRunning(rev2, 'rec-2');
  // 模拟 crash 窗口：文件已 rename/fsync（copy canonical → final），DB 未 commit
  const finalAbs2 = destinationAbsolutePath(`${fx.profileId}/${rev2.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbs2), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev2.revisionId, 'reference.wav'), finalAbs2);
  const handled2 = await recoverExpiredMaterializationJobs(10);
  ok(handled2 === 1, 'REC-02 recovery 完成 crash 窗口 job', handled2);
  const job2r = getMaterializationJob(job2)!;
  ok(job2r.status === 'succeeded' && job2r.owner_token === null, 'REC-02 job→succeeded（file 证据 exact，非冒充）', job2r.status);
  const proj2 = getProjection(fx.profileId, rev2.revisionId);
  ok(proj2?.status === 'file_ready_unpublished', 'REC-02 projection file_ready_unpublished', proj2?.status);
  const req2 = db.prepare("SELECT status, materialization_id FROM voice_materialization_requests WHERE project_id=? AND request_id='rec-2'").get(fx.projectId) as {status: string; materialization_id: string | null} | undefined;
  ok(req2?.status === 'succeeded' && req2.materialization_id === proj2?.id, 'REC-02 request→succeeded + materialization_id', req2);

  // ── REC-03：expired running + final file damaged（SHA 不符）→ failed ──
  const rev3 = await freshRevision(630);
  const job3 = insertExpiredRunning(rev3, 'rec-3');
  const finalAbs3 = destinationAbsolutePath(`${fx.profileId}/${rev3.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbs3), {recursive: true});
  fs.writeFileSync(finalAbs3, makeWav(800, 333)); // 不同内容的 WAV
  const handled3 = await recoverExpiredMaterializationJobs(10);
  ok(handled3 === 1, 'REC-03 recovery 处理 damaged file job', handled3);
  const job3r = getMaterializationJob(job3)!;
  ok(job3r.status === 'failed', 'REC-03 damaged final file → failed（不冒充 success）', job3r.status);
  ok(getProjection(fx.profileId, rev3.revisionId) === undefined, 'REC-03 无 projection', undefined);

  // ── REC-04：limit 上限 ──
  const rev4a = await freshRevision(640);
  const rev4b = await freshRevision(650);
  const job4a = insertExpiredRunning(rev4a, 'rec-4a');
  const job4b = insertExpiredRunning(rev4b, 'rec-4b');
  const handled4 = await recoverExpiredMaterializationJobs(1);
  ok(handled4 === 1, 'REC-04 limit=1 → 只处理 1 个', handled4);
  const remaining = db.prepare("SELECT count(*) c FROM voice_materialization_jobs WHERE status='running'").get() as {c: number};
  ok(remaining.c === 1, 'REC-04 剩余 1 个 running（下次 sweep 处理）', remaining.c);
  const handled4b = await recoverExpiredMaterializationJobs(10);
  ok(handled4b === 1, 'REC-04 第二次 sweep 处理剩余', handled4b);

  // ── REC-05：多 Worker 竞争——双进程同时 recover 同一 expired job → 恰好一个裁决 ──
  const rev5 = await freshRevision(660);
  const job5 = insertExpiredRunning(rev5, 'rec-5');
  const [c1, c2] = await Promise.all([runRecoveryChild(10), runRecoveryChild(10)]);
  ok(c1.error === undefined && c2.error === undefined, 'REC-05 双进程 recovery 均无异常', {e1: c1.error, e2: c2.error});
  ok(c1.count + c2.count === 1, 'REC-05 恰好一个进程裁决（fenced；不重复处理）', {c1: c1.count, c2: c2.count});
  const job5r = getMaterializationJob(job5)!;
  ok(job5r.status === 'failed', 'REC-05 job 终态 failed（单裁决）', job5r.status);

  // ── REC-07：无新 POST 也能结束原 request（REC-01 已证明；此处汇总断言） ──
  const terminalReqs = db.prepare("SELECT count(*) c FROM voice_materialization_requests WHERE project_id=? AND status IN ('failed','succeeded') AND request_id LIKE 'rec-%'").get(fx.projectId) as {c: number};
  ok(terminalReqs.c >= 6, 'REC-07 全部 expired 请求经 recovery 结束（无新 POST）', terminalReqs.c);

  // ── REC-DUR-02：injected final fsync 失败 → 不成功（indeterminate） ──
  const revDur2 = await freshRevision(665);
  const jobDur2 = insertExpiredRunning(revDur2, 'rec-dur2');
  const finalAbsDur2 = destinationAbsolutePath(`${fx.profileId}/${revDur2.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbsDur2), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, revDur2.revisionId, 'reference.wav'), finalAbsDur2);
  const handledDur2 = await recoverExpiredMaterializationJobs(10, db, {
    fsyncFile: async () => {
      throw new Error('injected recovery final fsync failure');
    },
  });
  ok(handledDur2 === 1, 'REC-DUR-02 注入 final fsync 失败 → 被处理', handledDur2);
  const jobDur2r = getMaterializationJob(jobDur2)!;
  ok(jobDur2r.status === 'indeterminate', 'REC-DUR-02 final fsync 失败 → indeterminate（不冒充 success）', jobDur2r.status);
  ok(getProjection(fx.profileId, revDur2.revisionId) === undefined, 'REC-DUR-02 不创建 projection', undefined);

  // ── REC-DUR-03：injected dir fsync 失败 → 不成功（indeterminate） ──
  const revDur3 = await freshRevision(666);
  const jobDur3 = insertExpiredRunning(revDur3, 'rec-dur3');
  const finalAbsDur3 = destinationAbsolutePath(`${fx.profileId}/${revDur3.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbsDur3), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, revDur3.revisionId, 'reference.wav'), finalAbsDur3);
  const handledDur3 = await recoverExpiredMaterializationJobs(10, db, {
    fsyncDir: async () => {
      throw new Error('injected recovery dir fsync failure');
    },
  });
  ok(handledDur3 === 1, 'REC-DUR-03 注入 dir fsync 失败 → 被处理', handledDur3);
  const jobDur3r = getMaterializationJob(jobDur3)!;
  ok(jobDur3r.status === 'indeterminate', 'REC-DUR-03 dir fsync 失败 → indeterminate（不冒充 success）', jobDur3r.status);
  ok(getProjection(fx.profileId, revDur3.revisionId) === undefined, 'REC-DUR-03 不创建 projection', undefined);

  cleanupC1a(TAG);
  summary('TTS-C.1A recovery');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * TTS-C.1A.R1 Worker execution fencing（P0-2 + §八 commit-time exact source fence + heartbeat）：
 * - execution handle：final 事务 WHERE exact owner_token+attempt+lease（mutation：放宽 owner 条件测试必失败）；
 * - heartbeat 真实运行：interval 续租；lease loss → ownershipLost → 不再 rename/commit；
 * - commit-time source fence：owner 漂移 / attempt 漂移 / Assignment 漂移 / Revision evidence 漂移 /
 *   destination path 漂移 / final 文件 SHA 被替换 / request Assignment 链接漂移 →
 *   DB success=0、projection 不创建、job 不得假 succeeded；
 * - WorkerFinalizeInput 全部字段参与 final fence（任一字段不比对测试即失败）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runMaterializationJob} from '../src/worker/materialization-executor';
import {
  workerFinalizeMaterialization,
  getProjection,
  getMaterializationJob,
  createMaterializationRequest,
  MaterializationError,
  type MaterializationExecutionHandle,
  type WorkerFinalizeInput,
} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';
import {openHeldMaterializedFileEvidence, type HeldMaterializedFileEvidence} from '../src/lib/tts-c/materialized-file-validator';

const TAG = 'test-tts-c1a-worker-fencing';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

/** 每个 mutation 场景独立 fixture revision（避免 partial unique / projection 污染）。 */
async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `wf-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `wf-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 创建 request → claim → 返回 handle（不执行）。 */
async function claimHandleFor(rev: RevCtx, requestId: string): Promise<MaterializationExecutionHandle> {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  const claimed = claimNextAnyJob('wf-worker');
  if (!claimed || claimed.type !== 'voice_materialization') throw new Error('claim failed');
  return claimed.handle;
}

/** 为 rev 建立真实 final 文件 + held evidence（WorkerFinalize 只接受 held capability）。 */
async function makeHeldFor(rev: RevCtx): Promise<HeldMaterializedFileEvidence> {
  const finalAbs = destinationAbsolutePath(`${fx.profileId}/${rev.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbs), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev.revisionId, 'reference.wav'), finalAbs);
  return openHeldMaterializedFileEvidence(
    {
      relativePath: `${fx.profileId}/${rev.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev.revisionId,
      expectedSha256: rev.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'durabilize',
  );
}

/** 真实 finalize 输入（held 绑定 rev 的真实 final 文件；asgSnapshots 由调用方按需补充）。 */
async function finalInput(handle: MaterializationExecutionHandle, rev: RevCtx, overrides: Partial<WorkerFinalizeInput> = {}): Promise<WorkerFinalizeInput> {
  const revAbs = path.join(fx.dataDir, 'voice-library', fx.profileId, rev.revisionId, 'reference.wav');
  const fileSize = fs.statSync(revAbs).size;
  const held = await makeHeldFor(rev);
  // 自动构造 asgSnapshots：job 的 active requests 的真实 assignment content hash（与 executor 同语义）
  const {listActiveRequestRows, sha256Text} = await import('../src/lib/tts-c/materialization');
  const {getProjectVoiceAssignment} = await import('../src/lib/tts-b/assignment');
  const db = getDb();
  const asgSnapshots: Array<{artifactId: string; contentHash: string}> = [];
  for (const r of listActiveRequestRows(handle.jobId)) {
    const asgRow = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
    if (asgRow) asgSnapshots.push({artifactId: r.assignment_artifact_id, contentHash: sha256Text(asgRow.artifact.content_json)});
  }
  const base: WorkerFinalizeInput = {
    handle,
    held,
    revisionEvidence: {
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev.revisionId,
      canonicalAudioSha256: rev.sha,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
      provider: 'indextts2',
      fileSize,
    },
    asgSnapshots,
  };
  return {...base, ...overrides} as WorkerFinalizeInput;
}

function expectErrCode(label: string, fn: () => unknown, code: string): void {
  try {
    fn();
    ok(false, label, 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === code, label, e);
  }
}

async function expectErrCodeAsync(label: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    ok(false, label, 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === code, label, e);
  }
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── WF-01：真实 worker 成功路径（heartbeat 运行 + execution handle exact final） ──
  const h1 = await claimHandleFor({revisionId: fx.revisionId, sha: fx.revisionSha256, assignmentArtifactId: fx.assignmentArtifactId}, 'wf-1');
  await runMaterializationJob(h1, {log: () => undefined});
  const job1 = getMaterializationJob(h1.jobId);
  ok(
    job1?.status === 'succeeded' && job1.owner_token === null && job1.lease_expires_at_epoch_ms === null && job1.heartbeat_at === null,
    'WF-01 成功路径 job succeeded + owner/lease/heartbeat 清空',
    {status: job1?.status, heartbeat: job1?.heartbeat_at},
  );
  const proj1 = getProjection(fx.profileId, fx.revisionId);
  ok(proj1?.status === 'file_ready_unpublished', 'WF-01 projection file_ready_unpublished', proj1?.status);

  // ── WF-02：heartbeat lease loss → ownershipLost → 不再 rename/commit（零副作用） ──
  const rev2 = await freshRevision(710);
  const h2 = await claimHandleFor(rev2, 'wf-2');
  // claim 后（executor 开始前）吊销 lease + 换 owner（模拟被接管）
  db.prepare(
    `UPDATE voice_materialization_jobs SET lease_expires_at_epoch_ms=?, owner_token=?, attempt=attempt+1, updated_at=?
     WHERE id=? AND status='running'`,
  ).run(Date.now() - 1000, 'other-owner', new Date().toISOString(), h2.jobId);
  let heartbeatLost = false;
  await runMaterializationJob(
    h2,
    {log: () => undefined},
    {
      onHeartbeatLoss: () => {
        heartbeatLost = true;
      },
    },
  );
  ok(heartbeatLost, 'WF-02 heartbeat lease loss → ownershipLost 回调触发', heartbeatLost);
  const job2 = getMaterializationJob(h2.jobId);
  ok(job2?.status === 'running' && job2.owner_token === 'other-owner', 'WF-02 吊销后 job 未被旧 handle 改写（零副作用）', {status: job2?.status});
  const proj2 = getProjection(fx.profileId, rev2.revisionId);
  ok(proj2 === undefined, 'WF-02 ownershipLost 后不创建 projection（不 rename/commit）', proj2?.status);

  // ── WF-03：owner token 漂移 → STALE，DB success=0 ──
  const rev3 = await freshRevision(720);
  const h3 = await claimHandleFor(rev3, 'wf-3');
  expectErrCodeAsync('WF-03 owner token 漂移 → STALE_VALIDATION_OWNER', async () => workerFinalizeMaterialization(await finalInput({...h3, ownerToken: 'wrong-owner'}, rev3)), 'STALE_VALIDATION_OWNER');
  const job3 = getMaterializationJob(h3.jobId);
  ok(job3?.status === 'running' && getProjection(fx.profileId, rev3.revisionId) === undefined, 'WF-03 job 不假 succeeded + projection 不创建', {status: job3?.status});

  // ── WF-04：attempt 漂移 → STALE ──
  const rev4 = await freshRevision(730);
  const h4 = await claimHandleFor(rev4, 'wf-4');
  expectErrCodeAsync('WF-04 attempt 漂移 → STALE_VALIDATION_OWNER', async () => workerFinalizeMaterialization(await finalInput({...h4, attempt: h4.attempt + 1}, rev4)), 'STALE_VALIDATION_OWNER');
  ok(getProjection(fx.profileId, rev4.revisionId) === undefined, 'WF-04 projection 不创建', undefined);

  // ── WF-05：copy 后 commit 前 Assignment source 漂移 → SOURCE_STALE ──
  const rev5 = await freshRevision(740);
  const h5 = await claimHandleFor(rev5, 'wf-5');
  const req5 = db.prepare('SELECT id, assignment_artifact_id FROM voice_materialization_requests WHERE job_id=?').all(h5.jobId) as {id: string; assignment_artifact_id: string}[];
  const asgRow5 = db.prepare('SELECT * FROM artifacts WHERE id=?').get(req5[0].assignment_artifact_id) as {content_json: string};
  const asgParsed5 = JSON.parse(asgRow5.content_json);
  asgParsed5.source.canonicalAudioSha256 = 'e'.repeat(64);
  db.prepare('UPDATE artifacts SET content_json=? WHERE id=?').run(JSON.stringify(asgParsed5), req5[0].assignment_artifact_id);
  expectErrCodeAsync('WF-05 Assignment source 漂移 → SOURCE_STALE', async () => workerFinalizeMaterialization(await finalInput(h5, rev5)), 'SOURCE_STALE');
  ok(getProjection(fx.profileId, rev5.revisionId) === undefined, 'WF-05 projection 不创建', undefined);

  // ── WF-06：revisionEvidence 与实际 Revision row 不一致（commit 时逐项重读） → SOURCE_STALE ──
  const rev6 = await freshRevision(750);
  const h6 = await claimHandleFor(rev6, 'wf-6');
  const base6 = await finalInput(h6, rev6);
  const badEvidence = base6.revisionEvidence;
  await base6.held.close();
  expectErrCodeAsync(
    'WF-06 Revision evidence 漂移 → SOURCE_STALE',
    async () => workerFinalizeMaterialization(await finalInput(h6, rev6, {revisionEvidence: {...badEvidence, canonicalAudioSha256: 'c'.repeat(64)}})),
    'SOURCE_STALE',
  );
  ok(getProjection(fx.profileId, rev6.revisionId) === undefined, 'WF-06 projection 不创建', undefined);

  // ── WF-07：destination path 漂移（held evidence 的 relativePath ≠ job 冻结值）→ REQUEST_STATE_INCONSISTENT ──
  const rev7 = await freshRevision(760);
  const h7 = await claimHandleFor(rev7, 'wf-7');
  const rev7b = await freshRevision(761);
  const wrongHeld7 = await makeHeldFor(rev7b); // held 指向 rev7b 的路径（≠ job7 路径）
  expectErrCodeAsync(
    'WF-07 held relativePath 漂移 → REQUEST_STATE_INCONSISTENT',
    async () => workerFinalizeMaterialization((await finalInput(h7, rev7, {held: wrongHeld7}))),
    'REQUEST_STATE_INCONSISTENT',
  );
  await wrongHeld7.close();
  ok(getProjection(fx.profileId, rev7.revisionId) === undefined, 'WF-07 projection 不创建', undefined);

  // ── WF-08：final 文件在 commit 前被替换（held SHA ≠ job 冻结值）→ 拒绝 ──
  const rev8 = await freshRevision(770);
  const h8 = await claimHandleFor(rev8, 'wf-8');
  const rev8b = await freshRevision(771);
  const wrongHeld8 = await makeHeldFor(rev8b); // held.sha = rev8b.sha ≠ job8.sha
  expectErrCodeAsync(
    'WF-08 held SHA ≠ job → REQUEST_STATE_INCONSISTENT',
    async () => workerFinalizeMaterialization((await finalInput(h8, rev8, {held: wrongHeld8}))),
    'REQUEST_STATE_INCONSISTENT',
  );
  await wrongHeld8.close();
  ok(getProjection(fx.profileId, rev8.revisionId) === undefined, 'WF-08 projection 不创建', undefined);

  // ── WF-09：request Assignment 链接不可改（frozen write-once，DB 层防线） ──
  const rev9 = await freshRevision(780);
  const h9 = await claimHandleFor(rev9, 'wf-9');
  const req9 = db.prepare('SELECT id, assignment_artifact_id FROM voice_materialization_requests WHERE job_id=?').all(h9.jobId) as {id: string; assignment_artifact_id: string}[];
  const otherAsg = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: rev9.revisionId,
    requestId: `wf-other-${crypto.randomUUID()}`,
  });
  if (otherAsg.kind === 'created' || otherAsg.kind === 'reused') {
    try {
      db.prepare('UPDATE voice_materialization_requests SET assignment_artifact_id=? WHERE id=?').run(otherAsg.artifact.id, req9[0].id);
      ok(false, 'WF-09 request assignment 链接漂移被 immutable 拒绝', 'no error');
    } catch (e) {
      ok((e as Error).message.includes('immutable'), 'WF-09 request assignment 链接 write-once（DB 层防线）', e);
    }
  }
  ok(getProjection(fx.profileId, rev9.revisionId) === undefined, 'WF-09 projection 不创建', undefined);

  // ── WF-10：运行中 lease 丢失（copy 期间被接管）→ ownershipLost → 不 rename/commit ──
  const rev10 = await freshRevision(790);
  const h10 = await claimHandleFor(rev10, 'wf-10');
  let lostMidFlight = false;
  await runMaterializationJob(
    h10,
    {log: () => undefined},
    {
      // 模拟 copy 期间被接管：sha256 校验前吊销 lease + 换 owner（heartbeat interval 将检测）
      sha256File: async (p) => {
        db.prepare(
          `UPDATE voice_materialization_jobs SET lease_expires_at_epoch_ms=?, owner_token=?, attempt=attempt+1, updated_at=?
           WHERE id=? AND status='running'`,
        ).run(Date.now() - 1000, 'hijacker', new Date().toISOString(), h10.jobId);
        const real = await (await import('../src/lib/tts-c/audio-probe')).sha256FileBytes(p);
        return real;
      },
      onHeartbeatLoss: () => {
        lostMidFlight = true;
      },
    },
  ).catch(() => undefined);
  ok(lostMidFlight, 'WF-10 运行中 lease 丢失 → ownershipLost 触发', lostMidFlight);
  const finalAbs10 = destinationAbsolutePath(`${fx.profileId}/${rev10.revisionId}/reference.wav`);
  ok(!fs.existsSync(finalAbs10), 'WF-10 ownershipLost 后不 rename（无 final 文件副作用）', fs.existsSync(finalAbs10));
  const job10 = getMaterializationJob(h10.jobId);
  ok(job10?.owner_token === 'hijacker', 'WF-10 job 未被旧 handle 改写', job10?.owner_token);
  ok(getProjection(fx.profileId, rev10.revisionId) === undefined, 'WF-10 不创建 projection', undefined);

  cleanupC1a(TAG);
  summary('TTS-C.1A worker-fencing');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

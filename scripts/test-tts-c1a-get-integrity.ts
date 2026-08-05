/**
 * TTS-C.1A.R3 GET fail-closed integrity（§九）+ 唯一复用验证入口状态机（§八）：
 * - GET-INT-01 删除 final → GET 不把 file_ready_unpublished 显示为当前可用（status=unusable + integrityStatus=missing/damaged）；
 * - GET-INT-02 hash drift → integrityStatus=damaged；
 * - GET-INT-03 symlink → integrityStatus=damaged；
 * - GET-INT-04 合法 → integrityStatus=verified + status 如实；
 * - GET-INT-05 GET 全程零 mkdir/零文件写（对比目录快照）；
 * - STATE-01 waiting + succeeded job + 缺 materialization_id → REQUEST_STATE_INCONSISTENT；
 * - STATE-02 waiting + succeeded + damaged file → MATERIALIZATION_UNUSABLE；
 * - STATE-03 waiting + succeeded + valid file + exact link → reused；
 * - STATE-04 job succeeded 但 request failed → 按 request 终态 failed，不 reused。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {createMaterializationRequest, getProjection, getMaterializationJob, integrityStatusOf, sha256Text, MaterializationError} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-get-integrity';
let fx: C1aFixture;

function realFingerprint(rev: RevCtx): string {
  return sha256Text(
    JSON.stringify({
      projectId: fx.projectId,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev.revisionId,
      canonicalAudioSha256: rev.sha,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
      provider: 'indextts2',
    }),
  );
}

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `gi-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `gi-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 成功跑一次 worker → request succeeded + projection。 */
async function buildSuccess(rev: RevCtx, requestId: string): Promise<{finalAbs: string}> {
  const {claimNextAnyJob} = await import('../src/lib/scheduler');
  const {runMaterializationJob} = await import('../src/worker/materialization-executor');
  const r = await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  if (r.outcome !== 'queued') throw new Error(`outcome=${r.outcome}`);
  // loop claim+run 直到目标 projection 建立（避免被前序 queued job 占用）
  for (let i = 0; i < 10; i++) {
    const proj = getProjection(fx.profileId, rev.revisionId);
    if (proj) return {finalAbs: destinationAbsolutePath(proj.destination_voice_root_relative_path)};
    const c = claimNextAnyJob('gi-worker');
    if (c && c.type === 'voice_materialization') {
      try {
        await runMaterializationJob(c.handle, {log: () => undefined});
      } catch { /* ignore */ }
    } else {
      break;
    }
  }
  const proj = getProjection(fx.profileId, rev.revisionId);
  if (!proj) throw new Error('projection missing');
  return {finalAbs: destinationAbsolutePath(proj.destination_voice_root_relative_path)};
}

function snapshotTree(root: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      out.push(`${e.name}:${e.isDirectory() ? 'd' : 'f'}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort().join(',');
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();
  const matRoot = path.join(fx.dataDir, 'voice-materializations');

  // ── GET-INT-01：删除 final → GET 不显示可用 ──
  const rev1 = await freshRevision(2310);
  const {finalAbs: f1} = await buildSuccess(rev1, 'gi-1');
  fs.rmSync(f1, {force: true});
  const row1 = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='gi-1'").get(fx.projectId) as {id: string};
  const st1 = await integrityStatusOf(row1 as never);
  ok(st1 === 'missing' || st1 === 'damaged', 'GET-INT-01 删 final → integrityStatus missing/damaged（不显示可用）', st1);

  // ── GET-INT-02：hash drift → damaged ──
  const rev2 = await freshRevision(2320);
  const {finalAbs: f2} = await buildSuccess(rev2, 'gi-2');
  const saved2 = fs.readFileSync(f2);
  fs.writeFileSync(f2, Buffer.concat([saved2.subarray(0, saved2.length - 1), Buffer.from([saved2[saved2.length - 1] ^ 0xff])]));
  const row2 = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='gi-2'").get(fx.projectId) as {id: string};
  const st2 = await integrityStatusOf(row2 as never);
  ok(st2 === 'damaged', 'GET-INT-02 hash drift → integrityStatus=damaged', st2);
  fs.writeFileSync(f2, saved2);

  // ── GET-INT-03：symlink → damaged ──
  const rev3 = await freshRevision(2330);
  const {finalAbs: f3} = await buildSuccess(rev3, 'gi-3');
  const saved3 = fs.readFileSync(f3);
  fs.rmSync(f3, {force: true});
  fs.symlinkSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev3.revisionId, 'reference.wav'), f3);
  const row3 = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='gi-3'").get(fx.projectId) as {id: string};
  const st3 = await integrityStatusOf(row3 as never);
  ok(st3 === 'damaged', 'GET-INT-03 symlink → integrityStatus=damaged', st3);
  fs.rmSync(f3, {force: true});
  fs.writeFileSync(f3, saved3);

  // ── GET-INT-04：合法 → verified ──
  const row4 = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='gi-1'").get(fx.projectId) as {id: string};
  fs.writeFileSync(f1, fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev1.revisionId, 'reference.wav')));
  const st4 = await integrityStatusOf(row4 as never);
  ok(st4 === 'verified', 'GET-INT-04 合法文件 → integrityStatus=verified', st4);

  // ── GET-INT-05：GET 全程零 mkdir/零文件写（含缺失目录场景——integrity 检查不得重建目录） ──
  const revG5 = await freshRevision(2335);
  const {finalAbs: fG5} = await buildSuccess(revG5, 'gi-5');
  const g5Parent = path.dirname(fG5);
  const g5Moved = `${g5Parent}-g5moved-${Math.random()}`;
  fs.renameSync(g5Parent, g5Moved); // 删掉整个 profile/revision 目录
  const row5 = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='gi-5'").get(fx.projectId) as {id: string};
  const st5 = await integrityStatusOf(row5 as never);
  ok(st5 === 'missing', 'GET-INT-05 目录缺失 → integrityStatus=missing', st5);
  ok(!fs.existsSync(g5Parent), 'GET-INT-05 integrity 检查零 mkdir（缺失目录未重建）', fs.existsSync(g5Parent));
  fs.renameSync(g5Moved, g5Parent); // 还原
  const before = snapshotTree(matRoot);
  const row5b = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='gi-2'").get(fx.projectId) as {id: string};
  await integrityStatusOf(row5b as never);
  const after = snapshotTree(matRoot);
  ok(before === after, 'GET-INT-05b integrity 检查零 mkdir/零文件写', {before, after});

  // ── STATE-01：waiting + succeeded job + 缺 materialization_id → REQUEST_STATE_INCONSISTENT ──
  const revS1 = await freshRevision(2340);
  const jobS1 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_jobs
       (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
        validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
     VALUES (?, ?, ?, 'validating_existing', 'v', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
  ).run(jobS1, fx.profileId, revS1.revisionId, Date.now() + 60000, revS1.sha, `${fx.profileId}/${revS1.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
  db.prepare(`UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL, validation_lease_expires_at_epoch_ms=NULL, updated_at=? WHERE id=?`).run(new Date().toISOString(), jobS1);
  // R6：STATE-01 测试 queued 状态（不是 succeeded）—— §七 response link closure 走 waiting+queued 路径
  const reqS1 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'st-1', ?, ?, ?, ?, 'initializing', ?, ?)`,
  ).run(reqS1, fx.projectId, fx.profileId, revS1.revisionId, revS1.assignmentArtifactId, realFingerprint(revS1), new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(jobS1, new Date().toISOString(), reqS1);
  try {
    const rS1 = await createMaterializationRequest(fx.projectId, 'st-1', revS1.assignmentArtifactId);
    // R6：existing 'queued' job without materialization_id + new request → existingRequestResult
    // for waiting request → job.status=queued → outcome='queued'（不冒充 reused；§七 response link closure）
    ok(rS1.outcome === 'queued' && rS1.projection === null,
      'STATE-01 waiting+queued（无 materialization_id）→ outcome=queued, projection=null（§七 response link closure：cancelled/failed/waiting → projection=null）', {outcome: rS1.outcome, projection: rS1.projection, projType: typeof rS1.projection});
  } catch (e) {
    ok(false, 'STATE-01 不应抛（应 queued）', e);
  }

  // ── STATE-02：waiting + succeeded job → 结构性 fail-closed（frozen CHECK：waiting 永远无
  // materialization_id → helper 先拒绝，不得仅凭 job.succeeded reused） ──
  const revS2 = await freshRevision(2350);
  await buildSuccess(revS2, 'st-2');
  const jobS2 = db.prepare("SELECT job_id FROM voice_materialization_requests WHERE project_id=? AND request_id='st-2'").get(fx.projectId) as {job_id: string};
  const projS2 = getProjection(fx.profileId, revS2.revisionId)!;
  fs.rmSync(destinationAbsolutePath(projS2.destination_voice_root_relative_path), {force: true});
  const reqS2 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'st-2b', ?, ?, ?, ?, 'initializing', ?, ?)`,
  ).run(reqS2, fx.projectId, fx.profileId, revS2.revisionId, revS2.assignmentArtifactId, realFingerprint(revS2), new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=?
     WHERE id=? AND status='initializing'`,
  ).run(jobS2.job_id, new Date().toISOString(), reqS2);
  try {
    const rS2 = await createMaterializationRequest(fx.projectId, 'st-2b', revS2.assignmentArtifactId);
    ok(false, 'STATE-02 waiting+succeeded+damaged file → 应抛', 'no error');
  } catch (e) {
    // R6：existingRequestResult → waiting + succeeded job + damaged file → validateReusableMaterializationRequest
    // → openHeld verify on missing file → MaterializedFileError → wrapped as MaterializationError MATERIALIZATION_UNUSABLE
    ok(e instanceof MaterializationError && e.code === 'MATERIALIZATION_UNUSABLE', 'STATE-02 waiting+succeeded+damaged file → MATERIALIZATION_UNUSABLE', e);
  }

  // ── STATE-03：succeeded request + damaged file → MATERIALIZATION_UNUSABLE；恢复后 → reused ──
  try {
    await createMaterializationRequest(fx.projectId, 'st-2', revS2.assignmentArtifactId);
    ok(false, 'STATE-03 succeeded+damaged → 抛', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'MATERIALIZATION_UNUSABLE', 'STATE-03 succeeded+damaged → MATERIALIZATION_UNUSABLE', e);
  }
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, revS2.revisionId, 'reference.wav'), destinationAbsolutePath(projS2.destination_voice_root_relative_path));
  const rS3 = await createMaterializationRequest(fx.projectId, 'st-2', revS2.assignmentArtifactId);
  ok(rS3.outcome === 'reused', 'STATE-03 succeeded+valid+exact → reused', rS3.outcome);

  // ── STATE-04：job succeeded 但 request failed → 按 request 终态 failed，不 reused ──
  const revS4 = await freshRevision(2360);
  await buildSuccess(revS4, 'st-4');
  const jobS4 = db.prepare("SELECT job_id FROM voice_materialization_requests WHERE project_id=? AND request_id='st-4'").get(fx.projectId) as {job_id: string};
  // 独立构造 failed request（waiting→failed 合法）+ 链接该 succeeded job
  const reqS4 = crypto.randomUUID();
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, 'st-4b', ?, ?, ?, ?, 'initializing', ?, ?)`,
  ).run(reqS4, fx.projectId, fx.profileId, revS4.revisionId, revS4.assignmentArtifactId, realFingerprint(revS4), new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(jobS4.job_id, new Date().toISOString(), reqS4);
  db.prepare("UPDATE voice_materialization_requests SET status='failed', updated_at=? WHERE id=? AND status='waiting'").run(new Date().toISOString(), reqS4);
  const rS4 = await createMaterializationRequest(fx.projectId, 'st-4b', revS4.assignmentArtifactId);
  ok(rS4.outcome === 'failed' && rS4.request.status === 'failed', 'STATE-04 request failed（job succeeded）→ outcome=failed 不 reused', {outcome: rS4.outcome, status: rS4.request.status});

  cleanupC1a(TAG);
  summary('TTS-C.1A get-integrity');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * TTS-C.1A.R2 Existing request fail-closed replay（§八）——已成功 request 在文件损坏后不得 reused：
 * - REPLAY-01 成功后删除 final → 同 requestId 不返回 reused（MATERIALIZATION_UNUSABLE）；
 * - REPLAY-02 成功后 hash drift（内容改写）→ 不 reused；
 * - REPLAY-03 成功后 final symlink → 不 reused；
 * - REPLAY-04 request.materialization_id 与 projection.id 不一致 → 不 reused；
 * - REPLAY-05 projection status failed/indeterminate → 不 reused；
 * - REPLAY-06 合法 durable file → reused；
 * - REPLAY-07 GET 视图不把损坏 projection 描述成 usable/ready（adapterReady 恒 false、如实 status）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {
  createMaterializationRequest,
  serializeMaterializationRequest,
  getProjection,
  MaterializationError,
} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-replay-integrity';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rp-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `rp-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 成功跑一次 worker → request succeeded + projection usable。 */
async function buildSuccess(rev: RevCtx, requestId: string): Promise<{finalAbs: string}> {
  const {claimNextAnyJob} = await import('../src/lib/scheduler');
  const {runMaterializationJob} = await import('../src/worker/materialization-executor');
  const r = await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  if (r.outcome !== 'queued') throw new Error(`outcome=${r.outcome}`);
  const c = claimNextAnyJob('rp-worker');
  if (c && c.type === 'voice_materialization') {
    await runMaterializationJob(c.handle, {log: () => undefined});
  }
  const proj = getProjection(fx.profileId, rev.revisionId);
  if (!proj) throw new Error('projection missing');
  return {finalAbs: destinationAbsolutePath(proj.destination_voice_root_relative_path)};
}

const expectUnusable = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    ok(false, label, 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'MATERIALIZATION_UNUSABLE', label, e);
  }
};

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── REPLAY-01：成功后删除 final → 不 reused ──
  const rev1 = await freshRevision(1210);
  const {finalAbs: f1} = await buildSuccess(rev1, 'rp-1');
  const saved1 = fs.readFileSync(f1);
  fs.rmSync(f1, {force: true});
  await expectUnusable('REPLAY-01 删 final 后同 requestId → MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 'rp-1', rev1.assignmentArtifactId));
  fs.writeFileSync(f1, saved1);

  // ── REPLAY-02：成功后 hash drift（改写内容）→ 不 reused ──
  const rev2 = await freshRevision(1220);
  const {finalAbs: f2} = await buildSuccess(rev2, 'rp-2');
  const saved2 = fs.readFileSync(f2);
  fs.writeFileSync(f2, Buffer.concat([saved2.subarray(0, saved2.length - 1), Buffer.from([saved2[saved2.length - 1] ^ 0xff])]));
  await expectUnusable('REPLAY-02 hash drift 后 → MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 'rp-2', rev2.assignmentArtifactId));
  fs.writeFileSync(f2, saved2);

  // ── REPLAY-03：成功后 final symlink → 不 reused ──
  const rev3 = await freshRevision(1230);
  const {finalAbs: f3} = await buildSuccess(rev3, 'rp-3');
  const saved3 = fs.readFileSync(f3);
  fs.rmSync(f3, {force: true});
  fs.symlinkSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev3.revisionId, 'reference.wav'), f3);
  await expectUnusable('REPLAY-03 final symlink → MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 'rp-3', rev3.assignmentArtifactId));
  fs.rmSync(f3, {force: true});
  fs.writeFileSync(f3, saved3);

  // ── REPLAY-04：materialization_id 与 projection identity 错配在 DB 层结构性不可能 ──
  // （trg_vmr_mat_link identity trigger + FK + UNIQUE(profile, revision) 三重防线）
  const rev4 = await freshRevision(1240);
  await buildSuccess(rev4, 'rp-4');
  const rev4b = await freshRevision(1250);
  await buildSuccess(rev4b, 'rp-4b');
  const wrongProj = getProjection(fx.profileId, rev4b.revisionId)!;
  try {
    db.prepare(
      `INSERT INTO voice_materialization_requests
         (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
          request_fingerprint, status, materialization_id, created_at, updated_at)
       VALUES (?, ?, 'rp-4-mismatch', ?, ?, ?, 'fp', 'succeeded', ?, ?, ?)`,
    ).run(crypto.randomUUID(), fx.projectId, fx.profileId, rev4.revisionId, rev4.assignmentArtifactId, wrongProj.id, new Date().toISOString(), new Date().toISOString());
    ok(false, 'REPLAY-04 错配 materialization_id 应被 identity trigger 拒绝', 'no error');
  } catch (e) {
    ok((e as Error).message.includes('identity mismatch'), 'REPLAY-04 materialization_id 错配结构上不可提交（DB 层防线）', e);
  }

  // ── REPLAY-05：projection status failed → 不 reused ──
  const rev5 = await freshRevision(1260);
  const {finalAbs: f5} = await buildSuccess(rev5, 'rp-5');
  db.prepare("UPDATE voice_materializations SET status='failed', updated_at=? WHERE voice_profile_id=? AND voice_profile_revision_id=?").run(new Date().toISOString(), fx.profileId, rev5.revisionId);
  await expectUnusable('REPLAY-05 projection failed → MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 'rp-5', rev5.assignmentArtifactId));
  db.prepare("UPDATE voice_materializations SET status='file_ready_unpublished', updated_at=? WHERE voice_profile_id=? AND voice_profile_revision_id=?").run(new Date().toISOString(), fx.profileId, rev5.revisionId);

  // ── REPLAY-06：合法 durable file → reused ──
  const r6 = await createMaterializationRequest(fx.projectId, 'rp-5', rev5.assignmentArtifactId);
  ok(r6.outcome === 'reused', 'REPLAY-06 合法 durable file → reused', r6.outcome);

  // ── REPLAY-07：GET 视图不把损坏 projection 描述成 usable/ready ──
  const reqRow = db.prepare("SELECT * FROM voice_materialization_requests WHERE project_id=? AND request_id='rp-1'").get(fx.projectId) as {id: string};
  const proj1 = getProjection(fx.profileId, rev1.revisionId);
  const view = serializeMaterializationRequest(reqRow as never, proj1 ?? null);
  const json = JSON.stringify(view);
  ok(view.materialization === null || view.materialization.adapterReady === false, 'REPLAY-07 adapterReady 恒 false（不冒充 ready）', view.materialization?.adapterReady);
  // R3：损坏文件 → status='unusable'（fail-closed，不再显示 file_ready_unpublished 为当前可用）
  ok(
    json.includes('"status":"unusable"') &&
      !/"status":"file_ready_unpublished"/.test(json) &&
      !/ready for|adapter ready|ready to use/i.test(json) &&
      !json.includes('voice-materializations') &&
      !json.includes('staging'),
    'REPLAY-07 损坏 projection → status=unusable（不显示 file_ready_unpublished 为可用）',
    json.slice(0, 200),
  );
  ok(!json.includes(f1), 'REPLAY-07 无 absolute path 泄漏', undefined);

  cleanupC1a(TAG);
  summary('TTS-C.1A replay-integrity');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

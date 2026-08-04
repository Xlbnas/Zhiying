/**
 * TTS-C.1A.R2 Validation Phase 3 exact evidence fence（P0-D）——Phase 2 完成后、finalize 前的漂移。
 * 每个场景独立 revision（避免 partial unique / projection 链式污染）：
 * - VAL-EV-01 Phase 2 后删除 final 文件 → MATERIALIZATION_UNUSABLE；
 * - VAL-EV-02 Phase 2 后 rename 替换 final regular file（新 inode）→ MATERIALIZATION_UNUSABLE；
 * - VAL-EV-03 Phase 2 后 projection row 漂移（status→failed）→ MATERIALIZATION_UNUSABLE；
 * - VAL-EV-04 Phase 2 后 Assignment source 漂移 → SOURCE_STALE；
 * - VAL-EV-05 Revision immutable：Phase 2→3 无漂移面（UPDATE 被 DB 拒绝）→ 合法 evidence → reused；
 * - VAL-EV-06 合法 evidence → 所有 subscriber reused。
 * 使用 hook afterProjectionValidationBeforeFinalize（仅测试）。
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
  setAfterProjectionValidationBeforeFinalize,
  getProjection,
  MaterializationError,
} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-validation-evidence';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `ve-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `ve-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

/** 建立 usable projection（worker 跑一次）。返回 {rev, projId, finalAbs}。 */
async function buildUsableProjection(rev: RevCtx, requestId: string): Promise<{projId: string; finalAbs: string}> {
  const {claimNextAnyJob} = await import('../src/lib/scheduler');
  const {runMaterializationJob} = await import('../src/worker/materialization-executor');
  const r0 = await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  if (r0.outcome !== 'queued') throw new Error(`前置 outcome=${r0.outcome}`);
  const c0 = claimNextAnyJob('ve-worker');
  if (c0 && c0.type === 'voice_materialization') {
    await runMaterializationJob(c0.handle, {log: () => undefined});
  }
  const proj = getProjection(fx.profileId, rev.revisionId);
  if (!proj || proj.status !== 'file_ready_unpublished') throw new Error('前置 projection 未 usable');
  return {projId: proj.id, finalAbs: destinationAbsolutePath(proj.destination_voice_root_relative_path)};
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  const expectNotReused = async (label: string, fn: () => Promise<unknown>, code: string): Promise<void> => {
    try {
      await fn();
      ok(false, label, 'no error');
    } catch (e) {
      ok(e instanceof MaterializationError && e.code === code, label, e);
    }
  };

  // ── VAL-EV-01：Phase 2 后删除 final 文件 → MATERIALIZATION_UNUSABLE ──
  const rev1 = await freshRevision(1110);
  const {finalAbs: f1} = await buildUsableProjection(rev1, 've-1');
  setAfterProjectionValidationBeforeFinalize(() => {
    fs.rmSync(f1, {force: true});
  });
  await expectNotReused('VAL-EV-01 Phase 2 后删文件 → MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 've-1r', rev1.assignmentArtifactId), 'MATERIALIZATION_UNUSABLE');

  // ── VAL-EV-02：Phase 2 后 rename 替换 final（新 inode）→ MATERIALIZATION_UNUSABLE ──
  const rev2 = await freshRevision(1120);
  const {finalAbs: f2} = await buildUsableProjection(rev2, 've-2');
  setAfterProjectionValidationBeforeFinalize(() => {
    const swap = `${f2}.swap-${Math.random()}`;
    fs.writeFileSync(swap, makeWav(800, 777));
    fs.renameSync(swap, f2); // 新 inode 替换
  });
  await expectNotReused('VAL-EV-02 Phase 2 后替换文件（新 inode）→ MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 've-2r', rev2.assignmentArtifactId), 'MATERIALIZATION_UNUSABLE');

  // ── VAL-EV-03：Phase 2 后 projection row 漂移 → MATERIALIZATION_UNUSABLE ──
  const rev3 = await freshRevision(1130);
  const {projId: p3} = await buildUsableProjection(rev3, 've-3');
  setAfterProjectionValidationBeforeFinalize(() => {
    db.prepare("UPDATE voice_materializations SET status='failed', updated_at=? WHERE id=?").run(new Date().toISOString(), p3);
  });
  await expectNotReused('VAL-EV-03 Phase 2 后 projection 漂移 → MATERIALIZATION_UNUSABLE', () => createMaterializationRequest(fx.projectId, 've-3r', rev3.assignmentArtifactId), 'MATERIALIZATION_UNUSABLE');

  // ── VAL-EV-04：Phase 2 后 Assignment source 漂移 → SOURCE_STALE ──
  const rev4 = await freshRevision(1140);
  await buildUsableProjection(rev4, 've-4');
  setAfterProjectionValidationBeforeFinalize(() => {
    const asgRow = db.prepare('SELECT * FROM artifacts WHERE id=?').get(rev4.assignmentArtifactId) as {content_json: string};
    const parsed = JSON.parse(asgRow.content_json);
    parsed.source.canonicalAudioSha256 = 'e'.repeat(64);
    db.prepare('UPDATE artifacts SET content_json=? WHERE id=?').run(JSON.stringify(parsed), rev4.assignmentArtifactId);
  });
  await expectNotReused('VAL-EV-04 Phase 2 后 Assignment 漂移 → SOURCE_STALE', () => createMaterializationRequest(fx.projectId, 've-4r', rev4.assignmentArtifactId), 'SOURCE_STALE');

  // ── VAL-EV-05：Revision immutable（Phase 2→3 无漂移面）→ 合法 evidence → reused ──
  const rev5 = await freshRevision(1150);
  await buildUsableProjection(rev5, 've-5');
  setAfterProjectionValidationBeforeFinalize(() => {
    try {
      db.prepare('UPDATE voice_profile_revisions SET canonical_audio_sha256=? WHERE id=?').run('d'.repeat(64), rev5.revisionId);
      ok(false, 'VAL-EV-05 revision UPDATE 应被 immutable 拒绝', 'no error');
    } catch (e) {
      ok((e as Error).message.includes('immutable'), 'VAL-EV-05 Revision immutable（Phase 2→3 无漂移面）', e);
    }
  });
  const r5 = await createMaterializationRequest(fx.projectId, 've-5r', rev5.assignmentArtifactId);
  ok(r5.outcome === 'reused', 'VAL-EV-05 Revision immutable → 合法 evidence → reused', r5.outcome);

  // ── VAL-EV-06：合法 evidence → 所有 subscriber reused ──
  setAfterProjectionValidationBeforeFinalize(null);
  const r6a = await createMaterializationRequest(fx.projectId, 've-6a', rev5.assignmentArtifactId);
  const r6b = await createMaterializationRequest(fx.projectId, 've-6b', rev5.assignmentArtifactId);
  ok(r6a.outcome === 'reused' && r6b.outcome === 'reused', 'VAL-EV-06 合法 evidence → 全部 reused', {a: r6a.outcome, b: r6b.outcome});
  const reqs = db.prepare("SELECT count(*) c FROM voice_materialization_requests WHERE project_id=? AND request_id IN ('ve-6a','ve-6b') AND status='reused'").get(fx.projectId) as {c: number};
  ok(reqs.c === 2, 'VAL-EV-06 两个 subscriber 均 reused', reqs.c);

  cleanupC1a(TAG);
  summary('TTS-C.1A validation-evidence');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

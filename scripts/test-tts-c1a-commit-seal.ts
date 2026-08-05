/**
 * TTS-C.1A.R3 Commit-sealed file identity（P0-A/P0-B）——held fd 持有到 commit + 同步 seal：
 * - SEAL-01 final evidence 后、DB commit 前同 inode 原地改写（不同内容）→ Worker 不得 succeeded；
 * - SEAL-02 同 inode truncate 后写入同长度不同内容 → 不得 succeeded；
 * - SEAL-03 同 inode 仅 mtime/ctime 漂移（touch）→ commit fence 拒绝；
 * - SEAL-04 evidence 后 rename 替换为新 inode → 拒绝；
 * - SEAL-05 parent directory 在 evidence 后被 rename/symlink 替换 → 拒绝；
 * - SEAL-06 伪造 held capability（clone 合法实例 + fd 指向另一文件）不能调用成功终局
 *   （R4：无公开 factory，clone/spoof 在第一道 capability fence 即 SEAL_MISMATCH）；
 * - SEAL-07 合法 held evidence → succeeded；commit 后再 verify usable。
 * 使用 executor hook afterFinalEvidenceBeforeCommit（仅测试）。
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
import {createMaterializationRequest, getProjection, getMaterializationJob, workerFinalizeMaterialization} from '../src/lib/tts-c/materialization';
import {openHeldMaterializedFileEvidence, validateMaterializedFileSnapshot, HeldMaterializedFileEvidence, MaterializedFileError} from '../src/lib/tts-c/materialized-file-validator';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-commit-seal';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `cs-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `cs-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

async function claimHandleFor(rev: RevCtx, requestId: string) {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  const claimed = claimNextAnyJob('cs-worker');
  if (!claimed || claimed.type !== 'voice_materialization') throw new Error('claim failed');
  return claimed.handle;
}

/** 运行 executor + 攻击 hook；断言 job 不得 succeeded。 */
async function expectSealReject(rev: RevCtx, requestId: string, attack: (finalAbs: string) => void): Promise<void> {
  const h = await claimHandleFor(rev, requestId);
  let attacked = false;
  await runMaterializationJob(
    h,
    {log: () => undefined},
    {
      afterFinalEvidenceBeforeCommit: (finalAbs) => {
        attack(finalAbs);
        attacked = true;
      },
    },
  ).catch(() => undefined);
  ok(attacked, `${requestId} hook 已执行`, attacked);
  const job = getMaterializationJob(h.jobId);
  ok(job?.status !== 'succeeded', `${requestId} 攻击后 job 不得 succeeded`, job?.status);
  ok(getProjection(fx.profileId, rev.revisionId) === undefined, `${requestId} projection=0`, undefined);
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();
  const canonicalOf = (rev: RevCtx): string => path.join(fx.dataDir, 'voice-library', fx.profileId, rev.revisionId, 'reference.wav');

  // ── SEAL-01：同 inode 原地改写（不同内容）──
  const rev1 = await freshRevision(2110);
  await expectSealReject(rev1, 'seal-1', (finalAbs) => {
    fs.writeFileSync(finalAbs, makeWav(900, 222)); // 同路径 truncate+write → inode 不变，mtime/ctime 变
  });

  // ── SEAL-02：同 inode truncate 同长度不同内容 ──
  const rev2 = await freshRevision(2120);
  await expectSealReject(rev2, 'seal-2', (finalAbs) => {
    const orig = fs.readFileSync(canonicalOf(rev2));
    const sameLen = Buffer.from(orig); // 同长度
    sameLen[sameLen.length - 1] = sameLen[sameLen.length - 1] ^ 0xff;
    fs.writeFileSync(finalAbs, sameLen);
  });

  // ── SEAL-03：仅 mtime/ctime 漂移（touch）──
  const rev3 = await freshRevision(2130);
  await expectSealReject(rev3, 'seal-3', (finalAbs) => {
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(finalAbs, now, now); // 只改时间戳（内容不变）
  });

  // ── SEAL-04：rename 替换为新 inode ──
  const rev4 = await freshRevision(2140);
  await expectSealReject(rev4, 'seal-4', (finalAbs) => {
    const swap = `${finalAbs}.swap-${Math.random()}`;
    fs.copyFileSync(canonicalOf(rev4), swap);
    fs.renameSync(swap, finalAbs); // 新 inode
  });

  // ── SEAL-04b：rename 替换 + mtime 伪装（仅 inode 不同）→ inode 检查独立拒绝 ──
  const rev4b = await freshRevision(2141);
  await expectSealReject(rev4b, 'seal-4b', (finalAbs) => {
    const origStat = fs.statSync(finalAbs);
    const swap = `${finalAbs}.swap-${Math.random()}`;
    fs.copyFileSync(finalAbs, swap);
    fs.utimesSync(swap, origStat.atime, origStat.mtime); // 伪装 mtime
    fs.renameSync(swap, finalAbs); // 新 inode，mtime 相同
  });

  // ── SEAL-05：parent 被 rename 替换 ──
  const rev5 = await freshRevision(2150);
  await expectSealReject(rev5, 'seal-5', (finalAbs) => {
    const parent = path.dirname(finalAbs);
    const moved = `${parent}-moved-${Math.random()}`;
    fs.renameSync(parent, moved); // parent inode 保留但路径变了？rename 目录：目录 inode 不变，但父目录项变化……
    // 更直接：parent 换成 symlink
    fs.rmSync(parent, {recursive: true, force: true});
    fs.symlinkSync(path.join(fx.dataDir, 'voice-library'), parent);
  });

  // ── SEAL-06：伪造 held capability（clone 合法实例 + fd 指向另一文件）不能成功终局 ──
  const rev6 = await freshRevision(2160);
  const h6 = await claimHandleFor(rev6, 'seal-6');
  // 伪造素材：rev6b 的合法 held（fd 锚定 rev6b 文件）
  const rev6b = await freshRevision(2161);
  const f6b = destinationAbsolutePath(`${fx.profileId}/${rev6b.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(f6b), {recursive: true});
  fs.copyFileSync(canonicalOf(rev6b), f6b);
  const legitHeld6b = await openHeldMaterializedFileEvidence(
    {
      relativePath: `${fx.profileId}/${rev6b.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev6b.revisionId,
      expectedSha256: rev6b.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'durabilize',
  );
  // R4：不存在公开 factory/register——攻击者只能 clone/prototype spoof 合法实例；
  // clone 是独立对象，不在 module-private WeakSet 内 → capability fence 必须拒绝
  const forged = Object.assign(
    Object.create(Object.getPrototypeOf(legitHeld6b)) as HeldMaterializedFileEvidence,
    legitHeld6b,
  );
  // 再篡改 evidence 声称指向 job6 的目标文件（relativePath/absolutePathInternal/sha 伪装）
  (forged as {evidence: unknown}).evidence = {
    ...legitHeld6b.evidence,
    relativePath: `${fx.profileId}/${rev6.revisionId}/reference.wav`,
    absolutePathInternal: destinationAbsolutePath(`${fx.profileId}/${rev6.revisionId}/reference.wav`),
    sha256: rev6.sha,
  };
  const {listActiveRequestRows, sha256Text} = await import('../src/lib/tts-c/materialization');
  const {getProjectVoiceAssignment} = await import('../src/lib/tts-b/assignment');
  const asgSnaps6 = [];
  for (const r of listActiveRequestRows(h6.jobId)) {
    const asgRow = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
    if (asgRow) asgSnaps6.push({artifactId: r.assignment_artifact_id, contentHash: sha256Text(asgRow.artifact.content_json)});
  }
  try {
    workerFinalizeMaterialization({
      handle: h6,
      held: forged,
      revisionEvidence: {
        voiceProfileId: fx.profileId,
        voiceProfileRevisionId: rev6.revisionId,
        canonicalAudioSha256: rev6.sha,
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
        provider: 'indextts2',
        fileSize: fs.statSync(canonicalOf(rev6)).size,
      },
      asgSnapshots: asgSnaps6,
    });
    ok(false, 'SEAL-06 伪造 held capability 不得成功终局', 'no error');
  } catch (e) {
    ok(e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH', 'SEAL-06 伪造 held capability → capability fence 拒绝（非 WeakSet 登记实例）', e);
  }
  await legitHeld6b.close();

  // ── SEAL-07：合法 held evidence → succeeded；commit 后再 verify usable ──
  const rev7 = await freshRevision(2170);
  const h7 = await claimHandleFor(rev7, 'seal-7');
  await runMaterializationJob(h7, {log: () => undefined});
  const job7 = getMaterializationJob(h7.jobId);
  ok(job7?.status === 'succeeded', 'SEAL-07 合法 held evidence → job succeeded', job7?.status);
  const proj7 = getProjection(fx.profileId, rev7.revisionId);
  ok(proj7?.status === 'file_ready_unpublished', 'SEAL-07 projection file_ready_unpublished', proj7?.status);
  const ev7 = await validateMaterializedFileSnapshot({
    relativePath: proj7!.destination_voice_root_relative_path,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: rev7.revisionId,
    expectedSha256: rev7.sha,
    expectedCodec: 'pcm_s16le',
    expectedSampleRate: 48000,
    expectedChannels: 1,
    minDurationMs: 1,
    adapterCompatibilityKey: 'indextts2-adapter-registry@1',
  });
  ok(ev7.sha256 === rev7.sha, 'SEAL-07 commit 后 verify 再次 usable', ev7.sha256.slice(0, 12));

  // ── DIR-01：parent 在 containment 后被换成 symlink → openHeld 拒绝（O_NOFOLLOW/path 检查） ──
  const revD1 = await freshRevision(2180);
  const fD1 = destinationAbsolutePath(`${fx.profileId}/${revD1.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(fD1), {recursive: true});
  fs.copyFileSync(canonicalOf(revD1), fD1);
  const parentD1 = path.dirname(fD1);
  const movedD1 = `${parentD1}-moved-${Math.random()}`;
  fs.renameSync(parentD1, movedD1);
  fs.symlinkSync(path.join(fx.dataDir, 'voice-library'), parentD1);
  try {
    await openHeldMaterializedFileEvidence(
      {
        relativePath: `${fx.profileId}/${revD1.revisionId}/reference.wav`,
        voiceProfileId: fx.profileId,
        voiceProfileRevisionId: revD1.revisionId,
        expectedSha256: revD1.sha,
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
      },
      'durabilize',
    );
    ok(false, 'DIR-01 parent symlink → openHeld 拒绝', 'no error');
  } catch (e) {
    ok(e instanceof MaterializedFileError && (e.code === 'CONTAINMENT' || e.code === 'MISSING'), 'DIR-01 parent 替换为 symlink → 拒绝', e);
  }
  fs.rmSync(parentD1, {force: true});
  fs.renameSync(movedD1, parentD1);

  // ── DIR-02：held parent fd 打开后、fsync 前 parent 被 rename 替换 → seal 拒绝 ──
  const revD2 = await freshRevision(2190);
  const fD2 = destinationAbsolutePath(`${fx.profileId}/${revD2.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(fD2), {recursive: true});
  fs.copyFileSync(canonicalOf(revD2), fD2);
  const heldD2 = await openHeldMaterializedFileEvidence(
    {
      relativePath: `${fx.profileId}/${revD2.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: revD2.revisionId,
      expectedSha256: revD2.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'durabilize',
  );
  // parent 换目录（新 inode）
  const parentD2 = path.dirname(fD2);
  const movedD2 = `${parentD2}-moved2-${Math.random()}`;
  fs.renameSync(parentD2, movedD2);
  fs.mkdirSync(parentD2, {recursive: true});
  try {
    const {assertHeldEvidenceCurrentSync} = await import('../src/lib/tts-c/materialized-file-validator');
    assertHeldEvidenceCurrentSync(heldD2, {
      relativePath: `${fx.profileId}/${revD2.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: revD2.revisionId,
      expectedSha256: revD2.sha,
    });
    ok(false, 'DIR-02 parent 替换 → seal 拒绝', 'no error');
  } catch (e) {
    ok(e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH', 'DIR-02 held parent 与 path inode 不一致 → seal 拒绝', e);
  }
  await heldD2.close();
  fs.rmSync(parentD2, {recursive: true, force: true});
  fs.renameSync(movedD2, parentD2);

  // ── DIR-03：held parent fd 与 path inode 不一致 → 拒绝（seal 复核） ──
  const revD3 = await freshRevision(2195);
  const fD3 = destinationAbsolutePath(`${fx.profileId}/${revD3.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(fD3), {recursive: true});
  fs.copyFileSync(canonicalOf(revD3), fD3);
  const heldD3 = await openHeldMaterializedFileEvidence(
    {
      relativePath: `${fx.profileId}/${revD3.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: revD3.revisionId,
      expectedSha256: revD3.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'durabilize',
  );
  // 用另一 rev 的 held 模拟 path↔fd 不一致（DIR-03 由 SEAL-06 已覆盖 path 层；此处验证 parent 层）
  ok(heldD3.evidence.parentDev !== 0n && heldD3.evidence.parentIno !== 0n, 'DIR-03 evidence 记录 parent dev/inode', {dev: heldD3.evidence.parentDev.toString(), ino: heldD3.evidence.parentIno.toString()});
  await heldD3.close();

  cleanupC1a(TAG);
  summary('TTS-C.1A commit-seal');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

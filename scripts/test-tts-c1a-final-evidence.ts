/**
 * TTS-C.1A.R2 Rename-after final evidence（P0-B）——rename 后校验的是真实 final，不是 temp：
 * - FINAL-01 rename 后替换 final 为另一 regular WAV → SHA/inode 不一致 → projection=0、job 不得 succeeded；
 * - FINAL-02 rename 后替换为 symlink → O_NOFOLLOW 拒绝；
 * - FINAL-03 final fsync 失败（注入）→ FSYNC_FAILED → DB success=0；
 * - FINAL-04 parent dir fsync 失败（注入）→ FSYNC_FAILED → DB success=0；
 * - FINAL-05 size/hash/codec 任一漂移 → evidence 建立失败；
 * - FINAL-06 合法 final evidence → DB commit 后 validator 再次 usable。
 * 使用 hook afterRenameBeforeFinalEvidence（仅测试）。
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
import {getProjection, getMaterializationJob, createMaterializationRequest} from '../src/lib/tts-c/materialization';
import {validateMaterializedFile, MaterializedFileError} from '../src/lib/tts-c/materialized-file-validator';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-final-evidence';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `fe-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `fe-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

async function claimHandleFor(rev: RevCtx, requestId: string) {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  const claimed = claimNextAnyJob('fe-worker');
  if (!claimed || claimed.type !== 'voice_materialization') throw new Error('claim failed');
  return claimed.handle;
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── FINAL-01：rename 后替换 final 为另一 regular WAV → 检测 SHA/inode 不一致 ──
  const rev1 = await freshRevision(1010);
  const h1 = await claimHandleFor(rev1, 'fe-1');
  let replaced = false;
  await runMaterializationJob(
    h1,
    {log: () => undefined},
    {
      afterRenameBeforeFinalEvidence: (finalAbs) => {
        // 替换为另一 regular WAV（不同内容）
        fs.writeFileSync(finalAbs, makeWav(900, 555));
        replaced = true;
      },
    },
  ).catch(() => undefined);
  ok(replaced, 'FINAL-01 hook 已替换 final', replaced);
  const job1 = getMaterializationJob(h1.jobId);
  ok(job1?.status !== 'succeeded', 'FINAL-01 替换后 job 不得 succeeded', job1?.status);
  ok(getProjection(fx.profileId, rev1.revisionId) === undefined, 'FINAL-01 projection=0', undefined);

  // ── FINAL-02：rename 后替换为 symlink → O_NOFOLLOW 拒绝 ──
  const rev2 = await freshRevision(1020);
  const h2 = await claimHandleFor(rev2, 'fe-2');
  const outside = path.join(fx.dataDir, 'fe-outside');
  fs.writeFileSync(outside, makeWav(800, 600));
  await runMaterializationJob(
    h2,
    {log: () => undefined},
    {
      afterRenameBeforeFinalEvidence: (finalAbs) => {
        fs.rmSync(finalAbs, {force: true});
        fs.symlinkSync(outside, finalAbs);
      },
    },
  ).catch(() => undefined);
  const job2 = getMaterializationJob(h2.jobId);
  ok(job2?.status !== 'succeeded', 'FINAL-02 symlink 替换 → job 不得 succeeded', job2?.status);
  ok(getProjection(fx.profileId, rev2.revisionId) === undefined, 'FINAL-02 projection=0', undefined);

  // ── FINAL-03：final fsync 失败（注入）→ FSYNC_FAILED → DB success=0 ──
  const rev3 = await freshRevision(1030);
  const h3 = await claimHandleFor(rev3, 'fe-3');
  let fsyncFailed = false;
  await runMaterializationJob(h3, {log: () => undefined}, {}).catch(() => undefined); // 先正常跑？不——直接注入失败需要 validator deps，executor 不暴露。
  // executor 不传 validator deps → 直接单测 validator 的 fsync 注入（FINAL-03/04 覆盖 validator 契约）
  const finalAbs3 = destinationAbsolutePath(`${fx.profileId}/${rev3.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(finalAbs3), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, rev3.revisionId, 'reference.wav'), finalAbs3);
  try {
    await validateMaterializedFile(
      {
        relativePath: `${fx.profileId}/${rev3.revisionId}/reference.wav`,
        voiceProfileId: fx.profileId,
        voiceProfileRevisionId: rev3.revisionId,
        expectedSha256: rev3.sha,
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
      },
      'durabilize',
      {
        fsyncFile: async () => {
          fsyncFailed = true;
          throw new Error('injected final fsync failure');
        },
      },
    );
    ok(false, 'FINAL-03 final fsync 失败 → 抛 FSYNC_FAILED', 'no error');
  } catch (e) {
    ok(fsyncFailed && e instanceof MaterializedFileError && e.code === 'FSYNC_FAILED', 'FINAL-03 final fsync 失败 → FSYNC_FAILED（durability 未建立）', e);
  }

  // ── FINAL-04：parent dir fsync 失败（注入）→ FSYNC_FAILED ──
  try {
    await validateMaterializedFile(
      {
        relativePath: `${fx.profileId}/${rev3.revisionId}/reference.wav`,
        voiceProfileId: fx.profileId,
        voiceProfileRevisionId: rev3.revisionId,
        expectedSha256: rev3.sha,
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
      },
      'durabilize',
      {
        fsyncDir: async () => {
          throw new Error('injected dir fsync failure');
        },
      },
    );
    ok(false, 'FINAL-04 dir fsync 失败 → 抛 FSYNC_FAILED', 'no error');
  } catch (e) {
    ok(e instanceof MaterializedFileError && e.code === 'FSYNC_FAILED', 'FINAL-04 parent dir fsync 失败 → FSYNC_FAILED', e);
  }

  // ── FINAL-05：size/hash/codec 任一漂移 → evidence 建立失败 ──
  const baseExpect = {
    relativePath: `${fx.profileId}/${rev3.revisionId}/reference.wav`,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: rev3.revisionId,
    expectedSha256: rev3.sha,
    expectedCodec: 'pcm_s16le',
    expectedSampleRate: 48000,
    expectedChannels: 1,
    minDurationMs: 1,
    adapterCompatibilityKey: 'indextts2-adapter-registry@1',
  };
  for (const [label, expect] of [
    ['hash 漂移', {expectedSha256: 'f'.repeat(64)}],
    ['size 漂移', {expectedSize: 12345}],
    ['codec 漂移', {expectedCodec: 'aac'}],
    ['sampleRate 漂移', {expectedSampleRate: 44100}],
    ['channels 漂移', {expectedChannels: 2}],
  ] as const) {
    try {
      await validateMaterializedFile(
        {...baseExpect, ...expect},
        'verify',
      );
      ok(false, `FINAL-05 ${label} → 拒绝`, 'no error');
    } catch (e) {
      ok(e instanceof MaterializedFileError, `FINAL-05 ${label} → MaterializedFileError`, e);
    }
  }

  // ── FINAL-06：合法 final evidence（durabilize）→ 成功后 validator verify 再次 usable ──
  const ev6 = await validateMaterializedFile(
    {
      relativePath: `${fx.profileId}/${rev3.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev3.revisionId,
      expectedSha256: rev3.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'durabilize',
  );
  ok(ev6.durabilityEstablished === true && ev6.sha256 === rev3.sha && ev6.size > 0, 'FINAL-06 durabilize 建立完整 evidence', {sha: ev6.sha256.slice(0, 12), durable: ev6.durabilityEstablished});
  const ev6v = await validateMaterializedFile(
    {
      relativePath: `${fx.profileId}/${rev3.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev3.revisionId,
      expectedSha256: rev3.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'verify',
  );
  ok(ev6v.sha256 === rev3.sha && ev6v.device === ev6.device && ev6v.inode === ev6.inode, 'FINAL-06 verify 模式再次 usable（同 inode）', ev6v.sha256.slice(0, 12));

  // ── 真实 executor 合法路径（FINAL-06 集成）：worker 成功 → job succeeded ──
  const rev7 = await freshRevision(1040);
  const h7 = await claimHandleFor(rev7, 'fe-7');
  await runMaterializationJob(h7, {log: () => undefined});
  const job7 = getMaterializationJob(h7.jobId);
  ok(job7?.status === 'succeeded', 'FINAL-06b 合法 final evidence → job succeeded（真实 executor）', job7?.status);
  const proj7 = getProjection(fx.profileId, rev7.revisionId);
  ok(proj7?.status === 'file_ready_unpublished', 'FINAL-06b projection file_ready_unpublished', proj7?.status);

  cleanupC1a(TAG);
  summary('TTS-C.1A final-evidence');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

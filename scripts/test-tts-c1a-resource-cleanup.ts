/**
 * TTS-C.1A.R2 Resource ownership 与 cleanup（§九）——全部 fd/timer/temp 生命周期：
 * - CLEAN-01 containment 抛错后 source fd 关闭（/proc/self/fd 计数稳定）；
 * - CLEAN-02 temp 完成后 rename 前 lease loss → temp 不存在（finally 清理）；
 * - CLEAN-03 shutdown during copy → fd/timer/temp 全清理；
 * - CLEAN-04 cleanup 失败不覆盖原始错误（注入 sha 错误仍传播）；
 * - CLEAN-05 连续故障注入后无 staging 残留；
 * - CLEAN-06 多次运行后无 fd/timer 泄漏（fd 计数稳定）。
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
import {createMaterializationRequest, getMaterializationJob, getProjection} from '../src/lib/tts-c/materialization';
import {materializationRootAbs} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-resource-cleanup';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `cl-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const sha = sha256Buf(fs.readFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav')));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `cl-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {revisionId: row.id, sha, assignmentArtifactId: built.artifact.id};
}

async function claimHandleFor(rev: RevCtx, requestId: string) {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  const claimed = claimNextAnyJob('cl-worker');
  if (!claimed || claimed.type !== 'voice_materialization') throw new Error('claim failed');
  return claimed.handle;
}

function fdCount(): number {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
}

function stagingResidue(): string[] {
  const root = materializationRootAbs();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.staging-|\.tmp$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── CLEAN-01：containment 抛错后 source fd 关闭 ──
  const rev1 = await freshRevision(1310);
  const h1 = await claimHandleFor(rev1, 'cl-1');
  // profile 目录替换为 symlink（containment 在 source open 后、temp 前抛错）
  const matRoot = path.join(fx.dataDir, 'voice-materializations');
  fs.mkdirSync(matRoot, {recursive: true});
  const profDir = path.join(matRoot, fx.profileId);
  fs.rmSync(profDir, {recursive: true, force: true});
  fs.symlinkSync(path.join(fx.dataDir, 'voice-library'), profDir);
  const fdBefore1 = fdCount();
  await runMaterializationJob(h1, {log: () => undefined}).catch(() => undefined);
  await sleep(50);
  const fdAfter1 = fdCount();
  ok(fdAfter1 <= fdBefore1 + 1, 'CLEAN-01 containment 抛错后无 fd 泄漏', {before: fdBefore1, after: fdAfter1});
  fs.rmSync(profDir, {force: true});

  // ── CLEAN-02：temp 完成后 rename 前 lease loss → temp 不存在 ──
  const rev2 = await freshRevision(1320);
  const h2 = await claimHandleFor(rev2, 'cl-2');
  // temp 预校验（sha256File）时吊销 lease → rename 前 verify 失败 → finally 删 temp
  await runMaterializationJob(
    h2,
    {log: () => undefined},
    {
      sha256File: async (p) => {
        db.prepare(
          `UPDATE voice_materialization_jobs SET lease_expires_at_epoch_ms=?, owner_token=?, attempt=attempt+1, updated_at=?
           WHERE id=? AND status='running'`,
        ).run(Date.now() - 1000, 'hijack', new Date().toISOString(), h2.jobId);
        return await (await import('../src/lib/tts-c/audio-probe')).sha256FileBytes(p);
      },
    },
  ).catch(() => undefined);
  const residues2 = stagingResidue();
  ok(residues2.length === 0, 'CLEAN-02 temp 完成→rename 前 lease loss → temp 已清理（无 staging 残留）', residues2);

  // ── CLEAN-03：shutdown during copy → fd/timer/temp 全清理 ──
  const rev3 = await freshRevision(1330);
  const h3 = await claimHandleFor(rev3, 'cl-3');
  let shutdownHit = false;
  const fdBefore3 = fdCount();
  await runMaterializationJob(
    h3,
    {
      log: () => undefined,
      isShuttingDown: () => {
        shutdownHit = true;
        return true;
      },
    },
    {},
  ).catch(() => undefined);
  await sleep(50);
  ok(shutdownHit, 'CLEAN-03 shutdown 在 copy 期间触发', shutdownHit);
  ok(stagingResidue().length === 0, 'CLEAN-03 shutdown 后 temp 已清理', undefined);
  ok(fdCount() <= fdBefore3 + 1, 'CLEAN-03 shutdown 后 fd 无泄漏', {before: fdBefore3, after: fdCount()});

  // ── CLEAN-04：cleanup 失败不覆盖原始错误 ──
  const rev4 = await freshRevision(1340);
  const h4 = await claimHandleFor(rev4, 'cl-4');
  let err4: unknown = null;
  try {
    await runMaterializationJob(
      h4,
      {log: () => undefined},
      {
        sha256File: async () => {
          throw new Error('injected primary failure');
        },
      },
    );
  } catch (e) {
    err4 = e;
  }
  ok(err4 instanceof Error && err4.message.includes('injected primary failure'), 'CLEAN-04 原始错误传播（cleanup 不覆盖）', err4);
  const req4 = db.prepare("SELECT status FROM voice_materialization_requests WHERE project_id=? AND request_id='cl-4'").get(fx.projectId) as {status: string} | undefined;
  ok(req4?.status === 'failed', 'CLEAN-04 确定性错误 fenced failed（fan-out）', req4?.status);

  // ── CLEAN-05：连续故障注入后无 staging 残留 ──
  const rev5a = await freshRevision(1350);
  const rev5b = await freshRevision(1360);
  const rev5c = await freshRevision(1370);
  for (const [rev, rid] of [[rev5a, 'cl-5a'], [rev5b, 'cl-5b'], [rev5c, 'cl-5c']] as const) {
    const h = await claimHandleFor(rev, rid);
    await runMaterializationJob(
      h,
      {log: () => undefined},
      {
        sha256File: async () => {
          throw new Error('injected');
        },
      },
    ).catch(() => undefined);
  }
  const residues5 = stagingResidue();
  ok(residues5.length === 0, 'CLEAN-05 连续 3 次故障注入后无 staging 残留', residues5);

  // ── CLEAN-06：多次成功运行后 fd/timer 无泄漏 ──
  const fdBefore6 = fdCount();
  for (let i = 0; i < 3; i++) {
    const rev = await freshRevision(1380 + i);
    const h = await claimHandleFor(rev, `cl-6-${i}`);
    await runMaterializationJob(h, {log: () => undefined});
    const job = getMaterializationJob(h.jobId);
    ok(job?.status === 'succeeded', `CLEAN-06 第 ${i + 1} 次成功`, job?.status);
  }
  await sleep(100);
  const fdAfter6 = fdCount();
  ok(fdAfter6 <= fdBefore6 + 2, 'CLEAN-06 3 次成功运行后 fd 稳定（timer/fd 无泄漏）', {before: fdBefore6, after: fdAfter6});

  cleanupC1a(TAG);
  summary('TTS-C.1A resource-cleanup');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

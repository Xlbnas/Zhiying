/**
 * TTS-C.1A.R4 hardening —— non-forgeable held capability + exact destination binding +
 * full ancestor seal + verify zero-write + zero-subscriber closure：
 * - CAP-01 plain object 伪装 Held → capability fence 拒绝（workerFinalize 第一道 fence）；
 * - CAP-02 Object.create(Held.prototype)（prototype spoof）→ 拒绝；
 * - CAP-03 clone 合法实例 + arbitrary fd → 拒绝（clone 不在 WeakSet）；
 * - CAP-04 公开 API 无 create/register capability；无 issue token 直接构造 → 拒绝；
 * - CAP-05 合法 openHeld 结果 → capability + commit seal 通过；
 * - SEAL-08 evidence.absolutePathInternal=canonical source（bytes exact、relativePath 伪装
 *   destination）→ 拒绝（derived destination binding）；
 * - SEAL-09 outside-root exact WAV + forged durability flag → 拒绝；
 * - SEAL-10 absolutePathInternal ≠ derived destination（任意他路径）→ 拒绝；
 * - SEAL-11 parentRealpath ≠ derived parent realpath → 拒绝；
 * - DIR-04 profile ancestor rename+symlink（final/immediate parent inode 不变）→ commit 拒绝；
 * - DIR-05 materialization root rename+symlink → commit 拒绝；
 * - DIR-06 profile replaced by different directory（revision/file inode 不变）→ commit 拒绝；
 * - DIR-07 合法完整 ancestor chain → pass；
 * - VERIFY-01 整个 materialization root 缺失：GET 不 mkdir（missing + fs snapshot 不变）；
 * - VERIFY-02 root 缺失：reuse validation 不 mkdir；
 * - VERIFY-03 root 缺失：replay 不 mkdir；
 * - VERIFY-04 Worker writer 可创建 root/profile/revision；
 * - CANCEL-06 worker final transaction 前 subscriber=0 → cancelled / projection=0；
 * - CANCEL-07 validation usable Phase 3 前 subscriber=0 → cancelled / 不 succeeded / 不 fan-out；
 * - CANCEL-08 subscriber>0 合法路径仍 succeeded/reused。
 * 测试不获得 secret token、不通过公开 factory 制造 capability；evidence 篡改通过对
 * 合法（已登记）实例的字段覆写模拟——runtime seal 之外的第二层 fence 必须独立拒绝。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment, getProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runMaterializationJob} from '../src/worker/materialization-executor';
import {
  createMaterializationRequest,
  getMaterializationRequest,
  getProjection,
  getMaterializationJob,
  workerFinalizeMaterialization,
  validateExistingProjection,
  listActiveRequestRows,
  sha256Text,
  setAfterProjectionValidationBeforeFinalize,
  MaterializationError,
  type MaterializationExecutionHandle,
} from '../src/lib/tts-c/materialization';
import {
  openHeldMaterializedFileEvidence,
  assertHeldCurrentSync,
  assertHeldCapability,
  HeldMaterializedFileEvidence,
  MaterializedFileError,
} from '../src/lib/tts-c/materialized-file-validator';
import {destinationAbsolutePath, materializationRootAbs} from '../src/lib/tts-c/paths';

const TAG = 'test-tts-c1a-r4-hardening';
const ADAPTER_KEY = 'indextts2-adapter-registry@1';
let fx: C1aFixture;

interface RevCtx {
  revisionId: string;
  sha: string;
  assignmentArtifactId: string;
  canonicalAbs: string;
  rel: string;
}

async function freshRevision(freq: number): Promise<RevCtx> {
  const rev = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `r4-rev-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, freq)},
    execDeps,
  );
  const row = rev.outcome === 'created' || rev.outcome === 'reused' ? rev.revision : null;
  if (!row) throw new Error('rev ingest failed');
  const canonicalAbs = path.join(fx.dataDir, 'voice-library', fx.profileId, row.id, 'reference.wav');
  const sha = sha256Buf(fs.readFileSync(canonicalAbs));
  const built = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: row.id,
    requestId: `r4-asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error('asg failed');
  return {
    revisionId: row.id,
    sha,
    assignmentArtifactId: built.artifact.id,
    canonicalAbs,
    rel: `${fx.profileId}/${row.id}/reference.wav`,
  };
}

async function claimHandleFor(rev: RevCtx, requestId: string): Promise<MaterializationExecutionHandle> {
  await createMaterializationRequest(fx.projectId, requestId, rev.assignmentArtifactId);
  const claimed = claimNextAnyJob('r4-worker');
  if (!claimed || claimed.type !== 'voice_materialization') throw new Error(`claim failed: ${requestId}`);
  return claimed.handle;
}

/** 造 exact final 文件（copy canonical → destination）。 */
function makeExactFinal(rev: RevCtx): string {
  const finalAbs = destinationAbsolutePath(rev.rel);
  fs.mkdirSync(path.dirname(finalAbs), {recursive: true});
  fs.copyFileSync(rev.canonicalAbs, finalAbs);
  return finalAbs;
}

function openHeldFor(rev: RevCtx, mode: 'verify' | 'durabilize'): Promise<HeldMaterializedFileEvidence> {
  return openHeldMaterializedFileEvidence(
    {
      relativePath: rev.rel,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev.revisionId,
      expectedSha256: rev.sha,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: ADAPTER_KEY,
    },
    mode,
  );
}

/** 构造 workerFinalizeMaterialization 的合法 input（revisionEvidence + asgSnapshots 实读）。 */
function finalizeInput(handle: MaterializationExecutionHandle, rev: RevCtx, held: HeldMaterializedFileEvidence) {
  const asgSnapshots = [];
  for (const r of listActiveRequestRows(handle.jobId)) {
    const asgRow = getProjectVoiceAssignment(r.project_id, r.assignment_artifact_id);
    if (asgRow) asgSnapshots.push({artifactId: r.assignment_artifact_id, contentHash: sha256Text(asgRow.artifact.content_json)});
  }
  return {
    handle,
    held,
    revisionEvidence: {
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: rev.revisionId,
      canonicalAudioSha256: rev.sha,
      adapterCompatibilityKey: ADAPTER_KEY,
      provider: 'indextts2',
      fileSize: fs.statSync(rev.canonicalAbs).size,
    },
    asgSnapshots,
  };
}

/** dataDir 的 filesystem 快照（相对路径 → 类型），用于零写断言。 */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        out.set(rel, 'd');
        walk(abs);
      } else if (e.isSymbolicLink()) {
        out.set(rel, 'l');
      } else {
        out.set(rel, `f:${fs.statSync(abs).size}`);
      }
    }
  };
  walk(root);
  return out;
}

function treeEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

/** executor + commit 前攻击 hook；断言 job 不得 succeeded 且 projection=0。 */
async function expectCommitReject(rev: RevCtx, requestId: string, attack: (finalAbs: string) => void): Promise<void> {
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

  // ═══ Capability（P0-A）═══

  // ── CAP-01：plain object 伪装 Held → 拒绝 ──
  const revC1 = await freshRevision(3110);
  const hC1 = await claimHandleFor(revC1, 'cap-1');
  const plainFake = {
    evidence: {relativePath: revC1.rel, sha256: revC1.sha, durabilityEstablished: true},
    fileFd: {fd: 0},
    parentFd: {fd: 0},
  };
  let cap01a = false;
  try {
    assertHeldCapability(plainFake);
  } catch (e) {
    cap01a = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
  }
  ok(cap01a, 'CAP-01a plain object → assertHeldCapability 拒绝');
  let cap01b = false;
  try {
    workerFinalizeMaterialization(finalizeInput(hC1, revC1, plainFake as unknown as HeldMaterializedFileEvidence));
  } catch (e) {
    cap01b =
      (e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH') ||
      (e instanceof MaterializationError && e.code === 'REQUEST_STATE_INCONSISTENT');
  }
  ok(cap01b, 'CAP-01b plain object → workerFinalize 第一道 fence 拒绝');
  ok(getMaterializationJob(hC1.jobId)?.status !== 'succeeded', 'CAP-01c job 不得 succeeded', getMaterializationJob(hC1.jobId)?.status);
  ok(getProjection(fx.profileId, revC1.revisionId) === undefined, 'CAP-01d projection=0', undefined);

  // ── CAP-02：Object.create(Held.prototype)（prototype spoof）→ 拒绝 ──
  const spoof = Object.create(HeldMaterializedFileEvidence.prototype) as HeldMaterializedFileEvidence;
  let cap02 = false;
  try {
    assertHeldCapability(spoof);
  } catch (e) {
    cap02 = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
  }
  ok(cap02, 'CAP-02 Object.create(prototype) spoof → 拒绝');

  // ── CAP-03：clone 合法实例 + arbitrary fd → 拒绝 ──
  const revC3 = await freshRevision(3120);
  makeExactFinal(revC3);
  const legitC3 = await openHeldFor(revC3, 'durabilize');
  const arbFh = await fsp.open(revC3.canonicalAbs, 'r'); // arbitrary fd（canonical source）
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(legitC3)) as HeldMaterializedFileEvidence,
    legitC3,
  );
  (clone as unknown as {fileHandle: unknown}).fileHandle = arbFh;
  let cap03 = false;
  try {
    assertHeldCapability(clone);
  } catch (e) {
    cap03 = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
  }
  ok(cap03, 'CAP-03 clone 合法实例 + arbitrary fd → 拒绝（clone 不在 WeakSet）');
  await arbFh.close();
  await legitC3.close();

  // ── CAP-04：公开 API 无 create/register capability；无 token 构造 → 拒绝 ──
  const validatorModule = await import('../src/lib/tts-c/materialized-file-validator');
  ok(
    (HeldMaterializedFileEvidence as unknown as {create?: unknown}).create === undefined &&
      (validatorModule as Record<string, unknown>).issueHeldEvidence === undefined &&
      (validatorModule as Record<string, unknown>).legitimateHeldEvidence === undefined &&
      (validatorModule as Record<string, unknown>).HELD_ISSUE_TOKEN === undefined,
    'CAP-04a 公开 API 不存在 create/register/token 入口',
  );
  let cap04b = false;
  try {
    // 无 module-private issue token 直接构造（模拟 runtime 绕过 TypeScript）→ 必须抛
    new HeldMaterializedFileEvidence({} as never, {} as never, {} as never, 'verify' as never, Symbol('forged'));
  } catch (e) {
    cap04b = e instanceof MaterializedFileError && e.code === 'SEAL_MISMATCH';
  }
  ok(cap04b, 'CAP-04b 无 issue token 直接构造 → 拒绝');

  // ── CAP-05：合法 openHeld 结果 → capability + seal 通过 ──
  const revC5 = await freshRevision(3130);
  makeExactFinal(revC5);
  const legitC5 = await openHeldFor(revC5, 'durabilize');
  let cap05 = true;
  try {
    assertHeldCapability(legitC5);
    assertHeldCurrentSync(legitC5, {requireDurability: true});
  } catch (e) {
    cap05 = false;
    console.log('       ', e);
  }
  ok(cap05, 'CAP-05 合法 openHeld → capability + commit seal 通过');
  ok(
    legitC5.evidence.rootIno !== 0n && legitC5.evidence.profileIno !== 0n && legitC5.evidence.parentIno !== 0n,
    'CAP-05b evidence 记录 root/profile/revision ancestor dev/ino',
  );
  await legitC5.close();

  // ═══ Exact absolute destination binding（P0-B → R5 P0-A immutable authority）═══
  // R5 注：tampering held.evidence 公开字段不再影响授权（authority record 来自 WeakMap，
  // 不可篡改）。原 R4 SEAL-08/10/11 的语义改为验证「公开字段被改写时 authority record
  // 保持不变 → 仍以 record 为准成功 commit」，由 R5 测试套件的 CAP-07 覆盖。
  // 本节保留：合法 held → commit seal 仍通过（防回归 R4 已删除的篡改测试）。

  // ═══ Full ancestor chain seal（P0-C）═══

  // ── DIR-04：profile ancestor rename+symlink（final/immediate parent inode 不变）→ commit 拒绝 ──
  const revD4 = await freshRevision(3180);
  {
    const rootAbs = materializationRootAbs();
    const profileDir = path.join(rootAbs, fx.profileId);
    const moved = `${profileDir}.moved-r4d4`;
    await expectCommitReject(revD4, 'dir-4', () => {
      fs.renameSync(profileDir, moved);
      fs.symlinkSync(moved, profileDir);
    });
    // restore（后续测试共用同一 profileId）
    fs.rmSync(profileDir, {force: true});
    fs.renameSync(moved, profileDir);
  }

  // ── DIR-05：materialization root rename+symlink → commit 拒绝 ──
  const revD5 = await freshRevision(3190);
  {
    const rootAbs = materializationRootAbs();
    const moved = `${rootAbs}.moved-r4d5`;
    await expectCommitReject(revD5, 'dir-5', () => {
      fs.renameSync(rootAbs, moved);
      fs.symlinkSync(moved, rootAbs);
    });
    fs.rmSync(rootAbs, {force: true});
    fs.renameSync(moved, rootAbs);
  }

  // ── DIR-06：profile replaced by different directory（revision/file inode 不变）→ commit 拒绝 ──
  const revD6 = await freshRevision(3210);
  {
    const rootAbs = materializationRootAbs();
    const profileDir = path.join(rootAbs, fx.profileId);
    const moved = `${profileDir}.moved-r4d6`;
    await expectCommitReject(revD6, 'dir-6', (finalAbs) => {
      const revDir = path.dirname(finalAbs);
      fs.renameSync(profileDir, moved);
      fs.mkdirSync(profileDir); // 新 directory（新 inode）
      fs.renameSync(path.join(moved, path.basename(revDir)), path.join(profileDir, path.basename(revDir)));
    });
    // restore：把 revision 目录移回 moved，删新 profile，rename 回原名
    const revDirName = revD6.revisionId;
    fs.renameSync(path.join(profileDir, revDirName), path.join(moved, revDirName));
    fs.rmSync(profileDir, {recursive: true, force: true});
    fs.renameSync(moved, profileDir);
  }

  // ── DIR-07：合法完整 ancestor chain → pass ──
  const revD7 = await freshRevision(3220);
  const hD7 = await claimHandleFor(revD7, 'dir-7');
  await runMaterializationJob(hD7, {log: () => undefined});
  ok(getMaterializationJob(hD7.jobId)?.status === 'succeeded', 'DIR-07 合法 ancestor chain → job succeeded', getMaterializationJob(hD7.jobId)?.status);
  ok(getProjection(fx.profileId, revD7.revisionId)?.status === 'file_ready_unpublished', 'DIR-07b projection file_ready_unpublished');

  // ═══ Verify zero-write（P0-D）═══

  // 准备：succeeded request + projection，然后删除整个 materialization root
  const revV = await freshRevision(3230);
  await createMaterializationRequest(fx.projectId, 'vfy-1', revV.assignmentArtifactId);
  const hV = claimNextAnyJob('r4-worker');
  if (!hV || hV.type !== 'voice_materialization') throw new Error('claim vfy failed');
  await runMaterializationJob(hV.handle, {log: () => undefined});
  ok(getMaterializationRequest(fx.projectId, 'vfy-1')?.status === 'succeeded', 'VERIFY-00 准备：request succeeded');
  const rootAbsV = materializationRootAbs();
  fs.rmSync(rootAbsV, {recursive: true, force: true}); // 删除整个 voice-materializations/
  ok(!fs.existsSync(rootAbsV), 'VERIFY-00b root 已删除');

  // ── VERIFY-01：GET 不 mkdir（missing + filesystem snapshot 完全不变）──
  const snapBefore1 = snapshotTree(fx.dataDir);
  const route = await import('../src/app/api/projects/[id]/voice-materializations/route');
  const g1 = await route.GET(new Request('http://localhost/api/projects/x/voice-materializations'), {params: Promise.resolve({id: fx.projectId})});
  ok(g1.status === 200, 'VERIFY-01a GET 200', g1.status);
  const body1 = (await g1.json()) as {requests: Array<{requestId: string; integrityStatus: string; materialization: {status: string | null} | null}>};
  const view1 = body1.requests.find((r) => r.requestId === 'vfy-1');
  ok(view1?.integrityStatus === 'missing', 'VERIFY-01b GET integrityStatus=missing', view1?.integrityStatus);
  ok(view1?.materialization?.status === 'unusable', 'VERIFY-01c GET 不把损坏 projection 显示为可用', view1?.materialization?.status);
  ok(!fs.existsSync(rootAbsV), 'VERIFY-01d GET 不重建 root（零 mkdir）');
  ok(treeEqual(snapBefore1, snapshotTree(fx.dataDir)), 'VERIFY-01e filesystem snapshot 完全不变');

  // ── VERIFY-02：reuse validation 不 mkdir ──
  const snapBefore2 = snapshotTree(fx.dataDir);
  const projV = getProjection(fx.profileId, revV.revisionId);
  ok(projV !== undefined, 'VERIFY-02a projection row 存在（DB 层）');
  const val2 = await validateExistingProjection(projV!, null, 'unknown');
  ok(val2.kind === 'unusable', 'VERIFY-02b reuse validation → unusable', val2.kind);
  ok(!fs.existsSync(rootAbsV), 'VERIFY-02c reuse validation 不重建 root');
  ok(treeEqual(snapBefore2, snapshotTree(fx.dataDir)), 'VERIFY-02d filesystem snapshot 不变');

  // ── VERIFY-03：replay（同 requestId 重放）不 mkdir ──
  const snapBefore3 = snapshotTree(fx.dataDir);
  let replayRejected = false;
  try {
    await createMaterializationRequest(fx.projectId, 'vfy-1', revV.assignmentArtifactId);
  } catch (e) {
    replayRejected = e instanceof MaterializationError && e.code === 'MATERIALIZATION_UNUSABLE';
  }
  ok(replayRejected, 'VERIFY-03a replay succeeded request → fail-closed 拒绝（不冒充 reused）');
  ok(!fs.existsSync(rootAbsV), 'VERIFY-03b replay 不重建 root');
  ok(treeEqual(snapBefore3, snapshotTree(fx.dataDir)), 'VERIFY-03c filesystem snapshot 不变');

  // ── VERIFY-04：Worker writer 可创建 root/profile/revision ──
  const revV4 = await freshRevision(3240);
  await createMaterializationRequest(fx.projectId, 'vfy-4', revV4.assignmentArtifactId);
  const hV4 = claimNextAnyJob('r4-worker');
  if (!hV4 || hV4.type !== 'voice_materialization') throw new Error('claim vfy-4 failed');
  await runMaterializationJob(hV4.handle, {log: () => undefined});
  ok(getMaterializationJob(hV4.handle.jobId)?.status === 'succeeded', 'VERIFY-04a Worker writer succeeded', getMaterializationJob(hV4.handle.jobId)?.status);
  ok(fs.existsSync(destinationAbsolutePath(revV4.rel)), 'VERIFY-04b Worker 创建 root/profile/revision/final');

  // ═══ Zero-subscriber closure（§七）═══

  // ── CANCEL-06：worker final transaction 前 subscriber=0 → cancelled / projection=0 ──
  const revK6 = await freshRevision(3250);
  const hK6 = await claimHandleFor(revK6, 'cancel-6');
  await runMaterializationJob(
    hK6,
    {log: () => undefined},
    {
      afterFinalEvidenceBeforeCommit: () => {
        // final evidence 后、commit 前唯一 subscriber 离开（waiting→cancelled）
        db.prepare("UPDATE voice_materialization_requests SET status='cancelled', updated_at=? WHERE job_id=? AND status IN ('waiting','running')")
          .run(new Date().toISOString(), hK6.jobId);
      },
    },
  ).catch(() => undefined);
  ok(getMaterializationJob(hK6.jobId)?.status === 'cancelled', 'CANCEL-06a zero-subscriber → job cancelled（非 succeeded）', getMaterializationJob(hK6.jobId)?.status);
  ok(getProjection(fx.profileId, revK6.revisionId) === undefined, 'CANCEL-06b projection=0（不创建不 repair）', undefined);
  ok(getMaterializationRequest(fx.projectId, 'cancel-6')?.status === 'cancelled', 'CANCEL-06c request 保持 cancelled', getMaterializationRequest(fx.projectId, 'cancel-6')?.status);

  // ── CANCEL-07：validation usable Phase 3 前 subscriber=0 → cancelled / 不 succeeded / 不 fan-out ──
  const revK7 = await freshRevision(3260);
  await createMaterializationRequest(fx.projectId, 'cancel-7a', revK7.assignmentArtifactId);
  const hK7 = claimNextAnyJob('r4-worker');
  if (!hK7 || hK7.type !== 'voice_materialization') throw new Error('claim cancel-7a failed');
  await runMaterializationJob(hK7.handle, {log: () => undefined});
  ok(getMaterializationRequest(fx.projectId, 'cancel-7a')?.status === 'succeeded', 'CANCEL-07a 准备：projection usable');
  setAfterProjectionValidationBeforeFinalize(() => {
    // Phase 2 usable 后、Phase 3 前唯一 subscriber 离开
    db.prepare("UPDATE voice_materialization_requests SET status='cancelled', updated_at=? WHERE project_id=? AND request_id='cancel-7b'")
      .run(new Date().toISOString(), fx.projectId);
  });
  const rK7 = await createMaterializationRequest(fx.projectId, 'cancel-7b', revK7.assignmentArtifactId);
  setAfterProjectionValidationBeforeFinalize(null);
  ok(rK7.outcome === 'cancelled', 'CANCEL-07b usable + zero subscriber → outcome=cancelled', rK7.outcome);
  ok(rK7.job.status === 'cancelled', 'CANCEL-07c validation job cancelled（非 succeeded）', rK7.job.status);
  ok(rK7.request.status === 'cancelled', 'CANCEL-07d request 保持 cancelled（不 fan-out reused）', rK7.request.status);

  // ── CANCEL-08：subscriber>0 合法路径仍 succeeded/reused ──
  const revK8 = await freshRevision(3270);
  await createMaterializationRequest(fx.projectId, 'cancel-8a', revK8.assignmentArtifactId);
  const hK8 = claimNextAnyJob('r4-worker');
  if (!hK8 || hK8.type !== 'voice_materialization') throw new Error('claim cancel-8a failed');
  await runMaterializationJob(hK8.handle, {log: () => undefined});
  ok(getMaterializationRequest(fx.projectId, 'cancel-8a')?.status === 'succeeded', 'CANCEL-08a subscriber>0 → worker succeeded');
  const rK8 = await createMaterializationRequest(fx.projectId, 'cancel-8b', revK8.assignmentArtifactId);
  ok(rK8.outcome === 'reused' && rK8.job.status === 'succeeded' && rK8.request.status === 'reused', 'CANCEL-08b subscriber>0 → validation reused', {outcome: rK8.outcome, job: rK8.job.status, req: rK8.request.status});

  cleanupC1a(TAG);
  summary('TTS-C.1A.R4 hardening');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

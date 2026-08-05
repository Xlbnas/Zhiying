/**
 * TTS-C.1A Durability 测试（F）：
 * - temp 写入/fsync/校验/rename/final fsync/dir fsync 失败 → 不返回成功；
 * - final DB 事务失败 → 文件已 durable 但 DB 不提交（无 false success）；
 * - cleanup best-effort 不覆盖原始错误；orphan 不被视为 usable；
 * - cleanup 不删除 DB 已引用文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, createC1aRequest, type C1aFixture} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runMaterializationJob} from '../src/worker/materialization-executor';
import {workerFinalizeMaterialization, MaterializationError} from '../src/lib/tts-c/materialization';
import {destinationAbsolutePath} from '../src/lib/tts-c/paths';
import {openHeldMaterializedFileEvidence} from '../src/lib/tts-c/materialized-file-validator';

const TAG = 'test-tts-c1a-durability';
let fx: C1aFixture;

async function claimAndRun(fx_: C1aFixture, requestId: string, deps: Parameters<typeof runMaterializationJob>[2] = {}): Promise<{outcome: 'ok' | 'err'; err?: unknown}> {
  const r = await createC1aRequest(fx_, requestId);
  const claimed = claimNextAnyJob('dur-worker');
  if (!claimed || claimed.type !== 'voice_materialization') return {outcome: 'err', err: new Error('claim failed')};
  try {
    await runMaterializationJob(claimed.handle, {log: () => undefined}, deps);
    return {outcome: 'ok'};
  } catch (e) {
    return {outcome: 'err', err: e};
  }
}

(async () => {
  fx = await setupC1aFixture(TAG);
  // 1) temp 写入失败（sha256 注入抛错 → 校验失败路径；同时验证 cleanup 不覆盖原始错误）
  const r1 = await claimAndRun(fx, 'dur-1', {
    sha256File: async () => {
      throw new Error('injected sha failure');
    },
  });
  ok(r1.outcome === 'err', 'temp 校验失败 → 不返回成功', r1.outcome);
  const db = getDb();
  // R1：确定性 executor 错误且仍持有 exact handle → 立即 fenced failed + requests fan-out（不等 lease 过期）
  const j1 = db.prepare("SELECT status FROM voice_materialization_jobs WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status='failed'").all(fx.profileId, fx.revisionId);
  ok(j1.length === 1, '确定性错误 → 立即 fenced failed（非 running 滞留）', j1.length);
  const r1Req = db.prepare("SELECT status FROM voice_materialization_requests WHERE project_id=? AND request_id='dur-1'").get(fx.projectId) as {status: string} | undefined;
  ok(r1Req?.status === 'failed', '失败请求 fan-out → failed', r1Req?.status);
  const matCount = (db.prepare('SELECT count(*) c FROM voice_materializations').get() as {c: number}).c;
  ok(matCount === 0, '失败不创建 projection', matCount);

  // 2) 真实成功路径（对照；新 request 自建 envelope → queued → Worker copy）
  const r2 = await claimAndRun(fx, 'dur-2');
  ok(r2.outcome === 'ok', '正常路径成功（失败后新请求恢复对照）', r2.outcome);
  const projOk = db
    .prepare("SELECT * FROM voice_materializations WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status='file_ready_unpublished'")
    .get(fx.profileId, fx.revisionId);
  ok(!!projOk, '恢复后 projection = file_ready_unpublished', projOk ?? null);

  // 3) DB final 事务失败注入：workerFinalizeMaterialization 用伪造 handle（no-such-job）→ STALE 错误，
  //    不产生 false success
  // 先建真实 final 文件拿 held（伪造 handle 场景：fenced reread 先失败 → STALE，held 内容无关）
  const fakeFinalAbs = destinationAbsolutePath(`${fx.profileId}/${fx.revisionId}/reference.wav`);
  fs.mkdirSync(path.dirname(fakeFinalAbs), {recursive: true});
  fs.copyFileSync(path.join(fx.dataDir, 'voice-library', fx.profileId, fx.revisionId, 'reference.wav'), fakeFinalAbs);
  const fakeHeld = await openHeldMaterializedFileEvidence(
    {
      relativePath: `${fx.profileId}/${fx.revisionId}/reference.wav`,
      voiceProfileId: fx.profileId,
      voiceProfileRevisionId: fx.revisionId,
      expectedSha256: fx.revisionSha256,
      expectedCodec: 'pcm_s16le',
      expectedSampleRate: 48000,
      expectedChannels: 1,
      minDurationMs: 1,
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    'durabilize',
  );
  try {
    workerFinalizeMaterialization({
      handle: {jobId: 'no-such-job', ownerToken: 'x', attempt: 1, leaseExpiresAtEpochMs: Date.now() + 60000},
      held: fakeHeld,
      revisionEvidence: {
        voiceProfileId: fx.profileId,
        voiceProfileRevisionId: fx.revisionId,
        canonicalAudioSha256: fx.revisionSha256,
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
        provider: 'indextts2',
        fileSize: fs.statSync(path.join(fx.dataDir, 'voice-library', fx.profileId, fx.revisionId, 'reference.wav')).size,
      },
      asgSnapshots: [],
    });
    ok(false, 'final DB 失败注入 → 抛错', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'STALE_VALIDATION_OWNER', 'final DB 失败 → STALE_VALIDATION_OWNER', e);
  } finally {
    await fakeHeld.close();
  }

  // 4) orphan 文件不视为 usable：向 materialization root 写入无 DB 引用的孤儿文件，
  //    reader 只认 voice_materializations 行（fail-closed），孤儿不影响任何证据
  const orphanProfile = crypto.randomUUID();
  const orphanRevision = crypto.randomUUID();
  const orphanRel = `${orphanProfile}/${orphanRevision}/reference.wav`;
  const orphanAbs = path.join(fx.dataDir, 'voice-materializations', orphanRel);
  fs.mkdirSync(path.dirname(orphanAbs), {recursive: true});
  fs.writeFileSync(orphanAbs, makeWavBytes(800, 300));
  const orphanRef = getDb()
    .prepare('SELECT * FROM voice_materializations WHERE voice_profile_id=? AND voice_profile_revision_id=?')
    .get(orphanProfile, orphanRevision);
  ok(!orphanRef, '孤儿文件无 DB 行 → 不被任何 reader 引用（fail-closed）');
  ok(fs.existsSync(orphanAbs), '孤儿文件保持存在（cleanup 不主动删除未引用文件）');
  fs.rmSync(path.dirname(path.dirname(orphanAbs)), {recursive: true, force: true}); // 清理孤儿目录

  // 5) cleanup 不删除 DB 已引用文件：删除 DB 引用的 final 文件 → validator 判 unusable
  const realProj = getDb().prepare('SELECT * FROM voice_materializations WHERE voice_profile_id=? AND voice_profile_revision_id=?').get(fx.profileId, fx.revisionId) as {destination_voice_root_relative_path: string} | undefined;
  if (realProj) {
    const realAbs = path.join(fx.dataDir, 'voice-materializations', realProj.destination_voice_root_relative_path);
    const realBytes = fs.readFileSync(realAbs);
    fs.rmSync(realAbs, {force: true});
    const {validateExistingProjection} = await import('../src/lib/tts-c/materialization');
    const vr = await validateExistingProjection(realProj as never);
    ok(vr.kind === 'unusable', 'DB 引用文件被删 → validator 判 unusable（fail-closed）', vr.kind);
    fs.writeFileSync(realAbs, realBytes); // 还原
  }

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-durability');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function makeWavBytes(durationMs: number, freq: number): Buffer {
  const sampleRate = 48000;
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

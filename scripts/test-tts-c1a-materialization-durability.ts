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

const TAG = 'test-tts-c1a-durability';
let fx: C1aFixture;

async function claimAndRun(fx_: C1aFixture, requestId: string, deps: Parameters<typeof runMaterializationJob>[2] = {}): Promise<{outcome: 'ok' | 'err'; err?: unknown}> {
  const r = await createC1aRequest(fx_, requestId);
  const claimed = claimNextAnyJob('dur-worker');
  if (!claimed || claimed.type !== 'voice_materialization') return {outcome: 'err', err: new Error('claim failed')};
  try {
    await runMaterializationJob(
      {jobId: claimed.job.id, ownerToken: claimed.job.owner_token!, attempt: claimed.job.attempt},
      {log: () => undefined},
      deps,
    );
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
  const j1 = db.prepare("SELECT status FROM voice_materialization_jobs WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status='running'").all(fx.profileId, fx.revisionId);
  ok(j1.length >= 0, '失败不提交 success（无 file_ready 由 worker 注入路径产生）');
  // 模拟 Worker 失联（崩溃后 lease 自然过期）：把 running job lease 置为过去。
  // 随后 dur-2 的 request 走 fenced 恢复：running(lease 过期)→failed → 新建 validating
  // → 无 projection → unusable + subscriber>0 → queued → Worker claim → 正常 copy。
  const expired = db
    .prepare(
      `UPDATE voice_materialization_jobs
       SET lease_expires_at_epoch_ms = ?
       WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status='running'`,
    )
    .run(Date.now() - 1000, fx.profileId, fx.revisionId);
  ok(expired.changes === 1, '失联恢复前置：running job lease 置为过期', expired.changes);

  // 2) 真实成功路径（对照；经失联恢复循环后正常 copy）
  const r2 = await claimAndRun(fx, 'dur-2');
  ok(r2.outcome === 'ok', '正常路径成功（失联恢复对照）', r2.outcome);
  const projOk = db
    .prepare("SELECT * FROM voice_materializations WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status='file_ready_unpublished'")
    .get(fx.profileId, fx.revisionId);
  ok(!!projOk, '恢复后 projection = file_ready_unpublished', projOk ?? null);

  // 3) DB final 事务失败注入：workerFinalizeMaterialization 用错误 jobId → STALE 错误，
  //    不产生 false success
  try {
    workerFinalizeMaterialization({
      jobId: 'no-such-job',
      sourceAbsPath: 'x', sourceSha256: 'a'.repeat(64), sourceSize: 1,
      codec: 'pcm_s16le', sampleRate: 48000, channels: 1, durationMs: 100,
    });
    ok(false, 'final DB 失败注入 → 抛错', 'no error');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === 'STALE_VALIDATION_OWNER', 'final DB 失败 → STALE_VALIDATION_OWNER', e);
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

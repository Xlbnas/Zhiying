/**
 * TTS-C.1A.R2 Worker materialization executor（唯一文件 writer）。
 *
 * 执行顺序（R2 加固）：
 *   fenced 确认持有（execution handle exact，DB-time lease）→ exact Revision reread →
 *   heartbeat loop + shutdown listener（统一登记）→ source open（O_NOFOLLOW + fstat）→
 *   containment（root realpath + 逐级 lstat）→ temp 写入（O_EXCL|O_NOFOLLOW）+ fsync →
 *   temp 预校验（早期失败，非 final evidence）→ rename 前 fenced verify → rename →
 *   [hook afterRenameBeforeFinalEvidence（测试注入）] →
 *   validateMaterializedFile(durabilize)：rename 后对真实 final 重新 O_NOFOLLOW 打开、
 *   fd SHA、fd WAV header、fsync final、fsync parent dir → MaterializedFileEvidence →
 *   BEGIN IMMEDIATE fenced 终局（workerFinalizeMaterialization：execution handle exact +
 *   commit-time exact source fence + final evidence 逐项）。
 * 任一 durability 步骤失败 → 不返回成功；确定性错误且仍持有 handle → 立即 fenced failed；
 * 外层 try/finally 统一关闭全部 fd / timer / listener / temp（cleanup 不跟随 symlink）。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {getDb} from '../lib/db';
import {getMaterializationJob, workerFinalizeMaterialization, failMaterializationJobFenced, type MaterializationExecutionHandle} from '../lib/tts-c/materialization';
import {validateVoiceProfileRevisionExact} from '../lib/voice-library/revisions';
import {
  destinationAbsolutePath,
  stagingTempPath,
  materializationRootAbs,
  ensureDestinationParentSafe,
  OPEN_FLAGS,
} from '../lib/tts-c/paths';
import {validateMaterializedFile, type MaterializedFileEvidence} from '../lib/tts-c/materialized-file-validator';
import {
  MATERIALIZATION_HEARTBEAT_INTERVAL_MS,
  MATERIALIZATION_EXECUTION_LEASE_MS,
} from '../lib/tts-c/constants';
import {probeAudio, sha256FileBytes} from '../lib/tts-c/audio-probe';

export interface MaterializationExecutorContext {
  log: (...args: unknown[]) => void;
  isShuttingDown?: () => boolean;
  shutdownSignal?: AbortSignal;
}

export interface MaterializationExecutorDeps {
  /** 测试注入：真实实现 = sha256FileBytes（temp 预校验） */
  sha256File?: (absPath: string) => Promise<string>;
  heartbeatMs?: number;
  leaseMs?: number;
  /** 测试注入：heartbeat loss 回调 */
  onHeartbeatLoss?: () => void;
  /** 测试注入（仅测试）：rename 后、final evidence 读取前 */
  afterRenameBeforeFinalEvidence?: (finalAbs: string) => Promise<void> | void;
}

function dbNowMs(db: ReturnType<typeof getDb>): number {
  const row = db.prepare(`SELECT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) AS n`).get() as {n: number};
  return row.n;
}

function dbNowSql(): string {
  return `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;
}

export async function runMaterializationJob(
  handle: MaterializationExecutionHandle,
  ctx: MaterializationExecutorContext,
  deps: MaterializationExecutorDeps = {},
): Promise<void> {
  const {log} = ctx;
  const shaImpl = deps.sha256File ?? sha256FileBytes;
  const heartbeatMs = deps.heartbeatMs ?? MATERIALIZATION_HEARTBEAT_INTERVAL_MS;
  const leaseMs = deps.leaseMs ?? MATERIALIZATION_EXECUTION_LEASE_MS;

  let tempPath: string | null = null;
  let ownershipLost = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const openedFds: fsSync.promises.FileHandle[] = [];

  /** fenced heartbeat/verify：exact handle + DB-time lease；changes=0 → ownershipLost。 */
  const verifyExecutionLease = (): boolean => {
    if (ownershipLost) return false;
    if (ctx.isShuttingDown?.()) {
      ownershipLost = true;
      stopHeartbeat();
      return false;
    }
    const db = getDb();
    const dbNow = dbNowMs(db);
    const res = db
      .prepare(
        `UPDATE voice_materialization_jobs
         SET lease_expires_at_epoch_ms = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'
           AND owner_token = ? AND attempt = ?
           AND (${dbNowSql()}) <= lease_expires_at_epoch_ms`,
      )
      .run(dbNow + leaseMs, new Date().toISOString(), new Date().toISOString(), handle.jobId, handle.ownerToken, handle.attempt);
    if (res.changes !== 1) {
      ownershipLost = true;
      stopHeartbeat();
      deps.onHeartbeatLoss?.();
      return false;
    }
    return true;
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const closeFd = async (fh: fsSync.promises.FileHandle | null): Promise<void> => {
    if (!fh) return;
    try {
      await fh.close();
    } catch {
      /* best-effort；不覆盖原错误 */
    }
    const idx = openedFds.indexOf(fh);
    if (idx !== -1) openedFds.splice(idx, 1);
  };

  // 外层资源生命周期（R2 §九）：source/temp/final/dir fd + timer + listener + temp path
  let srcFh: fsSync.promises.FileHandle | null = null;
  let tmpFh: fsSync.promises.FileHandle | null = null;
  let finalFh: fsSync.promises.FileHandle | null = null;
  let dirFh: fsSync.promises.FileHandle | null = null;
  let shutdownListener: (() => void) | null = null;
  let caughtErr: unknown = null;

  const cleanupTemp = async (): Promise<void> => {
    if (tempPath) {
      try {
        await fs.rm(tempPath, {force: true});
      } catch {
        // cleanup best-effort；不覆盖原始错误；不跟随 symlink（rm 只删自身路径）
      }
      tempPath = null;
    }
  };

  try {
    // 1) fenced 确认仍持有（DB-time lease）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} 已失去执行权，跳过`);
      return;
    }
    const job = getMaterializationJob(handle.jobId);
    if (!job || job.status !== 'running') {
      log(`materialization job ${handle.jobId} 不在 running，跳过`);
      return;
    }
    if (job.owner_token !== handle.ownerToken || job.attempt !== handle.attempt) {
      log(`materialization job ${handle.jobId} owner/attempt 与 handle 不匹配，跳过`);
      return;
    }

    // 2) exact Revision reread + source SHA
    const descriptor = await validateVoiceProfileRevisionExact(job.voice_profile_id, job.voice_profile_revision_id);
    if (!descriptor || !descriptor.usable) {
      throw new Error(`materialization job ${handle.jobId} source unusable: ${descriptor?.unusableReason ?? 'identity failed'}`);
    }
    if (descriptor.actualSha256 !== job.source_canonical_sha256) {
      throw new Error(`materialization job ${handle.jobId} source sha256 与 job 冻结值不一致`);
    }
    const revisionEvidence = {
      voiceProfileId: job.voice_profile_id,
      voiceProfileRevisionId: job.voice_profile_revision_id,
      canonicalAudioSha256: descriptor.actualSha256,
      adapterCompatibilityKey: descriptor.row.adapter_compatibility_key,
      provider: descriptor.row.provider,
      fileSize: descriptor.fileSize,
    };
    const sourceAbs = descriptor.canonicalAudioAbsolutePath;

    // 3) heartbeat loop + shutdown listener（统一登记）
    if (ctx.shutdownSignal) {
      shutdownListener = (): void => {
        ownershipLost = true;
        stopHeartbeat();
      };
      ctx.shutdownSignal.addEventListener('abort', shutdownListener, {once: true});
    }
    heartbeatTimer = setInterval(() => {
      try {
        if (!verifyExecutionLease()) {
          log(`materialization job ${handle.jobId} heartbeat 续租失败（lease 丢失）`);
        }
      } catch (err) {
        log(`materialization job ${handle.jobId} heartbeat 异常: ${err instanceof Error ? err.message : String(err)}`);
        ownershipLost = true;
        stopHeartbeat();
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();

    // 4) source open：O_RDONLY|O_NOFOLLOW + fstat regular（source open 前 fenced verify）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} source open 前 lease 丢失，中止`);
      return;
    }
    try {
      srcFh = await fs.open(sourceAbs, OPEN_FLAGS.readNoFollow);
    } catch (err) {
      throw new Error(`source open 失败（no-follow）: ${(err as NodeJS.ErrnoException)?.code ?? String(err)}`);
    }
    const srcStat = await srcFh.stat();
    if (!srcStat.isFile()) throw new Error('source 非 regular file（opened fd）');
    const sourceSize = srcStat.size;

    // 5) containment（root realpath + 逐级 lstat + parent realpath）
    const rootAbs = materializationRootAbs();
    const finalAbs = destinationAbsolutePath(job.destination_voice_root_relative_path);
    const {realRoot, realParent} = await ensureDestinationParentSafe(rootAbs, job.destination_voice_root_relative_path);
    const dirAbs = path.dirname(finalAbs);
    tempPath = stagingTempPath(finalAbs);

    // 6) temp 写入（temp 写前 fenced verify）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} temp 写入前 lease 丢失，中止`);
      return;
    }
    try {
      tmpFh = await fs.open(tempPath, OPEN_FLAGS.tempCreate);
      const buf = Buffer.alloc(1024 * 1024);
      let pos = 0;
      for (;;) {
        // copy 循环尽快检查 ownershipLost（R2 §九：不继续无限写 temp）
        if (ownershipLost || ctx.isShuttingDown?.()) {
          throw new Error('ownership lost / shutdown during copy');
        }
        const {bytesRead} = await srcFh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        await tmpFh.write(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      await tmpFh.sync();
      await closeFd(tmpFh);
      tmpFh = null;
    } catch (err) {
      await closeFd(tmpFh);
      tmpFh = null;
      throw err;
    } finally {
      await closeFd(srcFh);
      srcFh = null;
    }

    // 7) temp 预校验（早期失败；非 final evidence——P0-B）
    const tempSha = await shaImpl(tempPath);
    if (tempSha !== job.source_canonical_sha256) {
      throw new Error(`temp sha256 不一致（${tempSha.slice(0, 12)} ≠ ${job.source_canonical_sha256.slice(0, 12)}）`);
    }
    const tempStat = await fs.lstat(tempPath);
    if (!tempStat.isFile() || tempStat.size !== sourceSize) throw new Error('temp size 不一致');
    const tempProbe = probeAudio(tempPath);
    if (tempProbe.codec !== 'pcm_s16le' || tempProbe.sampleRate !== 48000 || tempProbe.channels !== 1 || tempProbe.durationMs <= 0) {
      throw new Error(`temp WAV 契约不匹配: ${JSON.stringify(tempProbe)}`);
    }

    // 8) rename 前 fenced verify + parent containment 复核
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} rename 前 lease 丢失，中止`);
      return;
    }
    const {realParent: realParentBefore} = await ensureDestinationParentSafe(rootAbs, job.destination_voice_root_relative_path);
    if (realParentBefore !== realParent) throw new Error('rename 前 parent containment 漂移');
    await fs.rename(tempPath, finalAbs);
    tempPath = null;
    const {realParent: realParentAfter} = await ensureDestinationParentSafe(rootAbs, job.destination_voice_root_relative_path);
    if (realParentAfter !== realParent || realParentAfter !== realRoot + path.sep + job.destination_voice_root_relative_path.split('/').slice(0, 2).join(path.sep)) {
      throw new Error('rename 后 parent containment 漂移');
    }

    // 9) hook（仅测试）：rename 后、final evidence 读取前
    if (deps.afterRenameBeforeFinalEvidence) {
      await deps.afterRenameBeforeFinalEvidence(finalAbs);
    }

    // 10) P0-B：rename 后对真实 final 建立 evidence（durabilize：fd SHA + fd WAV + fsync final + dir fsync）
    let evidence: MaterializedFileEvidence;
    try {
      evidence = await validateMaterializedFile(
        {
          relativePath: job.destination_voice_root_relative_path,
          voiceProfileId: job.voice_profile_id,
          voiceProfileRevisionId: job.voice_profile_revision_id,
          expectedSha256: job.source_canonical_sha256,
          expectedSize: sourceSize,
          expectedCodec: 'pcm_s16le',
          expectedSampleRate: 48000,
          expectedChannels: 1,
          minDurationMs: 1,
          adapterCompatibilityKey: job.adapter_compatibility_key,
        },
        'durabilize',
      );
    } catch (err) {
      throw new Error(`final evidence 建立失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 11) final DB transaction 前 fenced verify（commit fence）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} final commit 前 lease 丢失，中止`);
      return;
    }
    // 12) BEGIN IMMEDIATE fenced 终局（commit-time exact source fence + final evidence 逐项）
    const result = workerFinalizeMaterialization({
      handle,
      evidence,
      revisionEvidence,
    });
    log(`materialization job ${handle.jobId} succeeded（projection=${result.projectionId}，requests=${result.requestsUpdated}）`);
  } catch (err) {
    caughtErr = err;
    const msg = err instanceof Error ? err.message : String(err);
    log(`materialization job ${handle.jobId} failed: ${msg}`);
    // 确定性错误且仍持有 exact handle → 立即 fenced failed + fan-out，不等 lease 过期
    if (!ownershipLost) {
      const failed = failMaterializationJobFenced(handle, 'MATERIALIZATION_FAILED', msg, getDb());
      if (failed) {
        log(`materialization job ${handle.jobId} 已 fenced failed + requests fan-out`);
      } else {
        log(`materialization job ${handle.jobId} 无法 fenced failed（lease 已丢/被接管），交由 recovery`);
      }
    }
  } finally {
    // 统一清理：stop heartbeat → remove listener → close 全部 fd → 删 temp
    stopHeartbeat();
    if (shutdownListener && ctx.shutdownSignal) {
      try {
        ctx.shutdownSignal.removeEventListener('abort', shutdownListener);
      } catch {
        /* best-effort */
      }
      shutdownListener = null;
    }
    await closeFd(srcFh);
    await closeFd(tmpFh);
    await closeFd(finalFh);
    await closeFd(dirFh);
    for (const fh of openedFds.splice(0)) {
      await closeFd(fh);
    }
    await cleanupTemp();
    if (caughtErr !== null) {
      const msg = caughtErr instanceof Error ? caughtErr.message : String(caughtErr);
      // ownership lost / lease 丢失 / 中止 = 正常返回（不抛）；其余错误传播给调度循环
      if (!/ownership lost|lease 丢失|中止/.test(msg)) {
        throw caughtErr;
      }
    }
  }
}

// 保持既有导出兼容（tests 引用）
export {sha256FileBytes};

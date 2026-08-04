/**
 * TTS-C.1A.R1 Worker materialization executor（唯一文件 writer）。
 *
 * 执行顺序（frozen durability 协议 + R1 加固）：
 *   fenced 确认持有（execution handle exact）→ exact Revision reread → Assignment/source reread →
 *   heartbeat loop 启动（每 interval 续租；changes=0 → ownershipLost 停止副作用）→
 *   source open（O_RDONLY|O_NOFOLLOW + fstat regular）→ 同目录 staging temp（O_CREAT|O_EXCL|O_NOFOLLOW）
 *   → copy bytes → fsync temp → 校验（SHA/size/regular/WAV/pcm_s16le/mono/48000/duration）→
 *   rename temp→final → fsync final → fsync parent dir →
 *   BEGIN IMMEDIATE fenced 终局（workerFinalizeMaterialization：execution handle exact +
 *   commit-time exact source fence：Revision DB metadata + 每个 active request Assignment source
 *   + final evidence 逐项比较）。
 * 关键步骤前（source open / temp 写 / rename / final DB）显式 fenced heartbeat/verify；
 * 任一 durability 步骤失败 → 不返回成功；确定性错误且仍持有 handle → 立即 fenced failed + fan-out
 * （不等 lease 自然过期）；ownershipLost 后不再产生文件副作用。
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
  /** 测试注入：真实实现 = sha256FileBytes */
  sha256File?: (absPath: string) => Promise<string>;
  heartbeatMs?: number;
  leaseMs?: number;
  /** 测试注入：heartbeat loss 回调 */
  onHeartbeatLoss?: () => void;
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

  /** fenced heartbeat/verify：exact handle；changes=0 → ownershipLost（调用方停止后续副作用）。 */
  const verifyExecutionLease = (): boolean => {
    if (ownershipLost) return false;
    if (ctx.isShuttingDown?.()) {
      ownershipLost = true;
      return false;
    }
    const db = getDb();
    const now = Date.now();
    const res = db
      .prepare(
        `UPDATE voice_materialization_jobs
         SET lease_expires_at_epoch_ms = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'
           AND owner_token = ? AND attempt = ?
           AND (${dbNowSql()}) <= lease_expires_at_epoch_ms`,
      )
      .run(now + leaseMs, new Date().toISOString(), new Date().toISOString(), handle.jobId, handle.ownerToken, handle.attempt);
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

  const cleanupTemp = async (): Promise<void> => {
    if (tempPath) {
      try {
        await fs.rm(tempPath, {force: true});
      } catch {
        // cleanup best-effort；不覆盖原始错误
      }
      tempPath = null;
    }
  };

  try {
    // 1) fenced 确认仍持有（claim 后可能已被接管/回收）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} 已失去执行权，跳过`);
      return;
    }
    // 只读 job 信息（不作为凭据；凭据 = handle）
    const job = getMaterializationJob(handle.jobId);
    if (!job || job.status !== 'running') {
      log(`materialization job ${handle.jobId} 不在 running，跳过`);
      return;
    }
    if (job.owner_token !== handle.ownerToken || job.attempt !== handle.attempt) {
      log(`materialization job ${handle.jobId} owner/attempt 与 handle 不匹配，跳过`);
      return;
    }

    // 2) exact Revision reread（TTS-A 单一真相源）+ Assignment/source reread
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

    // 3) heartbeat loop 启动（shutdown signal 中止）
    if (ctx.shutdownSignal) {
      ctx.shutdownSignal.addEventListener('abort', () => {
        ownershipLost = true;
        stopHeartbeat();
      }, {once: true});
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

    // 4) 关键步骤前 fenced verify（source open 前）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} source open 前 lease 丢失，中止`);
      return;
    }
    // 5) source open：O_RDONLY|O_NOFOLLOW（真实 no-follow）+ fstat 必须 regular（不依赖 lstat→open 两步）
    let srcFh: fsSync.promises.FileHandle;
    try {
      srcFh = await fs.open(sourceAbs, OPEN_FLAGS.readNoFollow);
    } catch (err) {
      throw new Error(`source open 失败（no-follow）: ${(err as NodeJS.ErrnoException)?.code ?? String(err)}`);
    }
    let sourceSize: number;
    try {
      const st = await srcFh.stat();
      if (!st.isFile()) throw new Error('source 非 regular file（opened fd）');
      sourceSize = st.size;
    } finally {
      // 内容读取在 temp 写入阶段用同一 fd
    }

    // 6) 目标目录 containment（P0-3：root realpath + 逐级 lstat + parent realpath）
    const rootAbs = materializationRootAbs();
    const finalAbs = destinationAbsolutePath(job.destination_voice_root_relative_path);
    const {realRoot, realParent} = await ensureDestinationParentSafe(rootAbs, job.destination_voice_root_relative_path);
    const dirAbs = path.dirname(finalAbs);
    tempPath = stagingTempPath(finalAbs);

    // 7) temp 写入：O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW（temp 写前 fenced verify）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} temp 写入前 lease 丢失，中止`);
      return;
    }
    let tmpFh: fsSync.promises.FileHandle | null = null;
    try {
      tmpFh = await fs.open(tempPath, OPEN_FLAGS.tempCreate);
      const buf = Buffer.alloc(1024 * 1024);
      let pos = 0;
      for (;;) {
        const {bytesRead} = await srcFh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        await tmpFh.write(buf.subarray(0, bytesRead));
        pos += bytesRead;
        // 长 copy 期间 heartbeat 由 interval 覆盖；此处不再额外读 DB
      }
      // 8) fsync temp
      await tmpFh.sync();
      await tmpFh.close();
      tmpFh = null;
    } catch (err) {
      if (tmpFh) {
        try {
          await tmpFh.close();
        } catch {
          /* best-effort */
        }
      }
      throw err;
    } finally {
      await srcFh.close();
    }

    // 9) 校验：SHA256 / size / regular / WAV / pcm_s16le / mono / 48000 / duration
    const actualSha = await shaImpl(tempPath);
    if (actualSha !== job.source_canonical_sha256) {
      throw new Error(`temp sha256 不一致（${actualSha.slice(0, 12)} ≠ ${job.source_canonical_sha256.slice(0, 12)}）`);
    }
    const tmpStat = await fs.lstat(tempPath);
    if (!tmpStat.isFile() || tmpStat.size !== sourceSize) throw new Error('temp size 不一致');
    const probe = probeAudio(tempPath);
    if (probe.codec !== 'pcm_s16le' || probe.sampleRate !== 48000 || probe.channels !== 1 || probe.durationMs <= 0) {
      throw new Error(`WAV 契约不匹配: ${JSON.stringify(probe)}`);
    }

    // 10) rename 前 fenced verify + parent containment 复核（rename 前后）
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
    // 11) fsync final（O_RDONLY|O_NOFOLLOW）；12) fsync parent dir
    const finalFh = await fs.open(finalAbs, OPEN_FLAGS.readNoFollow);
    try {
      await finalFh.sync();
    } finally {
      await finalFh.close();
    }
    const dirFh = await fs.open(dirAbs, 'r');
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }

    // 13) final DB transaction 前 fenced verify（commit fence）
    if (!verifyExecutionLease()) {
      log(`materialization job ${handle.jobId} final commit 前 lease 丢失，中止`);
      return;
    }
    // 14-17) BEGIN IMMEDIATE fenced 终局（commit-time exact source fence 在事务内逐项重读）
    const result = workerFinalizeMaterialization({
      handle,
      finalRelativePath: job.destination_voice_root_relative_path,
      finalSha256: actualSha,
      finalSize: sourceSize,
      codec: probe.codec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      durationMs: probe.durationMs,
      revisionEvidence,
    });
    log(`materialization job ${handle.jobId} succeeded（projection=${result.projectionId}，requests=${result.requestsUpdated}）`);
  } catch (err) {
    await cleanupTemp();
    const msg = err instanceof Error ? err.message : String(err);
    log(`materialization job ${handle.jobId} failed: ${msg}`);
    // 确定性错误且仍持有 exact handle（lease 未丢）→ 立即 fenced failed + fan-out，不等 lease 过期
    if (!ownershipLost) {
      const failed = failMaterializationJobFenced(handle, 'MATERIALIZATION_FAILED', msg, getDb());
      if (failed) {
        log(`materialization job ${handle.jobId} 已 fenced failed + requests fan-out`);
      } else {
        log(`materialization job ${handle.jobId} 无法 fenced failed（lease 已丢/被接管），交由 recovery`);
      }
    }
    throw err;
  } finally {
    stopHeartbeat();
  }
}

// 保持既有导出兼容（tests 引用）
export {sha256FileBytes};

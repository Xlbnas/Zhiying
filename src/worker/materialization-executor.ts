/**
 * TTS-C.1A Worker materialization executor（唯一文件 writer）。
 *
 * 执行顺序（frozen durability 协议）：
 *   fenced reread（executor 入口由 scheduler claim 保证 running）→
 *   exact Revision reread（TTS-A validator）→ Assignment/source reread →
 *   open source no-follow → 同目录 staging temp 写入 → copy bytes →
 *   fsync temp → 校验（SHA/size/regular/WAV/pcm_s16le/mono/48000/duration）→
 *   rename temp→final → fsync final → fsync parent dir →
 *   BEGIN IMMEDIATE fenced 终局（workerFinalizeMaterialization）。
 * 任一 durability 步骤失败 → 不返回成功；cleanup best-effort 不覆盖原始错误。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {getDb} from '../lib/db';
import {getMaterializationJob} from '../lib/tts-c/materialization';
import {validateVoiceProfileRevisionExact} from '../lib/voice-library/revisions';
import {getProjectVoiceAssignment, classifyProjectVoiceAssignment} from '../lib/tts-b/assignment';
import {
  destinationAbsolutePath,
  stagingTempPath,
  materializationRootAbs,
} from '../lib/tts-c/paths';
import {workerFinalizeMaterialization} from '../lib/tts-c/materialization';
import {
  MATERIALIZATION_HEARTBEAT_INTERVAL_MS,
  MATERIALIZATION_EXECUTION_LEASE_MS,
} from '../lib/tts-c/constants';
import {probeAudio, sha256FileBytes} from '../lib/tts-c/audio-probe';

export interface MaterializationExecutorContext {
  log: (...args: unknown[]) => void;
  isShuttingDown?: () => boolean;
}

export interface MaterializationExecutorDeps {
  /** 测试注入：真实实现 = sha256FileBytes */
  sha256File?: (absPath: string) => Promise<string>;
  heartbeatMs?: number;
  leaseMs?: number;
}

/** 心跳续约（lease 丢失 → 返回 false；executor 应中止）。 */
export async function heartbeatMaterializationJob(
  jobId: string,
  ownerToken: string,
  attempt: number,
  deps: {leaseMs?: number; heartbeatMs?: number},
): Promise<boolean> {
  const db = getDb();
  const leaseMs = deps.leaseMs ?? MATERIALIZATION_EXECUTION_LEASE_MS;
  const res = db
    .prepare(
      `UPDATE voice_materialization_jobs
       SET lease_expires_at_epoch_ms = ?, heartbeat_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'
         AND owner_token = ? AND attempt = ?
         AND (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(Date.now() + leaseMs, new Date().toISOString(), new Date().toISOString(), jobId, ownerToken, attempt);
  return res.changes === 1;
}

export interface RunMaterializationJobInput {
  jobId: string;
  ownerToken: string;
  attempt: number;
}

export async function runMaterializationJob(
  input: RunMaterializationJobInput,
  ctx: MaterializationExecutorContext,
  deps: MaterializationExecutorDeps = {},
): Promise<void> {
  const {log} = ctx;
  const shaImpl = deps.sha256File ?? sha256FileBytes;
  const heartbeatMs = deps.heartbeatMs ?? MATERIALIZATION_HEARTBEAT_INTERVAL_MS;

  let tempPath: string | null = null;
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
    const job = getMaterializationJob(input.jobId);
    if (!job || job.status !== 'running') {
      log(`materialization job ${input.jobId} 不在 running（可能已接管/取消），跳过`);
      return;
    }
    if (job.owner_token !== input.ownerToken || job.attempt !== input.attempt) {
      log(`materialization job ${input.jobId} owner/attempt 不匹配，跳过`);
      return;
    }

    // 1) exact Revision reread（TTS-A 单一真相源）
    const descriptor = await validateVoiceProfileRevisionExact(job.voice_profile_id, job.voice_profile_revision_id);
    if (!descriptor || !descriptor.usable) {
      throw new Error(`materialization job ${input.jobId} source unusable: ${descriptor?.unusableReason ?? 'identity failed'}`);
    }
    // 2) Assignment/source reread（source SHA 与 job 冻结值一致）
    if (descriptor.actualSha256 !== job.source_canonical_sha256) {
      throw new Error(`materialization job ${input.jobId} source sha256 与 job 冻结值不一致`);
    }
    const sourceAbs = descriptor.canonicalAudioAbsolutePath;
    // 3) open source no-follow（lstat 已在 TTS-A validator 校验非 symlink；此处防御性复查）
    const st = await fs.lstat(sourceAbs);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('source 非 regular file');
    const sourceSize = st.size;

    // 4) 目标目录 + staging temp（同目录保证 rename 原子）
    const rootAbs = materializationRootAbs();
    const finalAbs = destinationAbsolutePath(job.destination_voice_root_relative_path);
    const dirAbs = path.dirname(finalAbs);
    await fs.mkdir(dirAbs, {recursive: true});
    tempPath = stagingTempPath(finalAbs);
    const srcFh = await fs.open(sourceAbs, 'r');
    let tmpFh: fsSync.promises.FileHandle | null = null;
    try {
      tmpFh = await fs.open(tempPath, 'wx');
      const buf = Buffer.alloc(1024 * 1024);
      let pos = 0;
      for (;;) {
        const {bytesRead} = await srcFh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        await tmpFh.write(buf.subarray(0, bytesRead));
        pos += bytesRead;
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

    // 10) rename temp→final；11) fsync final；12) fsync parent dir
    await fs.rename(tempPath, finalAbs);
    tempPath = null;
    const finalFh = await fs.open(finalAbs, 'r');
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

    // 13-17) BEGIN IMMEDIATE fenced 终局
    const result = workerFinalizeMaterialization({
      jobId: input.jobId,
      sourceAbsPath: sourceAbs,
      sourceSha256: actualSha,
      sourceSize,
      codec: probe.codec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      durationMs: probe.durationMs,
    });
    log(`materialization job ${input.jobId} succeeded（projection=${result.projectionId}，requests=${result.requestsUpdated}）`);
  } catch (err) {
    await cleanupTemp();
    // durability 关键步骤失败 → 不返回成功；job 状态由 recover/接管路径处理
    log(`materialization job ${input.jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * TTS-C.1A.R2 共享 safe final-file validator（唯一 exact file contract）。
 *
 * worker temp 校验 / recovery path 校验 / existing projection 校验 三路径共用本模块，
 * 禁止维护三套不同的文件契约。
 *
 * 模式：
 * - verify：Web/validation reuse 只读验证（不要求目录写权限）；
 * - durabilize：Worker/recovery 使用——验证后 fsync final fd + fsync parent dir，
 *   durability 建立后才能允许 DB success。
 *
 * 安全模型（P0-3 + R2）：
 * 1. validateDestinationRelativePath（形状）；
 * 2. root realpath + profile/revision 逐级 lstat + parent realpath containment；
 * 3. final 以 O_RDONLY|O_NOFOLLOW 打开；
 * 4. fstat 必须 regular；
 * 5. SHA 从已打开 fd 读取（不重新按 path 打开）；
 * 6. WAV 契约从同一 fd 安全解析 header（不重新跟随可替换 path）；
 * 7. verify path 当前 dev/inode 与 held fd 一致（detect path replacement）；
 * 8. durabilize：fsync held final fd + 安全打开 parent 并 fsync；
 * 9. fsync 失败 → durabilityEstablished=false / 抛错，禁止 DB success；
 * 10. finally 关闭全部 fd；
 * 11. absolute path 仅供内部（调用方负责 API redaction）。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  destinationAbsolutePath,
  ensureDestinationParentSafe,
  validateDestinationRelativePath,
  OPEN_FLAGS,
  ProjectionPathError,
  materializationRootAbs,
} from './paths';

export class MaterializedFileError extends Error {
  constructor(
    public readonly code:
      | 'MISSING'
      | 'NOT_REGULAR'
      | 'SYMLINK'
      | 'SHA_MISMATCH'
      | 'SIZE_MISMATCH'
      | 'WAV_CONTRACT'
      | 'INODE_CHANGED'
      | 'CONTAINMENT'
      | 'FSYNC_FAILED'
      | 'IO_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'MaterializedFileError';
  }
}

export interface MaterializedFileExpectation {
  relativePath: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  expectedSha256: string;
  expectedSize?: number;
  expectedCodec?: string;
  expectedSampleRate?: number;
  expectedChannels?: number;
  /** duration 下限（ms）；默认 > 0 */
  minDurationMs?: number;
  adapterCompatibilityKey: string;
}

export interface MaterializedFileEvidence {
  relativePath: string;
  /** 内部路径（禁止输出到 API） */
  absolutePathInternal: string;
  sha256: string;
  size: number;
  codec: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  parentRealpath: string;
  durabilityEstablished: boolean;
}

export type MaterializedFileMode = 'verify' | 'durabilize';

/** 测试注入（仅测试）：fsync 失败注入。生产调用方不传（默认真实 fsync）。 */
export interface MaterializedFileValidatorDeps {
  fsyncFile?: (fh: fsSync.promises.FileHandle) => Promise<void>;
  fsyncDir?: (fh: fsSync.promises.FileHandle) => Promise<void>;
}

/** 流式 SHA256 从已打开 fd（1MB buffer）。 */
async function sha256FromFd(fh: fsSync.promises.FileHandle): Promise<string> {
  const buf = Buffer.alloc(1024 * 1024);
  const hash = crypto.createHash('sha256');
  let pos = 0;
  for (;;) {
    const {bytesRead} = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return hash.digest('hex');
}

interface WavParse {
  codec: string;
  sampleRate: number;
  channels: number;
  byteRate: number;
  dataSize: number;
  durationMs: number;
}

/**
 * 从已打开 fd 安全解析 WAV header（RIFF/WAVE/fmt PCM s16le + data chunk size）。
 * 顺序扫描 chunk（容忍 LIST/INFO 等额外 chunk；上限 1MB 防恶意结构）；
 * 不依赖 ffprobe 重新打开 path（避免 TOCTOU）；失败抛 WAV_CONTRACT。
 */
async function parseWavHeaderFromFd(fh: fsSync.promises.FileHandle): Promise<WavParse> {
  const riff = Buffer.alloc(12);
  const {bytesRead: riffRead} = await fh.read(riff, 0, 12, 0);
  if (riffRead < 12) throw new MaterializedFileError('WAV_CONTRACT', 'header 不足 12 字节');
  if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
    throw new MaterializedFileError('WAV_CONTRACT', '非 RIFF/WAVE');
  }
  let fmt: {audioFormat: number; channels: number; sampleRate: number; byteRate: number; bitsPerSample: number} | null = null;
  let dataSize = -1;
  let pos = 12;
  for (;;) {
    if (pos > 1024 * 1024) throw new MaterializedFileError('WAV_CONTRACT', 'chunk 扫描超限（可疑结构）');
    const hdr = Buffer.alloc(8);
    const {bytesRead} = await fh.read(hdr, 0, 8, pos);
    if (bytesRead < 8) break;
    const id = hdr.toString('ascii', 0, 4);
    const size = hdr.readUInt32LE(4);
    if (id === 'fmt ') {
      const body = Buffer.alloc(64);
      const {bytesRead: fmtRead} = await fh.read(body, 0, 64, pos + 8);
      if (fmtRead < 16) throw new MaterializedFileError('WAV_CONTRACT', 'fmt chunk 不完整');
      fmt = {
        audioFormat: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        byteRate: body.readUInt32LE(8),
        bitsPerSample: body.readUInt16LE(14),
      };
      pos += 8 + size + (size % 2);
    } else if (id === 'data') {
      dataSize = size;
      break;
    } else {
      pos += 8 + size + (size % 2);
    }
  }
  if (!fmt) throw new MaterializedFileError('WAV_CONTRACT', '缺 fmt chunk');
  if (fmt.audioFormat !== 1) throw new MaterializedFileError('WAV_CONTRACT', `非 PCM（audioFormat=${fmt.audioFormat}）`);
  if (fmt.bitsPerSample !== 16) throw new MaterializedFileError('WAV_CONTRACT', `非 16-bit（bits=${fmt.bitsPerSample}）`);
  if (dataSize < 0) throw new MaterializedFileError('WAV_CONTRACT', '缺 data chunk');
  const durationMs = fmt.byteRate > 0 ? Math.round((dataSize / fmt.byteRate) * 1000) : 0;
  return {
    codec: 'pcm_s16le',
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    byteRate: fmt.byteRate,
    dataSize,
    durationMs,
  };
}

/**
 * 唯一 exact file contract 入口。
 * 返回不可伪造的 MaterializedFileEvidence；任何不满足 expectation 的
 * 条件抛 MaterializedFileError / ProjectionPathError（fail-closed）。
 */
export async function validateMaterializedFile(
  expectation: MaterializedFileExpectation,
  mode: MaterializedFileMode,
  deps: MaterializedFileValidatorDeps = {},
): Promise<MaterializedFileEvidence> {
  validateDestinationRelativePath(expectation.relativePath);
  const rootAbs = materializationRootAbs();
  const {realRoot, realParent} = await ensureDestinationParentSafe(rootAbs, expectation.relativePath);
  if (!realParent.startsWith(realRoot + path.sep)) {
    throw new MaterializedFileError('CONTAINMENT', 'parent realpath 越出 root');
  }
  const finalAbs = destinationAbsolutePath(expectation.relativePath);

  let fh: fsSync.promises.FileHandle | null = null;
  let dirFh: fsSync.promises.FileHandle | null = null;
  try {
    try {
      fh = await fs.open(finalAbs, OPEN_FLAGS.readNoFollow);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw new MaterializedFileError('MISSING', 'final file 不存在');
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new MaterializedFileError('SYMLINK', 'final 是 symlink（O_NOFOLLOW 拒绝）');
      throw new MaterializedFileError('IO_ERROR', `final open 失败: ${code ?? String(err)}`);
    }
    const st = await fh.stat({bigint: true});
    if (!st.isFile()) throw new MaterializedFileError('NOT_REGULAR', 'final 非 regular file');
    // path 当前 inode/dev 与 held fd 一致（detect replacement）
    let pathStat;
    try {
      pathStat = await fs.lstat(finalAbs);
    } catch (err) {
      throw new MaterializedFileError('INODE_CHANGED', `final path 不可 stat: ${(err as NodeJS.ErrnoException)?.code ?? '?'}`);
    }
    if (pathStat.isSymbolicLink()) throw new MaterializedFileError('SYMLINK', 'final path 现在是 symlink');
    if (pathStat.dev !== Number(st.dev) || pathStat.ino !== Number(st.ino)) {
      throw new MaterializedFileError('INODE_CHANGED', 'final path 与 opened fd 的 dev/inode 不一致（被替换）');
    }
    // SHA from fd
    const sha = await sha256FromFd(fh);
    if (sha !== expectation.expectedSha256) {
      throw new MaterializedFileError('SHA_MISMATCH', `sha256 不一致（${sha.slice(0, 12)}…）`);
    }
    // WAV 契约 from same fd
    const wav = await parseWavHeaderFromFd(fh);
    if (expectation.expectedCodec !== undefined && wav.codec !== expectation.expectedCodec) {
      throw new MaterializedFileError('WAV_CONTRACT', `codec=${wav.codec}`);
    }
    if (expectation.expectedSampleRate !== undefined && wav.sampleRate !== expectation.expectedSampleRate) {
      throw new MaterializedFileError('WAV_CONTRACT', `sampleRate=${wav.sampleRate}`);
    }
    if (expectation.expectedChannels !== undefined && wav.channels !== expectation.expectedChannels) {
      throw new MaterializedFileError('WAV_CONTRACT', `channels=${wav.channels}`);
    }
    const minDur = expectation.minDurationMs ?? 1;
    if (wav.durationMs < minDur) {
      throw new MaterializedFileError('WAV_CONTRACT', `durationMs=${wav.durationMs}`);
    }
    if (expectation.expectedSize !== undefined && st.size !== BigInt(expectation.expectedSize)) {
      throw new MaterializedFileError('SIZE_MISMATCH', `size=${st.size} expected=${expectation.expectedSize}`);
    }
    // durabilize：fsync held final fd + parent dir
    let durabilityEstablished = false;
    if (mode === 'durabilize') {
      try {
        if (deps.fsyncFile) {
          await deps.fsyncFile(fh);
        } else {
          await fh.sync();
        }
        dirFh = await fs.open(realParent, 'r');
        if (deps.fsyncDir) {
          await deps.fsyncDir(dirFh);
        } else {
          await dirFh.sync();
        }
        durabilityEstablished = true;
      } catch (err) {
        throw new MaterializedFileError('FSYNC_FAILED', `durability fsync 失败: ${(err as NodeJS.ErrnoException)?.code ?? String(err)}`);
      }
    }
    return {
      relativePath: expectation.relativePath,
      absolutePathInternal: finalAbs,
      sha256: sha,
      size: Number(st.size),
      codec: wav.codec,
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      durationMs: wav.durationMs,
      device: st.dev,
      inode: st.ino,
      mtimeNs: st.mtimeNs,
      parentRealpath: realParent,
      durabilityEstablished,
    };
  } finally {
    if (dirFh) {
      try {
        await dirFh.close();
      } catch {
        /* best-effort */
      }
    }
    if (fh) {
      try {
        await fh.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

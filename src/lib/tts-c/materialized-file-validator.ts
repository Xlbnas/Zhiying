/**
 * TTS-C.1A.R4 共享 safe final-file validator + Held evidence（唯一 exact file contract）。
 *
 * R3（P0-A/P0-B）：
 * - HeldMaterializedFileEvidence：final fd（O_RDONLY|O_NOFOLLOW）+ parent fd
 *   （O_RDONLY|O_DIRECTORY|O_NOFOLLOW）持有到 DB commit 完成或失败；close() 恰好一次；
 *   普通快照（snapshot）不得用于 DB success；
 * - SHA/WAV 均从 held final fd 读取；fsync held final + held parent；
 * - verify（Web/replay/GET/validation/recovery 校验，零 mkdir/零文件写）与 durabilize
 *   （Worker/recovery 建立 durability）双模式。
 *
 * R4 加固：
 * - P0-A runtime capability seal：module-private WeakSet 登记合法实例；
 *   不存在任何公开 factory/register；clone / Object.create(prototype) / plain object
 *   一律 SEAL_MISMATCH（assertHeldCapability）；
 * - P0-B exact destination binding：commit seal 的目标路径一律从 frozen identity
 *   （voiceProfileId/voiceProfileRevisionId）重新派生（expectedRelative/expectedAbsolute/
 *   expectedParent），绝不信任 evidence 自带路径；evidence 路径字段必须逐项等于派生值；
 * - P0-C full ancestor seal：acquisition 记录 root/profile/revision/file 四级 dev/ino；
 *   commit-time 逐级 lstat（非 symlink、类型、dev/ino）+ root realpath 锚定
 *   path.resolve(materializationRootAbs())；ancestor rename+symlink 替换必拒绝；
 * - P0-D verify 零写：root/parent 缺失 → MISSING，绝不 mkdir（见 paths.ts 拆分）。
 * - 参考审计：Node fs numeric flags 透传 Linux open(2)（O_NOFOLLOW 拒绝 symlink、
 *   O_DIRECTORY 非目录 ENOTDIR）；fd 持有 = inode 锚定，path 可替换 → commit-time 必须
 *   复核 path↔held fd；SQLite 与 filesystem 无跨资源原子事务 → fail-closed 边界 =
 *   held fd + 同步 seal + 先文件后 DB；知影为本地单 Worker writer（无分布式锁需求）。
 *   commit seal 使用 path+lstat 逐级复核（非 dirfd/openat anchored traversal），
 *   依赖本地 single-writer contract；ancestor mutation 由 R4 测试套件覆盖。
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  destinationAbsolutePath,
  destinationRelativePath,
  ensureExistingDestinationParentSafe,
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
      | 'SEAL_MISMATCH'
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
  ctimeNs: bigint;
  parentRealpath: string;
  parentDev: bigint;
  parentIno: bigint;
  /** R4 P0-C：acquisition 时 root / profile 两级 ancestor 身份（revision 级 = parent*） */
  rootDev: bigint;
  rootIno: bigint;
  profileDev: bigint;
  profileIno: bigint;
  durabilityEstablished: boolean;
}

export type MaterializedFileMode = 'verify' | 'durabilize';

/** 测试注入（仅测试）：fsync 失败注入。生产调用方不传（默认真实 fsync）。 */
export interface MaterializedFileValidatorDeps {
  fsyncFile?: (fh: fsSync.promises.FileHandle) => Promise<void>;
  fsyncDir?: (fh: fsSync.promises.FileHandle) => Promise<void>;
}

/**
 * R4 P0-A：module-private issue token（runtime secret，不导出）。
 * 构造器运行时必须出示本 token；外部/测试无法获得 → 无法构造或登记伪造 capability。
 */
const HELD_ISSUE_TOKEN: unique symbol = Symbol('tts-c1a-held-evidence-issue');

/**
 * Held evidence（P0-A）：final + parent fd 持有到 DB commit 完成或失败。
 * R4 起不存在任何公开 factory/register；构造器由 module-private issue token 门控
 * （runtime 检查，非仅靠 TypeScript private），合法实例只能经
 * openHeldMaterializedFileEvidence 发行并登记入 module-private WeakSet；
 * 普通 snapshot 不得作为 DB success 凭据。
 */
export class HeldMaterializedFileEvidence {
  private closed = false;
  constructor(
    readonly evidence: MaterializedFileEvidence,
    private readonly fileHandle: fsSync.promises.FileHandle,
    private readonly parentDirHandle: fsSync.promises.FileHandle,
    issueToken: symbol,
  ) {
    if (issueToken !== HELD_ISSUE_TOKEN) {
      throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 只能由 validator 发行（issue token 无效）');
    }
  }

  get fileFd(): fsSync.promises.FileHandle {
    return this.fileHandle;
  }

  get parentFd(): fsSync.promises.FileHandle {
    return this.parentDirHandle;
  }

  /** 恰好一次关闭（重复调用 no-op）。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let firstErr: unknown = null;
    try {
      await this.parentDirHandle.close();
    } catch (err) {
      firstErr = err;
    }
    try {
      await this.fileHandle.close();
    } catch (err) {
      if (firstErr === null) firstErr = err;
    }
    if (firstErr !== null) throw firstErr;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * R4 P0-A：runtime capability seal。module-private WeakSet 是唯一合法实例登记处；
 * brand 不导出，测试/调用方无法注册伪造 capability。
 * clone / Object.create(prototype) / prototype spoof / plain object 均不在集合内。
 */
const legitimateHeldEvidence = new WeakSet<object>();

/** 模块内部唯一发行点（不导出）。 */
function issueHeldEvidence(
  evidence: MaterializedFileEvidence,
  fileHandle: fsSync.promises.FileHandle,
  parentDirHandle: fsSync.promises.FileHandle,
): HeldMaterializedFileEvidence {
  const held = new HeldMaterializedFileEvidence(evidence, fileHandle, parentDirHandle, HELD_ISSUE_TOKEN);
  legitimateHeldEvidence.add(held);
  return held;
}

/**
 * 验证 value 是 validator 发行的合法 held capability（runtime seal，非类型声明）。
 * 任何非 WeakSet 登记对象 → SEAL_MISMATCH。
 */
export function assertHeldCapability(value: unknown): asserts value is HeldMaterializedFileEvidence {
  if (typeof value !== 'object' || value === null || !legitimateHeldEvidence.has(value)) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability is not validator-issued');
  }
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
 * 从已打开 fd 安全解析 WAV header（顺序 chunk 扫描，容忍 LIST/INFO；上限 1MB）。
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
 * 打开并验证 materialized file，返回 Held evidence（fd 持有到调用方 close）。
 * durabilize：fsync held final fd + held parent fd。
 * verify：零 mkdir、零文件写（parent 目录缺失 → MISSING）。
 */
export async function openHeldMaterializedFileEvidence(
  expectation: MaterializedFileExpectation,
  mode: MaterializedFileMode,
  deps: MaterializedFileValidatorDeps = {},
): Promise<HeldMaterializedFileEvidence> {
  validateDestinationRelativePath(expectation.relativePath);
  const rootAbs = materializationRootAbs();
  // verify/replay/GET/validation：parent 必须已存在（绝不 mkdir）；目录缺失 → MISSING
  let realRoot: string;
  let realParent: string;
  try {
    ({realRoot, realParent} = await ensureExistingDestinationParentSafe(rootAbs, expectation.relativePath));
  } catch (err) {
    if (err instanceof ProjectionPathError && err.message.includes('缺失')) {
      throw new MaterializedFileError('MISSING', `parent 目录缺失（零 mkdir）: ${err.message}`);
    }
    throw new MaterializedFileError('CONTAINMENT', `parent containment 失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!realParent.startsWith(realRoot + path.sep)) {
    throw new MaterializedFileError('CONTAINMENT', 'parent realpath 越出 root');
  }
  const finalAbs = destinationAbsolutePath(expectation.relativePath);

  let fh: fsSync.promises.FileHandle | null = null;
  let dirFh: fsSync.promises.FileHandle | null = null;
  try {
    // final fd：O_RDONLY|O_NOFOLLOW
    try {
      fh = await fs.open(finalAbs, OPEN_FLAGS.readNoFollow);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw new MaterializedFileError('MISSING', 'final file 不存在');
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new MaterializedFileError('SYMLINK', 'final 是 symlink（O_NOFOLLOW 拒绝）');
      throw new MaterializedFileError('IO_ERROR', `final open 失败: ${code ?? String(err)}`);
    }
    // parent fd：O_RDONLY|O_DIRECTORY|O_NOFOLLOW
    try {
      dirFh = await fs.open(realParent, OPEN_FLAGS.parentReadNoFollow);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new MaterializedFileError('CONTAINMENT', `parent 非目录/symlink: ${code}`);
      throw new MaterializedFileError('IO_ERROR', `parent open 失败: ${code ?? String(err)}`);
    }
    const st = await fh.stat({bigint: true});
    if (!st.isFile()) throw new MaterializedFileError('NOT_REGULAR', 'final 非 regular file');
    const parentStat = await dirFh.stat({bigint: true});
    if (!parentStat.isDirectory()) throw new MaterializedFileError('CONTAINMENT', 'parent fd 非 directory');
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
    // parent path 与 held parent fd 一致
    let parentPathStat;
    try {
      parentPathStat = await fs.lstat(realParent);
    } catch {
      throw new MaterializedFileError('CONTAINMENT', 'parent path 不可 stat');
    }
    if (parentPathStat.isSymbolicLink()) throw new MaterializedFileError('CONTAINMENT', 'parent path 现在是 symlink');
    if (parentPathStat.dev !== Number(parentStat.dev) || parentPathStat.ino !== Number(parentStat.ino)) {
      throw new MaterializedFileError('CONTAINMENT', 'parent path 与 held parent fd 不一致（被替换）');
    }
    // R4 P0-C：ancestor chain 身份锚定（root / profile 两级；revision 级 = parent*）。
    // 逐级 lstat 已在 containment 中拒绝 symlink；此处仅记录 dev/ino 供 commit seal 复核。
    const relParts = expectation.relativePath.split('/');
    const rootStat = await fs.lstat(realRoot, {bigint: true});
    const profileStat = await fs.lstat(path.join(realRoot, relParts[0]), {bigint: true});
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
    // durabilize：fsync held final fd + held parent fd
    let durabilityEstablished = false;
    if (mode === 'durabilize') {
      try {
        if (deps.fsyncFile) {
          await deps.fsyncFile(fh);
        } else {
          await fh.sync();
        }
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
    const evidence: MaterializedFileEvidence = {
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
      ctimeNs: st.ctimeNs,
      parentRealpath: realParent,
      parentDev: parentStat.dev,
      parentIno: parentStat.ino,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      profileDev: profileStat.dev,
      profileIno: profileStat.ino,
      durabilityEstablished,
    };
    return issueHeldEvidence(evidence, fh, dirFh);
  } catch (err) {
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
    throw err;
  }
}

/**
 * commit-time 同步 seal（P0-A/P0-B/P0-C）：BEGIN IMMEDIATE 内、DB writes 前调用。
 * R4：
 * 1. capability 真实性（WeakSet brand，伪造/clone/spoof 一律拒绝）；
 * 2. exact destination binding——目标路径只从 frozen identity 派生
 *    （expectedRelative/expectedAbsolute/expectedParent），绝不信任 evidence 自带路径；
 *    evidence 的 relativePath/absolutePathInternal/parentRealpath 必须逐项等于派生值；
 * 3. full ancestor seal——root/profile/revision(final parent)/final file 逐级
 *    lstat（非 symlink、类型、dev/ino 与 acquisition evidence 相同）+ root realpath
 *    锚定 path.resolve(materializationRootAbs())；ancestor rename+symlink 替换必拒绝；
 * 4. held fd fstat ↔ acquisition evidence（同 inode 原地改写 = mtime/ctime 漂移）。
 * 必须同步（无 await）；fence 后到 COMMIT 之间不得有可注入异步 hook。
 */
export function assertHeldEvidenceCurrentSync(
  held: HeldMaterializedFileEvidence,
  expected: {
    relativePath: string;
    voiceProfileId: string;
    voiceProfileRevisionId: string;
    expectedSha256: string;
  },
): void {
  // P0-A：capability 真实性是第一道 fence（未登记对象直接拒绝）
  assertHeldCapability(held);
  const ev = held.evidence;
  const fail = (code: MaterializedFileError['code'], msg: string): never => {
    throw new MaterializedFileError(code, msg);
  };
  // P0-B：从 frozen identity 重新派生 exact destination（不信任 evidence 路径）
  const expectedRelative = destinationRelativePath(expected.voiceProfileId, expected.voiceProfileRevisionId);
  if (expected.relativePath !== expectedRelative) fail('SEAL_MISMATCH', 'expected.relativePath ≠ destinationRelativePath(identity)');
  if (ev.relativePath !== expectedRelative) fail('SEAL_MISMATCH', 'evidence.relativePath ≠ derived destination');
  const expectedAbsolute = destinationAbsolutePath(expectedRelative);
  const expectedParent = path.dirname(expectedAbsolute);
  const profileDir = path.dirname(expectedParent);
  const rootDir = path.dirname(profileDir);
  if (ev.absolutePathInternal !== expectedAbsolute) fail('SEAL_MISMATCH', 'evidence.absolutePathInternal ≠ derived destination');
  if (ev.sha256 !== expected.expectedSha256) fail('SEAL_MISMATCH', 'evidence SHA ≠ expected');
  if (!ev.durabilityEstablished) fail('SEAL_MISMATCH', 'durability 未建立');
  // P0-C：full ancestor chain seal（path lstat ↔ acquisition dev/ino；本地 single-writer contract）
  // root：非 symlink、目录、dev/ino 一致、realpath 锚定 path.resolve(materializationRootAbs())
  let rootStat: fsSync.BigIntStats;
  try {
    rootStat = fsSync.lstatSync(rootDir, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'materialization root 不可 stat');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('SEAL_MISMATCH', 'materialization root 非目录/symlink');
  if (rootStat.dev !== ev.rootDev || rootStat.ino !== ev.rootIno) fail('SEAL_MISMATCH', 'materialization root dev/inode 漂移（被替换）');
  let realRootNow: string;
  try {
    realRootNow = fsSync.realpathSync(rootDir);
  } catch {
    return fail('SEAL_MISMATCH', 'materialization root realpath 不可解析');
  }
  if (realRootNow !== path.resolve(materializationRootAbs())) fail('SEAL_MISMATCH', 'materialization root realpath 漂移');
  // profile：非 symlink、目录、dev/ino 一致
  let profileStat: fsSync.BigIntStats;
  try {
    profileStat = fsSync.lstatSync(profileDir, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'profile ancestor 不可 stat');
  }
  if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) fail('SEAL_MISMATCH', 'profile ancestor 非目录/symlink');
  if (profileStat.dev !== ev.profileDev || profileStat.ino !== ev.profileIno) fail('SEAL_MISMATCH', 'profile ancestor dev/inode 漂移（被替换）');
  // revision（final parent）：非 symlink、目录、dev/ino 一致、realpath 精确等于 acquisition 值且位于 root 下
  let parentStat: fsSync.BigIntStats;
  try {
    parentStat = fsSync.lstatSync(expectedParent, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'revision parent 不可 stat');
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail('SEAL_MISMATCH', 'revision parent 非目录/symlink');
  if (parentStat.dev !== ev.parentDev || parentStat.ino !== ev.parentIno) fail('SEAL_MISMATCH', 'revision parent dev/inode 漂移（被替换）');
  let realParentNow: string;
  try {
    realParentNow = fsSync.realpathSync(expectedParent);
  } catch {
    return fail('SEAL_MISMATCH', 'revision parent realpath 不可解析');
  }
  if (realParentNow !== ev.parentRealpath) fail('SEAL_MISMATCH', 'evidence.parentRealpath ≠ derived parent realpath');
  if (!realParentNow.startsWith(realRootNow + path.sep)) fail('SEAL_MISMATCH', 'revision parent 越出 materialization root');
  // held fd fstat：同一 inode 的当前状态（mtime/ctime 反映同 inode 改写）
  const fdStat = fsSync.fstatSync(held.fileFd.fd, {bigint: true});
  if (fdStat.dev !== ev.device || fdStat.ino !== ev.inode) fail('SEAL_MISMATCH', 'held fd inode 漂移');
  if (fdStat.size !== BigInt(ev.size)) fail('SEAL_MISMATCH', 'held fd size 漂移（同 inode 改写）');
  if (fdStat.mtimeNs !== ev.mtimeNs || fdStat.ctimeNs !== ev.ctimeNs) {
    fail('SEAL_MISMATCH', 'held fd mtime/ctime 漂移（同 inode 原地改写）');
  }
  // final path（派生 expectedAbsolute，非 evidence 路径）lstat ↔ held fd
  let pathStat: fsSync.BigIntStats | undefined;
  try {
    pathStat = fsSync.lstatSync(expectedAbsolute, {bigint: true});
  } catch {
    fail('SEAL_MISMATCH', 'final path 不可 stat');
  }
  if (!pathStat) fail('SEAL_MISMATCH', 'final path 不可 stat');
  const ps: fsSync.BigIntStats = pathStat as fsSync.BigIntStats;
  if (ps.isSymbolicLink() || !ps.isFile()) fail('SEAL_MISMATCH', 'final path 非 regular');
  if (ps.dev !== ev.device || ps.ino !== ev.inode) fail('SEAL_MISMATCH', 'final path inode ≠ held fd（被替换）');
  if (ps.size !== BigInt(ev.size)) fail('SEAL_MISMATCH', 'final path size 漂移');
  if (ps.mtimeNs !== ev.mtimeNs || ps.ctimeNs !== ev.ctimeNs) fail('SEAL_MISMATCH', 'final path mtime/ctime 漂移（同 inode 改写）');
  // held parent fd ↔ acquisition parent evidence
  const parentFdStat = fsSync.fstatSync(held.parentFd.fd, {bigint: true});
  if (parentFdStat.dev !== ev.parentDev || parentFdStat.ino !== ev.parentIno) fail('SEAL_MISMATCH', 'held parent fd inode 漂移');
}

/** verify 模式的普通快照（不持 fd；不得用于 DB success）。 */
export async function validateMaterializedFileSnapshot(
  expectation: MaterializedFileExpectation,
): Promise<MaterializedFileEvidence> {
  const held = await openHeldMaterializedFileEvidence(expectation, 'verify');
  try {
    return held.evidence;
  } finally {
    await held.close();
  }
}

/**
 * TTS-C.1A.R5 共享 safe final-file validator + Held evidence + Branded reuse capability
 * （唯一 exact file contract + immutable authority record + unified ancestor seal）。
 *
 * R4（P0-A/P0-B/P0-C/P0-D）：
 * - HeldMaterializedFileEvidence：final fd（O_RDONLY|O_NOFOLLOW）+ parent fd
 *   （O_RDONLY|O_DIRECTORY|O_NOFOLLOW）持有到 DB commit 完成或失败；
 *   WeakSet brand；构造 token；公开 evidence 是 deep-frozen 诊断快照。
 * - verify/durabilize 双模式。
 * - commit-time exact destination binding + full ancestor seal（root/profile/revision/file）。
 * - verify 零写（root helper 拆分）。
 *
 * R5 加固：
 * - P0-A immutable authority record：module-private WeakMap 以 HeldMaterializedFileEvidence
 *   为键存储权威 mode/frozenEvidence/fileHandle/parentHandle/closed——**所有授权决策
 *   必须从 WeakMap record 读取**，绝不基于公开对象字段（`held.evidence.durabilityEstablished`、
 *   `held.fileFd`、`held.parentFd`）。verify capability 即使公开字段被改为
 *   `durabilityEstablished=true` 仍必须被 Worker reject。close 后 capability 不可用。
 * - P0-B branded reuse capability：新增 `ValidatedReusableProjectionCapability`，仅由
 *   validator 发行；持有 verified held + projection identity + candidate metadata hash +
 *   exact derived destination + 四级 ancestor identity + file SHA/WAV；WeakMap 注册；
 *   `finalizeValidatingJob` 仅接受 branded capability，拒绝 plain
 *   `ProjectionValidationResult`/`ValidatedProjectionEvidence`。Phase 3 完成后关闭 held。
 * - P0-C unified ancestor seal：`assertHeldCurrentSync(cap, {requireDurability})` 同时被
 *   Worker finalize（requireDurability=true）与 reuse finalize（requireDurability=false）
 *   调用，路径/parent/root profile ancestor 逐级 lstat + realpath 锚定。
 * - P0-D SHA authority：Phase 3 不得接受调用者填入 SHA——真实 SHA 来自 issuer 对 held fd
 *   的读取，并存于不可修改的 WeakMap record。
 * - §九 production hook guard 由调用方在 materialization.ts 实现。
 *
 * 参考审计：Node fs numeric flags 透传 Linux open(2)（O_NOFOLLOW 拒绝 symlink、
 * O_DIRECTORY 非目录 ENOTDIR）；fd 持有 = inode 锚定，path 可替换 → commit-time 必须
 * 复核 path↔held fd；SQLite 与 filesystem 无跨资源原子事务 → fail-closed 边界 =
 * held fd + 同步 seal + 先文件后 DB；知影为本地单 Worker writer（无分布式锁需求）。
 * commit seal 使用 path+lstat 逐级复核（非 dirfd/openat anchored traversal），
 * 依赖本地 single-writer contract；ancestor mutation 由 R4/R5 测试套件覆盖。
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

/** Deep-frozen snapshot（仅诊断；**不参与 DB success 授权**）。 */
export interface MaterializedFileEvidence {
  voiceProfileId: string;
  voiceProfileRevisionId: string;
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

// ────────── R5：immutable authority record（WeakMap；module-private） ──────────

/** module-private issue tokens；不导出；无 token 构造 → SEAL_MISMATCH。 */
const HELD_ISSUE_TOKEN: unique symbol = Symbol('tts-c1a-held-issue');
const REUSE_ISSUE_TOKEN: unique symbol = Symbol('tts-c1a-reuse-issue');

/** R5 P0-A：Held capability 的不可篡改权威记录。 */
interface HeldAuthorityRecord {
  mode: 'verify' | 'durabilize';
  /** 内部路径 + file identity 全字段；仅用于诊断；不能作授权决策。 */
  diagnosticSnapshot: Readonly<MaterializedFileEvidence>;
  fileHandle: fsSync.promises.FileHandle;
  parentHandle: fsSync.promises.FileHandle;
  closed: boolean;
}
const heldRecords = new WeakMap<HeldMaterializedFileEvidence, HeldAuthorityRecord>();

/** R5 P0-B：reuse finalize 的不可篡改权威记录。 */
interface ReuseAuthorityRecord {
  projectionId: string;
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  sourceSha256: string;
  adapterCompatibilityKey: string;
  provider: string;
  candidateMetadataHash: string;
  relativePath: string;
  absolutePathInternal: string;
  rootDev: bigint;
  rootIno: bigint;
  profileDev: bigint;
  profileIno: bigint;
  revisionDev: bigint;
  revisionIno: bigint;
  fileDev: bigint;
  fileIno: bigint;
  fileMtimeNs: bigint;
  fileCtimeNs: bigint;
  fileSize: number;
  rootRealpath: string;
  revisionParentRealpath: string;
  fileSha256: string;
  fileCodec: string;
  fileSampleRate: number;
  fileChannels: number;
  fileDurationMs: number;
  /** 持有直到 finalize close。 */
  heldVerify: HeldMaterializedFileEvidence;
  closed: boolean;
}
const reuseRecords = new WeakMap<ValidatedReusableProjectionCapability, ReuseAuthorityRecord>();

/** 运行时 deep-freeze；不可变快照（用于 public diagnosticSnapshot）。 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const k of Object.keys(obj as object)) {
    const v = (obj as Record<string, unknown>)[k];
    if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj as Readonly<T>;
}

// ────────── Held capability ──────────

/**
 * R5：HeldMaterializedFileEvidence 仅作为 WeakMap 的 key；公开字段（evidence snapshot、
 * fileFd/parentFd getter）只是 OS 状态的便利视图——**不参与授权决策**。授权决策一律
 * 通过 `assertHeldCapability` + WeakMap record 完成；mode/closed 来自 record。
 */
export class HeldMaterializedFileEvidence {
  /** Deep-frozen 诊断快照；不参与 DB success 授权。 */
  readonly evidence: Readonly<MaterializedFileEvidence>;
  constructor(
    evidence: MaterializedFileEvidence,
    fileHandle: fsSync.promises.FileHandle,
    parentHandle: fsSync.promises.FileHandle,
    mode: 'verify' | 'durabilize',
    issueToken: symbol,
  ) {
    if (issueToken !== HELD_ISSUE_TOKEN) {
      throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 只能由 validator 发行（issue token 无效）');
    }
    this.evidence = deepFreeze({...evidence});
    heldRecords.set(this, {
      mode,
      diagnosticSnapshot: this.evidence,
      fileHandle,
      parentHandle,
      closed: false,
    });
  }

  /** 仅作 OS fstat 入口；不用于授权（授权看 record.mode 与 record.fileHandle）。 */
  get fileFd(): fsSync.promises.FileHandle {
    const r = heldRecords.get(this);
    if (!r) throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 无 authority record');
    return r.fileHandle;
  }
  /** 仅作 OS fstat 入口；不用于授权。 */
  get parentFd(): fsSync.promises.FileHandle {
    const r = heldRecords.get(this);
    if (!r) throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 无 authority record');
    return r.parentHandle;
  }

  async close(): Promise<void> {
    const r = heldRecords.get(this);
    if (!r || r.closed) return;
    r.closed = true;
    let firstErr: unknown = null;
    try {
      await r.parentHandle.close();
    } catch (err) {
      firstErr = err;
    }
    try {
      await r.fileHandle.close();
    } catch (err) {
      if (firstErr === null) firstErr = err;
    }
    if (firstErr !== null) throw firstErr;
  }

  get isClosed(): boolean {
    const r = heldRecords.get(this);
    return !r || r.closed;
  }
}

/** 模块内部唯一 Held 发行点。 */
function issueHeldEvidence(
  evidence: MaterializedFileEvidence,
  fileHandle: fsSync.promises.FileHandle,
  parentHandle: fsSync.promises.FileHandle,
  mode: 'verify' | 'durabilize',
): HeldMaterializedFileEvidence {
  return new HeldMaterializedFileEvidence(evidence, fileHandle, parentHandle, mode, HELD_ISSUE_TOKEN);
}

/**
 * Runtime capability seal + 返回权威 mode（用于 assertHeldCurrentSync 二次校验）。
 * 未登记对象、closed capability → SEAL_MISMATCH。
 */
export function assertHeldCapability(value: unknown): asserts value is HeldMaterializedFileEvidence {
  if (typeof value !== 'object' || value === null || !(value instanceof HeldMaterializedFileEvidence)) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability is not validator-issued');
  }
  const r = heldRecords.get(value);
  if (!r || r.closed) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability closed or not validator-issued');
  }
}

/** 模块内 accessors（不导出）。 */
function getHeldRecord(value: HeldMaterializedFileEvidence): HeldAuthorityRecord {
  const r = heldRecords.get(value);
  if (!r || r.closed) throw new MaterializedFileError('SEAL_MISMATCH', 'held capability closed or not validator-issued');
  return r;
}

function getReuseRecord(value: ValidatedReusableProjectionCapability): ReuseAuthorityRecord {
  const r = reuseRecords.get(value);
  if (!r || r.closed) throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability closed or not validator-issued');
  return r;
}

// ────────── ValidatedReusableProjectionCapability（P0-B）──────────

/**
 * R5 P0-B：branded reuse validation capability。仅由 validateExistingProjection 发行；
 * module-private WeakMap 注册；构造需 REUSE_ISSUE_TOKEN。bind projection identity +
 * verified held capability + 四级 ancestor identity + file SHA/WAV。
 * finalizeValidatingJob 必须接受本类型；plain ProjectionValidationResult / 伪造对象
 * 全部 SEAL_MISMATCH。
 */
export class ValidatedReusableProjectionCapability {
  readonly projectionId: string;
  readonly voiceProfileId: string;
  readonly voiceProfileRevisionId: string;
  readonly sourceSha256: string;
  readonly adapterCompatibilityKey: string;
  readonly provider: string;
  readonly candidateMetadataHash: string;
  readonly relativePath: string;
  readonly absolutePathInternal: string;
  readonly rootRealpath: string;
  readonly revisionParentRealpath: string;
  readonly fileSha256: string;
  readonly fileCodec: string;
  readonly fileSampleRate: number;
  readonly fileChannels: number;
  readonly fileDurationMs: number;
  readonly fileSize: number;
  readonly closed: boolean;
  constructor(
    fields: Omit<ReuseAuthorityRecord, 'closed'>,
    issueToken: symbol,
  ) {
    if (issueToken !== REUSE_ISSUE_TOKEN) {
      throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability 只能由 validator 发行（issue token 无效）');
    }
    this.projectionId = fields.projectionId;
    this.voiceProfileId = fields.voiceProfileId;
    this.voiceProfileRevisionId = fields.voiceProfileRevisionId;
    this.sourceSha256 = fields.sourceSha256;
    this.adapterCompatibilityKey = fields.adapterCompatibilityKey;
    this.provider = fields.provider;
    this.candidateMetadataHash = fields.candidateMetadataHash;
    this.relativePath = fields.relativePath;
    this.absolutePathInternal = fields.absolutePathInternal;
    this.rootRealpath = fields.rootRealpath;
    this.revisionParentRealpath = fields.revisionParentRealpath;
    this.fileSha256 = fields.fileSha256;
    this.fileCodec = fields.fileCodec;
    this.fileSampleRate = fields.fileSampleRate;
    this.fileChannels = fields.fileChannels;
    this.fileDurationMs = fields.fileDurationMs;
    this.fileSize = fields.fileSize;
    this.closed = false;
    reuseRecords.set(this, {...fields, closed: false});
  }

  /** Phase 3 完成或失败后关闭（关闭内部持有的 verified held capability）。 */
  async close(): Promise<void> {
    const r = reuseRecords.get(this);
    if (!r || r.closed) return;
    r.closed = true;
    (this as {closed: boolean}).closed = true;
    await r.heldVerify.close().catch(() => undefined);
  }
}

/** 模块内 reuse capability 唯一发行点。 */
function issueValidatedReusableCapability(
  fields: Omit<ReuseAuthorityRecord, 'closed'>,
): ValidatedReusableProjectionCapability {
  return new ValidatedReusableProjectionCapability(fields, REUSE_ISSUE_TOKEN);
}

// ────────── 流式 SHA256 / WAV parse（保持既有）──────────

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

// ────────── openHeldMaterializedFileEvidence（唯一 issuer）──────────

/**
 * 打开并验证 materialized file，返回 Held capability（fd 持有到调用方 close）。
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
    try {
      fh = await fs.open(finalAbs, OPEN_FLAGS.readNoFollow);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') throw new MaterializedFileError('MISSING', 'final file 不存在');
      if (code === 'ELOOP' || code === 'ENOTDIR') throw new MaterializedFileError('SYMLINK', 'final 是 symlink（O_NOFOLLOW 拒绝）');
      throw new MaterializedFileError('IO_ERROR', `final open 失败: ${code ?? String(err)}`);
    }
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
    const relParts = expectation.relativePath.split('/');
    const rootStat = await fs.lstat(realRoot, {bigint: true});
    const profileStat = await fs.lstat(path.join(realRoot, relParts[0]), {bigint: true});
    const sha = await sha256FromFd(fh);
    if (sha !== expectation.expectedSha256) {
      throw new MaterializedFileError('SHA_MISMATCH', `sha256 不一致（${sha.slice(0, 12)}…）`);
    }
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
      voiceProfileId: expectation.voiceProfileId,
      voiceProfileRevisionId: expectation.voiceProfileRevisionId,
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
    return issueHeldEvidence(evidence, fh, dirFh, mode);
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
 * R5 统一 commit-time 同步 seal（P0-A/P0-B/P0-C/P0-D）：
 * - capability 真实性 + 未关闭（assertHeldCapability）；
 * - requireDurability=true 时 record.mode === 'durabilize'（verify capability 不得成功终局）；
 * - exact destination binding：从 frozen identity 重新派生 expectedRelative/expectedAbsolute/
 *   expectedParent/profileDir/rootDir，evidence.relativePath/absolutePathInternal/
 *   parentRealpath 必须逐项等于派生值；
 * - full ancestor seal：root/profile/revision(final parent)/final 逐级 lstatSync
 *   （非 symlink、类型、dev/ino 与 acquisition evidence 相同）+ root realpath 锚定
 *   path.resolve(materializationRootAbs()) + revision parent realpath 精确等于
 *   acquisition 值且位于 root 下；
 * - held fd fstat ↔ acquisition dev/inode/size/mtime/ctime（同 inode 原地改写 =
 *   mtime/ctime 漂移）。
 * 必须同步（无 await）；fence 后到 COMMIT 之间不得有可注入异步 hook。
 */
export function assertHeldCurrentSync(
  capability: HeldMaterializedFileEvidence,
  opts: {requireDurability: boolean; expectedVoiceProfileId?: string; expectedVoiceProfileRevisionId?: string; expectedSha256?: string},
): void {
  assertHeldCapability(capability);
  const r = getHeldRecord(capability);
  if (opts.requireDurability && r.mode !== 'durabilize') {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 非 durabilize mode（不得成功终局）');
  }
  const snap = r.diagnosticSnapshot;
  if (opts.expectedVoiceProfileId !== undefined && snap.voiceProfileId !== opts.expectedVoiceProfileId) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held voiceProfileId ≠ expected job binding');
  }
  if (opts.expectedVoiceProfileRevisionId !== undefined && snap.voiceProfileRevisionId !== opts.expectedVoiceProfileRevisionId) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held voiceProfileRevisionId ≠ expected job binding');
  }
  if (opts.expectedSha256 !== undefined && snap.sha256 !== opts.expectedSha256) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held sha256 ≠ expected job binding');
  }
  const fail = (code: MaterializedFileError['code'], msg: string): never => {
    throw new MaterializedFileError(code, msg);
  };
  const expectedRelative = destinationRelativePath(snap.voiceProfileId, snap.voiceProfileRevisionId);
  if (snap.relativePath !== expectedRelative) fail('SEAL_MISMATCH', 'evidence.relativePath ≠ derived destination');
  const expectedAbsolute = destinationAbsolutePath(expectedRelative);
  const expectedParent = path.dirname(expectedAbsolute);
  const profileDir = path.dirname(expectedParent);
  const rootDir = path.dirname(profileDir);
  if (snap.absolutePathInternal !== expectedAbsolute) fail('SEAL_MISMATCH', 'evidence.absolutePathInternal ≠ derived destination');
  let realParentNow: string;
  try {
    realParentNow = fsSync.realpathSync(expectedParent);
  } catch {
    return fail('SEAL_MISMATCH', 'derived parent realpath 不可解析（可能 dangling symlink）');
  }
  if (snap.parentRealpath !== realParentNow) fail('SEAL_MISMATCH', 'evidence.parentRealpath ≠ derived parent realpath');
  // root
  let rootStat: fsSync.BigIntStats;
  try {
    rootStat = fsSync.lstatSync(rootDir, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'materialization root 不可 stat');
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('SEAL_MISMATCH', 'materialization root 非目录/symlink');
  if (rootStat.dev !== snap.rootDev || rootStat.ino !== snap.rootIno) fail('SEAL_MISMATCH', 'materialization root dev/inode 漂移（被替换）');
  let realRootNow: string;
  try {
    realRootNow = fsSync.realpathSync(rootDir);
  } catch {
    return fail('SEAL_MISMATCH', 'materialization root realpath 不可解析');
  }
  if (realRootNow !== path.resolve(materializationRootAbs())) fail('SEAL_MISMATCH', 'materialization root realpath 漂移');
  // profile
  let profileStat: fsSync.BigIntStats;
  try {
    profileStat = fsSync.lstatSync(profileDir, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'profile ancestor 不可 stat');
  }
  if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) fail('SEAL_MISMATCH', 'profile ancestor 非目录/symlink');
  if (profileStat.dev !== snap.profileDev || profileStat.ino !== snap.profileIno) fail('SEAL_MISMATCH', 'profile ancestor dev/inode 漂移（被替换）');
  // revision (final parent)
  let parentStat: fsSync.BigIntStats;
  try {
    parentStat = fsSync.lstatSync(expectedParent, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'revision parent 不可 stat');
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail('SEAL_MISMATCH', 'revision parent 非目录/symlink');
  if (parentStat.dev !== snap.parentDev || parentStat.ino !== snap.parentIno) fail('SEAL_MISMATCH', 'revision parent dev/inode 漂移（被替换）');
  if (realParentNow !== snap.parentRealpath) fail('SEAL_MISMATCH', 'parentRealpath drift vs acquired');
  if (!realParentNow.startsWith(realRootNow + path.sep)) fail('SEAL_MISMATCH', 'revision parent 越出 materialization root');
  // held fd fstat vs evidence
  const fdStat = fsSync.fstatSync(r.fileHandle.fd, {bigint: true});
  if (fdStat.dev !== snap.device || fdStat.ino !== snap.inode) fail('SEAL_MISMATCH', 'held fd inode 漂移');
  if (fdStat.size !== BigInt(snap.size)) fail('SEAL_MISMATCH', 'held fd size 漂移（同 inode 改写）');
  if (fdStat.mtimeNs !== snap.mtimeNs || fdStat.ctimeNs !== snap.ctimeNs) {
    fail('SEAL_MISMATCH', 'held fd mtime/ctime 漂移（同 inode 原地改写）');
  }
  // final path (derived) lstat vs evidence
  let pathStat: fsSync.BigIntStats | undefined;
  try {
    pathStat = fsSync.lstatSync(expectedAbsolute, {bigint: true});
  } catch {
    fail('SEAL_MISMATCH', 'final path 不可 stat');
  }
  if (!pathStat) fail('SEAL_MISMATCH', 'final path 不可 stat');
  const ps: fsSync.BigIntStats = pathStat as fsSync.BigIntStats;
  if (ps.isSymbolicLink() || !ps.isFile()) fail('SEAL_MISMATCH', 'final path 非 regular');
  if (ps.dev !== snap.device || ps.ino !== snap.inode) fail('SEAL_MISMATCH', 'final path inode ≠ held fd（被替换）');
  if (ps.size !== BigInt(snap.size)) fail('SEAL_MISMATCH', 'final path size 漂移');
  if (ps.mtimeNs !== snap.mtimeNs || ps.ctimeNs !== snap.ctimeNs) fail('SEAL_MISMATCH', 'final path mtime/ctime 漂移');
  // held parent fd vs evidence
  const parentFdStat = fsSync.fstatSync(r.parentHandle.fd, {bigint: true});
  if (parentFdStat.dev !== snap.parentDev || parentFdStat.ino !== snap.parentIno) fail('SEAL_MISMATCH', 'held parent fd inode 漂移');
}

/**
 * Internal: 派生 file evidence snapshot（仅诊断；P0-B 强调 SHA 真实来自 record，
 * 该 snapshot 不能被调用方用于构造 reuse capability）。
 */
function fileEvidenceFromReuseRecord(r: ReuseAuthorityRecord): Readonly<MaterializedFileEvidence> {
  return deepFreeze({
    voiceProfileId: r.voiceProfileId,
    voiceProfileRevisionId: r.voiceProfileRevisionId,
    relativePath: r.relativePath,
    absolutePathInternal: r.absolutePathInternal,
    sha256: r.fileSha256,
    size: r.fileSize,
    codec: r.fileCodec,
    sampleRate: r.fileSampleRate,
    channels: r.fileChannels,
    durationMs: r.fileDurationMs,
    device: r.fileDev,
    inode: r.fileIno,
    mtimeNs: r.fileMtimeNs,
    ctimeNs: r.fileCtimeNs,
    parentRealpath: r.revisionParentRealpath,
    parentDev: r.revisionDev,
    parentIno: r.revisionIno,
    rootDev: r.rootDev,
    rootIno: r.rootIno,
    profileDev: r.profileDev,
    profileIno: r.profileIno,
    durabilityEstablished: false,
  }) as Readonly<MaterializedFileEvidence>;
}

/** 模块内：发行 ValidatedReusableProjectionCapability 并返回 file evidence 诊断快照。 */
function issueReuseCapabilityFromHeld(
  projection: {id: string; voice_profile_id: string; voice_profile_revision_id: string; source_canonical_sha256: string; adapter_compatibility_key: string; destination_voice_root_relative_path: string},
  candidateMetadataHash: string,
  provider: string,
  held: HeldMaterializedFileEvidence,
): {capability: ValidatedReusableProjectionCapability; fileEvidence: Readonly<MaterializedFileEvidence>} {
  const r = getHeldRecord(held);
  const snap = r.diagnosticSnapshot;
  const expectedRelative = destinationRelativePath(projection.voice_profile_id, projection.voice_profile_revision_id);
  if (snap.relativePath !== expectedRelative) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'projection relative path ≠ derived destination');
  }
  const expectedAbsolute = destinationAbsolutePath(expectedRelative);
  const expectedParent = path.dirname(expectedAbsolute);
  const realParent = fsSync.realpathSync(expectedParent);
  const profileDir = path.dirname(expectedParent);
  const rootDir = path.dirname(profileDir);
  const realRoot = fsSync.realpathSync(rootDir);
  const cap = issueValidatedReusableCapability({
    projectionId: projection.id,
    voiceProfileId: projection.voice_profile_id,
    voiceProfileRevisionId: projection.voice_profile_revision_id,
    sourceSha256: projection.source_canonical_sha256,
    adapterCompatibilityKey: projection.adapter_compatibility_key,
    provider,
    candidateMetadataHash,
    relativePath: snap.relativePath,
    absolutePathInternal: snap.absolutePathInternal,
    rootDev: snap.rootDev,
    rootIno: snap.rootIno,
    profileDev: snap.profileDev,
    profileIno: snap.profileIno,
    revisionDev: snap.parentDev,
    revisionIno: snap.parentIno,
    fileDev: snap.device,
    fileIno: snap.inode,
    fileMtimeNs: snap.mtimeNs,
    fileCtimeNs: snap.ctimeNs,
    fileSize: snap.size,
    rootRealpath: realRoot,
    revisionParentRealpath: realParent,
    fileSha256: snap.sha256,
    fileCodec: snap.codec,
    fileSampleRate: snap.sampleRate,
    fileChannels: snap.channels,
    fileDurationMs: snap.durationMs,
    heldVerify: held,
  });
  const r2 = reuseRecords.get(cap)!;
  return {capability: cap, fileEvidence: fileEvidenceFromReuseRecord(r2)};
}

/** 模块内 export — materialization.ts 唯一授权发行 reuse capability 的入口。 */
export const __internal = {
  issueReuseCapabilityFromHeld,
  /** Reuse finalize / 测试 hook：取得 capability 内部持有的 verified held capability。 */
  underlyingHeldForReuse: (cap: ValidatedReusableProjectionCapability): HeldMaterializedFileEvidence => {
    const r = getReuseRecord(cap);
    return r.heldVerify;
  },
};

/**
 * 兼容层：R4 `validateMaterializedFileSnapshot` —— 打开 verify 模式并立即关闭，
 * 返回只读 evidence snapshot（不能用于构造 reuse capability）。
 */
export async function validateMaterializedFileSnapshot(
  expectation: MaterializedFileExpectation,
): Promise<MaterializedFileEvidence> {
  const held = await openHeldMaterializedFileEvidence(expectation, 'verify');
  try {
    return held.evidence as MaterializedFileEvidence;
  } finally {
    await held.close();
  }
}
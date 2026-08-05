/**
 * TTS-C.1A.R6 共享 safe final-file validator + Held capability + Branded reuse capability
 * （唯一 exact file contract + immutable authority record + unified ancestor seal +
 * private reuse authority + record-only SHA seal + one-shot consumption + private fd lifecycle）。
 *
 * R3：openHeldMaterializedFileEvidence 唯一 issuer；verify/durabilize 双模式。
 * R4：构造 token + WeakMap brand + exact destination binding + ancestor seal + verify zero-write。
 * R5：WeakMap authority record + branded reuse capability + unified assertHeldCurrentSync +
 *      terminal response link closure + POST integrity closure + production hook guard。
 * R6（P0-A..F 全部生效点修改）：
 * - P0-A：彻底删除 `__internal` / `__validatorInternal` 任何形式的 public export；reuse
 *   capability 的发行与消费全部 module-private；任何模块（含 materialization.ts）不得
 *   直接获得 issuer token 或访问 reuseRecords/heldRecords WeakMap——只能经高层
 *   `validateProjectionForReuse`（事务外）→ `consumeValidatedProjectionForReuse`
 *   （事务内）两个 entry 走完。
 * - P0-B：公开 capability 只作为 opaque WeakMap key；不暴露 projectionId/voiceProfileId/
 *   voiceProfileRevisionId/sourceSha256/adapterCompatibilityKey/provider/relativePath/
 *   fileSha256 等任何身份/授权字段；若保留 deep-frozen diagnosticSnapshot 字段，仅作诊断
 *   序列化（不参与任何授权判断）。
 * - P0-C：issuance 时严格一致性：record.mode === 'verify'、record.sha256 === projection
 *   .source_canonical_sha256、record.voiceProfileId/voiceProfileRevisionId/relativePath
 *   === derived exact destination、projection.destination_voice_root_relative_path ===
 *   derived、projection.voice_profile_id/voice_profile_revision_id === record.*、provider/
 *   adapter exact、candidateMaterializationId/candidateMetadataHash exact；任一不一致：
 *   关闭 held fd + 不注册 record + throw unusable。
 * - P0-D：one-shot consumption + exact validation handle binding：record 绑定 jobId/
 *   validationOwnerToken/validationAttempt/candidateMaterializationId/candidateMetadataHash/
 *   projectionId；事务内 re-check；consumed 标记；attempt+1 takeover 后旧 capability
 *   自动 reject；不同 job/handle 不得共享；candidate hash 漂移 reject。
 * - P0-E：fd 生命周期 module-private——`consumeReuseCapability(cap, success)` + `closeReuse
 *   Capability(cap)` 直接操作 record；method/property shadow 不影响关闭；record closed
 *   同步标记；底层 held final fd 与 parent fd 恰好关闭一次。
 *
 * 参考审计：Node fs numeric flags 透传 Linux open(2)（O_NOFOLLOW 拒绝 symlink、
 * O_DIRECTORY 非目录 ENOTDIR）；fd 持有 = inode 锚定，path 可替换 → commit-time 必须
 * 复核 path↔held fd；SQLite 与 filesystem 无跨资源原子事务 → fail-closed 边界 =
 * held fd + 同步 seal + 先文件后 DB；知影为本地单 Worker writer（无分布式锁需求）。
 * commit seal 使用 path+lstat 逐级复核（非 dirfd/openat anchored traversal），
 * 依赖本地 single-writer contract；ancestor mutation 由 R4/R5/R6 测试套件覆盖。
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
  minDurationMs?: number;
  adapterCompatibilityKey: string;
}

/** Deep-frozen diagnostic snapshot（**不参与 DB success 授权**；仅 GET 序列化诊断用）。 */
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

/** R6 私有：validation owner 凭据（materialization.ts 导入用于 capability binding shape） */
export interface ValidationOwnerShape {
  jobId: string;
  validationOwnerToken: string;
  validationAttempt: number;
  candidateMaterializationId: string | null;
  candidateMaterializationMetadataHash: string | null;
}

export interface MaterializedFileValidatorDeps {
  fsyncFile?: (fh: fsSync.promises.FileHandle) => Promise<void>;
  fsyncDir?: (fh: fsSync.promises.FileHandle) => Promise<void>;
}

// ────────── R6：immutable authority records（WeakMap；module-private） ──────────

/** module-private issue tokens；不导出；无 token 构造 → SEAL_MISMATCH */
const HELD_ISSUE_TOKEN: unique symbol = Symbol('tts-c1a-held-issue');

/** R6 P0-A 持有 record：权威 mode + fd 状态 */
interface HeldAuthorityRecord {
  mode: 'verify' | 'durabilize';
  diagnosticSnapshot: Readonly<MaterializedFileEvidence>;
  fileHandle: fsSync.promises.FileHandle;
  parentHandle: fsSync.promises.FileHandle;
  closed: boolean;
}
const heldRecords = new WeakMap<HeldMaterializedFileEvidence, HeldAuthorityRecord>();

/**
 * R6 P0-A P0-B P0-C P0-D P0-E：reuse authority record。**唯一授权来源**——所有 finalizeValidatingJob
 * 授权判断一律从此 record 读取；公开 `ValidatedReusableProjectionCapability` 不暴露任何身份/
 * 授权字段（不暴露 projectionId/voiceProfileId/sourceSha256 等）。
 *
 * Issuance (P0-C) 校验：
 * - heldRecord.mode === 'verify'
 * - heldRecord.sha256 === projection.source_canonical_sha256
 * - heldRecord.voiceProfileId/voiceProfileRevisionId === projection.*
 * - heldRecord.relativePath === derived exact destination
 * - projection.destination_voice_root_relative_path === derived
 * - candidateMaterializationId / candidateMaterializationMetadataHash exact
 *
 * one-shot consumption (P0-D)：
 * - boundExpectedHandle 绑定 transaction 入口的 validation handle（jobId/ownerToken/attempt/
 *   candidate id+hash）——事务内逐项 exact re-check
 * - consumed 标记：事务完成后无论成功/失败都标记；attempt+1 takeover 后旧 cap 自动 reject；
 *   不同 job/handle 不得共享；candidate hash 漂移 reject
 */
interface ReuseAuthorityRecord {
  // 来源身份（issuance 严格一致性校验冻结）
  voiceProfileId: string;
  voiceProfileRevisionId: string;
  sourceSha256: string;
  adapterCompatibilityKey: string;
  provider: string;
  // exact destination（derived once at issuance）
  relativePath: string;
  absolutePathInternal: string;
  rootRealpath: string;
  revisionParentRealpath: string;
  // file identity（issuance 时刻从 held fd 读取）
  fileSha256: string;
  fileCodec: string;
  fileSampleRate: number;
  fileChannels: number;
  fileDurationMs: number;
  fileSize: number;
  // 四级 ancestor identity（issuance 时刻 lstat 读取）
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
  // projection identity（issuance 时刻与 projection row 严格一致）
  projectionId: string;
  // candidate binding（issuance 时刻冻结；transaction 内 exact re-check）
  candidateMaterializationId: string | null;
  candidateMaterializationMetadataHash: string | null;
  // one-shot consumption binding (P0-D)
  boundExpectedHandle: ValidationOwnerShape;
  /**
   * R7 P0-B：显式状态机。任何 await/callback/DB transaction/hook 之前必须完成 open→consuming；
   * 并发第二次消费看到 consuming 即拒绝（callback 不执行）。
   */
  state: 'open' | 'consuming' | 'consumed' | 'closed';
  // 持有的 verified held capability（issuance 时捕获；consume 中保存为常量，不被 callback 可修改）
  heldVerify: HeldMaterializedFileEvidence;
  // 仅诊断：deep-frozen 派生诊断快照（**不参与授权**；仅 GET 序列化诊断用）
  diagnosticSnapshotBase: MaterializedFileEvidence;
}
const reuseRecords = new WeakMap<ValidatedReusableProjectionCapability, ReuseAuthorityRecord>();

/** 运行时 deep-freeze（不可变快照）。 */
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
 * R6 P0-A：HeldMaterializedFileEvidence 仅作为 WeakMap 的 key；公开字段是 deep-frozen 诊断
 * 快照，**不参与 DB success 授权**。授权决策一律通过 `assertHeldCapability` + WeakMap record
 * 完成；mode/closed 来自 record。fd 生命周期由 module-private 路径管理。
 */
export class HeldMaterializedFileEvidence {
  /** Deep-frozen 诊断快照（仅 GET 序列化诊断用；不参与 DB success 授权）。 */
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
  get fileFd(): fsSync.promises.FileHandle {
    const r = heldRecords.get(this);
    if (!r) throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 无 authority record');
    return r.fileHandle;
  }
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

/** module-private：唯一 Held 发行点 */
function issueHeldEvidence(
  evidence: MaterializedFileEvidence,
  fileHandle: fsSync.promises.FileHandle,
  parentHandle: fsSync.promises.FileHandle,
  mode: 'verify' | 'durabilize',
): HeldMaterializedFileEvidence {
  return new HeldMaterializedFileEvidence(evidence, fileHandle, parentHandle, mode, HELD_ISSUE_TOKEN);
}

/** Runtime capability seal + 返回权威 mode（用于 assertHeldCurrentSync 二次校验） */
export function assertHeldCapability(value: unknown): asserts value is HeldMaterializedFileEvidence {
  if (typeof value !== 'object' || value === null || !(value instanceof HeldMaterializedFileEvidence)) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability is not validator-issued');
  }
  const r = heldRecords.get(value);
  if (!r || r.closed) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability closed or not validator-issued');
  }
}

/** module-private accessors（不导出） */
function getHeldRecord(value: HeldMaterializedFileEvidence): HeldAuthorityRecord {
  const r = heldRecords.get(value);
  if (!r || r.closed) throw new MaterializedFileError('SEAL_MISMATCH', 'held capability closed or not validator-issued');
  return r;
}

function getReuseRecord(value: ValidatedReusableProjectionCapability): ReuseAuthorityRecord {
  const r = reuseRecords.get(value);
  if (!r || r.state === 'closed' || r.state === 'consumed') {
    throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability closed or not validator-issued');
  }
  return r;
}

// ────────── ValidatedReusableProjectionCapability（P0-A P0-B）──────────

/**
 * R7 P0-A P0-B：branded reuse validation capability。**仅作为 opaque WeakMap key**——公开
 * 字段不暴露任何身份/授权字段（projectionId/voiceProfileId/sourceSha256/adapterCompatibilityKey/
 * provider/relativePath/fileSha256 等全部隐藏在 module-private WeakMap record）。`state` /
 * `isClosed` 来自 record；method/property shadow 不影响 record。R7 引入显式状态机
 * open/consuming/consumed/closed（任何 await/callback/transaction/hook 前完成 open→consuming）；
 * `diagnosticSnapshot` 为 deep-frozen 诊断字段（**不参与授权**）。
 */
export class ValidatedReusableProjectionCapability {
  /**
   * R7 P0-B：deep-frozen 诊断快照（**不参与 DB success 授权**；仅 GET 序列化诊断用）。
   * 修改此字段不影响 record；篡改不影响授权。
   */
  readonly diagnosticSnapshot: Readonly<MaterializedFileEvidence> | null;
  /** R7 P0-B：显式状态机（来自 module-private record；method shadow 无效）。 */
  readonly state: 'open' | 'consuming' | 'consumed' | 'closed';
  constructor(issueToken: symbol, fields: ReuseAuthorityRecord) {
    if (issueToken !== HELD_ISSUE_TOKEN) {
      throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability 只能由 validator 发行（issue token 无效）');
    }
    this.diagnosticSnapshot = deepFreeze({...fields.diagnosticSnapshotBase}) as Readonly<MaterializedFileEvidence>;
    this.state = fields.state;
    reuseRecords.set(this, fields);
  }
  /** R7 P0-C/P0-E：公开 close() 仅为便利包装——module-private 关闭路径（closeReuseCapability /
   *  consume 内部 finally）才是权威；shadow 此方法不影响 record state。 */
  async close(): Promise<void> {
    await closeReuseCapability(this);
  }
  get isClosed(): boolean {
    const r = reuseRecords.get(this);
    return !r || r.state === 'closed' || r.state === 'consumed';
  }
}

// ReuseAuthorityRecord 扩展诊断字段（不入 record 其它任何字段）
type ReuseAuthorityRecordFields = ReuseAuthorityRecord;

// ────────── 流式 SHA256 / WAV parse ──────────

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
      try { await dirFh.close(); } catch { /* best-effort */ }
    }
    if (fh) {
      try { await fh.close(); } catch { /* best-effort */ }
    }
    throw err;
  }
}

/**
 * R5 unified commit-time 同步 seal（P0-A/P0-B/P0-C/P0-D/P0-E）。
 * - capability 真实性 + 未关闭（assertHeldCapability）；
 * - requireDurability=true 时 record.mode === 'durabilize'（verify capability 不得成功终局）；
 * - expectedVoiceProfileId/voiceProfileRevisionId/expectedSha256 与 record identity exact
 *   （P0-B/P0-C/P0-D：job-binding 与 issuance frozen identity）；
 * - exact destination binding：从 record.voiceProfileId/voiceProfileRevisionId 重新派生
 *   expectedRelative/expectedAbsolute/expectedParent/profileDir/rootDir；record.relativePath/
 *   absolutePathInternal/parentRealpath 必须逐项等于派生值（不信任 record 路径字段外的任何
 *   来源作为查询路径——改回 caller 字段的攻击由 binding equality 兜住）；
 * - full ancestor seal：lstatSync root/profile/revision(final parent)/final + realpath
 *   锚定（path+lstat 逐级复核；本地 single-writer contract）。
 * 必须同步（无 await）；fence 后到 COMMIT 之间不得有可注入异步 hook。
 */
export function assertHeldCurrentSync(
  capability: HeldMaterializedFileEvidence,
  opts: {
    requireDurability: boolean;
    expectedVoiceProfileId?: string;
    expectedVoiceProfileRevisionId?: string;
    expectedSha256?: string;
  },
): void {
  assertHeldCapability(capability);
  const r = getHeldRecord(capability);
  if (opts.requireDurability && r.mode !== 'durabilize') {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held capability 非 durabilize mode（不得成功终局）');
  }
  const snap = r.diagnosticSnapshot;
  const fail = (code: MaterializedFileError['code'], msg: string): never => {
    throw new MaterializedFileError(code, msg);
  };
  if (opts.expectedVoiceProfileId !== undefined && snap.voiceProfileId !== opts.expectedVoiceProfileId) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held voiceProfileId ≠ expected job binding');
  }
  if (opts.expectedVoiceProfileRevisionId !== undefined && snap.voiceProfileRevisionId !== opts.expectedVoiceProfileRevisionId) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held voiceProfileRevisionId ≠ expected job binding');
  }
  if (opts.expectedSha256 !== undefined && snap.sha256 !== opts.expectedSha256) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'held sha256 ≠ expected job binding');
  }
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
  let profileStat: fsSync.BigIntStats;
  try {
    profileStat = fsSync.lstatSync(profileDir, {bigint: true});
  } catch {
    return fail('SEAL_MISMATCH', 'profile ancestor 不可 stat');
  }
  if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) fail('SEAL_MISMATCH', 'profile ancestor 非目录/symlink');
  if (profileStat.dev !== snap.profileDev || profileStat.ino !== snap.profileIno) fail('SEAL_MISMATCH', 'profile ancestor dev/inode 漂移（被替换）');
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
  const fdStat = fsSync.fstatSync(r.fileHandle.fd, {bigint: true});
  if (fdStat.dev !== snap.device || fdStat.ino !== snap.inode) fail('SEAL_MISMATCH', 'held fd inode 漂移');
  if (fdStat.size !== BigInt(snap.size)) fail('SEAL_MISMATCH', 'held fd size 漂移（同 inode 改写）');
  if (fdStat.mtimeNs !== snap.mtimeNs || fdStat.ctimeNs !== snap.ctimeNs) {
    fail('SEAL_MISMATCH', 'held fd mtime/ctime 漂移（同 inode 原地改写）');
  }
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
  const parentFdStat = fsSync.fstatSync(r.parentHandle.fd, {bigint: true});
  if (parentFdStat.dev !== snap.parentDev || parentFdStat.ino !== snap.parentIno) fail('SEAL_MISMATCH', 'held parent fd inode 漂移');
}

// ────────── R6 P0-A P0-B P0-C P0-D P0-E：reusable projection 高层 API ──────────

/**
 * R6 P0-A：唯一对外的 reuse entry。**事务外**调用，事务完成后通过 `consumeValidatedProjectionForReuse`
 * 完成事务内 finalize（不允许 materialization.ts 之外的任何模块获得 issuer token / WeakMap 注册入口）。
 *
 * 内部（P0-C）严格一致性校验——任一不通过则：
 *  1) 关闭已打开的 held fd（不留 dangling 资源）；
 *  2) 不注册 record（不向 WeakMap 写入）；
 *  3) throw MaterializedFileError SEAL_MISMATCH。
 * 调用方应捕获 → 返回 unusable。
 */
export async function validateProjectionForReuse(
  projection: {
    id: string;
    voice_profile_id: string;
    voice_profile_revision_id: string;
    source_canonical_sha256: string;
    adapter_compatibility_key: string;
    destination_voice_root_relative_path: string;
    status: 'file_ready_unpublished' | 'published_usable' | 'failed' | 'indeterminate';
    published_registry_generation: number | null;
    published_registry_sha256: string | null;
    published_by_publication_id: string | null;
    created_at: string;
    updated_at: string;
  },
  candidateMetadataHash: string | null,
  expectedHandle: ValidationOwnerShape,
  provider: string,
): Promise<
  | {kind: 'usable'; capability: ValidatedReusableProjectionCapability; projection: typeof projection}
  | {kind: 'unusable'; reason: string}
> {
  if (projection.status !== 'file_ready_unpublished' && projection.status !== 'published_usable') {
    return {kind: 'unusable', reason: `projection status=${projection.status}`};
  }
  const {validateVoiceProfileRevisionExact} = await import('../voice-library/revisions');
  const descriptor = await validateVoiceProfileRevisionExact(projection.voice_profile_id, projection.voice_profile_revision_id);
  if (!descriptor) return {kind: 'unusable', reason: 'exact voice revision 不可读'};
  if (!descriptor.usable) return {kind: 'unusable', reason: descriptor.unusableReason ?? 'hash_mismatch'};
  let held: HeldMaterializedFileEvidence;
  try {
    held = await openHeldMaterializedFileEvidence(
      {
        relativePath: projection.destination_voice_root_relative_path,
        voiceProfileId: projection.voice_profile_id,
        voiceProfileRevisionId: projection.voice_profile_revision_id,
        expectedSha256: projection.source_canonical_sha256,
        expectedSize: descriptor.fileSize,
        expectedCodec: 'pcm_s16le',
        expectedSampleRate: 48000,
        expectedChannels: 1,
        minDurationMs: 1,
        adapterCompatibilityKey: projection.adapter_compatibility_key,
      },
      'verify',
    );
  } catch (err) {
    return {kind: 'unusable', reason: err instanceof Error ? err.message : String(err)};
  }
  // P0-C：issuance 严格一致性校验
  try {
    const snap = held.evidence;
    // P0-E：从成功打开 held 开始的全部后处理放入统一 try/finally——任何异常
    // （identity check / candidate binding / realpath / lstat / record construction /
    //  capability registration）都保证关闭 originalHeld（不注册 record）。
    let transferred = false;
    try {
      const expectedRel = destinationRelativePath(projection.voice_profile_id, projection.voice_profile_revision_id);
      const expectedAbs = destinationAbsolutePath(expectedRel);
      const expectedParent = path.dirname(expectedAbs);
      const realRoot = fsSync.realpathSync(materializationRootAbs());
      const realParent = fsSync.realpathSync(expectedParent);
      if (
        projection.destination_voice_root_relative_path !== expectedRel ||
        snap.relativePath !== expectedRel ||
        snap.absolutePathInternal !== expectedAbs ||
        snap.parentRealpath !== realParent ||
        snap.voiceProfileId !== projection.voice_profile_id ||
        snap.voiceProfileRevisionId !== projection.voice_profile_revision_id ||
        snap.sha256 !== projection.source_canonical_sha256
      ) {
        throw new MaterializedFileError('SEAL_MISMATCH', 'issuance 严格一致性校验失败：projection/record identity 不匹配');
      }
      // candidate binding exact
      if (expectedHandle.candidateMaterializationId !== (projection.id ?? null)) {
        throw new MaterializedFileError('SEAL_MISMATCH', 'candidate materialization id 漂移（issuance）');
      }
      if (expectedHandle.candidateMaterializationMetadataHash !== candidateMetadataHash) {
        throw new MaterializedFileError('SEAL_MISMATCH', 'candidate metadata hash 漂移（issuance）');
      }
      // 构造 record（lstat root/profile/revision + 冻结 fields）
      const parentStat = fsSync.lstatSync(realParent, {bigint: true});
      const rootStat = fsSync.lstatSync(realRoot, {bigint: true});
      const profileStat = fsSync.lstatSync(path.dirname(expectedParent), {bigint: true});
      const fields: ReuseAuthorityRecord = {
        voiceProfileId: projection.voice_profile_id,
        voiceProfileRevisionId: projection.voice_profile_revision_id,
        sourceSha256: projection.source_canonical_sha256,
        adapterCompatibilityKey: projection.adapter_compatibility_key,
        provider,
        relativePath: expectedRel,
        absolutePathInternal: expectedAbs,
        rootRealpath: realRoot,
        revisionParentRealpath: realParent,
        fileSha256: snap.sha256,
        fileCodec: snap.codec,
        fileSampleRate: snap.sampleRate,
        fileChannels: snap.channels,
        fileDurationMs: snap.durationMs,
        fileSize: snap.size,
        rootDev: rootStat.dev,
        rootIno: rootStat.ino,
        profileDev: profileStat.dev,
        profileIno: profileStat.ino,
        revisionDev: parentStat.dev,
        revisionIno: parentStat.ino,
        fileDev: snap.device,
        fileIno: snap.inode,
        fileMtimeNs: snap.mtimeNs,
        fileCtimeNs: snap.ctimeNs,
        projectionId: projection.id,
        candidateMaterializationId: expectedHandle.candidateMaterializationId,
        candidateMaterializationMetadataHash: expectedHandle.candidateMaterializationMetadataHash,
        boundExpectedHandle: {
          jobId: expectedHandle.jobId,
          validationOwnerToken: expectedHandle.validationOwnerToken,
          validationAttempt: expectedHandle.validationAttempt,
          candidateMaterializationId: expectedHandle.candidateMaterializationId,
          candidateMaterializationMetadataHash: expectedHandle.candidateMaterializationMetadataHash,
        },
        state: 'open',
        heldVerify: held,
        diagnosticSnapshotBase: {...snap},
      };
      // 通过 module-private 构造器写入 reuseRecords
      const cap = new ValidatedReusableProjectionCapability(HELD_ISSUE_TOKEN, fields);
      transferred = true;
      return {kind: 'usable', capability: cap, projection};
    } finally {
      // P0-E：未 transferred（任何异常路径）→ 关闭 originalHeld；不注册 record
      if (!transferred) {
        await held.close().catch(() => undefined);
      }
    }
  } catch (e) {
    return {kind: 'unusable', reason: e instanceof Error ? e.message : String(e)};
  }
}

/**
 * R7 P0-A P0-B P0-C P0-D：唯一对外的 reuse consume entry。
 *
 * 生命周期（**任何 await/callback/DB transaction/hook 之前完成 open→consuming**）：
 *  1. get private record（不在 WeakMap → SEAL_MISMATCH）
 *  2. state !== 'open' → SEAL_MISMATCH（含 consuming 并发第二次）
 *  3. 同步 state = 'consuming'
 *  4. 保存 `const originalHeld = r.heldVerify`（**issuance 时捕获；不被 callback 可修改**）
 *  5. try:
 *       a. exact handle binding re-check
 *       b. `await beforeCommitHook?.()`（Phase 2 后、commit seal 前——hook throw 必关闭）
 *       c. commit-time seal（assertHeldCurrentSync requireDurability=false）
 *       d. `await onCommit()`（DB transaction）
 *       e. state = 'consumed'
 *     finally:
 *       state = 'closed'
 *       关闭 originalHeld（module-private；不依赖 public close / callback 可修改对象）
 *
 * callback 签名 **不接收 record**（P0-A：ReuseAuthorityRecord 不离开本 module）。
 */
export async function consumeValidatedProjectionForReuse(
  capability: ValidatedReusableProjectionCapability,
  expectedHandle: ValidationOwnerShape,
  onCommit: () => Promise<void> | void,
  beforeCommitHook?: () => Promise<void> | void,
): Promise<void> {
  // 1. 私有 record（不导出）
  const r = reuseRecords.get(capability);
  if (!r) {
    throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability 不是 validator-issued');
  }
  // 2. state 检查（open 才可消费；consuming/consumed/closed 全部拒绝）
  if (r.state !== 'open') {
    throw new MaterializedFileError(
      'SEAL_MISMATCH',
      `reuse capability state=${r.state}（仅 open 可消费；consuming 表示并发第二次）`,
    );
  }
  // 3. 同步 open→consuming（任何 await 之前）
  r.state = 'consuming';
  (capability as unknown as {state: string}).state = 'consuming';
  // 4. 保存 originalHeld 常量（issuance 时捕获；callback 无法替换）
  const originalHeld = r.heldVerify;
  try {
    // 5a. exact handle binding re-check
    if (
      r.boundExpectedHandle.jobId !== expectedHandle.jobId ||
      r.boundExpectedHandle.validationOwnerToken !== expectedHandle.validationOwnerToken ||
      r.boundExpectedHandle.validationAttempt !== expectedHandle.validationAttempt ||
      r.boundExpectedHandle.candidateMaterializationId !== expectedHandle.candidateMaterializationId ||
      r.boundExpectedHandle.candidateMaterializationMetadataHash !== expectedHandle.candidateMaterializationMetadataHash
    ) {
      throw new MaterializedFileError('SEAL_MISMATCH', 'reuse capability handle binding 不匹配（attempt+1 takeover / 不同 job / candidate 漂移）');
    }
    // 5b. Phase 2 hook（受控生命周期内部——hook throw 走 finally 关闭）
    if (beforeCommitHook) {
      await beforeCommitHook();
    }
    // 5c. commit-time seal（从 private record 读取 expected identity/SHA；不得省略）
    assertHeldCurrentSync(originalHeld, {
      requireDurability: false,
      expectedVoiceProfileId: r.voiceProfileId,
      expectedVoiceProfileRevisionId: r.voiceProfileRevisionId,
      expectedSha256: r.fileSha256,
    });
    // 5d. DB transaction（callback 不接收 record）
    await onCommit();
    // 5e. consumed
    r.state = 'consumed';
    (capability as unknown as {state: string}).state = 'consumed';
  } finally {
    // P0-C：任何路径（handle mismatch / seal fail / hook throw / onCommit throw / rollback / success）
    // 都进入同一 finally——state=closed + 关闭 originalHeld（恰好一次）
    r.state = 'closed';
    (capability as unknown as {state: string}).state = 'closed';
    try {
      await originalHeld.close();
    } catch {
      // best-effort；closed 已标记防 double-close
    }
  }
}

/**
 * R7 P0-C/P0-E：module-private 关闭路径（不依赖 public close；不读取 callback 可修改对象）。
 * 直接操作 reuseRecords；仅 open/consuming 可被外部 close（consumed/closed 已终态）。
 */
async function closeReuseCapability(capability: ValidatedReusableProjectionCapability): Promise<void> {
  const r = reuseRecords.get(capability);
  if (!r) return;
  if (r.state === 'consumed' || r.state === 'closed') return;
  // 保存 originalHeld 常量后标记 closed 并关闭（避免并发 consume 在 finally 中重复关闭）
  const originalHeld = r.heldVerify;
  r.state = 'closed';
  (capability as unknown as {state: string}).state = 'closed';
  try {
    await originalHeld.close();
  } catch {
    // best-effort
  }
}

/**
 * R6 兼容层：verify 模式打开并立即关闭，返回只读 evidence snapshot（不能用于构造 reuse capability）。
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
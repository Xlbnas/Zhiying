/**
 * TTS-C.1B.3 registry activation / acknowledgment / atomic activation / recovery。
 *
 * 范围（frozen §7.3 T3/T4/T5、§D CC-1…CC-6、1B.3 计划 §E/§K）：
 *   - T3：active registry 原子提升（temp→fsync→rename→dir fsync→reread 验证；fixed path 原则）+ adapter POST /reload。
 *   - T4：markActivationPending + GET /registry-status acknowledgment（唯一观察面）。
 *   - T5：唯一 atomic activation command（normal_owner_finalize / indeterminate_reconciliation）。
 *   - Lease takeover CAS + crash reconciliation（CC-1…CC-6）。
 *
 * TTS-C.1B.3.R1（blocker repair，pending blocker-specific Review）：
 *   P0-A  enterIndeterminateFenced：owner/attempt/lease fenced 单 statement；stale owner 无法清除
 *          takeover winner 的新 owner/lease；indeterminate 自动入口只允许 fromStatus='activation_pending'。
 *   P0-B  file_durable 阶段 reload 不确定（timeout/reset/malformed）不再进入 indeterminate——保持
 *          file_durable，执行一次 fenced registry-status 观察：candidate → pending+T5；
 *          stable → reload_retryable；unknown/status 不可用 → reload_result_unknown（保持 file_durable，
 *          不释放 single-flight，等待 recovery 重试）。indeterminate 仅来自 activation_pending。
 *   P0-C  durable stable snapshot（<dataDir>/voice-registries/stable-before-<generation>.json）在首次
 *          promotion 前持久化；任何自动 failed/cancelled 前先 restore stable disk + reload +
 *          registry-status ack（loaded == stable）确认后才释放 publication；不确定 → rollback_pending/
 *          unknown（保持 single-flight）。
 *   Legacy rollback：fail/cancel 同 BEGIN IMMEDIATE 完成 publication terminal + legacy entry
 *          mapping_pending→mapped_verified（清 pending link + selector；mapping_mode/provenance 保持）。
 *   P1-A  recovery 每个 HTTP 副作用前 fenced renew；publishRegistryCandidate(handle) 的 file_durable
 *          re-durabilize 前 renew。
 *   P1-B  active path 全链 containment（root realpath + 逐级 parent 无 symlink + final no-follow），
 *          candidate-idempotent 路径同样执行。
 *   P2    adapter error shape（真实 {"error","message"} 优先）在 adapter-client 完成。
 *
 * TTS-C.1B.3.R2（blocker repair，pending blocker-specific Review）：
 *   P0-1  每个 active 文件 mutation（stable snapshot 新写 / snapshot re-durabilize / candidate→active
 *          promote / stable restore）紧邻前重新 fenced renew（renewPublicationOrThrow），
 *          renew 与 mutation 之间不再执行任何 HTTP/其他文件副作用；测试注入
 *          beforeActiveWriteHook / beforeStableRestoreWriteHook / beforeSnapshotWriteHook
 *          在最终 renew 之前挂起，证明 stale owner 在 renew 处失败、零文件副作用。
 *   P0-2  indeterminate→failed 只能走 resolveIndeterminateFailedAndRollbackLegacy（单 BEGIN IMMEDIATE：
 *          publication indeterminate→failed + legacy subject 同事务 mapping_pending→mapped_verified；
 *          legacy 不命中整事务回滚）；reconcileIndeterminate 不再直接 UPDATE failed。
 *   P1-1  terminal rollback 拆 pre-promotion（building/candidate_persisted，无需 stable restore）
 *         与 post-promotion（file_durable/activation_pending，须已 restore confirmed）两个入口。
 *   P1-2  dir fsync 目标改为 rename 实际发生的 exact final parent（path.dirname(finalAbs)），
 *         不再无条件 fsync containment root；lstat 校验 parent 非 symlink 且为目录。
 *
 * TTS-C.1B.3.R3（API-safety closure，pending final blocker-specific Review）：
 *   post-promotion failed/cancelled 的唯一公开入口改为 async safe orchestrator
 *   （terminalPostPromotionPublicationSafely / failPostPromotionPublicationSafely /
 *   cancelPostPromotionPublicationSafely）：代码强制先 restoreStableAndConfirm == 'confirmed'
 *   （stable disk restore + reload + registry-status ack），confirmed 后才执行
 *   owner/attempt/lease-fenced terminal transaction；rollback_pending/unknown 不修改
 *   publication/legacy、不释放 single-flight。低层同步事务 helper
 *   terminalPostPromotionAfterRestoreConfirmed 收为模块私有——不再存在仅凭
 *   db+publicationId+owner+attempt 即可把 file_durable/activation_pending 推进 terminal 的
 *   公开函数。pre-promotion（building/candidate_persisted）helper 保持公开（无需 restore）。
 *   afterRestoreConfirmedHook（仅测试注入）位于 restore confirmed 后、terminal 前，用于构造
 *   takeover 竞态。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type {Db} from '../db';
import {
  PUBLISHER_REGISTRY_SCHEMA_VERSION,
  SUPPORTED_PUBLISHER_SCHEMA_VERSION,
  parseAndValidateRegistry,
  sha256Bytes,
} from './registry-schema';
import {RegistryContractError} from './registry-contract-error';
import {
  getPublicationRow,
  renewPublicationLease,
  candidateRegistryPath,
  candidateRegistryDir,
  durabilizeAndVerifyCandidate,
  failPublication,
  publishRegistryCandidate,
  PUBLICATION_LEASE_MS,
  PUBLICATION_NOT_OWNER,
  PUBLICATION_LEASE_EXPIRED,
  PUBLICATION_INVALID_STATE,
  CANDIDATE_FILE_IO,
  CANDIDATE_BYTES_CONFLICT,
  type PublicationRow,
  type PublishRegistryCandidateOptions,
} from './registry-publisher';
import {dbNowMs, nowIso} from './materialization';
import {AdapterClient, REGISTRY_STATE_UNKNOWN, type AdapterRegistryStatus} from './adapter-client';
import {OPEN_FLAGS, stagingTempPath} from './paths';

export {AdapterClient, REGISTRY_STATE_UNKNOWN, type AdapterRegistryStatus};

export const ACTIVATION_CONFLICT = 'ACTIVATION_CONFLICT';
export const ACTIVATION_INVALID_STATE = 'ACTIVATION_INVALID_STATE';
export const LEGACY_ROLLBACK_MISMATCH = 'LEGACY_ROLLBACK_MISMATCH';
export const STABLE_SNAPSHOT_CONFLICT = 'STABLE_SNAPSHOT_CONFLICT';

// ── 路径配置 ──

export interface ActiveRegistryPaths {
  /** 配置的 active registry 文件绝对路径（adapter 固定配置路径的宿主/worker 侧对应）。 */
  activeRegistryPath: string;
  /** active registry 所在目录（containment root；非 symlink + realpath 固定）。 */
  activeRegistryRoot: string;
  /**
   * 测试注入（仅测试；R2 P0-1）：文件 mutation 前的挂起 hook——在最终 fenced renew 之前触发，
   * 用于证明 stale owner 在最终 renew 处失败、不再产生任何文件副作用。
   */
  beforeActiveWriteHook?: () => Promise<void> | void;
  beforeStableRestoreWriteHook?: () => Promise<void> | void;
  beforeSnapshotWriteHook?: () => Promise<void> | void;
  /** 测试注入（仅测试；R2 P1-2）：final 文件 fsync hook（active 提升用）。 */
  fsyncFile?: (fh: fsPromises.FileHandle) => Promise<void>;
  /** 测试注入（仅测试；R2 P1-2）：exact final parent 目录 fsync hook（active 写/restore/snapshot 共用）。 */
  fsyncDir?: (fh: fsPromises.FileHandle) => Promise<void>;
}

/** stable snapshot 确定性路径（权威绑定 = generation + stable_registry_sha256 + path）。 */
export function stableSnapshotPath(generation: number): string {
  return path.join(candidateRegistryDir(), `stable-before-${generation}.json`);
}

// ── P1-B：active path 全链 containment（统一 helper；read/classify/promotion/restore 共用） ──

/**
 * 在任何 read/classify/idempotent-return/temp-write/rename/fsync/reload 之前调用：
 *   root 绝对 + lstat 目录非 symlink + realpath==resolve；
 *   final lexical 位于 root 内；逐级 parent（root→final）lstat 无 symlink；
 *   final 存在时 O_NOFOLLOW + fstat regular。
 */
export async function validateActivePathSafe(paths: ActiveRegistryPaths): Promise<string> {
  if (!path.isAbsolute(paths.activeRegistryRoot)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry root 必须绝对路径');
  }
  const root = path.resolve(paths.activeRegistryRoot);
  let rootSt: fs.Stats;
  try {
    rootSt = await fsPromises.lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry root 缺失: ${root}`);
    }
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry root 不可 stat: ${root}`);
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry root 是 symlink 或非目录');
  }
  let realRoot: string;
  try {
    realRoot = await fsPromises.realpath(root);
  } catch {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry root realpath 不可解析');
  }
  if (realRoot !== root) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry root realpath 漂移（symlink 逃逸）');
  }
  const finalAbs = path.resolve(paths.activeRegistryPath);
  if (!path.isAbsolute(paths.activeRegistryPath)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry path 必须绝对路径');
  }
  if (!finalAbs.startsWith(root + path.sep)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry final path 越出 root');
  }
  const rel = finalAbs.slice(root.length + 1);
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry path 段非法: ${rel}`);
  }
  // 逐级 parent 无 symlink
  let cur = root;
  for (const seg of parts.slice(0, -1)) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = await fsPromises.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry parent 缺失: ${cur}`);
      }
      throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry parent 不可 stat: ${cur}`);
    }
    if (st.isSymbolicLink()) throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry parent 是 symlink: ${cur}`);
    if (!st.isDirectory()) throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry parent 非目录: ${cur}`);
  }
  // final 存在时 O_NOFOLLOW + fstat regular
  try {
    const st = await fsPromises.lstat(finalAbs);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry final 是 symlink 或非普通文件');
    }
    const fh = await fsPromises.open(finalAbs, OPEN_FLAGS.readNoFollow);
    try {
      const fst = await fh.stat();
      if (fst.isSymbolicLink() || !fst.isFile()) {
        throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry final 非普通文件');
      }
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof RegistryContractError) throw err;
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry final 不可验证: ${(err as Error).message}`);
    }
  }
  return root;
}

// ── T3：active disk 状态裁决 + 原子提升 ──

export type DiskActiveState = 'stable' | 'candidate' | 'unknown';

async function readActiveRegistryFile(paths: ActiveRegistryPaths): Promise<{sha: string; bytes: Buffer} | null> {
  await validateActivePathSafe(paths);
  let st: fs.Stats;
  try {
    st = await fsPromises.lstat(paths.activeRegistryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry 不可 stat: ${paths.activeRegistryPath}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry 是 symlink 或非普通文件');
  }
  let fh: fsPromises.FileHandle;
  try {
    fh = await fsPromises.open(paths.activeRegistryPath, OPEN_FLAGS.readNoFollow);
  } catch {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry 不可打开: ${paths.activeRegistryPath}`);
  }
  let bytes: Buffer;
  try {
    const fst = await fh.stat();
    if (fst.isSymbolicLink() || !fst.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry 非普通文件');
    }
    bytes = await fh.readFile();
  } finally {
    await fh.close();
  }
  return {sha: sha256Bytes(bytes), bytes};
}

export async function classifyActiveDiskState(
  db: Db,
  publicationId: string,
  paths: ActiveRegistryPaths,
): Promise<{state: DiskActiveState; activeSha: string | null}> {
  await validateActivePathSafe(paths);
  const pub = getPublicationRow(db, publicationId);
  const read = await readActiveRegistryFile(paths);
  if (!read) return {state: 'unknown', activeSha: null};
  if (pub.stable_registry_sha256 === read.sha) return {state: 'stable', activeSha: read.sha};
  if (pub.candidate_registry_sha256 !== null && pub.candidate_registry_sha256 === read.sha) {
    return {state: 'candidate', activeSha: read.sha};
  }
  return {state: 'unknown', activeSha: read.sha};
}

async function readDurableCandidateBytes(db: Db, publicationId: string): Promise<Buffer> {
  const pub = getPublicationRow(db, publicationId);
  if (!pub.candidate_registry_sha256) {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${publicationId} 无 candidate evidence`);
  }
  const candidatePath = candidateRegistryPath(pub.generation);
  let fh: fsPromises.FileHandle;
  try {
    fh = await fsPromises.open(candidatePath, OPEN_FLAGS.readNoFollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `durable candidate 缺失: ${candidatePath}`);
    }
    throw new RegistryContractError(CANDIDATE_FILE_IO, `durable candidate 不可打开: ${candidatePath}`);
  }
  let bytes: Buffer;
  try {
    const st = await fh.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'durable candidate 非普通文件');
    }
    bytes = await fh.readFile();
  } finally {
    await fh.close();
  }
  if (sha256Bytes(bytes) !== pub.candidate_registry_sha256) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'durable candidate SHA 与 DB evidence 不符');
  }
  return bytes;
}

/** 原子写文件（temp 同目录 O_EXCL → write → fsync → rename → 统一 acceptance）。hooks 仅测试注入。 */
async function atomicWriteFile(
  root: string,
  finalAbs: string,
  bytes: Buffer,
  expectedSha256: string,
  expectedGeneration: number,
  hooks?: {fsyncFile?: (fh: fsPromises.FileHandle) => Promise<void>; fsyncDir?: (fh: fsPromises.FileHandle) => Promise<void>},
): Promise<void> {
  const tempAbs = stagingTempPath(finalAbs);
  let fh: fsPromises.FileHandle | null = null;
  try {
    fh = await fsPromises.open(tempAbs, OPEN_FLAGS.tempCreate, 0o640);
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = null;
    await fsPromises.rename(tempAbs, finalAbs);
    await durabilizeAndVerifyCandidate({
      rootDir: root,
      finalPath: finalAbs,
      expectedSha256,
      expectedLength: bytes.length,
      expectedGeneration,
      fsyncFile: hooks?.fsyncFile,
      fsyncDir: hooks?.fsyncDir,
    });
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        // 忽略
      }
    }
    try {
      await fsPromises.unlink(tempAbs);
    } catch {
      // temp 可能已 rename——忽略
    }
    if (err instanceof RegistryContractError) throw err;
    throw new RegistryContractError(CANDIDATE_FILE_IO, `原子写失败: ${(err as Error).message}`);
  }
}

/**
 * stable snapshot 等非 1.1 文件用的 raw durability（fsync final + reread SHA；无 JSON 语义校验）。
 * R2 P1-2：dir fsync 目标 = path.dirname(finalAbs)（rename 实际发生的目录），
 * 不再无条件 fsync containment root；lstat 校验 parent 非 symlink 且为目录。
 */
async function durabilizeRawFile(
  root: string,
  finalAbs: string,
  expectedSha256: string,
  expectedLength: number,
  hooks?: {fsyncDir?: (fh: fsPromises.FileHandle) => Promise<void>},
): Promise<void> {
  const rootAbs = path.resolve(root);
  const finalAbsResolved = path.resolve(finalAbs);
  if (!finalAbsResolved.startsWith(rootAbs + path.sep)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `final path 越出 root: ${finalAbsResolved}`);
  }
  let fh: fsPromises.FileHandle;
  try {
    fh = await fsPromises.open(finalAbsResolved, OPEN_FLAGS.readNoFollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `文件缺失: ${finalAbsResolved}`);
    }
    throw new RegistryContractError(CANDIDATE_FILE_IO, `文件不可打开: ${finalAbsResolved}`);
  }
  try {
    const st = await fh.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, '文件是 symlink 或非普通文件');
    }
    const bytes = await fh.readFile();
    if (bytes.length !== expectedLength) throw new RegistryContractError(CANDIDATE_FILE_IO, `文件 length 不符（${bytes.length} != ${expectedLength}）`);
    if (sha256Bytes(bytes) !== expectedSha256) throw new RegistryContractError(CANDIDATE_FILE_IO, '文件 SHA 与预期不符');
    await fh.sync();
  } finally {
    await fh.close();
  }
  // exact final parent directory fsync（no-follow）
  const finalParent = path.dirname(finalAbsResolved);
  let parentSt: fs.Stats;
  try {
    parentSt = await fsPromises.lstat(finalParent);
  } catch (err) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `final parent 不可 stat: ${finalParent}`);
  }
  if (parentSt.isSymbolicLink() || !parentSt.isDirectory()) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'final parent 是 symlink 或非目录');
  }
  const dirFh = await fsPromises.open(finalParent, OPEN_FLAGS.parentReadNoFollow);
  try {
    if (hooks?.fsyncDir) {
      await hooks.fsyncDir(dirFh);
    } else {
      await dirFh.sync();
    }
  } catch (err) {
    if (err instanceof RegistryContractError) throw err;
    throw new RegistryContractError(CANDIDATE_FILE_IO, `final parent dir fsync 失败: ${(err as Error).message}`);
  } finally {
    await dirFh.close();
  }
  // fsync 后 reread 复核
  const rereadFh = await fsPromises.open(finalAbsResolved, OPEN_FLAGS.readNoFollow);
  try {
    const bytes = await rereadFh.readFile();
    if (sha256Bytes(bytes) !== expectedSha256) throw new RegistryContractError(CANDIDATE_FILE_IO, 'reread SHA 与预期不符');
  } finally {
    await rereadFh.close();
  }
}

/** raw 原子写（temp→write→fsync→rename→raw durability）。hooks 仅测试注入。 */
async function atomicWriteRawFile(
  root: string,
  finalAbs: string,
  bytes: Buffer,
  expectedSha256: string,
  hooks?: {fsyncDir?: (fh: fsPromises.FileHandle) => Promise<void>},
): Promise<void> {
  const tempAbs = stagingTempPath(finalAbs);
  let fh: fsPromises.FileHandle | null = null;
  try {
    fh = await fsPromises.open(tempAbs, OPEN_FLAGS.tempCreate, 0o640);
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = null;
    await fsPromises.rename(tempAbs, finalAbs);
    await durabilizeRawFile(root, finalAbs, expectedSha256, bytes.length, hooks);
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        // 忽略
      }
    }
    try {
      await fsPromises.unlink(tempAbs);
    } catch {
      // temp 可能已 rename——忽略
    }
    if (err instanceof RegistryContractError) throw err;
    throw new RegistryContractError(CANDIDATE_FILE_IO, `raw 原子写失败: ${(err as Error).message}`);
  }
}

// ── P0-C：durable stable snapshot ──

/**
 * 在首次 stable→candidate promotion 前持久化 old stable registry exact bytes 到确定性路径
 * （<dataDir>/voice-registries/stable-before-<generation>.json）。
 * 已存在：同 SHA → 重新 durabilize 后复用；异 SHA → STABLE_SNAPSHOT_CONFLICT fail-closed。
 */
export async function durabilizeStableSnapshot(db: Db, publicationId: string, ownerToken: string, attempt: number, paths: ActiveRegistryPaths): Promise<string> {
  if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${publicationId} lease 过期（stable snapshot 前）`);
  }
  const pub = getPublicationRow(db, publicationId);
  const disk = await readActiveRegistryFile(paths);
  if (!disk) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry 缺失——无法快照 stable');
  }
  if (disk.sha !== pub.stable_registry_sha256) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active disk SHA 非 stable（${disk.sha}）——拒绝快照`);
  }
  const root = await validateActivePathSafe({activeRegistryPath: stableSnapshotPath(pub.generation), activeRegistryRoot: candidateRegistryDir()});
  const finalAbs = stableSnapshotPath(pub.generation);

  let st: fs.Stats | null = null;
  try {
    st = await fsPromises.lstat(finalAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `stable snapshot 不可 stat: ${finalAbs}`);
    }
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'stable snapshot 是 symlink 或非普通文件');
    }
    let existingSha: string;
    const fh = await fsPromises.open(finalAbs, OPEN_FLAGS.readNoFollow);
    try {
      existingSha = sha256Bytes(await fh.readFile());
    } finally {
      await fh.close();
    }
    if (existingSha !== disk.sha) {
      throw new RegistryContractError(STABLE_SNAPSHOT_CONFLICT, `stable snapshot 已存在不同 bytes（fail-closed，不覆盖）`);
    }
    // 同 SHA：重新建立 durability 后复用（raw——stable 是 1.0 格式，无 1.1 语义校验）
    // R2 P0-1：挂起 hook 在最终 renew 之前（stale owner 必须在最终 renew 处失败）；
    // renew 与 mutation 之间不再执行任何 HTTP/其他文件写入/可阻塞 hook。
    if (paths.beforeSnapshotWriteHook) await paths.beforeSnapshotWriteHook();
    renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'stable snapshot re-durabilize');
    await durabilizeRawFile(root, finalAbs, disk.sha, disk.bytes.length, {fsyncDir: paths.fsyncDir});
    return finalAbs;
  }
  // R2 P0-1：挂起 hook 在最终 renew 之前；renew 紧邻新文件写入
  if (paths.beforeSnapshotWriteHook) await paths.beforeSnapshotWriteHook();
  renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'stable snapshot write');
  await atomicWriteRawFile(root, finalAbs, disk.bytes, disk.sha, {fsyncDir: paths.fsyncDir});
  return finalAbs;
}

// ── T3：promote（stable → candidate 原子提升；candidate-idempotent 也全链验证） ──

export async function promoteCandidateToActive(
  db: Db,
  publicationId: string,
  ownerToken: string,
  attempt: number,
  paths: ActiveRegistryPaths,
): Promise<'promoted' | 'idempotent'> {
  if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${publicationId} lease 过期/被接管（promote 前）`);
  }
  const pub = getPublicationRow(db, publicationId);
  if (pub.status !== 'file_durable' && pub.status !== 'activation_pending') {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${publicationId} 状态 ${pub.status} 不可 promote`);
  }
  const bytes = await readDurableCandidateBytes(db, publicationId);
  const disk = await classifyActiveDiskState(db, publicationId, paths); // 含全链 containment（P1-B）
  if (disk.state === 'unknown') {
    throw new RegistryContractError(
      REGISTRY_STATE_UNKNOWN,
      `active registry disk SHA 既非 stable 也非 candidate（${disk.activeSha ?? 'missing'}）——不覆盖不 reload`,
    );
  }
  if (disk.state === 'candidate') {
    // 幂等：不重写（P1-B：classify 已执行全链验证）
    return 'idempotent';
  }
  // stable → 先持久化 stable snapshot（P0-C，内部已 renew + hook），再原子提升
  await durabilizeStableSnapshot(db, publicationId, ownerToken, attempt, paths);
  const root = await validateActivePathSafe(paths);
  const finalAbs = path.resolve(paths.activeRegistryPath);
  // R2 P0-1：挂起 hook 在最终 renew 之前（stale owner 必须在最终 renew 处失败）；
  // 最终 renew 紧邻 active 文件写入——此后不再执行任何 HTTP/其他文件写入/可阻塞 hook
  if (paths.beforeActiveWriteHook) await paths.beforeActiveWriteHook();
  renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'active registry promotion write');
  await atomicWriteFile(root, finalAbs, bytes, pub.candidate_registry_sha256 as string, pub.generation, {fsyncFile: paths.fsyncFile, fsyncDir: paths.fsyncDir});
  return 'promoted';
}

// ── P0-C：stable restore + adapter ack ──

export type RestoreOutcome = 'confirmed' | 'rollback_pending' | 'unknown';

/**
 * 自动 failed/cancelled 前的 stable 恢复闭环：
 *   disk 已 candidate → 读 snapshot（SHA==stable 校验）→ 原子恢复 active 文件 → reload →
 *   registry-status loaded == stable 确认；disk 已 stable → 直接 reload+ack；
 *   disk unknown / 任一步不确定 → 不 failed/cancelled，返回 rollback_pending / unknown。
 */
export async function restoreStableAndConfirm(
  db: Db,
  publicationId: string,
  ownerToken: string,
  attempt: number,
  paths: ActiveRegistryPaths,
  adapter: AdapterClient,
): Promise<RestoreOutcome> {
  try {
    if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
      return 'rollback_pending'; // owner 已失效——不自动恢复
    }
    const pub = getPublicationRow(db, publicationId);
    const disk = await classifyActiveDiskState(db, publicationId, paths);
    if (disk.state === 'stable') {
      // disk 已 stable——只需 reload + ack
      if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) return 'rollback_pending';
      const reload = await adapter.reload();
      if (reload.kind !== 'ok') return 'rollback_pending';
      if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) return 'rollback_pending';
      const status = await adapter.registryStatus();
      if (status.kind !== 'ok') return 'rollback_pending';
      if (status.status.loadedRegistrySha256 === pub.stable_registry_sha256) return 'confirmed';
      return 'rollback_pending';
    }
    if (disk.state === 'candidate') {
      // 读 snapshot（SHA==stable 校验）
      const snapshotAbs = stableSnapshotPath(pub.generation);
      const fh = await fsPromises.open(snapshotAbs, OPEN_FLAGS.readNoFollow);
      let snapshotBytes: Buffer;
      try {
        snapshotBytes = await fh.readFile();
      } finally {
        await fh.close();
      }
      if (sha256Bytes(snapshotBytes) !== pub.stable_registry_sha256) {
        throw new RegistryContractError(STABLE_SNAPSHOT_CONFLICT, `stable snapshot SHA 与 stable_registry_sha256 不符`);
      }
      // 原子恢复 active 文件（raw durability——stable 是 1.0 格式，无 1.1 语义校验）
      // R2 P0-1：挂起 hook 在最终 renew 之前（stale owner 必须在最终 renew 处失败）；
      // 最终 renew 紧邻 restore 写——此后不再执行其他副作用
      const root = await validateActivePathSafe(paths);
      const finalAbs = path.resolve(paths.activeRegistryPath);
      if (paths.beforeStableRestoreWriteHook) await paths.beforeStableRestoreWriteHook();
      renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'stable restore write');
      await atomicWriteRawFile(root, finalAbs, snapshotBytes, pub.stable_registry_sha256, {fsyncDir: paths.fsyncDir});
      // reload + ack
      if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) return 'rollback_pending';
      const reload = await adapter.reload();
      if (reload.kind !== 'ok') return 'rollback_pending';
      if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) return 'rollback_pending';
      const status = await adapter.registryStatus();
      if (status.kind !== 'ok') return 'rollback_pending';
      if (status.status.loadedRegistrySha256 === pub.stable_registry_sha256) return 'confirmed';
      return 'rollback_pending';
    }
    return 'unknown'; // disk unknown——不自动恢复
  } catch (err) {
    if (err instanceof RegistryContractError && err.code === STABLE_SNAPSHOT_CONFLICT) throw err;
    return 'rollback_pending';
  }
}

// ── T4：activation_pending + acknowledgment ──

export function markActivationPending(db: Db, publicationId: string, ownerToken: string, attempt: number): void {
  const lease = dbNowMs(db) + PUBLICATION_LEASE_MS;
  const now = nowIso();
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET status='activation_pending', activation_requested_at=?, lease_expires_at_epoch_ms=?, updated_at=?
        WHERE id=? AND status='file_durable'
          AND owner_token=? AND attempt=?
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(now, lease, now, publicationId, ownerToken, attempt);
  if (res.changes !== 1) {
    throw new RegistryContractError(PUBLICATION_NOT_OWNER, `publication ${publicationId} 无法推进 activation_pending（fence 不命中）`);
  }
}

export type AckVerdict = 'candidate' | 'stable' | 'unknown';

export function classifyAdapterStatus(status: AdapterRegistryStatus, pub: PublicationRow): AckVerdict {
  if (
    status.ready === true &&
    status.schemaVersion === PUBLISHER_REGISTRY_SCHEMA_VERSION &&
    status.loadedRegistrySha256 === pub.candidate_registry_sha256 &&
    status.loadedRegistryGeneration === pub.generation &&
    status.publisherSchemaVersion === SUPPORTED_PUBLISHER_SCHEMA_VERSION
  ) {
    return 'candidate';
  }
  if (status.loadedRegistrySha256 === pub.stable_registry_sha256) {
    return 'stable';
  }
  return 'unknown';
}

// ── P0-A：fenced enterIndeterminate（唯一入口；fromStatus 只允许 activation_pending） ──

export interface EnterIndeterminateOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  fromStatus: 'activation_pending';
  errorCode: string;
  errorMessage: string;
}

/**
 * Owner-fenced 进入 indeterminate（单 statement）：
 *   id + status==fromStatus + owner_token + attempt + DB_NOW<=lease + indeterminate_from_status IS NULL
 *   → status=indeterminate, indeterminate_from_status=fromStatus, owner/lease=NULL, error_code/message, updated_at。
 * changes!=1 → PUBLICATION_NOT_OWNER（stale owner 无法清除 takeover winner 的新 owner/lease）。
 */
export function enterIndeterminateFenced(db: Db, options: EnterIndeterminateOptions): void {
  const now = nowIso();
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET status='indeterminate', indeterminate_from_status=?, owner_token=NULL,
              lease_expires_at_epoch_ms=NULL, error_code=?, error_message=?, updated_at=?
        WHERE id=? AND status=? AND owner_token=? AND attempt=?
          AND indeterminate_from_status IS NULL
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(options.fromStatus, options.errorCode, options.errorMessage, now,
      options.publicationId, options.fromStatus, options.ownerToken, options.attempt);
  if (res.changes !== 1) {
    throw new RegistryContractError(PUBLICATION_NOT_OWNER, `publication ${options.publicationId} 无法进入 indeterminate（fence 不命中/stale owner）`);
  }
}

// ── T5：唯一 atomic activation command ──

export interface ActivationCommandOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  observedActiveRegistrySha256: string;
}

export function activateRegistryPublication(db: Db, options: ActivationCommandOptions): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO voice_registry_publication_activations
       (id, publication_id, owner_token, attempt, observed_active_registry_sha256,
        activation_mode, activated_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'normal_owner_finalize', ?, ?)`,
  ).run(
    crypto.randomUUID(),
    options.publicationId,
    options.ownerToken,
    options.attempt,
    options.observedActiveRegistrySha256,
    now,
    now,
  );
}

export interface IndeterminateReconciliationOptions {
  publicationId: string;
  observedActiveRegistrySha256: string;
  resolutionEvidence: string;
  resolutionEvidenceHash: string;
}

export function reconcileIndeterminateActivation(db: Db, options: IndeterminateReconciliationOptions): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO voice_registry_publication_activations
       (id, publication_id, owner_token, attempt, observed_active_registry_sha256,
        activation_mode, resolution_evidence, resolution_evidence_hash, activated_at, created_at)
     VALUES (?, ?, NULL, (SELECT attempt FROM voice_registry_publications WHERE id=?), ?, 
        'indeterminate_reconciliation', ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    options.publicationId,
    options.publicationId,
    options.observedActiveRegistrySha256,
    options.resolutionEvidence,
    options.resolutionEvidenceHash,
    now,
    now,
  );
}

// ── Lease takeover CAS ──

export type TakeoverResult =
  | {kind: 'taken'; handle: {publicationId: string; generation: number; ownerToken: string; attempt: number}}
  | {kind: 'not_taken'; reason: 'lease_valid' | 'terminal' | 'indeterminate'};

export function takeoverExpiredPublication(db: Db, publicationId: string): TakeoverResult {
  const row = getPublicationRow(db, publicationId);
  if (row.status === 'indeterminate') return {kind: 'not_taken', reason: 'indeterminate'};
  if (!['building', 'candidate_persisted', 'file_durable', 'activation_pending'].includes(row.status)) {
    return {kind: 'not_taken', reason: 'terminal'};
  }
  const now = dbNowMs(db);
  if (row.lease_expires_at_epoch_ms !== null && row.lease_expires_at_epoch_ms >= now) {
    return {kind: 'not_taken', reason: 'lease_valid'};
  }
  const newOwner = crypto.randomUUID();
  const newLease = now + PUBLICATION_LEASE_MS;
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET owner_token=?, attempt=attempt+1, lease_expires_at_epoch_ms=?, updated_at=?
        WHERE id=? AND status IN ('building','candidate_persisted','file_durable','activation_pending')
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) > lease_expires_at_epoch_ms`,
    )
    .run(newOwner, newLease, nowIso(), publicationId);
  if (res.changes !== 1) return {kind: 'not_taken', reason: 'lease_valid'};
  const fresh = getPublicationRow(db, publicationId);
  return {
    kind: 'taken',
    handle: {publicationId: fresh.id, generation: fresh.generation, ownerToken: fresh.owner_token as string, attempt: fresh.attempt},
  };
}

// ── Legacy rollback（同 BEGIN IMMEDIATE；不修改 frozen trigger） ──

export interface TerminalRollbackOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  terminalStatus: 'failed' | 'cancelled';
  errorCode: string;
  errorMessage: string;
}

/**
 * R2 P1-1：shared tx 实现——publication fenced terminal（failed_at/error 必填；owner/lease 清空）+
 * （legacy subject）同事务 legacy entry mapping_pending→mapped_verified
 * （清 pending link + selector；mapping_mode/provenance 保持；frozen trg_lve_rollback 要求
 * publication 已在同事务内 failed/cancelled——先更新 publication 再更新 legacy）。
 * legacy UPDATE changes!=1 → LEGACY_ROLLBACK_MISMATCH 整事务回滚（不得只提交 publication terminal）。
 * allowedStatuses 区分：
 *   pre-promotion（building/candidate_persisted）——active registry 尚未被本 publication 提升，
 *     无需 stable restore；
 *   post-promotion（file_durable/activation_pending）——调用方必须已
 *     restoreStableAndConfirm == 'confirmed'（stable disk + adapter ack）后才可调用。
 */
function failOrCancelPublicationAndRollbackLegacyForStatuses(
  db: Db,
  options: TerminalRollbackOptions,
  allowedStatuses: readonly ('building' | 'candidate_persisted' | 'file_durable' | 'activation_pending')[],
): void {
  const tx = db.transaction((): void => {
    const now = nowIso();
    const placeholders = allowedStatuses.map(() => '?').join(',');
    const res = db
      .prepare(
        `UPDATE voice_registry_publications
            SET status=?, failed_at=?, error_code=?, error_message=?,
                owner_token=NULL, lease_expires_at_epoch_ms=NULL, updated_at=?
          WHERE id=? AND status IN (${placeholders})
            AND owner_token=? AND attempt=?
            AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
      )
      .run(options.terminalStatus, now, options.errorCode, options.errorMessage, now,
        options.publicationId, ...allowedStatuses, options.ownerToken, options.attempt);
    if (res.changes !== 1) {
      throw new RegistryContractError(PUBLICATION_NOT_OWNER, `publication ${options.publicationId} 无法推进 ${options.terminalStatus}（fence 不命中）`);
    }
    const pub = getPublicationRow(db, options.publicationId);
    if (pub.subject_type === 'legacy_cutover_publish' || pub.subject_type === 'legacy_cutover_existing') {
      const lve = db
        .prepare(
          `UPDATE legacy_adapter_voice_entries
              SET mapping_status='mapped_verified', pending_publication_id=NULL, candidate_source_selector=NULL
            WHERE id=? AND mapping_status='mapping_pending' AND pending_publication_id=?`,
        )
        .run(pub.subject_id, options.publicationId);
      if (lve.changes !== 1) {
        throw new RegistryContractError(LEGACY_ROLLBACK_MISMATCH, `legacy entry ${pub.subject_id} rollback 不匹配（整事务回滚）`);
      }
    }
    // materialization_publish / registry_rebuild：无 legacy 更新
  });
  tx.immediate();
}

/** R2 P1-1：pre-promotion 入口（building/candidate_persisted）——无需 stable restore。 */
export function failPrePromotionPublicationAndRollbackLegacy(db: Db, options: Omit<TerminalRollbackOptions, 'terminalStatus'>): void {
  failOrCancelPublicationAndRollbackLegacyForStatuses(db, {...options, terminalStatus: 'failed'}, ['building', 'candidate_persisted']);
}

export function cancelPrePromotionPublicationAndRollbackLegacy(db: Db, options: Omit<TerminalRollbackOptions, 'terminalStatus'>): void {
  failOrCancelPublicationAndRollbackLegacyForStatuses(db, {...options, terminalStatus: 'cancelled'}, ['building', 'candidate_persisted']);
}

/**
 * R3 API-safety closure：post-promotion 低层 terminal 事务——模块私有。
 * 只允许被本模块的 safe orchestrator（terminalPostPromotionPublicationSafely）在
 * restoreStableAndConfirm == 'confirmed' 之后调用。公开导出意味着调用方可以绕过
 * stable disk restore + adapter reload acknowledgment，直接以 db+owner+attempt
 * 把 file_durable/activation_pending 推进 failed/cancelled——已从模块 API 移除。
 */
function terminalPostPromotionAfterRestoreConfirmed(db: Db, options: TerminalRollbackOptions): void {
  failOrCancelPublicationAndRollbackLegacyForStatuses(db, options, ['file_durable', 'activation_pending']);
}

// ── R3：post-promotion safe terminal orchestrator（代码强制 restore + reload ack 前置） ──

export type SafeTerminalOutcome =
  | {kind: 'failed'}
  | {kind: 'cancelled'}
  | {kind: 'rollback_pending'}
  | {kind: 'registry_state_unknown'};

export interface SafePostPromotionTerminalOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  terminalStatus: 'failed' | 'cancelled';
  errorCode: string;
  errorMessage: string;
  paths: ActiveRegistryPaths;
  adapter: AdapterClient;
  /**
   * 测试注入（仅测试）：restore confirmed 之后、最终 terminal transaction 之前挂起——
   * 用于构造 restore/terminal 之间的 takeover 竞态（R3-04）。生产路径不设置。
   */
  afterRestoreConfirmedHook?: () => Promise<void> | void;
}

/**
 * post-promotion failed/cancelled 的唯一公开入口（async）：
 *   1. 读取 publication，确认 status ∈ {file_durable, activation_pending}；
 *   2. restoreStableAndConfirm(...)（restore disk → reload → registry-status ack）；
 *   3. 仅当 confirmed：owner/attempt/lease-fenced terminal transaction + legacy rollback；
 *   4. rollback_pending / unknown：不修改 publication、不修改 legacy、不释放 global single-flight。
 * restore ack 之后、terminal 之前发生 takeover → 最终 fence 不命中 → PUBLICATION_NOT_OWNER
 * 抛出（调用方按失败处理；disk/adapter 已恢复 stable 是允许的安全结果）。
 * 不新增 publication DB 状态。
 */
export async function terminalPostPromotionPublicationSafely(
  db: Db,
  options: SafePostPromotionTerminalOptions,
): Promise<SafeTerminalOutcome> {
  const pub = getPublicationRow(db, options.publicationId);
  if (pub.status !== 'file_durable' && pub.status !== 'activation_pending') {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${options.publicationId} 状态 ${pub.status} 不可 post-promotion terminal`);
  }
  const restore = await restoreStableAndConfirm(
    db,
    options.publicationId,
    options.ownerToken,
    options.attempt,
    options.paths,
    options.adapter,
  );
  if (restore === 'rollback_pending') return {kind: 'rollback_pending'};
  if (restore === 'unknown') return {kind: 'registry_state_unknown'};
  // restore === 'confirmed'
  if (options.afterRestoreConfirmedHook) await options.afterRestoreConfirmedHook();
  terminalPostPromotionAfterRestoreConfirmed(db, {
    publicationId: options.publicationId,
    ownerToken: options.ownerToken,
    attempt: options.attempt,
    terminalStatus: options.terminalStatus,
    errorCode: options.errorCode,
    errorMessage: options.errorMessage,
  });
  return {kind: options.terminalStatus === 'failed' ? 'failed' : 'cancelled'};
}

export function failPostPromotionPublicationSafely(
  db: Db,
  options: Omit<SafePostPromotionTerminalOptions, 'terminalStatus'>,
): Promise<SafeTerminalOutcome> {
  return terminalPostPromotionPublicationSafely(db, {...options, terminalStatus: 'failed'});
}

export function cancelPostPromotionPublicationSafely(
  db: Db,
  options: Omit<SafePostPromotionTerminalOptions, 'terminalStatus'>,
): Promise<SafeTerminalOutcome> {
  return terminalPostPromotionPublicationSafely(db, {...options, terminalStatus: 'cancelled'});
}

// ── R2 P0-2：indeterminate → failed 的唯一自动入口（无 owner；atomic legacy rollback） ──

export interface ResolveIndeterminateFailedOptions {
  publicationId: string;
  /** 必须与当前 publication.attempt 精确匹配（evidence 一致性 fence；indeterminate 无 owner）。 */
  attempt: number;
  errorCode: string;
  errorMessage: string;
}

/**
 * indeterminate → failed 的唯一自动入口（无 owner；不匹配则整事务回滚）：
 *   单 BEGIN IMMEDIATE：publication indeterminate→failed（id + status='indeterminate' +
 *   indeterminate_from_status='activation_pending' + attempt 精确匹配；candidate/stable evidence
 *   不变——frozen trg_vrp_immutable），随后 legacy subject 同事务 mapping_pending→mapped_verified
 *   （清 pending link + selector；mapping_mode/mapped_voice_materialization_id/import provenance
 *   保持）。legacy UPDATE changes!=1 → LEGACY_ROLLBACK_MISMATCH 整事务回滚（publication 保持
 *   indeterminate）。materialization_publish / registry_rebuild 不更新 legacy 表。
 * 调用方必须已确认 active disk == stable 且 adapter loaded == stable（reconcileIndeterminate）。
 */
export function resolveIndeterminateFailedAndRollbackLegacy(db: Db, options: ResolveIndeterminateFailedOptions): void {
  const tx = db.transaction((): void => {
    const now = nowIso();
    const res = db
      .prepare(
        `UPDATE voice_registry_publications
            SET status='failed', failed_at=?, error_code=?, error_message=?, updated_at=?
          WHERE id=? AND status='indeterminate'
            AND indeterminate_from_status='activation_pending'
            AND attempt=?`,
      )
      .run(now, options.errorCode, options.errorMessage, now, options.publicationId, options.attempt);
    if (res.changes !== 1) {
      throw new RegistryContractError(ACTIVATION_INVALID_STATE, `publication ${options.publicationId} 无法 indeterminate→failed（fence 不命中）`);
    }
    const pub = getPublicationRow(db, options.publicationId);
    if (pub.subject_type === 'legacy_cutover_publish' || pub.subject_type === 'legacy_cutover_existing') {
      const lve = db
        .prepare(
          `UPDATE legacy_adapter_voice_entries
              SET mapping_status='mapped_verified', pending_publication_id=NULL, candidate_source_selector=NULL
            WHERE id=? AND mapping_status='mapping_pending' AND pending_publication_id=?`,
        )
        .run(pub.subject_id, options.publicationId);
      if (lve.changes !== 1) {
        throw new RegistryContractError(LEGACY_ROLLBACK_MISMATCH, `legacy entry ${pub.subject_id} rollback 不匹配（整事务回滚）`);
      }
    }
  });
  tx.immediate();
}

// ── P1-A：fenced renew helper（每个 HTTP 副作用前） ──

export function renewPublicationOrThrow(db: Db, publicationId: string, ownerToken: string, attempt: number, stepName: string): void {
  if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${publicationId} lease 过期/被接管（${stepName} 前）`);
  }
}

// ── 编排：T3→T4→T5 ──

export type ActivationOutcome =
  | {kind: 'active'; publicationId: string; generation: number}
  | {kind: 'already_active'; publicationId: string; generation: number}
  | {kind: 'reload_retryable'; publicationId: string; generation: number; detail: string}
  | {kind: 'reload_result_unknown'; publicationId: string; generation: number; detail: string}
  | {kind: 'already_in_flight'; publicationId: string; generation: number; status: 'file_durable' | 'activation_pending'}
  | {kind: 'indeterminate'; publicationId: string; generation: number; detail: string}
  | {kind: 'registry_state_unknown'; publicationId: string; generation: number; detail: string}
  | {kind: 'failed'; publicationId: string; generation: number; errorCode: string; errorMessage: string};

export interface ActivateRegistryPublicationOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  paths: ActiveRegistryPaths;
  adapter: AdapterClient;
}

/**
 * 完整 T3→T4→T5 编排。
 * reload 结果不确定（file_durable 阶段）：不进入 indeterminate——保持 file_durable，
 * 执行一次 fenced registry-status 观察（candidate→pending+T5；stable→reload_retryable；
 * unknown/status 不可用→reload_result_unknown 保持 file_durable 等 recovery）。
 * poll 阶段（activation_pending）结果不确定 → enterIndeterminateFenced(from=activation_pending)。
 */
export async function activateRegistryPublicationFlow(
  db: Db,
  options: ActivateRegistryPublicationOptions,
): Promise<ActivationOutcome> {
  const {publicationId, ownerToken, attempt, paths, adapter} = options;
  const pub = getPublicationRow(db, publicationId);
  if (pub.status === 'active') {
    return {kind: 'already_active', publicationId, generation: pub.generation};
  }
  if (pub.status === 'building' || pub.status === 'candidate_persisted') {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${publicationId} 状态 ${pub.status} 不可激活（应先到 file_durable）`);
  }
  if (pub.status === 'indeterminate') {
    throw new RegistryContractError(ACTIVATION_INVALID_STATE, `publication ${publicationId} indeterminate 必须走 reconciliation`);
  }
  if (pub.status !== 'file_durable' && pub.status !== 'activation_pending') {
    throw new RegistryContractError(ACTIVATION_INVALID_STATE, `publication ${publicationId} 状态 ${pub.status} 不可激活`);
  }

  // T3 promote（含前置 renew + disk triage + stable snapshot）
  await promoteCandidateToActive(db, publicationId, ownerToken, attempt, paths);

  // T3 reload（前置 renew）
  renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'reload');
  const reload = await adapter.reload();
  if (reload.kind === 'rejected') {
    return {kind: 'reload_retryable', publicationId, generation: pub.generation, detail: `reload rejected HTTP ${reload.httpStatus}${reload.errorCode ? ` ${reload.errorCode}` : ''}`};
  }
  if (reload.kind === 'network_error' || reload.kind === 'invalid') {
    // P0-B：file_durable 阶段 reload 不确定 → 保持 file_durable，一次 fenced status 观察
    return observeAfterUncertainReload(db, publicationId, ownerToken, attempt, paths, adapter, pub.generation, reload.error);
  }

  // T4 mark activation_pending（file_durable → activation_pending）
  const afterReload = getPublicationRow(db, publicationId);
  if (afterReload.status === 'file_durable') {
    markActivationPending(db, publicationId, ownerToken, attempt);
  }

  // T4 poll（前置 renew）
  renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'registry-status poll');
  const statusRes = await adapter.registryStatus();
  if (statusRes.kind === 'network_error' || statusRes.kind === 'invalid') {
    // activation_pending 阶段结果不确定 → fenced indeterminate（唯一合法入口）
    enterIndeterminateFenced(db, {
      publicationId,
      ownerToken,
      attempt,
      fromStatus: 'activation_pending',
      errorCode: REGISTRY_STATE_UNKNOWN,
      errorMessage: statusRes.error,
    });
    return {kind: 'indeterminate', publicationId, generation: pub.generation, detail: statusRes.error};
  }

  const current = getPublicationRow(db, publicationId);
  const verdict = classifyAdapterStatus(statusRes.status, current);
  if (verdict === 'candidate') {
    activateRegistryPublication(db, {
      publicationId,
      ownerToken,
      attempt,
      observedActiveRegistrySha256: current.candidate_registry_sha256 as string,
    });
    return {kind: 'active', publicationId, generation: current.generation};
  }
  if (verdict === 'stable') {
    return {kind: 'reload_retryable', publicationId, generation: current.generation, detail: 'adapter loaded identity == stable（reload 未生效/LKG）'};
  }
  return {kind: 'registry_state_unknown', publicationId, generation: current.generation, detail: 'adapter loaded identity 既非 candidate 也非 stable'};
}

/** P0-B：reload 不确定后的 fenced status 观察（publication 保持 file_durable）。 */
async function observeAfterUncertainReload(
  db: Db,
  publicationId: string,
  ownerToken: string,
  attempt: number,
  paths: ActiveRegistryPaths,
  adapter: AdapterClient,
  generation: number,
  reloadError: string,
): Promise<ActivationOutcome> {
  // 不进入 indeterminate；保持 file_durable。执行一次 fenced registry-status 观察。
  try {
    renewPublicationOrThrow(db, publicationId, ownerToken, attempt, 'uncertain-reload status observation');
  } catch {
    return {kind: 'reload_result_unknown', publicationId, generation, detail: `reload ${reloadError}; owner lease 已失效——保持 file_durable 等 recovery`};
  }
  const statusRes = await adapter.registryStatus();
  if (statusRes.kind !== 'ok') {
    return {kind: 'reload_result_unknown', publicationId, generation, detail: `reload ${reloadError}; status 不可用——保持 file_durable 等 recovery`};
  }
  const current = getPublicationRow(db, publicationId);
  if (current.status !== 'file_durable') {
    return {kind: 'reload_result_unknown', publicationId, generation, detail: 'publication 状态已变化（保持现状）'};
  }
  const verdict = classifyAdapterStatus(statusRes.status, current);
  if (verdict === 'candidate') {
    // adapter 已加载 candidate → 可继续 pending + T5
    markActivationPending(db, publicationId, ownerToken, attempt);
    activateRegistryPublication(db, {
      publicationId,
      ownerToken,
      attempt,
      observedActiveRegistrySha256: current.candidate_registry_sha256 as string,
    });
    return {kind: 'active', publicationId, generation: current.generation};
  }
  if (verdict === 'stable') {
    return {kind: 'reload_retryable', publicationId, generation, detail: 'reload 结果不确定但 adapter 仍 stable——保持 file_durable 可重试'};
  }
  return {kind: 'reload_result_unknown', publicationId, generation, detail: 'reload 结果不确定且 loaded identity unknown——保持 file_durable 等 recovery'};
}

// ── Crash reconciliation ──

export interface RegistryRecoveryDeps {
  db: Db;
  paths: ActiveRegistryPaths;
  adapter: AdapterClient;
  build: Omit<PublishRegistryCandidateOptions['build'], 'publication'>;
}

function canonicalResolutionEvidence(publicationId: string, generation: number, observedSha: string): {evidence: string; hash: string} {
  const canonical = JSON.stringify({
    publicationId,
    generation,
    observedActiveRegistrySha256: observedSha,
    evidenceKind: 'indeterminate_reconciliation',
    evidenceTime: nowIso(),
  });
  return {evidence: canonical, hash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')};
}

async function reconcileIndeterminate(db: Db, pub: PublicationRow, deps: RegistryRecoveryDeps): Promise<'resolved_active' | 'resolved_failed' | 'kept'> {
  if (pub.indeterminate_from_status !== 'activation_pending') {
    return 'kept';
  }
  // 只读 registry-status（indeterminate 无 owner/lease，允许观察；不产生 owner 路径副作用）
  const statusRes = await deps.adapter.registryStatus();
  if (statusRes.kind !== 'ok') {
    return 'kept';
  }
  const loaded = statusRes.status;
  const candidateMatch =
    loaded.ready === true &&
    loaded.schemaVersion === PUBLISHER_REGISTRY_SCHEMA_VERSION &&
    loaded.loadedRegistrySha256 === pub.candidate_registry_sha256 &&
    loaded.loadedRegistryGeneration === pub.generation &&
    loaded.publisherSchemaVersion === SUPPORTED_PUBLISHER_SCHEMA_VERSION;
  if (candidateMatch && pub.candidate_registry_sha256) {
    const {evidence, hash} = canonicalResolutionEvidence(pub.id, pub.generation, pub.candidate_registry_sha256);
    reconcileIndeterminateActivation(db, {
      publicationId: pub.id,
      observedActiveRegistrySha256: pub.candidate_registry_sha256,
      resolutionEvidence: evidence,
      resolutionEvidenceHash: hash,
    });
    return 'resolved_active';
  }
  if (loaded.loadedRegistrySha256 === pub.stable_registry_sha256) {
    // adapter 明确仍 stable。indeterminate 无 owner——不得执行 reload/restore 副作用（P1-A）；
    // 仅当 active disk 也已 stable（无任何文件/HTTP 副作用需要）时允许显式 failed，
    // 否则保持 indeterminate（不得出现 failed + adapter stable + disk candidate）。
    // R2 P0-2：failed 必须走 atomic legacy rollback helper（单事务；legacy 不命中整事务回滚）。
    const disk = await readActiveRegistryFile(deps.paths);
    if (disk !== null && disk.sha === pub.stable_registry_sha256) {
      resolveIndeterminateFailedAndRollbackLegacy(db, {
        publicationId: pub.id,
        attempt: pub.attempt,
        errorCode: REGISTRY_STATE_UNKNOWN,
        errorMessage: 'indeterminate resolved failed: disk+adapter stable',
      });
      return 'resolved_failed';
    }
    return 'kept'; // disk 仍 candidate——无法安全 failed，保持 indeterminate（人工/后续裁决）
  }
  return 'kept';
}

async function reconcileActivationPending(db: Db, pub: PublicationRow, deps: RegistryRecoveryDeps): Promise<ActivationOutcome> {
  if (pub.lease_expires_at_epoch_ms !== null && pub.lease_expires_at_epoch_ms >= dbNowMs(db)) {
    return {kind: 'already_in_flight', publicationId: pub.id, generation: pub.generation, status: 'activation_pending'};
  }
  const taken = takeoverExpiredPublication(db, pub.id);
  if (taken.kind !== 'taken') return {kind: 'already_in_flight', publicationId: pub.id, generation: pub.generation, status: 'activation_pending'};
  const fresh = getPublicationRow(db, pub.id);
  const {ownerToken, attempt} = taken.handle;

  // P1-A：每个 HTTP 前 fenced renew
  renewPublicationOrThrow(db, pub.id, ownerToken, attempt, 'recovery status');
  const statusRes = await deps.adapter.registryStatus();
  if (statusRes.kind !== 'ok') {
    return {kind: 'reload_result_unknown', publicationId: pub.id, generation: fresh.generation, detail: statusRes.error};
  }
  const verdict = classifyAdapterStatus(statusRes.status, fresh);
  if (verdict === 'candidate') {
    activateRegistryPublication(db, {
      publicationId: pub.id,
      ownerToken,
      attempt,
      observedActiveRegistrySha256: fresh.candidate_registry_sha256 as string,
    });
    return {kind: 'active', publicationId: pub.id, generation: fresh.generation};
  }
  if (verdict === 'stable') {
    // 受控重试 reload（一次）→ 仍 stable → reload_retryable
    renewPublicationOrThrow(db, pub.id, ownerToken, attempt, 'recovery reload');
    const reload = await deps.adapter.reload();
    if (reload.kind === 'ok') {
      renewPublicationOrThrow(db, pub.id, ownerToken, attempt, 'recovery reload ack');
      const again = await deps.adapter.registryStatus();
      if (again.kind === 'ok' && classifyAdapterStatus(again.status, fresh) === 'candidate') {
        activateRegistryPublication(db, {
          publicationId: pub.id,
          ownerToken,
          attempt,
          observedActiveRegistrySha256: fresh.candidate_registry_sha256 as string,
        });
        return {kind: 'active', publicationId: pub.id, generation: fresh.generation};
      }
    }
    return {kind: 'reload_retryable', publicationId: pub.id, generation: fresh.generation, detail: 'recovery: adapter 仍 stable'};
  }
  return {kind: 'registry_state_unknown', publicationId: pub.id, generation: fresh.generation, detail: 'recovery: loaded identity unknown'};
}

/**
 * 单轮 publication 恢复。failed/cancelled 前（P0-C）：若 disk 已提升 candidate，先
 * restoreStableAndConfirm（restore + reload + ack）；不确定 → 保持现状（rollback_pending/unknown）。
 */
export async function recoverOnePublication(
  db: Db,
  publicationId: string,
  deps: RegistryRecoveryDeps,
): Promise<ActivationOutcome> {
  const pub = getPublicationRow(db, publicationId);

  if (pub.status === 'indeterminate') {
    const outcome = await reconcileIndeterminate(db, pub, deps);
    if (outcome === 'resolved_active') return {kind: 'active', publicationId: pub.id, generation: pub.generation};
    if (outcome === 'resolved_failed') return {kind: 'failed', publicationId: pub.id, generation: pub.generation, errorCode: REGISTRY_STATE_UNKNOWN, errorMessage: 'indeterminate resolved failed'};
    return {kind: 'registry_state_unknown', publicationId: pub.id, generation: pub.generation, detail: 'indeterminate kept（无法确认 identity）'};
  }

  if (pub.status === 'activation_pending') {
    return reconcileActivationPending(db, pub, deps);
  }

  // building / candidate_persisted / file_durable
  if (pub.lease_expires_at_epoch_ms !== null && pub.lease_expires_at_epoch_ms >= dbNowMs(db)) {
    return {kind: 'already_in_flight', publicationId: pub.id, generation: pub.generation, status: 'file_durable'};
  }
  const taken = takeoverExpiredPublication(db, pub.id);
  if (taken.kind !== 'taken') {
    return {kind: 'already_in_flight', publicationId: pub.id, generation: pub.generation, status: 'file_durable'};
  }
  const pubResult = await publishRegistryCandidate(db, {
    subject: {subjectType: pub.subject_type, subjectId: pub.subject_id, subjectMode: pub.subject_mode},
    stableRegistrySha256: pub.stable_registry_sha256,
    handle: taken.handle,
    build: deps.build,
  });
  void pubResult;
  const after = getPublicationRow(db, publicationId);
  if (after.status === 'file_durable' || after.status === 'activation_pending') {
    return activateRegistryPublicationFlow(db, {
      publicationId,
      ownerToken: taken.handle.ownerToken,
      attempt: taken.handle.attempt,
      paths: deps.paths,
      adapter: deps.adapter,
    });
  }
  if (after.status === 'active') return {kind: 'active', publicationId, generation: after.generation};
  return {kind: 'failed', publicationId, generation: after.generation, errorCode: after.error_code ?? 'RECOVERY_STOPPED', errorMessage: after.error_message ?? 'recovery 未推进'};
}

/** 单轮 sweep 结果：handled = 实际处理的 publication 数；errors = 逐条隔离的错误（不阻断其余）。 */
export interface RegistryRecoveryRunResult {
  handled: number;
  errors: string[];
}

export async function recoverRegistryPublications(
  db: Db,
  deps: RegistryRecoveryDeps,
  limit = 10,
): Promise<RegistryRecoveryRunResult> {
  const rows = db
    .prepare(
      `SELECT id FROM voice_registry_publications
        WHERE status IN ('building','candidate_persisted','file_durable','activation_pending','indeterminate')
        ORDER BY generation ASC LIMIT ?`,
    )
    .all(limit) as Array<{id: string}>;
  const errors: string[] = [];
  for (const {id} of rows) {
    try {
      await recoverOnePublication(db, id, deps);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${id}: ${msg.slice(0, 200)}`);
    }
  }
  return {handled: rows.length, errors};
}

/**
 * TTS-C.1B.3 registry activation / acknowledgment / atomic activation / recovery。
 *
 * 范围（frozen §7.3 T3/T4/T5、§D crash reconciliation、1B.3 计划 §E/§K）：
 *   - T3：active registry 原子提升（temp→fsync→rename→dir fsync→reread 验证；fixed path 原则——
 *     adapter /reload 只读自身配置路径，publisher 把 durable candidate 的**相同 bytes**提升到
 *     active registry 文件路径）+ adapter POST /reload（内部 client，不传 path）。
 *   - T4：markActivationPending（file_durable→activation_pending，fenced）+ GET /registry-status
 *     acknowledgment（唯一观察面；必须同时匹配 ready/sha/generation/publisherSchemaVersion/
 *     schemaVersion，只匹配 SHA 不足）。
 *   - T5：唯一 atomic activation command（INSERT voice_registry_publication_activations，
 *     normal_owner_finalize / indeterminate_reconciliation 双 mode）；应用层禁止直接 UPDATE
 *     projection/legacy/publication 到 active。
 *   - Lease takeover CAS（过期 attempt+1 换主；indeterminate 不 takeover）。
 *   - Crash reconciliation（CC-1…CC-6 按 frozen journal 状态逐状态推进）。
 *
 * 明确不做：新 DB 表/migration/trigger、TTS-C.1C.2、TTS-C.2、真实 synthesis、
 * production 部署/拓扑/env 修改。
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
  markFileDurable,
  failPublication,
  publishRegistryCandidate,
  PUBLICATION_LEASE_MS,
  PUBLICATION_NOT_OWNER,
  PUBLICATION_LEASE_EXPIRED,
  PUBLICATION_INVALID_STATE,
  CANDIDATE_FILE_IO,
  type PublicationRow,
  type PublicationStatusDto,
  type PublishRegistryCandidateOptions,
} from './registry-publisher';
import {dbNowMs, nowIso} from './materialization';
import {AdapterClient, REGISTRY_STATE_UNKNOWN, type AdapterRegistryStatus} from './adapter-client';
import {OPEN_FLAGS, stagingTempPath} from './paths';

export {AdapterClient, REGISTRY_STATE_UNKNOWN, type AdapterRegistryStatus}; // REGISTRY_STATE_UNKNOWN 来自 adapter-client

export const ACTIVATION_CONFLICT = 'ACTIVATION_CONFLICT';
export const ACTIVATION_INVALID_STATE = 'ACTIVATION_INVALID_STATE';

// ── 路径配置 ──

export interface ActiveRegistryPaths {
  /** 配置的 active registry 文件绝对路径（adapter 固定配置路径的宿主/worker 侧对应）。 */
  activeRegistryPath: string;
  /** active registry 所在目录（containment root；非 symlink + realpath 固定）。 */
  activeRegistryRoot: string;
}

// ── T3：active disk 状态裁决 + 原子提升 ──

export type DiskActiveState = 'stable' | 'candidate' | 'unknown';

async function readActiveRegistryFile(paths: ActiveRegistryPaths): Promise<{sha: string; bytes: Buffer} | null> {
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

/**
 * Disk-state 裁决（frozen §6.3）：
 *   active disk SHA == stable → 可原子提升 candidate；
 *   active disk SHA == candidate → 幂等（不重写）；
 *   既非 stable 也非 candidate（含缺失）→ unknown：不覆盖、不 reload、不 activation。
 */
export async function classifyActiveDiskState(
  db: Db,
  publicationId: string,
  paths: ActiveRegistryPaths,
): Promise<{state: DiskActiveState; activeSha: string | null}> {
  const pub = getPublicationRow(db, publicationId);
  const read = await readActiveRegistryFile(paths);
  if (!read) return {state: 'unknown', activeSha: null};
  if (pub.stable_registry_sha256 === read.sha) return {state: 'stable', activeSha: read.sha};
  if (pub.candidate_registry_sha256 !== null && pub.candidate_registry_sha256 === read.sha) {
    return {state: 'candidate', activeSha: read.sha};
  }
  return {state: 'unknown', activeSha: read.sha};
}

async function ensureActiveRootSafe(rootAbs: string): Promise<string> {
  let st: fs.Stats;
  try {
    st = await fsPromises.lstat(rootAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry root 缺失: ${rootAbs}`);
    }
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry root 不可 stat: ${rootAbs}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry root 是 symlink 或非目录');
  }
  const real = await fsPromises.realpath(rootAbs);
  if (real !== path.resolve(rootAbs)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry root realpath 漂移（symlink 逃逸）');
  }
  return real;
}

/**
 * 读取 durable candidate 文件（exact bytes；candidate immutable 文件绝不删除/修改）。
 */
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

/**
 * 原子提升 durable candidate → active registry（相同 bytes；temp 同目录 → fsync → rename →
 * dir fsync → reread 验证 SHA/1.1/generation/publisherSchemaVersion）。
 * disk 已 candidate → 幂等（不重写）；disk unknown → REGISTRY_STATE_UNKNOWN（不覆盖）。
 */
export async function promoteCandidateToActive(
  db: Db,
  publicationId: string,
  ownerToken: string,
  attempt: number,
  paths: ActiveRegistryPaths,
): Promise<'promoted' | 'idempotent'> {
  // T1.5：外部副作用前 fenced renew
  if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${publicationId} lease 过期/被接管（promote 前）`);
  }
  const pub = getPublicationRow(db, publicationId);
  if (pub.status !== 'file_durable' && pub.status !== 'activation_pending') {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${publicationId} 状态 ${pub.status} 不可 promote`);
  }
  const bytes = await readDurableCandidateBytes(db, publicationId);

  const disk = await classifyActiveDiskState(db, publicationId, paths);
  if (disk.state === 'unknown') {
    throw new RegistryContractError(
      REGISTRY_STATE_UNKNOWN,
      `active registry disk SHA 既非 stable 也非 candidate（${disk.activeSha ?? 'missing'}）——不覆盖不 reload`,
    );
  }
  if (disk.state === 'candidate') return 'idempotent';

  // stable → 原子提升
  const root = await ensureActiveRootSafe(paths.activeRegistryRoot);
  const finalAbs = path.resolve(paths.activeRegistryPath);
  if (!finalAbs.startsWith(root + path.sep)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'active registry final path 越出 root');
  }
  const tempAbs = stagingTempPath(finalAbs);
  let fh: fsPromises.FileHandle | null = null;
  try {
    fh = await fsPromises.open(tempAbs, OPEN_FLAGS.tempCreate, 0o640);
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = null;
    await fsPromises.rename(tempAbs, finalAbs);
    // 统一 acceptance：final fsync + dir fsync + reread（SHA/length/1.1/generation/publisherSchemaVersion）
    await durabilizeAndVerifyCandidate({
      rootDir: root,
      finalPath: finalAbs,
      expectedSha256: pub.candidate_registry_sha256 as string,
      expectedLength: bytes.length,
      expectedGeneration: pub.generation,
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
    throw new RegistryContractError(CANDIDATE_FILE_IO, `active registry 提升失败: ${(err as Error).message}`);
  }
  return 'promoted';
}

// ── T4：activation_pending + acknowledgment ──

/** file_durable → activation_pending（fenced：owner/attempt/lease exact；activation_requested_at=now）。 */
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

/**
 * Acknowledgment 裁决：必须同时匹配
 * ready==true + schemaVersion=="1.1" + loadedRegistrySha256==candidate +
 * loadedRegistryGeneration==generation + publisherSchemaVersion==SUPPORTED —— 只匹配 SHA 不足。
 */
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

// ── T5：唯一 atomic activation command ──

export interface ActivationCommandOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  observedActiveRegistrySha256: string;
}

/**
 * Normal owner finalize：单条 INSERT voice_registry_publication_activations
 * （normal_owner_finalize）。frozen trigger 在同一 statement 内原子完成
 * projection→published_usable / legacy→mapped_active / publication→active；
 * 任一 ABORT → 整条 statement 回滚（无部分提交）。
 */
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

/**
 * Indeterminate reconciliation（仅 indeterminate_from_status='activation_pending' 且 adapter
 * loaded identity == persisted candidate）：owner NULL、attempt = publication.attempt 精确、
 * resolution_evidence + hash 必填。不得在 reconciliation 时首次填写 candidate/manifest/
 * file/activation evidence（frozen seal 拒绝）。
 */
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

/**
 * Fenced takeover CAS：status IN (building,candidate_persisted,file_durable,activation_pending)
 * 且 lease_expires_at_epoch_ms < DB_NOW_MS；成功 = 新 owner token + attempt=old+1 + 新 lease。
 * changes=1 才获得恢复 ownership；indeterminate 不 takeover（显式 reconciliation）。
 */
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

// ── 编排：T3→T4→T5 ──

export type ActivationOutcome =
  | {kind: 'active'; publicationId: string; generation: number}
  | {kind: 'already_active'; publicationId: string; generation: number}
  | {kind: 'reload_retryable'; publicationId: string; generation: number; detail: string}
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

function enterIndeterminate(db: Db, publicationId: string, fromStatus: 'file_durable' | 'activation_pending'): void {
  const now = nowIso();
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET status='indeterminate', indeterminate_from_status=?, owner_token=NULL,
              lease_expires_at_epoch_ms=NULL, updated_at=?
        WHERE id=? AND status=? AND indeterminate_from_status IS NULL`,
    )
    .run(fromStatus, now, publicationId, fromStatus);
  if (res.changes !== 1) {
    throw new RegistryContractError(ACTIVATION_INVALID_STATE, `publication ${publicationId} 无法进入 indeterminate`);
  }
}

/**
 * 完整 T3→T4→T5 编排（frozen 顺序）：
 * renew → promote(active) → renew → reload → mark activation_pending → renew → poll/classify →
 *   candidate → T5 atomic activation → active
 *   stable → reload_retryable（不 activation；状态保持 file_durable/activation_pending）
 *   unknown → registry_state_unknown（不 activation 不修改 projection/legacy）
 *   reload/poll 网络结果不确定 → indeterminate（frozen evidence shape 允许时）
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

  // T3 promote（含前置 renew + disk triage）
  await promoteCandidateToActive(db, publicationId, ownerToken, attempt, paths);

  // T3 reload（前置 renew）
  if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${publicationId} lease 过期（reload 前）`);
  }
  const reload = await adapter.reload();
  if (reload.kind === 'rejected') {
    // adapter 明确拒绝（LKG）：保持既有可恢复状态，不 activation
    return {kind: 'reload_retryable', publicationId, generation: pub.generation, detail: `reload rejected HTTP ${reload.httpStatus}${reload.errorCode ? ` ${reload.errorCode}` : ''}`};
  }
  if (reload.kind === 'network_error') {
    // 外部副作用结果无法判断 → indeterminate（frozen evidence shape）
    enterIndeterminate(db, publicationId, pub.status === 'activation_pending' ? 'activation_pending' : 'file_durable');
    return {kind: 'indeterminate', publicationId, generation: pub.generation, detail: reload.error};
  }
  if (reload.kind === 'invalid') {
    enterIndeterminate(db, publicationId, pub.status === 'activation_pending' ? 'activation_pending' : 'file_durable');
    return {kind: 'indeterminate', publicationId, generation: pub.generation, detail: reload.error};
  }

  // T4 mark activation_pending（仅 file_durable → activation_pending；已是 activation_pending 跳过）
  const afterReload = getPublicationRow(db, publicationId);
  if (afterReload.status === 'file_durable') {
    markActivationPending(db, publicationId, ownerToken, attempt);
  }

  // T4 poll（前置 renew）
  if (!renewPublicationLease(db, publicationId, ownerToken, attempt)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${publicationId} lease 过期（poll 前）`);
  }
  const statusRes = await adapter.registryStatus();
  if (statusRes.kind === 'network_error' || statusRes.kind === 'invalid') {
    enterIndeterminate(db, publicationId, 'activation_pending');
    return {kind: 'indeterminate', publicationId, generation: pub.generation, detail: statusRes.error};
  }

  const current = getPublicationRow(db, publicationId);
  const verdict = classifyAdapterStatus(statusRes.status, current);
  if (verdict === 'candidate') {
    // T5 atomic activation
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
    // 非 activation_pending 来源的 indeterminate 不得 resolve active——保持，人工/后续裁决
    return 'kept';
  }
  const statusRes = await deps.adapter.registryStatus();
  if (statusRes.kind !== 'ok') {
    // 无法确认 → 保持 indeterminate（REGISTRY_STATE_UNKNOWN 语义），零状态修改
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
    // adapter 明确仍 stable：indeterminate → failed（frozen 显式裁决；无 owner fence——indeterminate 无 owner）
    const now = nowIso();
    const res = db
      .prepare(
        `UPDATE voice_registry_publications
            SET status='failed', failed_at=?, error_code=?, error_message=?, updated_at=?
          WHERE id=? AND status='indeterminate'`,
      )
      .run(now, REGISTRY_STATE_UNKNOWN, 'indeterminate resolved failed: adapter loaded stable', now, pub.id);
    if (res.changes !== 1) throw new RegistryContractError(ACTIVATION_INVALID_STATE, 'indeterminate failed resolve 失败');
    return 'resolved_failed';
  }
  return 'kept';
}

async function reconcileActivationPending(db: Db, pub: PublicationRow, deps: RegistryRecoveryDeps): Promise<ActivationOutcome> {
  // lease 有效 → 在飞 winner，跳过
  if (pub.lease_expires_at_epoch_ms !== null && pub.lease_expires_at_epoch_ms >= dbNowMs(db)) {
    return {kind: 'already_in_flight', publicationId: pub.id, generation: pub.generation, status: 'activation_pending'};
  }
  const taken = takeoverExpiredPublication(db, pub.id);
  if (taken.kind !== 'taken') return {kind: 'already_in_flight', publicationId: pub.id, generation: pub.generation, status: 'activation_pending'};
  const fresh = getPublicationRow(db, pub.id);
  // poll classify
  const statusRes = await deps.adapter.registryStatus();
  if (statusRes.kind !== 'ok') {
    return {kind: 'indeterminate', publicationId: pub.id, generation: pub.generation, detail: statusRes.error};
  }
  const verdict = classifyAdapterStatus(statusRes.status, fresh);
  if (verdict === 'candidate') {
    activateRegistryPublication(db, {
      publicationId: pub.id,
      ownerToken: taken.handle.ownerToken,
      attempt: taken.handle.attempt,
      observedActiveRegistrySha256: fresh.candidate_registry_sha256 as string,
    });
    return {kind: 'active', publicationId: pub.id, generation: fresh.generation};
  }
  if (verdict === 'stable') {
    // 受控重试 reload（一次）→ 仍 stable → reload_retryable
    const reload = await deps.adapter.reload();
    if (reload.kind === 'ok') {
      const again = await deps.adapter.registryStatus();
      if (again.kind === 'ok' && classifyAdapterStatus(again.status, fresh) === 'candidate') {
        activateRegistryPublication(db, {
          publicationId: pub.id,
          ownerToken: taken.handle.ownerToken,
          attempt: taken.handle.attempt,
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
 * 单轮 publication 恢复（一条坏 publication 异常由调用方隔离——见 controller）。
 * 状态推进：
 *   building / candidate_persisted / file_durable（lease 过期）→ takeover →
 *     publishRegistryCandidate(handle)（1B.2 编排到 file_durable）→ activateRegistryPublicationFlow
 *   activation_pending（lease 过期）→ takeover → poll classify → T5 / retry reload / unknown
 *   indeterminate → 显式 reconciliation（from activation_pending 且 loaded==candidate）/
 *     loaded==stable → failed / unknown → 保持
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
  // 续跑 1B.2 编排到 file_durable（幂等；building/candidate_persisted/file_durable 均可续）
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

/** 周期 sweep 入口：扫描 active-flight publications，逐条隔离恢复（单条异常不阻断其余）。 */
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

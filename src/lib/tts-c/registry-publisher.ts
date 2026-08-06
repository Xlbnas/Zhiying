/**
 * TTS-C.1B.2 registry publisher——T1 claim / candidate 确定性构建 / T2 file_durable 持久化。
 *
 * 范围（docs/TTS_C_1B_1C_EXECUTION_PLAN.md §C 步骤 1-3，frozen §7.3 T1/T1.5/T2）：
 *   - T1：BEGIN IMMEDIATE 内 INSERT voice_registry_publications(status='building',
 *     generation=BEGIN IMMEDIATE 下 SELECT COALESCE(MAX(generation),0)+1 单调分配, subject 四态冻结,
 *     stable_registry_sha256, publisher_schema_version, owner_token=UUID, lease=DB_NOW_MS+LEASE, attempt=1)；
 *     legacy_cutover subject 同事务 entry mapped_verified→mapping_pending
 *     （pending_publication_id + candidate_source_selector='tts_a'）。
 *   - T1.5：fenced verify/renew（owner_token + attempt + lease >= DB_NOW_MS 精确比对）。
 *   - candidate：stable view（frozen §7.1 投影规则）全量确定性重建 + subject key 换入；
 *     1.1 文档（schemaVersion/registryGeneration/publisherSchemaVersion）；canonical JSON；
 *     registry SHA = 最终原始 bytes 单一 SHA-256；manifest 逐 key 记录
 *     emitted source / source row id / reference SHA / adapter key。
 *   - T2：先 DB（building→candidate_persisted，evidence 一次写入）后文件
 *     （temp O_EXCL→write→fsync→rename→dir fsync→reread 复算 SHA→JSON/generation 复核），
 *     再 DB（candidate_persisted→file_durable，file_durable_at）。
 *
 * 明确不做：adapter reload（T3）、activation acknowledgment（T4）、atomic activation（T5）、
 * recovery/reconciler（1B.3）、production registry 写入、production 部署。
 * 不引入 capability/WeakMap authority；无新 hash 层；不新增表/trigger。
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Db} from '../db';
import {getDataDir} from '../db';
import {
  PUBLISHER_REGISTRY_SCHEMA_VERSION,
  SUPPORTED_PUBLISHER_SCHEMA_VERSION,
  parseAndValidateRegistry,
  serializePublisherRegistry,
  sha256Bytes,
  canonicalVoiceKey,
  type PublisherRegistryDoc,
  type RegistryVoiceEntry,
} from './registry-schema';
import {RegistryContractError} from './registry-contract-error';
import {dbNowMs, nowIso} from './materialization';
import {verifyReferenceFile} from './legacy-import';
import {validateMaterializedFileSnapshot} from './materialized-file-validator';
import {OPEN_FLAGS, stagingTempPath} from './paths';

export const PUBLICATION_LEASE_MS = 15 * 60 * 1000; // 与 1A generation lease 15min 对齐
export const PUBLISHER_SCHEMA_VERSION = SUPPORTED_PUBLISHER_SCHEMA_VERSION;
/** publisher candidate registry 根目录（dataDir 下；temp→rename 原子写，同目录）。 */
export const REGISTRY_CANDIDATE_ROOT_DIR = 'voice-registries';
export const CANDIDATE_FILENAME_TEMPLATE = 'candidate-<generation>.json';

export const PUBLICATION_SUBJECT_TYPES = [
  'materialization_publish',
  'legacy_cutover_publish',
  'legacy_cutover_existing',
  'registry_rebuild',
] as const;
export const PUBLICATION_SUBJECT_MODES = ['publish_and_cutover', 'cutover_existing', 'none'] as const;
export type PublicationSubjectType = (typeof PUBLICATION_SUBJECT_TYPES)[number];
export type PublicationSubjectMode = (typeof PUBLICATION_SUBJECT_MODES)[number];
export type PublicationStatus =
  | 'building'
  | 'candidate_persisted'
  | 'file_durable'
  | 'activation_pending'
  | 'active'
  | 'failed'
  | 'indeterminate'
  | 'cancelled';

export interface PublicationSubject {
  subjectType: PublicationSubjectType;
  subjectId: string;
  subjectMode: PublicationSubjectMode;
}

export interface PublicationRow {
  id: string;
  generation: number;
  subject_type: PublicationSubjectType;
  subject_id: string;
  subject_mode: PublicationSubjectMode;
  stable_registry_sha256: string;
  candidate_registry_sha256: string | null;
  candidate_manifest_json: string | null;
  candidate_manifest_sha256: string | null;
  publisher_schema_version: string;
  status: PublicationStatus;
  owner_token: string | null;
  lease_expires_at_epoch_ms: number | null;
  attempt: number;
  file_durable_at: string | null;
  activation_requested_at: string | null;
  activated_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  indeterminate_from_status: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 普通 publication status DTO（R1 P0-A 最小收窄）——不含 owner_token。
 * already_in_flight 只返回此形状，调用方无法读取/误用 owner token。
 * 字段保持 snake_case 与 DB 一致，避免重构 publication API。
 */
export interface PublicationStatusDto {
  id: string;
  generation: number;
  status: PublicationStatus;
  subject_type: PublicationSubjectType;
  subject_id: string;
  subject_mode: PublicationSubjectMode;
  candidate_registry_sha256: string | null;
}

export type ClaimResult =
  | {kind: 'claimed'; publication: PublicationRow}
  | {kind: 'already_in_flight'; publication: PublicationStatusDto};

export interface ClaimOptions {
  subject: PublicationSubject;
  stableRegistrySha256: string;
  /** 默认 SUPPORTED_PUBLISHER_SCHEMA_VERSION（唯一合法值）。 */
  publisherSchemaVersion?: string;
  leaseMs?: number;
}

export interface CandidateEntry {
  key: string;
  emittedSource: 'legacy' | 'materialization';
  sourceRowId: string;
  voice: RegistryVoiceEntry;
}

export interface CandidateManifest {
  registryGeneration: number;
  entries: Array<{
    key: string;
    emittedSource: 'legacy' | 'materialization';
    sourceRowId: string;
    voiceProfile: string;
    voiceRevision: string;
    referenceSha256: string;
    adapterKey: string;
  }>;
}

export interface CandidateBuildResult {
  registryDoc: PublisherRegistryDoc;
  registryBytes: Buffer;
  registrySha256: string;
  manifest: CandidateManifest;
  manifestJson: string;
  manifestSha256: string;
  entries: CandidateEntry[];
}

export interface BuildCandidateOptions {
  publication: PublicationRow;
  /** legacy reference 文件本机根目录（realpath containment 基准）。 */
  legacyVoiceRootDir: string;
  /** materialization projection 文件本机根目录（= dataDir/voice-materializations）。 */
  materializationRootDir: string;
  /** registry 文档内 referenceAssetPath 的 path 前缀（adapter 侧 voice root，如 /voices）。 */
  emitVoiceRootPath: string;
  /** legacy registry 路径 → 本机文件路径映射（与 import 同语义；默认直接落在 legacyVoiceRootDir 内）。 */
  resolveLegacyReferencePath?: (registryPath: string) => string;
}

export type PublishRegistryCandidateResult =
  | {
      kind: 'completed';
      publicationId: string;
      generation: number;
      status: 'file_durable';
      candidateRegistrySha256: string;
      candidateFilePath: string;
    }
  | {
      kind: 'already_in_flight';
      publicationId: string;
      generation: number;
      status: 'building' | 'candidate_persisted' | 'activation_pending' | 'indeterminate';
    }
  | {
      kind: 'already_file_durable';
      publicationId: string;
      generation: number;
      status: 'file_durable';
      candidateRegistrySha256: string;
      candidateFilePath: string;
    };

// ── 错误码（操作语义；不新增 hash/checksum 层） ──
export const PUBLICATION_CONFLICT = 'PUBLICATION_CONFLICT'; // 不同 subject active-flight 冲突
export const PUBLICATION_NOT_OWNER = 'PUBLICATION_NOT_OWNER'; // owner/attempt/lease fence 不命中
export const PUBLICATION_INVALID_STATE = 'PUBLICATION_INVALID_STATE'; // 状态不满足步骤前置
export const CANDIDATE_EVIDENCE_MISMATCH = 'CANDIDATE_EVIDENCE_MISMATCH'; // 已持久 evidence 与重算候选不一致
export const CANDIDATE_REFERENCE_MISSING = 'CANDIDATE_REFERENCE_MISSING'; // candidate 引用（DB 行/文件）缺失
export const CANDIDATE_KEY_CONFLICT = 'CANDIDATE_KEY_CONFLICT'; // 同 key 多 source / subject key 冲突
export const CANDIDATE_BYTES_CONFLICT = 'CANDIDATE_BYTES_CONFLICT'; // 同 generation 已存在不同 bytes
export const CANDIDATE_FILE_IO = 'CANDIDATE_FILE_IO'; // temp/fsync/rename/reread 故障
export const PUBLICATION_LEASE_EXPIRED = 'PUBLICATION_LEASE_EXPIRED'; // lease 过期（未接管）

// ── 路径 ──

export function candidateRegistryDir(): string {
  return path.join(getDataDir(), REGISTRY_CANDIDATE_ROOT_DIR);
}

export function candidateRegistryPath(generation: number): string {
  return path.join(candidateRegistryDir(), `candidate-${generation}.json`);
}

async function ensureCandidateRootSafe(rootAbs: string): Promise<string> {
  try {
    await fsPromises.mkdir(rootAbs, {recursive: true});
  } catch {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate root 不可创建: ${rootAbs}`);
  }
  let st: fs.Stats;
  try {
    st = await fsPromises.lstat(rootAbs);
  } catch {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate root 不可 stat: ${rootAbs}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate root 是 symlink 或非目录');
  }
  const real = await fsPromises.realpath(rootAbs);
  if (real !== path.resolve(rootAbs)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate root realpath 漂移（symlink 逃逸）');
  }
  return real;
}

// ── 行读取 ──

export function getPublicationRow(db: Db, publicationId: string): PublicationRow {
  const row = db.prepare('SELECT * FROM voice_registry_publications WHERE id = ?').get(publicationId) as
    | PublicationRow
    | undefined;
  if (!row) throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication 不存在: ${publicationId}`);
  return row;
}

// ── T1 claim ──

/**
 * T1：BEGIN IMMEDIATE 全局 reservation。
 * 并发同 subject：active single-flight UNIQUE 保证唯一 winner；同 subject 已 active → already_in_flight（复用）；
 * 不同 subject 已 active → PUBLICATION_CONFLICT。
 */
export function claimPublication(db: Db, options: ClaimOptions): ClaimResult {
  const publisherSchemaVersion = options.publisherSchemaVersion ?? PUBLISHER_SCHEMA_VERSION;
  const leaseMs = options.leaseMs ?? PUBLICATION_LEASE_MS;
  if (publisherSchemaVersion !== PUBLISHER_SCHEMA_VERSION) {
    throw new RegistryContractError('VOICE_REGISTRY_INVALID', `publisherSchemaVersion 必须 ${PUBLISHER_SCHEMA_VERSION}`);
  }

  const tx = db.transaction((): ClaimResult => {
    // 同 subject 复用检查（active-flight 内）
    const inFlight = db
      .prepare(
        `SELECT * FROM voice_registry_publications
          WHERE status IN ('building','candidate_persisted','file_durable','activation_pending','indeterminate')`,
      )
      .get() as PublicationRow | undefined;
    if (inFlight) {
      const sameSubject =
        inFlight.subject_type === options.subject.subjectType &&
        inFlight.subject_id === options.subject.subjectId &&
        inFlight.subject_mode === options.subject.subjectMode;
      if (sameSubject) {
        // R1 P0-A：already_in_flight 只返回无 owner_token 的收窄 DTO
        const dto: PublicationStatusDto = {
          id: inFlight.id,
          generation: inFlight.generation,
          status: inFlight.status,
          subject_type: inFlight.subject_type,
          subject_id: inFlight.subject_id,
          subject_mode: inFlight.subject_mode,
          candidate_registry_sha256: inFlight.candidate_registry_sha256,
        };
        return {kind: 'already_in_flight', publication: dto};
      }
      throw new RegistryContractError(
        PUBLICATION_CONFLICT,
        `active publication ${inFlight.id} (subject ${inFlight.subject_type}/${inFlight.subject_id}) 在飞，`
          + `请求 subject ${options.subject.subjectType}/${options.subject.subjectId} 冲突`,
      );
    }

    const generationRow = db.prepare('SELECT COALESCE(MAX(generation),0)+1 AS n FROM voice_registry_publications').get() as {n: number};
    const generation = generationRow.n;
    const publicationId = crypto.randomUUID();
    const ownerToken = crypto.randomUUID();
    const now = nowIso();
    const lease = dbNowMs(db) + leaseMs;

    db.prepare(
      `INSERT INTO voice_registry_publications
         (id, generation, subject_type, subject_id, subject_mode, stable_registry_sha256,
          publisher_schema_version, status, owner_token, lease_expires_at_epoch_ms, attempt,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, 1, ?, ?)`,
    ).run(publicationId, generation, options.subject.subjectType, options.subject.subjectId, options.subject.subjectMode,
      options.stableRegistrySha256, publisherSchemaVersion, ownerToken, lease, now, now);

    // legacy cutover subject：同事务 entry mapped_verified → mapping_pending
    if (options.subject.subjectType === 'legacy_cutover_publish' || options.subject.subjectType === 'legacy_cutover_existing') {
      const res = db
        .prepare(
          `UPDATE legacy_adapter_voice_entries
              SET mapping_status='mapping_pending', pending_publication_id=?, candidate_source_selector='tts_a'
            WHERE id=? AND mapping_status='mapped_verified'`,
        )
        .run(publicationId, options.subject.subjectId);
      if (res.changes !== 1) {
        // 让 trigger 的精确错误（subject invalid / 状态不匹配）优先表达；这里兜底
        throw new RegistryContractError(PUBLICATION_INVALID_STATE, `legacy entry ${options.subject.subjectId} 无法推进 mapping_pending`);
      }
    }

    const row = getPublicationRow(db, publicationId);
    return {kind: 'claimed', publication: row};
  });
  return tx.immediate();
}

// ── T1.5 fenced renew ──

/** T1.5：fenced verify/renew（owner_token + attempt + lease >= DB_NOW_MS；changes=1 必须）。 */
export function renewPublicationLease(
  db: Db,
  publicationId: string,
  ownerToken: string,
  attempt: number,
  leaseMs?: number,
): boolean {
  const lease = dbNowMs(db) + (leaseMs ?? PUBLICATION_LEASE_MS);
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET lease_expires_at_epoch_ms=?, updated_at=?
        WHERE id=? AND status IN ('building','candidate_persisted','file_durable','activation_pending')
          AND owner_token=? AND attempt=?
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(lease, nowIso(), publicationId, ownerToken, attempt);
  return res.changes === 1;
}

// ── candidate 确定性构建（纯计算；DB 只读） ──

interface LegacyEntryRow {
  id: string;
  voice_profile_key: string;
  voice_revision_key: string;
  speaker_name: string;
  reference_asset_path_or_safe_projection: string;
  reference_sha256: string;
  mapping_status: string;
  mapped_voice_materialization_id: string | null;
  pending_publication_id: string | null;
}

interface MaterializationRow {
  id: string;
  voice_profile_id: string;
  voice_profile_revision_id: string;
  source_canonical_sha256: string;
  destination_voice_root_relative_path: string;
  status: string;
  published_registry_generation: number | null;
  published_registry_sha256: string | null;
  published_by_publication_id: string | null;
}

/** resolver 只做 path translation；containment/symlink/no-follow 由 verifyReferenceFile(rootDir) 强制（R1 P1-A）。 */
function resolveLegacyLocal(registryPath: string, options: BuildCandidateOptions): string {
  if (options.resolveLegacyReferencePath) return options.resolveLegacyReferencePath(registryPath);
  return path.resolve(registryPath);
}

/** 构造并验证单个 TTS-A source 的 registry voice（projection 文件校验）。 */
async function buildMaterializationVoice(
  mat: MaterializationRow,
  revisionNumber: number,
  options: BuildCandidateOptions,
): Promise<{voice: RegistryVoiceEntry; localPath: string}> {
  const voiceProfile = mat.voice_profile_id;
  const voiceRevision = String(revisionNumber);
  const referenceAssetPath = `${options.emitVoiceRootPath}/${mat.destination_voice_root_relative_path}`;
  const voice: RegistryVoiceEntry = {
    voiceProfile,
    voiceRevision,
    speakerName: '',
    referenceAssetPath,
    referenceSha256: mat.source_canonical_sha256,
  };
  // R1 P1-A：复用现有 hardened validator（materialized-file-validator.ts）——
  // relativePath shape（uuid/uuid/reference.wav、非绝对/无 ../、无反斜杠）+ parent 逐级 symlink
  // containment + O_NOFOLLOW fd 读取 + SHA + WAV 头校验；verify 模式零 mkdir。
  await validateMaterializedFileSnapshot({
    relativePath: mat.destination_voice_root_relative_path,
    voiceProfileId: mat.voice_profile_id,
    voiceProfileRevisionId: mat.voice_profile_revision_id,
    expectedSha256: mat.source_canonical_sha256,
    adapterCompatibilityKey: 'indextts2-adapter-registry@1',
  });
  const localPath = path.resolve(options.materializationRootDir, mat.destination_voice_root_relative_path);
  return {voice, localPath};
}

/**
 * 构建完整 registry 1.1 candidate（全量确定性快照）。
 * 对每个 emitted source 复算 reference 文件 SHA-256 并比对（含 materialized projection 文件）；
 * 冲突 key → fail-closed；不修改任何输入对象；不写 DB。
 */
export async function buildRegistryCandidate(
  db: Db,
  options: BuildCandidateOptions,
): Promise<CandidateBuildResult> {
  const pub = options.publication;
  const entries = new Map<string, CandidateEntry>();
  const speakerNames = new Map<string, string>(); // key → speakerName（TTS-A source 用）

  // 1) stable view：legacy entries（frozen §7.1 投影规则）
  const legacyRows = db
    .prepare(
      `SELECT l.id, l.voice_profile_key, l.voice_revision_key, l.speaker_name,
              l.reference_asset_path_or_safe_projection, l.reference_sha256,
              l.mapping_status, l.mapped_voice_materialization_id, l.pending_publication_id,
              m.status AS mat_status, m.source_canonical_sha256 AS mat_sha,
              m.destination_voice_root_relative_path AS mat_rel
         FROM legacy_adapter_voice_entries l
         LEFT JOIN voice_materializations m ON m.id = l.mapped_voice_materialization_id
        ORDER BY l.voice_profile_key, l.voice_revision_key`,
    )
    .all() as Array<LegacyEntryRow & {mat_status: string | null; mat_sha: string | null; mat_rel: string | null}>;

  for (const row of legacyRows) {
    const key = canonicalVoiceKey(row.voice_profile_key, row.voice_revision_key);
    if (row.mapping_status === 'retired') continue; // retired → 不输出

    if (row.mapping_status === 'mapped_active') {
      // mapped_active → TTS-A source（key 保持 legacy key；speaker 保持 legacy 身份）
      if (!row.mapped_voice_materialization_id || row.mat_status === null || row.mat_sha === null || row.mat_rel === null) {
        throw new RegistryContractError(CANDIDATE_KEY_CONFLICT, `mapped_active entry ${row.id} 缺少映射 projection`);
      }
      const mat: MaterializationRow = {
        id: row.mapped_voice_materialization_id,
        voice_profile_id: '',
        voice_profile_revision_id: '',
        source_canonical_sha256: row.mat_sha,
        destination_voice_root_relative_path: row.mat_rel,
        status: row.mat_status,
        published_registry_generation: null,
        published_registry_sha256: null,
        published_by_publication_id: null,
      };
      const matRow = db
        .prepare(
          `SELECT m.voice_profile_id, m.voice_profile_revision_id, r.revision_number
             FROM voice_materializations m
             JOIN voice_profile_revisions r ON r.id = m.voice_profile_revision_id
            WHERE m.id = ?`,
        )
        .get(row.mapped_voice_materialization_id) as {voice_profile_id: string; voice_profile_revision_id: string; revision_number: number} | undefined;
      if (!matRow) throw new RegistryContractError(CANDIDATE_REFERENCE_MISSING, `projection 行缺失: ${row.mapped_voice_materialization_id}`);
      const {voice} = await buildMaterializationVoice(
        {...mat, voice_profile_id: matRow.voice_profile_id, voice_profile_revision_id: matRow.voice_profile_revision_id},
        matRow.revision_number,
        options,
      );
      const emitted: RegistryVoiceEntry = {...voice, speakerName: row.speaker_name, voiceProfile: row.voice_profile_key, voiceRevision: row.voice_revision_key};
      if (entries.has(key)) throw new RegistryContractError(CANDIDATE_KEY_CONFLICT, `stable view 重复 key: ${key}`);
      entries.set(key, {key, emittedSource: 'materialization', sourceRowId: row.mapped_voice_materialization_id, voice: emitted});
      speakerNames.set(key, row.speaker_name);
    } else {
      // unmapped / mapped_verified / mapping_pending → legacy source
      const voice: RegistryVoiceEntry = {
        voiceProfile: row.voice_profile_key,
        voiceRevision: row.voice_revision_key,
        speakerName: row.speaker_name,
        referenceAssetPath: row.reference_asset_path_or_safe_projection,
        referenceSha256: row.reference_sha256,
      };
      const localPath = resolveLegacyLocal(voice.referenceAssetPath, options);
      await verifyReferenceFile(localPath, voice.referenceSha256, options.legacyVoiceRootDir);
      if (entries.has(key)) throw new RegistryContractError(CANDIDATE_KEY_CONFLICT, `stable view 重复 key: ${key}`);
      entries.set(key, {key, emittedSource: 'legacy', sourceRowId: row.id, voice});
      speakerNames.set(key, row.speaker_name);
    }
  }

  // 2) stable view：published_usable materializations 以自身 TTS-A key 输出（frozen 规则；
  //   1B.2 阶段 trg_vmat_publish 使 published_usable 不可达，防御性实现 + 冲突 fail-closed）
  const publishedMats = db
    .prepare(
      `SELECT m.id, m.voice_profile_id, m.voice_profile_revision_id, m.source_canonical_sha256,
              m.destination_voice_root_relative_path, m.status, m.published_registry_generation,
              m.published_registry_sha256, m.published_by_publication_id,
              r.revision_number
         FROM voice_materializations m
         JOIN voice_profile_revisions r ON r.id = m.voice_profile_revision_id
        WHERE m.status='published_usable'
        ORDER BY m.voice_profile_id, r.revision_number`,
    )
    .all() as Array<MaterializationRow & {revision_number: number}>;
  for (const mat of publishedMats) {
    const {voice} = await buildMaterializationVoice(mat, mat.revision_number, options);
    const profileName = db.prepare('SELECT display_name FROM voice_profiles WHERE id=?').get(mat.voice_profile_id) as
      | {display_name: string}
      | undefined;
    if (!profileName) throw new RegistryContractError(CANDIDATE_REFERENCE_MISSING, `voice profile 缺失: ${mat.voice_profile_id}`);
    const emitted: RegistryVoiceEntry = {...voice, speakerName: profileName.display_name};
    const key = canonicalVoiceKey(emitted.voiceProfile, emitted.voiceRevision);
    if (entries.has(key)) throw new RegistryContractError(CANDIDATE_KEY_CONFLICT, `已发布 projection key 冲突: ${key}`);
    entries.set(key, {key, emittedSource: 'materialization', sourceRowId: mat.id, voice: emitted});
    speakerNames.set(key, profileName.display_name);
  }

  // 3) subject swap（frozen §7.1 candidate view：仅 subject key 换入新 source）
  if (pub.subject_type === 'registry_rebuild') {
    // 纯重建：无新 key
  } else if (pub.subject_type === 'materialization_publish') {
    const mat = db
      .prepare(
        `SELECT m.id, m.voice_profile_id, m.voice_profile_revision_id, m.source_canonical_sha256,
                m.destination_voice_root_relative_path, m.status, m.published_registry_generation,
                m.published_registry_sha256, m.published_by_publication_id,
                r.revision_number
           FROM voice_materializations m
           JOIN voice_profile_revisions r ON r.id = m.voice_profile_revision_id
          WHERE m.id = ?`,
      )
      .get(pub.subject_id) as (MaterializationRow & {revision_number: number}) | undefined;
    if (!mat) throw new RegistryContractError(CANDIDATE_REFERENCE_MISSING, `subject materialization 缺失: ${pub.subject_id}`);
    if (mat.status !== 'file_ready_unpublished') {
      throw new RegistryContractError(PUBLICATION_INVALID_STATE, `subject materialization 状态必须 file_ready_unpublished: ${mat.status}`);
    }
    const {voice} = await buildMaterializationVoice(mat, mat.revision_number, options);
    const profileName = db.prepare('SELECT display_name FROM voice_profiles WHERE id=?').get(mat.voice_profile_id) as
      | {display_name: string}
      | undefined;
    if (!profileName) throw new RegistryContractError(CANDIDATE_REFERENCE_MISSING, `voice profile 缺失: ${mat.voice_profile_id}`);
    const emitted: RegistryVoiceEntry = {...voice, speakerName: profileName.display_name};
    const key = canonicalVoiceKey(emitted.voiceProfile, emitted.voiceRevision);
    if (entries.has(key)) throw new RegistryContractError(CANDIDATE_KEY_CONFLICT, `materialization_publish subject key 已存在: ${key}`);
    entries.set(key, {key, emittedSource: 'materialization', sourceRowId: mat.id, voice: emitted});
    speakerNames.set(key, profileName.display_name);
  } else {
    // legacy_cutover_publish / legacy_cutover_existing：subject key 由 legacy source 换为 TTS-A source
    const entry = db
      .prepare(
        `SELECT l.id, l.voice_profile_key, l.voice_revision_key, l.speaker_name,
                l.reference_asset_path_or_safe_projection, l.reference_sha256,
                l.mapping_status, l.mapped_voice_materialization_id, l.pending_publication_id
           FROM legacy_adapter_voice_entries l
          WHERE l.id = ?`,
      )
      .get(pub.subject_id) as LegacyEntryRow | undefined;
    if (!entry) throw new RegistryContractError(PUBLICATION_INVALID_STATE, `subject legacy entry 缺失: ${pub.subject_id}`);
    if (entry.mapping_status !== 'mapping_pending' || entry.pending_publication_id !== pub.id) {
      throw new RegistryContractError(
        PUBLICATION_INVALID_STATE,
        `subject legacy entry 必须 mapping_pending 且 pending_publication_id=本 publication（当前 ${entry.mapping_status}/${entry.pending_publication_id}）`,
      );
    }
    if (!entry.mapped_voice_materialization_id) {
      throw new RegistryContractError(PUBLICATION_INVALID_STATE, 'subject legacy entry 缺少 mapped materialization');
    }
    const mat = db
      .prepare(
        `SELECT m.id, m.voice_profile_id, m.voice_profile_revision_id, m.source_canonical_sha256,
                m.destination_voice_root_relative_path, m.status, m.published_registry_generation,
                m.published_registry_sha256, m.published_by_publication_id,
                r.revision_number
           FROM voice_materializations m
           JOIN voice_profile_revisions r ON r.id = m.voice_profile_revision_id
          WHERE m.id = ?`,
      )
      .get(entry.mapped_voice_materialization_id) as (MaterializationRow & {revision_number: number}) | undefined;
    if (!mat) throw new RegistryContractError(CANDIDATE_REFERENCE_MISSING, `subject projection 缺失: ${entry.mapped_voice_materialization_id}`);
    const {voice} = await buildMaterializationVoice(mat, mat.revision_number, options);
    // key 保持 legacy key；speaker 保持 legacy 身份（voice 连续性）
    const key = canonicalVoiceKey(entry.voice_profile_key, entry.voice_revision_key);
    const emitted: RegistryVoiceEntry = {
      ...voice,
      speakerName: entry.speaker_name,
      voiceProfile: entry.voice_profile_key,
      voiceRevision: entry.voice_revision_key,
    };
    // candidate view：subject key 由 stable 的 legacy source 换为 TTS-A source（替换，非新增）
    const existing = entries.get(key);
    if (existing && existing.sourceRowId !== entry.id) {
      throw new RegistryContractError(CANDIDATE_KEY_CONFLICT, `cutover subject key 被其他 source 占用: ${key}`);
    }
    if (!existing) {
      throw new RegistryContractError(PUBLICATION_INVALID_STATE, `cutover subject key 在 stable view 缺失: ${key}`);
    }
    entries.set(key, {key, emittedSource: 'materialization', sourceRowId: mat.id, voice: emitted});
    speakerNames.set(key, entry.speaker_name);
  }

  // 4) 确定性输出：canonical key 升序
  const sortedKeys = [...entries.keys()].sort();
  const sortedEntries = sortedKeys.map((k) => entries.get(k) as CandidateEntry);
  const registryDoc: PublisherRegistryDoc = {
    schemaVersion: PUBLISHER_REGISTRY_SCHEMA_VERSION,
    registryGeneration: pub.generation,
    publisherSchemaVersion: PUBLISHER_SCHEMA_VERSION,
    voices: sortedEntries.map((e) => e.voice),
  };
  const registryBytes = Buffer.from(serializePublisherRegistry(registryDoc), 'utf8');
  const registrySha256 = sha256Bytes(registryBytes);

  const manifest: CandidateManifest = {
    registryGeneration: pub.generation,
    entries: sortedEntries.map((e) => ({
      key: e.key,
      emittedSource: e.emittedSource,
      sourceRowId: e.sourceRowId,
      voiceProfile: e.voice.voiceProfile,
      voiceRevision: e.voice.voiceRevision,
      referenceSha256: e.voice.referenceSha256,
      adapterKey: canonicalVoiceKey(e.voice.voiceProfile, e.voice.voiceRevision),
    })),
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  const manifestSha256 = crypto.createHash('sha256').update(manifestJson, 'utf8').digest('hex');

  // 5) 自校验：candidate 必须通过 adapter 同款严格校验（round-trip）
  const parsed = parseAndValidateRegistry(registryBytes);
  if (parsed.doc.schemaVersion !== PUBLISHER_REGISTRY_SCHEMA_VERSION) {
    throw new RegistryContractError('VOICE_REGISTRY_INVALID', 'candidate 自校验失败：schemaVersion');
  }
  if (parsed.voices.length !== sortedEntries.length) {
    throw new RegistryContractError('VOICE_REGISTRY_INVALID', 'candidate 自校验失败：voices 数量');
  }

  return {registryDoc, registryBytes, registrySha256, manifest, manifestJson, manifestSha256, entries: sortedEntries};
}

// ── T2：DB candidate_persisted（Tx A，fenced） ──

export interface MarkCandidatePersistedOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  candidateRegistrySha256: string;
  candidateManifestJson: string;
  candidateManifestSha256: string;
}

/** Tx A：building → candidate_persisted（candidate evidence 一次写入；T1.5 fence 同 statement）。 */
export function markCandidatePersisted(db: Db, options: MarkCandidatePersistedOptions): void {
  const lease = dbNowMs(db) + PUBLICATION_LEASE_MS;
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET status='candidate_persisted',
              candidate_registry_sha256=?, candidate_manifest_json=?, candidate_manifest_sha256=?,
              lease_expires_at_epoch_ms=?, updated_at=?
        WHERE id=? AND status='building'
          AND owner_token=? AND attempt=?
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(options.candidateRegistrySha256, options.candidateManifestJson, options.candidateManifestSha256,
      lease, nowIso(), options.publicationId, options.ownerToken, options.attempt);
  if (res.changes !== 1) {
    throw new RegistryContractError(PUBLICATION_NOT_OWNER, `publication ${options.publicationId} 无法推进 candidate_persisted（fence 不命中）`);
  }
}

// ── T2：candidate 文件持久化（统一 durable acceptance；R1 P0-B + P2 方案 A） ──

export interface VerifyDurableCandidateOptions {
  /** candidate registry root（containment 基准；必须已由 ensureCandidateRootSafe 验证）。 */
  rootDir: string;
  /** final 绝对路径（rootDir 内）。 */
  finalPath: string;
  expectedSha256: string;
  /** 已知时校验长度（loser file_durable 验证路径可省略）。 */
  expectedLength?: number;
  expectedGeneration: number;
  /** 测试注入（仅测试；1A materialization.ts 同款先例）。 */
  fsyncFile?: (fh: fsPromises.FileHandle) => Promise<void>;
  fsyncDir?: (fh: fsPromises.FileHandle) => Promise<void>;
}

/**
 * 统一 final acceptance（R1 P0-B + P2 方案 A）——新文件与 existing-final 共用：
 *   O_NOFOLLOW 打开 → fstat 普通文件 → 从 fd 读取 bytes → length → SHA →
 *   parse registry JSON → schemaVersion "1.1" → registryGeneration == expected →
 *   publisherSchemaVersion 精确 → final fsync → parent dir fsync（no-follow）。
 * 全部成功才返回；同 SHA 不得直接 return（必须重新建立 durability）。
 */
export async function durabilizeAndVerifyCandidate(options: VerifyDurableCandidateOptions): Promise<void> {
  const root = path.resolve(options.rootDir);
  const finalAbs = path.resolve(options.finalPath);
  if (!finalAbs.startsWith(root + path.sep)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `final path 越出 candidate root: ${finalAbs}`);
  }

  let fh: fsPromises.FileHandle;
  try {
    fh = await fsPromises.open(finalAbs, OPEN_FLAGS.readNoFollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate final 缺失: ${finalAbs}`);
    }
    throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate final 不可打开: ${finalAbs}`);
  }
  try {
    const st = await fh.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate final 是 symlink 或非普通文件');
    }
    const bytes = await fh.readFile();
    if (options.expectedLength !== undefined && bytes.length !== options.expectedLength) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate length 不符（${bytes.length} != ${options.expectedLength}）`);
    }
    if (sha256Bytes(bytes) !== options.expectedSha256) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate SHA 与预期不符');
    }
    // P2 方案 A：final bytes 语义校验（persist 内部，非测试外部）
    const parsed = parseAndValidateRegistry(bytes);
    if (parsed.doc.schemaVersion !== PUBLISHER_REGISTRY_SCHEMA_VERSION) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate schemaVersion 必须 1.1');
    }
    if (parsed.doc.schemaVersion === '1.1' && parsed.doc.registryGeneration !== options.expectedGeneration) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate registryGeneration 不符（${parsed.doc.registryGeneration} != ${options.expectedGeneration}）`);
    }
    if (parsed.doc.schemaVersion === '1.1' && parsed.doc.publisherSchemaVersion !== SUPPORTED_PUBLISHER_SCHEMA_VERSION) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate publisherSchemaVersion 必须 tts-c-registry-publisher@1');
    }
    // final fsync（重新建立 durability）
    try {
      if (options.fsyncFile) {
        await options.fsyncFile(fh);
      } else {
        await fh.sync();
      }
    } catch (err) {
      if (err instanceof RegistryContractError) throw err;
      throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate final fsync 失败: ${(err as Error).message}`);
    }
  } finally {
    await fh.close();
  }

  // parent directory fsync（no-follow）——错误统一包装为 CANDIDATE_FILE_IO
  let dirFh: fsPromises.FileHandle;
  try {
    dirFh = await fsPromises.open(root, OPEN_FLAGS.parentReadNoFollow);
  } catch (err) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate parent dir 不可打开: ${(err as Error).message}`);
  }
  try {
    if (options.fsyncDir) {
      await options.fsyncDir(dirFh);
    } else {
      await dirFh.sync();
    }
  } catch (err) {
    if (err instanceof RegistryContractError) throw err;
    throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate parent dir fsync 失败: ${(err as Error).message}`);
  } finally {
    await dirFh.close();
  }
}

export interface PersistCandidateFileOptions {
  generation: number;
  candidateBytes: Buffer;
  expectedSha256: string;
  /** 测试注入（仅测试；1A materialization.ts 同款先例）：文件/目录 fsync 与 rename 后钩子。 */
  fsyncFile?: (fh: fsPromises.FileHandle) => Promise<void>;
  fsyncDir?: (fh: fsPromises.FileHandle) => Promise<void>;
  afterRenameHook?: () => Promise<void>;
}

/**
 * 写入 durable candidate 文件。同 generation 已存在：
 *   bytes 完全一致 → 重新建立 durability（R1 P0-B：fsync final + parent dir）后返回；
 *   bytes 不一致 → CANDIDATE_BYTES_CONFLICT fail-closed（不覆盖）。
 * 新文件路径与 existing 路径共用 durabilizeAndVerifyCandidate 最终 acceptance。
 */
export async function persistCandidateFile(options: PersistCandidateFileOptions): Promise<string> {
  const root = await ensureCandidateRootSafe(candidateRegistryDir());
  const finalAbs = path.join(root, `candidate-${options.generation}.json`);
  if (finalAbs !== candidateRegistryPath(options.generation)) {
    throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate final path 与约定不一致');
  }

  // 已存在分支：同 bytes → 重新建立 durability 后复用；异 bytes → fail-closed
  let existingSt: fs.Stats | null = null;
  try {
    existingSt = await fsPromises.lstat(finalAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate final 不可 stat: ${finalAbs}`);
    }
  }
  if (existingSt) {
    if (existingSt.isSymbolicLink() || !existingSt.isFile()) {
      throw new RegistryContractError(CANDIDATE_FILE_IO, 'candidate final 是 symlink 或非普通文件');
    }
    let existingBytes: Buffer;
    try {
      const fh = await fsPromises.open(finalAbs, OPEN_FLAGS.readNoFollow);
      try {
        existingBytes = await fh.readFile();
      } finally {
        await fh.close();
      }
    } catch {
      throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate final 不可读: ${finalAbs}`);
    }
    if (sha256Bytes(existingBytes) !== options.expectedSha256) {
      throw new RegistryContractError(
        CANDIDATE_BYTES_CONFLICT,
        `同 generation ${options.generation} 已存在不同 bytes 的 candidate（fail-closed，不覆盖）`,
      );
    }
    // 同 SHA：不得直接 return——重新建立 durability（P0-B）
    await durabilizeAndVerifyCandidate({
      rootDir: root,
      finalPath: finalAbs,
      expectedSha256: options.expectedSha256,
      expectedLength: options.candidateBytes.length,
      expectedGeneration: options.generation,
      fsyncFile: options.fsyncFile,
      fsyncDir: options.fsyncDir,
    });
    return finalAbs;
  }

  // 全新写入：temp 独占 → write → fsync → rename → 统一 acceptance
  const tempAbs = stagingTempPath(finalAbs);
  let fh: fsPromises.FileHandle | null = null;
  try {
    fh = await fsPromises.open(tempAbs, OPEN_FLAGS.tempCreate, 0o640);
    await fh.writeFile(options.candidateBytes);
    if (options.fsyncFile) {
      await options.fsyncFile(fh);
    } else {
      await fh.sync();
    }
    await fh.close();
    fh = null;

    await fsPromises.rename(tempAbs, finalAbs);

    if (options.afterRenameHook) {
      await options.afterRenameHook();
    }

    // 统一 acceptance（final fsync + dir fsync + P2 语义校验）
    await durabilizeAndVerifyCandidate({
      rootDir: root,
      finalPath: finalAbs,
      expectedSha256: options.expectedSha256,
      expectedLength: options.candidateBytes.length,
      expectedGeneration: options.generation,
      fsyncFile: options.fsyncFile,
      fsyncDir: options.fsyncDir,
    });
  } catch (err) {
    // 清理可能残留的 temp（final 已 durable 时绝不删除 authoritative candidate）
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        // 忽略关闭失败
      }
    }
    try {
      await fsPromises.unlink(tempAbs);
    } catch {
      // temp 可能未创建或已 rename——忽略
    }
    if (err instanceof RegistryContractError) throw err;
    throw new RegistryContractError(CANDIDATE_FILE_IO, `candidate 文件写入失败: ${(err as Error).message}`);
  }
  return finalAbs;
}

// ── T2：DB file_durable（Tx B，fenced） ──

/** Tx B：candidate_persisted → file_durable（file_durable_at；T1.5 fence 同 statement）。 */
export function markFileDurable(db: Db, publicationId: string, ownerToken: string, attempt: number): void {
  const lease = dbNowMs(db) + PUBLICATION_LEASE_MS;
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET status='file_durable', file_durable_at=?, lease_expires_at_epoch_ms=?, updated_at=?
        WHERE id=? AND status='candidate_persisted'
          AND owner_token=? AND attempt=?
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(nowIso(), lease, nowIso(), publicationId, ownerToken, attempt);
  if (res.changes !== 1) {
    throw new RegistryContractError(PUBLICATION_NOT_OWNER, `publication ${publicationId} 无法推进 file_durable（fence 不命中）`);
  }
}

// ── fenced fail（frozen failed 终态；供失败路径与后续 reconciler 复用；非 recovery 闭环） ──

export interface FailPublicationOptions {
  publicationId: string;
  ownerToken: string;
  attempt: number;
  errorCode: string;
  errorMessage: string;
}

/**
 * fenced 推进 failed 终态（owner_token/lease 清空；failed_at + error_code 必填——frozen 形状）。
 * 仅 building/candidate_persisted/file_durable 可进 failed（trg_vrp_transition）；
 * fence 不命中 → PUBLICATION_NOT_OWNER。不是 recovery/reconciler（1B.3）。
 */
export function failPublication(db: Db, options: FailPublicationOptions): void {
  const now = nowIso();
  const res = db
    .prepare(
      `UPDATE voice_registry_publications
          SET status='failed', failed_at=?, error_code=?, error_message=?,
              owner_token=NULL, lease_expires_at_epoch_ms=NULL, updated_at=?
        WHERE id=? AND status IN ('building','candidate_persisted','file_durable')
          AND owner_token=? AND attempt=?
          AND (SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) <= lease_expires_at_epoch_ms`,
    )
    .run(now, options.errorCode, options.errorMessage, now, options.publicationId, options.ownerToken, options.attempt);
  if (res.changes !== 1) {
    throw new RegistryContractError(PUBLICATION_NOT_OWNER, `publication ${options.publicationId} 无法推进 failed（fence 不命中）`);
  }
}

// ── 编排入口（T1 → T1.5 → build → Tx A → file → Tx B；幂等可重跑） ──

export interface PublicationOwnerHandleShape {
  publicationId: string;
  generation: number;
  ownerToken: string;
  attempt: number;
}

export interface PublishRegistryCandidateOptions {
  subject: PublicationSubject;
  /** 当前 active registry 文件原始 bytes 的 SHA-256（调用方读取 active registry 文件计算；active 文件不被修改）。 */
  stableRegistrySha256: string;
  /** T1 用；默认 15min。 */
  leaseMs?: number;
  build: Omit<BuildCandidateOptions, 'publication'>;
  /**
   * TTS-C.1B.3 向后兼容扩展（不改变 1B.2 无 handle 行为）：已 claim 的 winner handle
   * （同进程/恢复续跑 building/candidate_persisted/file_durable）。subscriber（无 handle）
   * 只能得到 already_in_flight / already_file_durable。handle 必须与 DB owner_token+attempt
   * 精确匹配，否则 PUBLICATION_NOT_OWNER。
   */
  handle?: PublicationOwnerHandleShape;
}

/**
 * 完整 T1+T2 编排（R1 P0-A 最小分流）：claim → 分流：
 *   - already_in_flight（loser）：不 renew / 不 build / 不写 DB / 不写文件 / 不 failPublication；
 *     file_durable → 只读 durable verification（P0-B acceptance）→ already_file_durable；
 *     building / candidate_persisted / activation_pending / indeterminate → 立即 already_in_flight
 *     （activation_pending/indeterminate 属 1B.3 范围外，不启动）。
 *   - claimed（winner）：renew → 构建 candidate → candidate_persisted → durable 文件 → file_durable。
 * 幂等：同 subject 重跑 → loser 语义；过期 owner 的 takeover/recovery 留给 1B.3。
 */
export async function publishRegistryCandidate(
  db: Db,
  options: PublishRegistryCandidateOptions,
): Promise<PublishRegistryCandidateResult> {
  let pub: PublicationRow;
  let ownerToken: string;
  let attempt: number;

  if (options.handle) {
    // 1B.3 扩展：winner 续跑——handle 必须与 DB owner_token+attempt 精确匹配
    const row = getPublicationRow(db, options.handle.publicationId);
    if (row.owner_token !== options.handle.ownerToken || row.attempt !== options.handle.attempt) {
      throw new RegistryContractError(PUBLICATION_NOT_OWNER, `handle 不再权威（owner 被接管/替换）: ${row.id}`);
    }
    pub = row;
    ownerToken = options.handle.ownerToken;
    attempt = options.handle.attempt;
  } else {
    const claimed = claimPublication(db, {subject: options.subject, stableRegistrySha256: options.stableRegistrySha256, leaseMs: options.leaseMs});

    // loser 分流：零写副作用
    if (claimed.kind === 'already_in_flight') {
      const p = claimed.publication;
      if (p.status === 'file_durable') {
        // 只读 durable verification（不续租、不更新 DB；P0-B acceptance 重新建立 durability）
        const filePath = candidateRegistryPath(p.generation);
        await durabilizeAndVerifyCandidate({
          rootDir: candidateRegistryDir(),
          finalPath: filePath,
          expectedSha256: p.candidate_registry_sha256 as string,
          expectedGeneration: p.generation,
        });
        return {
          kind: 'already_file_durable',
          publicationId: p.id,
          generation: p.generation,
          status: 'file_durable',
          candidateRegistrySha256: p.candidate_registry_sha256 as string,
          candidateFilePath: filePath,
        };
      }
      // building / candidate_persisted / activation_pending / indeterminate：立即返回，零副作用
      return {
        kind: 'already_in_flight',
        publicationId: p.id,
        generation: p.generation,
        status: p.status as 'building' | 'candidate_persisted' | 'activation_pending' | 'indeterminate',
      };
    }

    // winner 路径（持有 owner token 的唯一调用方）
    pub = claimed.publication;
    ownerToken = pub.owner_token as string;
    attempt = pub.attempt;
  }
  if (!ownerToken) throw new RegistryContractError(PUBLICATION_NOT_OWNER, 'publication 无 owner');

  if (pub.status === 'file_durable') {
    // winner 幂等重跑：只读 durable verification 后复用结果
    const filePath = candidateRegistryPath(pub.generation);
    await durabilizeAndVerifyCandidate({
      rootDir: candidateRegistryDir(),
      finalPath: filePath,
      expectedSha256: pub.candidate_registry_sha256 as string,
      expectedGeneration: pub.generation,
    });
    return {
      kind: 'already_file_durable',
      publicationId: pub.id,
      generation: pub.generation,
      status: 'file_durable',
      candidateRegistrySha256: pub.candidate_registry_sha256 as string,
      candidateFilePath: filePath,
    };
  }
  if (pub.status === 'activation_pending' || pub.status === 'indeterminate') {
    // 1B.3 范围外状态：不启动 activation
    return {
      kind: 'already_in_flight',
      publicationId: pub.id,
      generation: pub.generation,
      status: pub.status,
    };
  }
  if (pub.status !== 'building' && pub.status !== 'candidate_persisted') {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${pub.id} 已处于终态 ${pub.status}`);
  }

  if (!renewPublicationLease(db, pub.id, ownerToken, attempt, options.leaseMs)) {
    throw new RegistryContractError(PUBLICATION_LEASE_EXPIRED, `publication ${pub.id} lease 过期/被接管`);
  }
  const fresh = getPublicationRow(db, pub.id);

  // 构建 candidate（纯计算 + reference 只读验证）
  const built = await buildRegistryCandidate(db, {publication: fresh, ...options.build});

  // 已 candidate_persisted：验证 evidence 与重算一致后续写文件（幂等）
  if (fresh.status === 'candidate_persisted') {
    if (
      fresh.candidate_registry_sha256 !== built.registrySha256 ||
      fresh.candidate_manifest_sha256 !== built.manifestSha256 ||
      fresh.candidate_manifest_json !== built.manifestJson
    ) {
      throw new RegistryContractError(CANDIDATE_EVIDENCE_MISMATCH, '已持久 candidate evidence 与确定性重建不一致');
    }
  } else if (fresh.status === 'building') {
    markCandidatePersisted(db, {
      publicationId: fresh.id,
      ownerToken,
      attempt,
      candidateRegistrySha256: built.registrySha256,
      candidateManifestJson: built.manifestJson,
      candidateManifestSha256: built.manifestSha256,
    });
  } else {
    throw new RegistryContractError(PUBLICATION_INVALID_STATE, `publication ${fresh.id} 状态 ${fresh.status} 不可续 T2`);
  }

  const filePath = await persistCandidateFile({generation: fresh.generation, candidateBytes: built.registryBytes, expectedSha256: built.registrySha256});

  // DB file_durable：仅当文件已 durable 后才推进（DB 不得在 durable 文件前声称成功）
  markFileDurable(db, fresh.id, ownerToken, attempt);

  const final = getPublicationRow(db, fresh.id);
  return {
    kind: 'completed',
    publicationId: final.id,
    generation: final.generation,
    status: 'file_durable',
    candidateRegistrySha256: final.candidate_registry_sha256 as string,
    candidateFilePath: filePath,
  };
}

/**
 * TTS-C.1B.2 legacy adapter registry 确定性导入（frozen §2.8 legacy_adapter_voice_entries）。
 *
 * 语义（docs/TTS_C_1B_1C_EXECUTION_PLAN.md §F）：
 *   - 数据源 = 宿主机 registry JSON 文件 + 每个 entry reference 文件字节（只读重算 SHA-256）；
 *   - 不修改 registry 文件；不复制/重写/重编码 reference voice；
 *   - 身份 = frozen UNIQUE(voice_profile_key, voice_revision_key)（确定字段，不依赖数组顺序/时间）；
 *   - 同 key 同内容（speaker_name / reference_asset_path / reference_sha256 全等）→ no-op 复用；
 *   - 同 key 异内容（任一项漂移）→ 冲突 fail-closed，整批原子回滚，明确错误不更新；
 *   - source_registry_sha256 = 本次源 registry 文件原始 bytes 的 SHA-256（首次导入记录）；
 *     同 key 同内容从另一份 registry 文件重导入 → 复用并保留首次导入的 source sha（provenance）；
 *   - 导入只 INSERT mapping_status='unmapped' 行；绝不激活/cutover/创建 materialization；
 *     绝不把 legacy reference 文件冒充 TTS-C.1A materialization。
 *   - 导入是单 BEGIN IMMEDIATE 事务：任一 voice 冲突 → 整批零写入（fail-closed）。
 */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {Db} from '../db';
import {
  parseAndValidateRegistry,
  sha256Bytes,
  canonicalVoiceKey,
  REFERENCE_VOICE_MISSING,
  REFERENCE_SHA256_MISMATCH,
} from './registry-schema';
import {RegistryContractError} from './registry-contract-error';
import {nowIso} from './materialization';
import {OPEN_FLAGS} from './paths';

export const LEGACY_IMPORT_CONFLICT = 'LEGACY_IMPORT_CONFLICT';

export interface LegacyImportOptions {
  /** registry JSON 文件绝对路径（本机可读；只读）。 */
  registryFilePath: string;
  /** voice root 绝对路径（本机；reference 文件 containment 基准，realpath 校验）。 */
  voiceRootDir: string;
  /**
   * registry 内 referenceAssetPath（容器/registry 路径形态，如 /voices/x.wav）→ 本机文件路径。
   * 默认：路径必须直接落在 voiceRootDir 内（realpath 包含性校验）。
   * 生产宿主路径形态不同（registry 为容器路径 /voices/...，本机 root 为
   * /vol1/1000/docker/zhiying/voices）时，调用方传入显式映射。
   */
  resolveReferencePath?: (registryPath: string) => string;
}

export interface LegacyImportResult {
  inserted: number;
  reused: number;
  /** 导入的 voices（按 canonical key 升序，与 registry 内顺序无关）。 */
  keys: string[];
  sourceRegistrySha256: string;
}

interface LegacyEntryRow {
  id: string;
  voice_profile_key: string;
  voice_revision_key: string;
  speaker_name: string;
  reference_asset_path_or_safe_projection: string;
  reference_sha256: string;
  source_registry_sha256: string;
}

/**
 * 校验 reference 文件（R1 P1-A 最小修复）：resolver 结果必须重新经过 containment/no-follow 校验。
 * 传入 rootDir 时执行完整校验：
 *   root 绝对/存在/目录/非 symlink + realpath 固定 → mappedPath 绝对且 lexical 位于 root 内 →
 *   逐级 parent lstat 无 symlink → final O_NOFOLLOW 打开 → fstat 普通文件 → fd 读取 → SHA 精确比对。
 * 错误码复用 frozen 语义（containment/symlink/非普通文件/不可读 → REFERENCE_VOICE_MISSING；
 * SHA 不符 → REFERENCE_SHA256_MISMATCH）。只读，零 DB/文件副作用。
 */
export async function verifyReferenceFile(localPath: string, expectedSha256: string, rootDir?: string): Promise<void> {
  const finalAbs = path.resolve(localPath);

  if (rootDir) {
    if (!path.isAbsolute(rootDir)) throw new RegistryContractError(REFERENCE_VOICE_MISSING, 'root 必须绝对路径');
    const rootResolved = path.resolve(rootDir);
    let rootSt: fs.Stats;
    try {
      rootSt = await fsPromises.lstat(rootResolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new RegistryContractError(REFERENCE_VOICE_MISSING, `voice root 缺失: ${rootResolved}`);
      }
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, `voice root 不可 stat: ${rootResolved}`);
    }
    if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, 'voice root 是 symlink 或非目录');
    }
    let rootReal: string;
    try {
      rootReal = await fsPromises.realpath(rootResolved);
    } catch {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, 'voice root realpath 不可解析');
    }
    if (rootReal !== rootResolved) {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, 'voice root realpath 漂移（symlink 逃逸）');
    }
    if (!finalAbs.startsWith(rootResolved + path.sep)) {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference 越出 voice root: ${localPath}`);
    }
    const rel = finalAbs.slice(rootResolved.length + 1);
    const parts = rel.split('/');
    if (parts.some((p) => p === '..' || p === '.' || p === '')) {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference 路径段非法: ${rel}`);
    }
    // 逐级 parent lstat：任何 symlink 拒绝
    let cur = rootResolved;
    for (const seg of parts.slice(0, -1)) {
      cur = path.join(cur, seg);
      let segSt: fs.Stats;
      try {
        segSt = await fsPromises.lstat(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference parent 缺失: ${cur}`);
        }
        throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference parent 不可 stat: ${cur}`);
      }
      if (segSt.isSymbolicLink()) throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference parent 是 symlink: ${cur}`);
      if (!segSt.isDirectory()) throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference parent 非目录: ${cur}`);
    }
  }

  // final：O_NOFOLLOW 打开 + fstat 普通文件 + 从 fd 读取
  let fh: fsPromises.FileHandle;
  try {
    fh = await fsPromises.open(finalAbs, OPEN_FLAGS.readNoFollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference 文件缺失: ${finalAbs}`);
    }
    throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference 文件不可打开: ${finalAbs}`);
  }
  let buf: Buffer;
  try {
    const st = await fh.stat();
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new RegistryContractError(REFERENCE_VOICE_MISSING, `reference 非普通文件: ${finalAbs}`);
    }
    buf = await fh.readFile();
  } finally {
    await fh.close();
  }
  const actual = sha256Bytes(buf);
  if (actual !== expectedSha256) {
    throw new RegistryContractError(REFERENCE_SHA256_MISMATCH, `reference SHA-256 不符: ${finalAbs}`);
  }
}

/** resolver 只做 path translation；containment/symlink/no-follow 由 verifyReferenceFile(rootDir) 强制（R1 P1-A）。 */
function resolveReferenceLocal(registryPath: string, options: LegacyImportOptions): string {
  if (options.resolveReferencePath) return options.resolveReferencePath(registryPath);
  return path.resolve(registryPath);
}

/**
 * 确定性导入 production legacy adapter registry → legacy_adapter_voice_entries。
 * 单 BEGIN IMMEDIATE 事务：任一冲突 → 整批零写入。
 */
export async function importLegacyRegistry(
  db: Db,
  options: LegacyImportOptions,
): Promise<LegacyImportResult> {
  let bytes: Buffer;
  try {
    bytes = await fsPromises.readFile(options.registryFilePath);
  } catch {
    throw new RegistryContractError('VOICE_REGISTRY_UNREADABLE', `registry 文件不可读: ${options.registryFilePath}`);
  }
  const sourceRegistrySha256 = sha256Bytes(bytes);
  const {voices} = parseAndValidateRegistry(bytes); // 已按 canonical key 升序 + 去重

  // 前置：全部 reference 文件只读验证（任一失败 → 整批 fail-closed，零 DB 写入）
  const verified: Array<{voice: (typeof voices)[number]; localPath: string}> = [];
  for (const voice of voices) {
    const localPath = resolveReferenceLocal(voice.referenceAssetPath, options);
    await verifyReferenceFile(localPath, voice.referenceSha256, options.voiceRootDir);
    verified.push({voice, localPath});
  }

  const now = nowIso();
  const inserted: string[] = [];
  const reused: string[] = [];

  const tx = db.transaction((): void => {
    const selectStmt = db.prepare(
      `SELECT id, voice_profile_key, voice_revision_key, speaker_name,
              reference_asset_path_or_safe_projection, reference_sha256, source_registry_sha256
         FROM legacy_adapter_voice_entries
        WHERE voice_profile_key = ? AND voice_revision_key = ?`,
    );
    const insertStmt = db.prepare(
      `INSERT INTO legacy_adapter_voice_entries
         (id, voice_profile_key, voice_revision_key, speaker_name,
          reference_asset_path_or_safe_projection, reference_sha256, source_registry_sha256,
          imported_at, mapping_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmapped')`,
    );
    for (const {voice} of verified) {
      const existing = selectStmt.get(voice.voiceProfile, voice.voiceRevision) as LegacyEntryRow | undefined;
      if (!existing) {
        insertStmt.run(
          crypto.randomUUID(),
          voice.voiceProfile,
          voice.voiceRevision,
          voice.speakerName,
          voice.referenceAssetPath,
          voice.referenceSha256,
          sourceRegistrySha256,
          now,
        );
        inserted.push(canonicalVoiceKey(voice.voiceProfile, voice.voiceRevision));
        continue;
      }
      // 已存在：内容一致 → no-op 复用；任一项漂移 → 冲突 fail-closed（整批回滚）
      const contentEqual =
        existing.speaker_name === voice.speakerName &&
        existing.reference_asset_path_or_safe_projection === voice.referenceAssetPath &&
        existing.reference_sha256 === voice.referenceSha256;
      if (!contentEqual) {
        throw new RegistryContractError(
          LEGACY_IMPORT_CONFLICT,
          `legacy voice key ${canonicalVoiceKey(voice.voiceProfile, voice.voiceRevision)} 已存在但内容漂移`
            + `（speaker/path/SHA 任一项不一致）——fail-closed，不更新`,
        );
      }
      reused.push(canonicalVoiceKey(voice.voiceProfile, voice.voiceRevision));
    }
  });
  tx.immediate();

  const keys = [...inserted, ...reused].sort();
  return {inserted: inserted.length, reused: reused.length, keys, sourceRegistrySha256};
}

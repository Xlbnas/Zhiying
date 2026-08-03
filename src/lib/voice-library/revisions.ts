/**
 * TTS-A Voice Profile Revision：exact validator + 安全摄取管线（设计文档 §3/§4/§5/§9）。
 *
 * - revision immutable：DB trigger 禁止 UPDATE/DELETE；本模块绝不提供更新/删除路径。
 * - 单一真相源 validateVoiceProfileRevisionExact：双 ID 精确读取 + 内容级契约校验 +
 *   路径形状/包含性校验 + 文件 hash 校验；getVoiceProfileRevisionExact（API 视图）、
 *   readRevisionAudio、requestId reused 检查全部复用同一入口，不再维护两套 path/hash 校验。
 * - 摄取 fail-closed：任何一步失败清理 staging，只有 DB commit 成功才返回 created。
 * - Crash model（TTS-A.R1 修正）：durability-critical 的 rename/fsync 全部在 SQLite
 *   commit 之前完成；commit 后不再执行会把成功响应转成 500 的关键 fsync。
 *   崩溃只可能留「final 文件存在但无 DB 行」的 orphan（永不视为 usable）。
 */
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {getDataDir, getDb} from '@/lib/db';
import {sha256File} from '@/lib/render/artifact';
import {
  ADAPTER_COMPATIBILITY_KEY,
  CANONICAL_CHANNELS,
  CANONICAL_CODEC,
  CANONICAL_FILENAME,
  CANONICAL_SAMPLE_RATE,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  MAX_REFERENCE_AUDIO_MS,
  MAX_REFERENCE_UPLOAD_BYTES,
  MIN_REFERENCE_AUDIO_MS,
  STAGING_DIR_NAME,
  VOICE_CANONICALIZATION_VERSION,
  VOICE_LIBRARY_ROOT,
  VOICE_PROFILE_REVISION_SCHEMA_VERSION,
  VOICE_PROFILE_SCHEMA_VERSION,
  VOICE_PROVIDER,
} from './constants';
import {getVoiceProfile} from './profiles';
import {
  normalizeTranscript,
  revisionMetadataSchema,
  sanitizeOriginalFilename,
  serializeRevision,
  validateIngestFields,
  VoiceLibraryError,
  type RevisionMetadata,
  type VoiceProfileRevisionRow,
  type VoiceProfileRow,
  type VoiceRevisionUnusableReason,
} from './types';

const execFileAsync = promisify(execFile);

/** profileId 参与路径构造前的形状校验（防御性；真实 Profile id 均为服务端 UUID）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- 可注入 subprocess（参照 worker/tts-executor.ts 的 ffprobeImpl 模式） ----------

export interface ProbedAudio {
  durationMs: number;
  codec: string;
  sampleRate: number;
  channels: number;
  hasVideo: boolean;
}

/**
 * 可注入 file-op deps（TTS-A.R1：durability 顺序/故障测试）。
 * rename/fsyncFile/fsyncDir 分别对应摄取事务内的 rename 与 fsync 调用点；
 * 注入实现可记录调用顺序或抛错以模拟 fsync 失败/崩溃窗口。
 */
export interface VoiceLibraryFileOps {
  rename: (from: string, to: string) => void;
  fsyncFile: (absPath: string) => void;
  fsyncDir: (absDir: string) => void;
}

export interface VoiceLibraryExecDeps {
  ffprobeImpl?: (absPath: string) => Promise<ProbedAudio>;
  ffmpegImpl?: (args: string[]) => Promise<void>;
  fileOps?: Partial<VoiceLibraryFileOps>;
}

/** ffprobe 实测音频元数据（不信任容器声明之外输入；参数数组 spawn，无 shell）。 */
async function defaultFfprobe(absPath: string): Promise<ProbedAudio> {
  const {stdout} = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', absPath],
    {timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024},
  );
  const json = JSON.parse(stdout) as {
    format?: {duration?: string};
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  };
  const audio = (json.streams ?? []).find((s) => s.codec_type === 'audio');
  const hasVideo = (json.streams ?? []).some((s) => s.codec_type === 'video');
  const durationSec = Number(json.format?.duration ?? 0);
  return {
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
    codec: audio?.codec_name ?? 'none',
    sampleRate: Number(audio?.sample_rate ?? 0),
    channels: audio?.channels ?? 0,
    hasVideo,
  };
}

async function defaultFfmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', args, {timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024});
}

function resolveFileOps(deps: VoiceLibraryExecDeps): VoiceLibraryFileOps {
  return {
    rename: deps.fileOps?.rename ?? ((from: string, to: string) => fs.renameSync(from, to)),
    fsyncFile: deps.fileOps?.fsyncFile ?? fsyncFileSync,
    fsyncDir: deps.fileOps?.fsyncDir ?? fsyncDirSync,
  };
}

// ---------- 路径与安全助手 ----------

export function voiceLibraryRootAbs(): string {
  return path.join(getDataDir(), VOICE_LIBRARY_ROOT);
}

/**
 * 安全建立/验证目录（TTS-A.R1：staging/intermediate symlink 防护）：
 * - 已存在 symlink / 非目录 → ingest_failed（fail-closed）；
 * - 不存在 → 非递归 mkdir（父级必须已被安全建立，禁止 recursive mkdir 跨越未检查 symlink）；
 * - 建立后 realpath 必须位于 rootAbs realpath 内（防中间目录 symlink 越界）。
 * 绝不使用请求输入作为路径（调用方只传服务端拼好的绝对路径）。
 */
export function ensureSafeDir(absPath: string, rootAbs?: string): void {
  const root = rootAbs ?? voiceLibraryRootAbs();
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      // 不含 absPath：API 响应绝不携带宿主路径。
      console.error(`[voice-library] refusing symlink dir: ${absPath}`);
      throw new VoiceLibraryError('ingest_failed', 500, '拒绝 symlink 目录路径');
    }
    if (!st.isDirectory()) {
      console.error(`[voice-library] refusing non-directory path: ${absPath}`);
      throw new VoiceLibraryError('ingest_failed', 500, '路径不是目录');
    }
  } else {
    fs.mkdirSync(absPath, {mode: 0o700});
  }
  const real = fs.realpathSync(absPath);
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    console.error(`[voice-library] refusing out-of-root realpath: ${real}`);
    throw new VoiceLibraryError('ingest_failed', 500, '目录 realpath 越出 voice-library 根');
  }
}

/** 解析 DB 相对路径 → 绝对路径；前缀必须是 voice-library/ 且不越界，否则 null（fail-closed）。 */
function resolveCanonicalAbs(relPath: string): string | null {
  if (!relPath.startsWith(`${VOICE_LIBRARY_ROOT}/`)) return null;
  const root = voiceLibraryRootAbs();
  const abs = path.resolve(root, relPath.slice(VOICE_LIBRARY_ROOT.length + 1));
  if (!abs.startsWith(root + path.sep)) return null;
  return abs;
}

function fsyncFileSync(absPath: string): void {
  const fd = fs.openSync(absPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirSync(absDir: string): void {
  const fd = fs.openSync(absDir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- fingerprint（length-prefixed，复用 tts/fingerprint.ts 风格） ----------

function lengthPrefixed(fields: string[]): string {
  return fields.map((f) => `${f.length}:${f}`).join('|');
}

export function computeVoiceRevisionFingerprint(fields: {
  voiceProfileId: string;
  originalAudioSha256: string;
  transcript: string | null;
  language: string | null;
}): string {
  const normalizedTranscript = fields.transcript ? normalizeTranscript(fields.transcript) : '';
  const canonical = lengthPrefixed([
    fields.voiceProfileId,
    VOICE_PROVIDER,
    fields.originalAudioSha256,
    normalizedTranscript.length > 0 ? normalizedTranscript : 'none',
    fields.language ?? 'none',
    VOICE_CANONICALIZATION_VERSION,
    ADAPTER_COMPATIBILITY_KEY,
  ]);
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

// ---------- 共享 exact validator（单一真相源） ----------

/**
 * 内部 descriptor：仅供服务端内部使用（未来 TTS 接入 / audio route / reused 校验）。
 * 绝不直接序列化到 API（含 absolute path / relative canonical path / dataDir / host path）。
 */
export interface VoiceRevisionExactDescriptor {
  row: VoiceProfileRevisionRow;
  profile: VoiceProfileRow;
  canonicalAudioRelativePath: string;
  canonicalAudioAbsolutePath: string;
  fileSize: number;
  actualSha256: string;
  metadata: RevisionMetadata | null;
  usable: boolean;
  unusableReason: VoiceRevisionUnusableReason | null;
}

/**
 * 共享 exact validator（TTS-A.R1 单一真相源）：
 * - Profile：存在 / schema_version 正确 / provider=indextts2（archived historical read 允许）→ 否则 null；
 * - Revision：双 ID exact match / schema_version 正确 → 否则 null；
 * - 内容级契约：provider / adapter_compatibility_key / codec / sample_rate / channels /
 *   duration（冻结范围）/ hash 字段格式 / metadata_json 可解析且通过 strict schema 且与行一致
 *   → 失败返回 usable=false + 具体原因；
 * - 路径：canonical_audio_path 必须精确等于 voice-library/<pid>/<rid>/reference.wav；
 *   lexical resolve 不越界；voice-library root realpath；中间目录 realpath 不越界；
 *   final 非 symlink 且为 regular file → 任一失败返回 null（identity 级 fail-closed）；
 * - 文件：SHA256 与 DB 完全一致 → 不一致 usable=false + hash_mismatch。
 */
export async function validateVoiceProfileRevisionExact(
  voiceProfileId: string,
  voiceProfileRevisionId: string,
): Promise<VoiceRevisionExactDescriptor | null> {
  const profile = getVoiceProfile(voiceProfileId);
  if (!profile || profile.schema_version !== VOICE_PROFILE_SCHEMA_VERSION || profile.provider !== VOICE_PROVIDER) {
    return null;
  }
  const row = getDb()
    .prepare('SELECT * FROM voice_profile_revisions WHERE id = ? AND voice_profile_id = ?')
    .get(voiceProfileRevisionId, voiceProfileId) as VoiceProfileRevisionRow | undefined;
  if (!row || row.schema_version !== VOICE_PROFILE_REVISION_SCHEMA_VERSION) return null;

  // 内容级契约（失败 → usable=false + 原因）
  let unusableReason: VoiceRevisionUnusableReason | null = null;
  if (
    row.provider !== VOICE_PROVIDER ||
    row.adapter_compatibility_key !== ADAPTER_COMPATIBILITY_KEY ||
    row.codec !== CANONICAL_CODEC ||
    row.sample_rate !== CANONICAL_SAMPLE_RATE ||
    row.channels !== CANONICAL_CHANNELS ||
    row.duration_ms < MIN_REFERENCE_AUDIO_MS ||
    row.duration_ms > MAX_REFERENCE_AUDIO_MS
  ) {
    unusableReason = 'contract_mismatch';
  } else if (
    !/^[0-9a-f]{64}$/.test(row.canonical_audio_sha256) ||
    !/^[0-9a-f]{64}$/.test(row.original_audio_sha256) ||
    !/^sha256:[0-9a-f]{64}$/.test(row.request_fingerprint)
  ) {
    unusableReason = 'fingerprint_invalid';
  }

  let metadata: RevisionMetadata | null = null;
  if (unusableReason === null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metadata_json);
    } catch {
      unusableReason = 'metadata_malformed';
    }
    if (unusableReason === null) {
      const parsedOk = revisionMetadataSchema.safeParse(parsed);
      if (!parsedOk.success) {
        unusableReason = 'metadata_invalid';
      } else {
        metadata = parsedOk.data;
        if (
          metadata.canonicalizationVersion !== VOICE_CANONICALIZATION_VERSION ||
          metadata.adapterCompatibilityKey !== ADAPTER_COMPATIBILITY_KEY
        ) {
          unusableReason = 'metadata_contract_mismatch';
        }
      }
    }
  }

  // 路径形状：必须精确（lexical），防止任何拼接变体
  const expectedRel = path.posix.join(
    VOICE_LIBRARY_ROOT,
    voiceProfileId,
    voiceProfileRevisionId,
    CANONICAL_FILENAME,
  );
  if (row.canonical_audio_path !== expectedRel) return null;

  const rootAbs = voiceLibraryRootAbs();
  const abs = resolveCanonicalAbs(row.canonical_audio_path);
  if (!abs) return null;
  // realpath 包含性：所有中间目录经 symlink 越界 → identity 级 null（fail-closed）
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = fs.realpathSync(rootAbs);
    realAbs = fs.realpathSync(abs);
  } catch {
    return null; // 根或文件不存在
  }
  if (!realAbs.startsWith(realRoot + path.sep)) return null;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null; // 文件缺失
  }
  if (st.isSymbolicLink() || !st.isFile()) return null;

  const actualSha256 = await sha256File(abs);
  if (unusableReason === null && actualSha256 !== row.canonical_audio_sha256) {
    unusableReason = 'hash_mismatch';
  }
  return {
    row,
    profile,
    canonicalAudioRelativePath: row.canonical_audio_path,
    canonicalAudioAbsolutePath: abs,
    fileSize: st.size,
    actualSha256,
    metadata,
    usable: unusableReason === null,
    unusableReason,
  };
}

/** API 视图（仅公开序列化字段 + usable 标记；绝不含路径）。 */
export interface VoiceRevisionDescriptor extends ReturnType<typeof serializeRevision> {
  usable: boolean;
  unusableReason: VoiceRevisionUnusableReason | null;
}

/**
 * 按双 ID 精确读取（API 视图）：Profile/Revision 不存在、跨 Profile、schema 非法、路径
 * 不合法/文件缺失 → null；内容级契约失败 / hash 漂移 → usable=false + 原因（fail-closed）。
 */
export async function getVoiceProfileRevisionExact(
  voiceProfileId: string,
  voiceProfileRevisionId: string,
): Promise<VoiceRevisionDescriptor | null> {
  const d = await validateVoiceProfileRevisionExact(voiceProfileId, voiceProfileRevisionId);
  if (!d) return null;
  return {...serializeRevision(d.row), usable: d.usable, unusableReason: d.unusableReason};
}

/**
 * 预留给未来 TTS 接入的薄封装（本轮不被任何生产路径调用，只导出）。
 * 返回内部 descriptor（含 file/row/profile 供 TTS 使用）；usable=false / null 一律视为不可用。
 */
export async function resolveVoiceRevisionForFutureTts(
  voiceProfileId: string,
  voiceProfileRevisionId: string,
): Promise<VoiceRevisionExactDescriptor | null> {
  return validateVoiceProfileRevisionExact(voiceProfileId, voiceProfileRevisionId);
}

/** 列表（按 revision_number 升序），供列表 UI 使用；不做文件级校验。 */
export function listVoiceProfileRevisions(voiceProfileId: string): VoiceProfileRevisionRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM voice_profile_revisions WHERE voice_profile_id = ? ORDER BY revision_number ASC',
    )
    .all(voiceProfileId) as VoiceProfileRevisionRow[];
}

// ---------- 摄取管线 ----------

export interface IngestVoiceRevisionInput {
  voiceProfileId: string;
  requestId: string;
  audioBuffer: Buffer;
  originalFilename?: string | null;
  transcript?: string | null;
  language?: string | null;
}

/**
 * 核心摄取输入（production route 路径）：调用方（multipart streaming helper）已把
 * original 安全写入 staging（O_EXCL|O_NOFOLLOW + fsync）并给出 original SHA256 / 实测字节数。
 * Buffer 输入（IngestVoiceRevisionInput）只是测试 wrapper，走同一个核心函数。
 */
export interface IngestStagedVoiceRevisionInput {
  voiceProfileId: string;
  requestId: string;
  /** 所属 staging 目录（.staging/<uuid>/）；本函数持有并负责 finally 清理。 */
  stagingDir: string;
  /** stagingDir/original.bin：已安全写入、已 fsync。 */
  stagedOriginalPath: string;
  /** 流式计算出的 original SHA256（与 Buffer wrapper 的哈希同语义）。 */
  originalSha256: string;
  /** 实测字节长度（multipart 流式计数；Buffer wrapper 为 buffer.byteLength）。 */
  byteLength: number;
  originalFilename?: string | null;
  transcript?: string | null;
  language?: string | null;
}

export type IngestVoiceRevisionOutcome =
  | {outcome: 'created'; status: 201; revision: VoiceProfileRevisionRow}
  | {outcome: 'reused'; status: 200; revision: VoiceProfileRevisionRow};

type PrecheckResult =
  | {kind: 'proceed'}
  | {kind: 'reused'; row: VoiceProfileRevisionRow};

/** 同事务内 requestId 裁决：已存在行 → 同 fingerprint 候选 reused / 异 fingerprint conflict。 */
function judgeRequestId(
  voiceProfileId: string,
  requestId: string,
  fingerprint: string,
): PrecheckResult {
  const existing = getDb()
    .prepare(
      'SELECT * FROM voice_profile_revisions WHERE voice_profile_id = ? AND request_id = ?',
    )
    .get(voiceProfileId, requestId) as VoiceProfileRevisionRow | undefined;
  if (!existing) return {kind: 'proceed'};
  if (existing.request_fingerprint === fingerprint) {
    return {kind: 'reused', row: existing};
  }
  throw new VoiceLibraryError(
    'request_id_conflict',
    409,
    `requestId 已用于不同内容的摄取（profile ${voiceProfileId}）`,
  );
}

/**
 * reused 前 exact 校验（TTS-A.R1：损坏 revision 不得 reused）：
 * 同 requestId + 同 fingerprint 只是候选；必须 validateVoiceProfileRevisionExact
 * 确认 usable=true 才返回 200 reused；unusable/null → 409 revision_unusable（fail-closed）。
 */
async function assertReusableOrThrow(voiceProfileId: string, row: VoiceProfileRevisionRow): Promise<void> {
  const d = await validateVoiceProfileRevisionExact(voiceProfileId, row.id);
  if (!d || !d.usable) {
    throw new VoiceLibraryError(
      'revision_unusable',
      409,
      `revision ${row.id} 已损坏或不可用，拒绝幂等复用（请重新摄取）`,
    );
  }
}

/**
 * 完整摄取管线（设计文档 §4 顺序；TTS-A.R1 durability 修正）：
 * requestId 快速预检（同 fingerprint 候选 reused 需 exact 校验通过才返回 200）
 * → ffprobe original → ffmpeg 固定参数 canonical → ffprobe canonical 复核 → canonical sha256
 * → BEGIN IMMEDIATE（复查 requestId / Profile active / 同 Profile canonical hash 去重
 *   / revision_number=MAX+1 / INSERT）
 * → durability-critical 段（全部在 SQLite commit 前）：安全建立 profile/revision 目录
 *   → final 不存在断言 → rename → fsync final → fsync revisionDir → fsync profileDir
 *   → fsync voice-library root → fsync staging 源目录 → callback 正常返回 → commit
 * → commit 后仅 best-effort metadata.json（非 durability-critical，失败不影响结果）。
 * 任何失败清理 staging；DB 失败只可能留下 orphan final（永不视为 revision）。
 */
export async function ingestVoiceProfileRevisionFromStaged(
  input: IngestStagedVoiceRevisionInput,
  deps: VoiceLibraryExecDeps = {},
): Promise<IngestVoiceRevisionOutcome> {
  const ffprobe = deps.ffprobeImpl ?? defaultFfprobe;
  const ffmpeg = deps.ffmpegImpl ?? defaultFfmpeg;
  const fileOps = resolveFileOps(deps);
  const db = getDb();

  // 1. 请求字段与大小早判
  validateIngestFields({
    requestId: input.requestId,
    transcript: input.transcript,
    language: input.language,
  });
  if (input.byteLength > MAX_REFERENCE_UPLOAD_BYTES) {
    throw new VoiceLibraryError(
      'file_too_large',
      413,
      `音频大小 ${(input.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 25MB`,
    );
  }
  const profile = getVoiceProfile(input.voiceProfileId);
  if (!profile) {
    throw new VoiceLibraryError('profile_not_found', 404, `voice profile ${input.voiceProfileId} 不存在`);
  }
  if (!UUID_RE.test(input.voiceProfileId)) {
    // 防御性：profileId 参与路径构造，必须是服务端 UUID 形状（真实 Profile 恒满足）
    throw new VoiceLibraryError('profile_not_found', 404, `voice profile ${input.voiceProfileId} 不存在`);
  }

  // 归一化后的存储值
  const transcript = input.transcript ? normalizeTranscript(input.transcript) : '';
  const storedTranscript = transcript.length > 0 ? transcript : null;
  const storedLanguage = input.language?.trim() ? input.language.trim() : null;
  const originalFilenameDisplay = input.originalFilename
    ? sanitizeOriginalFilename(input.originalFilename)
    : null;

  const fingerprint = computeVoiceRevisionFingerprint({
    voiceProfileId: input.voiceProfileId,
    originalAudioSha256: input.originalSha256,
    transcript: storedTranscript,
    language: storedLanguage,
  });

  // staging 目录由本函数持有：无论成败（含 reused 早退）一律清理
  const cleanupStaging = (): void => {
    fs.rmSync(input.stagingDir, {recursive: true, force: true});
  };

  try {
    // 2. requestId 快速预检（BEGIN IMMEDIATE；命中候选则省掉 canonicalization，但需 exact 校验）
    const precheck = db.transaction((): PrecheckResult =>
      judgeRequestId(input.voiceProfileId, input.requestId, fingerprint),
    );
    const pre = precheck.immediate();
    if (pre.kind === 'reused') {
      await assertReusableOrThrow(input.voiceProfileId, pre.row);
      return {outcome: 'reused', status: 200, revision: pre.row};
    }

    // 3. ffprobe original：必须有 audio stream、必须无 video stream、时长在 [MIN, MAX]
    let probe: ProbedAudio;
    try {
      probe = await ffprobe(input.stagedOriginalPath);
    } catch (err) {
      // 详情只进服务端日志：err.message 可能含 staging 绝对路径，API 响应绝不携带路径。
      console.error('[voice-library] ffprobe original failed:', err);
      throw new VoiceLibraryError('unsupported_audio', 415, '无法解析音频内容（不是可识别的音频文件）');
    }
    if (probe.codec === 'none' || probe.hasVideo) {
      throw new VoiceLibraryError(
        'unsupported_audio',
        415,
        probe.hasVideo ? '不支持带视频流的文件' : '文件不含音频流',
      );
    }
    if (probe.durationMs < MIN_REFERENCE_AUDIO_MS || probe.durationMs > MAX_REFERENCE_AUDIO_MS) {
      throw new VoiceLibraryError(
        'invalid_audio_contract',
        422,
        `参考音频时长 ${probe.durationMs}ms 不在 [${MIN_REFERENCE_AUDIO_MS}, ${MAX_REFERENCE_AUDIO_MS}] 范围内`,
      );
    }

    // 4. ffmpeg → canonical staging（参数全部由服务端固定，上传内容不能影响参数）
    const canonicalStagingPath = path.join(input.stagingDir, 'canonical.wav');
    try {
      await ffmpeg([
        '-v', 'error', '-y',
        '-i', input.stagedOriginalPath,
        '-vn',
        '-ac', String(CANONICAL_CHANNELS),
        '-ar', String(CANONICAL_SAMPLE_RATE),
        '-acodec', CANONICAL_CODEC,
        canonicalStagingPath,
      ]);
    } catch (err) {
      console.error('[voice-library] ffmpeg canonicalize failed:', err);
      throw new VoiceLibraryError('unsupported_audio', 415, '音频转码失败（内容不可解码）');
    }

    // 5. ffprobe canonical 复核：codec/sr/channels/duration 必须与常量一致
    let canonicalProbe: ProbedAudio;
    try {
      canonicalProbe = await ffprobe(canonicalStagingPath);
    } catch (err) {
      console.error('[voice-library] ffprobe canonical recheck failed:', err);
      throw new VoiceLibraryError('ingest_failed', 500, 'canonical 复核失败');
    }
    if (
      canonicalProbe.codec !== CANONICAL_CODEC ||
      canonicalProbe.sampleRate !== CANONICAL_SAMPLE_RATE ||
      canonicalProbe.channels !== CANONICAL_CHANNELS ||
      canonicalProbe.hasVideo ||
      canonicalProbe.durationMs < MIN_REFERENCE_AUDIO_MS ||
      canonicalProbe.durationMs > MAX_REFERENCE_AUDIO_MS
    ) {
      throw new VoiceLibraryError(
        'ingest_failed',
        500,
        `canonical 复核不通过：codec=${canonicalProbe.codec} sr=${canonicalProbe.sampleRate} ` +
          `ch=${canonicalProbe.channels} duration=${canonicalProbe.durationMs}ms`,
      );
    }
    const canonicalAudioSha256 = await sha256File(canonicalStagingPath);

    // 6. BEGIN IMMEDIATE：并发兜底复查 + 去重 + 分配 revision_number + INSERT +
    //    durability-critical 段（rename + fsync 全部在 commit 前）
    const rootAbs = voiceLibraryRootAbs();
    const revisionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(
      revisionMetadataSchema.parse({
        canonicalizationVersion: VOICE_CANONICALIZATION_VERSION,
        adapterCompatibilityKey: ADAPTER_COMPATIBILITY_KEY,
        ingestedAt: now,
      }),
    );
    const profileDirAbs = path.join(rootAbs, input.voiceProfileId);
    const revisionDirAbs = path.join(profileDirAbs, revisionId);
    const finalAbs = path.join(revisionDirAbs, CANONICAL_FILENAME);
    const canonicalRelPath = path.posix.join(
      VOICE_LIBRARY_ROOT,
      input.voiceProfileId,
      revisionId,
      CANONICAL_FILENAME,
    );

    const commit = db.transaction((): PrecheckResult => {
      // 并发兜底：同一 requestId 可能在本进程 canonicalization 期间被另一请求提交
      const judge = judgeRequestId(input.voiceProfileId, input.requestId, fingerprint);
      if (judge.kind === 'reused') return judge;
      // 复查 Profile active（archived → 409；不新增 revision）
      const fresh = getVoiceProfile(input.voiceProfileId);
      if (!fresh) {
        throw new VoiceLibraryError('profile_not_found', 404, `voice profile ${input.voiceProfileId} 不存在`);
      }
      if (fresh.status === 'archived') {
        throw new VoiceLibraryError(
          'profile_archived',
          409,
          `voice profile ${input.voiceProfileId} 已归档，不能新增 revision`,
        );
      }
      // 同 Profile canonical hash 重复 → 409（跨 Profile 相同音频允许，文件独立复制）
      const dup = db
        .prepare(
          'SELECT id FROM voice_profile_revisions WHERE voice_profile_id = ? AND canonical_audio_sha256 = ? LIMIT 1',
        )
        .get(input.voiceProfileId, canonicalAudioSha256) as {id: string} | undefined;
      if (dup) {
        throw new VoiceLibraryError(
          'duplicate_audio',
          409,
          `相同 canonical 音频已存在于 revision ${dup.id}（同 Profile 内不允许重复）`,
        );
      }
      const revisionNumber =
        (db
          .prepare(
            'SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM voice_profile_revisions WHERE voice_profile_id = ?',
          )
          .get(input.voiceProfileId) as {n: number}).n;

      db.prepare(
        `INSERT INTO voice_profile_revisions
           (id, schema_version, voice_profile_id, revision_number, request_id, provider,
            adapter_compatibility_key, original_audio_sha256, canonical_audio_sha256,
            original_filename_display, canonical_audio_path, codec, sample_rate, channels,
            duration_ms, transcript, language, metadata_json, request_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId,
        VOICE_PROFILE_REVISION_SCHEMA_VERSION,
        input.voiceProfileId,
        revisionNumber,
        input.requestId,
        VOICE_PROVIDER,
        ADAPTER_COMPATIBILITY_KEY,
        input.originalSha256,
        canonicalAudioSha256,
        originalFilenameDisplay,
        canonicalRelPath,
        CANONICAL_CODEC,
        CANONICAL_SAMPLE_RATE,
        CANONICAL_CHANNELS,
        canonicalProbe.durationMs,
        storedTranscript,
        storedLanguage,
        metadataJson,
        fingerprint,
        now,
      );

      // durability-critical 段：全部在 SQLite commit 前完成。
      // 任一 rename/fsync 失败 → 事务回滚（无 revision 行）；rename 已生效时 final 只是 orphan。
      try {
        ensureSafeDir(profileDirAbs, rootAbs);
        ensureSafeDir(revisionDirAbs, rootAbs);
        assertFinalAbsent(finalAbs);
        fileOps.rename(canonicalStagingPath, finalAbs);
        fileOps.fsyncFile(finalAbs);
        fileOps.fsyncDir(revisionDirAbs);
        fileOps.fsyncDir(profileDirAbs);
        fileOps.fsyncDir(rootAbs);
        fileOps.fsyncDir(input.stagingDir);
      } catch (err) {
        if (err instanceof VoiceLibraryError) throw err;
        // 详情只进服务端日志（err.message 可能含路径）
        console.error('[voice-library] durability phase failed:', err);
        throw new VoiceLibraryError('ingest_failed', 500, '音频文件落盘失败（摄取中止）');
      }
      return {kind: 'proceed'};
    });
    const committed = commit.immediate();
    if (committed.kind === 'reused') {
      await assertReusableOrThrow(input.voiceProfileId, committed.row);
      return {outcome: 'reused', status: 200, revision: committed.row};
    }

    // 7. commit 已完成：DB 行对应 durable final 文件。此后只允许非 durability-critical 操作
    //    （不得再执行会把成功响应转成 500 的关键 fsync/rename）。
    const row = db
      .prepare('SELECT * FROM voice_profile_revisions WHERE id = ?')
      .get(revisionId) as VoiceProfileRevisionRow;

    // 8. best-effort metadata.json（非权威；权威永远是 DB + reference.wav；失败不影响结果）
    try {
      const metadataPath = path.join(revisionDirAbs, 'metadata.json');
      const tmpPath = `${metadataPath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify(
          {
            schemaVersion: VOICE_PROFILE_REVISION_SCHEMA_VERSION,
            voiceProfileId: input.voiceProfileId,
            revisionId,
            revisionNumber: row.revision_number,
            requestId: input.requestId,
            canonicalAudioSha256,
            metadata: JSON.parse(metadataJson),
          },
          null,
          2,
        ),
        {mode: 0o600},
      );
      fs.renameSync(tmpPath, metadataPath);
    } catch {
      // best-effort：失败不影响摄取结果
    }

    return {outcome: 'created', status: 201, revision: row};
  } finally {
    cleanupStaging();
  }
}

/** final 路径必须不存在（禁止覆盖任何既有文件/symlink）；存在 → ingest_failed。 */
function assertFinalAbsent(absPath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  console.error(`[voice-library] refusing to overwrite existing final path: ${absPath}`);
  throw new VoiceLibraryError('ingest_failed', 500, 'final 文件路径已存在，拒绝覆盖');
}

/**
 * Buffer 输入 wrapper（仅测试/内部使用）：与 production route 走同一个核心摄取函数
 * （ingestVoiceProfileRevisionFromStaged），不构成第二套语义——先安全写入 staging
 * （O_EXCL|O_NOFOLLOW + fsync）并计算 SHA256，再进入核心管线。
 */
export async function ingestVoiceProfileRevision(
  input: IngestVoiceRevisionInput,
  deps: VoiceLibraryExecDeps = {},
): Promise<IngestVoiceRevisionOutcome> {
  // 大小早判（保持 size 预检语义：超限在 staging 写入前 413）
  if (input.audioBuffer.byteLength > MAX_REFERENCE_UPLOAD_BYTES) {
    throw new VoiceLibraryError(
      'file_too_large',
      413,
      `音频大小 ${(input.audioBuffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 25MB`,
    );
  }

  // 安全建立 staging（root → .staging → <uuid>；symlink 任一存在 → ingest_failed）
  const rootAbs = voiceLibraryRootAbs();
  ensureSafeDir(rootAbs);
  ensureSafeDir(path.join(rootAbs, STAGING_DIR_NAME), rootAbs);
  const stagingDir = path.join(rootAbs, STAGING_DIR_NAME, crypto.randomUUID());
  fs.mkdirSync(stagingDir, {mode: 0o700});

  const originalPath = path.join(stagingDir, 'original.bin');
  const fd = fs.openSync(
    originalPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, input.audioBuffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  const originalSha256 = crypto.createHash('sha256').update(input.audioBuffer).digest('hex');

  return ingestVoiceProfileRevisionFromStaged(
    {
      voiceProfileId: input.voiceProfileId,
      requestId: input.requestId,
      stagingDir,
      stagedOriginalPath: originalPath,
      originalSha256,
      byteLength: input.audioBuffer.byteLength,
      originalFilename: input.originalFilename,
      transcript: input.transcript,
      language: input.language,
    },
    deps,
  );
}

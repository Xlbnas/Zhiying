/**
 * TTS-A Voice Profile Revision：exact reader + 安全摄取管线（设计文档 §3/§4/§5）。
 *
 * - revision immutable：DB trigger 禁止 UPDATE/DELETE；本模块绝不提供更新/删除路径。
 * - exact reader 只按双 ID 精确读取；不提供 getLatest 业务接口。
 * - 摄取 fail-closed：任何一步失败清理 staging，只有 DB commit 成功才返回 created。
 * - Crash model：rename 在 commit 前执行 → committed 行必然有 final 文件；
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
  VOICE_CANONICALIZATION_VERSION,
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
  type VoiceProfileRevisionRow,
} from './types';

const execFileAsync = promisify(execFile);

const VOICE_LIBRARY_ROOT = 'voice-library';
const STAGING_DIR_NAME = '.staging';

// ---------- 可注入 subprocess（参照 worker/tts-executor.ts 的 ffprobeImpl 模式） ----------

export interface ProbedAudio {
  durationMs: number;
  codec: string;
  sampleRate: number;
  channels: number;
  hasVideo: boolean;
}

export interface VoiceLibraryExecDeps {
  ffprobeImpl?: (absPath: string) => Promise<ProbedAudio>;
  ffmpegImpl?: (args: string[]) => Promise<void>;
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

// ---------- 路径与安全助手 ----------

function voiceLibraryRootAbs(): string {
  return path.join(getDataDir(), VOICE_LIBRARY_ROOT);
}

/** symlink 防护：路径存在且是 symlink → ingest_failed；不存在 → 放行。 */
function assertNotSymlink(absPath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    // 不含 absPath：API 响应绝不携带宿主路径。
    console.error(`[voice-library] refusing symlink path: ${absPath}`);
    throw new VoiceLibraryError('ingest_failed', 500, '拒绝写入 symlink 路径');
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

// ---------- exact reader ----------

export interface VoiceRevisionDescriptor extends ReturnType<typeof serializeRevision> {
  /** false = 行存在但文件 hash 漂移（fail-closed 不可用）。 */
  usable: boolean;
  unusableReason: 'hash_mismatch' | null;
}

/**
 * 按双 ID 精确读取 immutable descriptor：
 * - Profile / Revision 不存在、跨 Profile、schema_version 非法 → null；
 * - canonical 文件缺失（或不可信，如 symlink）→ null（与「不存在」不可区分，按设计）；
 * - 文件 sha256 与 DB 不匹配 → 返回 descriptor 且 usable=false（fail-closed）；
 * - archived Profile 的 historical exact read 仍可读。
 */
export async function getVoiceProfileRevisionExact(
  voiceProfileId: string,
  voiceProfileRevisionId: string,
): Promise<VoiceRevisionDescriptor | null> {
  const profile = getVoiceProfile(voiceProfileId);
  if (!profile || profile.schema_version !== VOICE_PROFILE_SCHEMA_VERSION) return null;
  const row = getDb()
    .prepare('SELECT * FROM voice_profile_revisions WHERE id = ? AND voice_profile_id = ?')
    .get(voiceProfileRevisionId, voiceProfileId) as VoiceProfileRevisionRow | undefined;
  if (!row || row.schema_version !== VOICE_PROFILE_REVISION_SCHEMA_VERSION) return null;

  const abs = resolveCanonicalAbs(row.canonical_audio_path);
  if (!abs) return null;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null; // 文件缺失 → null
  }
  if (st.isSymbolicLink() || !st.isFile()) return null;

  const actual = await sha256File(abs);
  if (actual !== row.canonical_audio_sha256) {
    return {...serializeRevision(row), usable: false, unusableReason: 'hash_mismatch'};
  }
  return {...serializeRevision(row), usable: true, unusableReason: null};
}

/**
 * 预留给未来 TTS 接入的薄封装（本轮不被任何生产路径调用，只导出）。
 * 调用方必须按双 ID 精确传入；usable=false / null 一律视为不可用。
 */
export async function resolveVoiceRevisionForFutureTts(
  voiceProfileId: string,
  voiceProfileRevisionId: string,
): Promise<VoiceRevisionDescriptor | null> {
  return getVoiceProfileRevisionExact(voiceProfileId, voiceProfileRevisionId);
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

export type IngestVoiceRevisionOutcome =
  | {outcome: 'created'; status: 201; revision: VoiceProfileRevisionRow}
  | {outcome: 'reused'; status: 200; revision: VoiceProfileRevisionRow};

type PrecheckResult =
  | {kind: 'proceed'}
  | {kind: 'reused'; row: VoiceProfileRevisionRow};

/** 同事务内 requestId 裁决：已存在行 → 同 fingerprint reused / 异 fingerprint conflict。 */
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
 * 完整摄取管线（设计文档 §4 顺序）：
 * requestId 快速预检 → staging 写入（0600/O_EXCL/O_NOFOLLOW）→ original sha256
 * → ffprobe original（audio stream 必须有、video stream 必须无、时长在限内）
 * → ffmpeg 固定参数 canonical → ffprobe canonical 复核 → canonical sha256 → fsync
 * → BEGIN IMMEDIATE（复查 requestId / Profile active / 同 Profile canonical hash 去重
 *   / revision_number=MAX+1 / INSERT / 同事务 rename final）
 * → commit → fsync parent dirs → best-effort metadata.json。
 * 任何失败清理 staging；并发同 requestId 由 UNIQUE + 事务内复查兜底。
 */
export async function ingestVoiceProfileRevision(
  input: IngestVoiceRevisionInput,
  deps: VoiceLibraryExecDeps = {},
): Promise<IngestVoiceRevisionOutcome> {
  const ffprobe = deps.ffprobeImpl ?? defaultFfprobe;
  const ffmpeg = deps.ffmpegImpl ?? defaultFfmpeg;
  const db = getDb();

  // 1. 请求字段与大小早判
  validateIngestFields({
    requestId: input.requestId,
    transcript: input.transcript,
    language: input.language,
  });
  if (input.audioBuffer.byteLength > MAX_REFERENCE_UPLOAD_BYTES) {
    throw new VoiceLibraryError(
      'file_too_large',
      413,
      `音频大小 ${(input.audioBuffer.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 25MB`,
    );
  }
  const profile = getVoiceProfile(input.voiceProfileId);
  if (!profile) {
    throw new VoiceLibraryError('profile_not_found', 404, `voice profile ${input.voiceProfileId} 不存在`);
  }

  // 归一化后的存储值
  const transcript = input.transcript ? normalizeTranscript(input.transcript) : '';
  const storedTranscript = transcript.length > 0 ? transcript : null;
  const storedLanguage = input.language?.trim() ? input.language.trim() : null;
  const originalFilenameDisplay = input.originalFilename
    ? sanitizeOriginalFilename(input.originalFilename)
    : null;

  const originalAudioSha256 = crypto
    .createHash('sha256')
    .update(input.audioBuffer)
    .digest('hex');
  const fingerprint = computeVoiceRevisionFingerprint({
    voiceProfileId: input.voiceProfileId,
    originalAudioSha256,
    transcript: storedTranscript,
    language: storedLanguage,
  });

  // 2. requestId 快速预检（BEGIN IMMEDIATE；命中则省掉 canonicalization）
  const precheck = db.transaction((): PrecheckResult =>
    judgeRequestId(input.voiceProfileId, input.requestId, fingerprint),
  );
  const pre = precheck.immediate();
  if (pre.kind === 'reused') {
    return {outcome: 'reused', status: 200, revision: pre.row};
  }

  // 3. staging 写入（0700 目录；0600 文件；O_EXCL|O_NOFOLLOW）
  const rootAbs = voiceLibraryRootAbs();
  assertNotSymlink(rootAbs);
  fs.mkdirSync(rootAbs, {recursive: true});
  const stagingDir = path.join(rootAbs, STAGING_DIR_NAME, crypto.randomUUID());
  fs.mkdirSync(stagingDir, {recursive: true, mode: 0o700});
  const cleanupStaging = (): void => {
    fs.rmSync(stagingDir, {recursive: true, force: true});
  };

  try {
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

    // 4. ffprobe original：必须有 audio stream、必须无 video stream、时长在 [MIN, MAX]
    let probe: ProbedAudio;
    try {
      probe = await ffprobe(originalPath);
    } catch (err) {
      // 详情只进服务端日志：err.message 含 staging 绝对路径，API 响应绝不携带路径。
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

    // 5. ffmpeg → canonical staging（参数全部由服务端固定，上传内容不能影响参数）
    const canonicalStagingPath = path.join(stagingDir, 'canonical.wav');
    try {
      await ffmpeg([
        '-v', 'error', '-y',
        '-i', originalPath,
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

    // 6. ffprobe canonical 复核：codec/sr/channels/duration 必须与常量一致
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

    // 7. fsync canonical 文件
    fsyncFileSync(canonicalStagingPath);

    // 8. BEGIN IMMEDIATE：并发兜底复查 + 去重 + 分配 revision_number + INSERT + 同事务 rename
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
        originalAudioSha256,
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

      // rename 在 commit 前：失败 → 事务回滚，无 DB 行；成功 → committed 行必有 final 文件
      assertNotSymlink(profileDirAbs);
      fs.mkdirSync(profileDirAbs, {recursive: true});
      assertNotSymlink(revisionDirAbs);
      fs.mkdirSync(revisionDirAbs, {recursive: true});
      fs.renameSync(canonicalStagingPath, path.join(revisionDirAbs, CANONICAL_FILENAME));
      return {kind: 'proceed'};
    });
    const committed = commit.immediate();
    if (committed.kind === 'reused') {
      return {outcome: 'reused', status: 200, revision: committed.row};
    }

    // 9. commit 后：fsync 各 parent directory（崩溃持久性）
    fsyncDirSync(revisionDirAbs);
    fsyncDirSync(profileDirAbs);
    fsyncDirSync(rootAbs);

    const row = db
      .prepare('SELECT * FROM voice_profile_revisions WHERE id = ?')
      .get(revisionId) as VoiceProfileRevisionRow;

    // 10. best-effort metadata.json（非权威；权威永远是 DB + reference.wav）
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

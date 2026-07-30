import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {getDataDir, getDb} from '@/lib/db';
import {
  buildRuntimeNarrationLogicalPath,
  computePropsSha256,
  computeSourceKeyForCompilerVersion,
  FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
  FINAL_RENDER_SOURCE_ARTIFACT_KIND,
  finalRenderAttemptSchema,
  finalRenderSourceSchema,
  RUNTIME_NARRATION_PATTERN,
  type FinalRenderAttempt,
  type FinalRenderSource,
} from '@/lib/final-render/schema';
import type {RenderJobRow} from '@/lib/jobs';
import {narrationAudioManifestSchema} from '@/lib/narration/audio';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';

/**
 * Runtime Narration Staging（M3-E Worker 侧）。
 *
 * Remotion 4.0.492 实证：bundler 把 public/ 拷贝到 <bundle>/public，
 * staticFile(x) → <serveUrl>/public/x；serveHandler 按请求从磁盘读——
 * bundle 后 stage 进 <bundle>/public 的文件可被 Renderer 消费。
 *
 * 链：job.payload 出现 runtime-audio/... → final_render_attempt（恰好一条）
 * → final_render_source（exact）→ 校验 key/sha/props deep equal →
 * exact historical narration_audio_manifest（不调 getCurrent*）→
 * manifest/file 完整性 → copy → tmp sha 校验 → rename 到
 * <bundledPublicRoot>/runtime-audio/{projectId}/{audioArtifactId}.wav。
 *
 * Legacy（full/audio/...）与 Preview（narration=null）不匹配 pattern，
 * 完全不进入本模块——行为零变化。
 */

export type RuntimeAudioErrorCode =
  | 'FINAL_RENDER_SOURCE_INVALID'
  | 'NARRATION_SOURCE_INVALID'
  | 'NARRATION_FILE_MISSING'
  | 'NARRATION_SHA_MISMATCH'
  | 'RUNTIME_AUDIO_STAGE_ERROR';

export class RuntimeAudioError extends Error {
  constructor(
    public readonly code: RuntimeAudioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeAudioError';
  }
}

function sha256File(absPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/**
 * bundled public root = <bundleLocation>/public（Remotion 4.0.492 实证结构）。
 * 不存在则创建；拒绝 symlink escape；必须 containment 在 bundleLocation 内。
 */
export function resolveBundledPublicRoot(bundleLocation: string): string {
  const root = path.resolve(bundleLocation);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new RuntimeAudioError(
      'RUNTIME_AUDIO_STAGE_ERROR',
      `bundleLocation 不存在或不是目录: ${bundleLocation}`,
    );
  }
  const pub = path.join(root, 'public');
  if (fs.existsSync(pub) && fs.lstatSync(pub).isSymbolicLink()) {
    const real = fs.realpathSync(pub);
    if (!real.startsWith(root + path.sep)) {
      throw new RuntimeAudioError(
        'RUNTIME_AUDIO_STAGE_ERROR',
        `bundled public root 是指向 bundle 外部的 symlink: ${real}`,
      );
    }
  }
  fs.mkdirSync(pub, {recursive: true});
  const resolved = path.resolve(pub);
  if (!resolved.startsWith(root + path.sep)) {
    throw new RuntimeAudioError(
      'RUNTIME_AUDIO_STAGE_ERROR',
      `bundled public root 越出 bundleLocation: ${resolved}`,
    );
  }
  return resolved;
}

interface ArtifactRow {
  id: string;
  project_id: string;
  version: number;
  content_json: string;
}

function parseAttempt(row: ArtifactRow): FinalRenderAttempt | null {
  try {
    const parsed = finalRenderAttemptSchema.safeParse(JSON.parse(row.content_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseSource(row: ArtifactRow): FinalRenderSource | null {
  try {
    const parsed = finalRenderSourceSchema.safeParse(JSON.parse(row.content_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 查 job 对应的 final_render_attempt（必须恰好一条合法）。 */
function findAttemptForJob(job: RenderJobRow): FinalRenderAttempt {
  const rows = getDb()
    .prepare(`SELECT * FROM artifacts WHERE project_id = ? AND kind = ?`)
    .all(job.project_id, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND) as ArtifactRow[];
  const matches = rows
    .map(parseAttempt)
    .filter((a): a is FinalRenderAttempt => a !== null && a.jobId === job.id);
  if (matches.length !== 1) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      `job ${job.id} 对应的 final_render_attempt 数量=${matches.length}（必须恰好 1）`,
    );
  }
  return matches[0]!;
}

function loadFinalSource(job: RenderJobRow, attempt: FinalRenderAttempt): FinalRenderSource {
  const row = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ? AND version = ?`)
    .get(
      attempt.finalRenderSourceArtifactId,
      job.project_id,
      FINAL_RENDER_SOURCE_ARTIFACT_KIND,
      attempt.finalRenderSourceArtifactVersion,
    ) as ArtifactRow | undefined;
  const source = row ? parseSource(row) : null;
  if (!source) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      `final_render_source ${attempt.finalRenderSourceArtifactId} v${attempt.finalRenderSourceArtifactVersion} 缺失或非法`,
    );
  }
  // ---- persisted source self-integrity gate（不信任存储的 hash 字段，全部重算）----
  // 1. propsSha：必须确实是 source.props 的 hash
  if (source.propsSha256 !== computePropsSha256(source.props)) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      'persisted propsSha256 与 source.props 重算不一致',
    );
  }
  // 2. sourceKey：按 source.compilerVersion 自己重算（historical 1.0 job 仍可执行——
  // 不要求等于当前 compiler 常量；build/current 与 Worker 共用唯一 key algorithm）
  const expectedKey = computeSourceKeyForCompilerVersion({
    compilerVersion: source.compilerVersion,
    projectId: job.project_id,
    source: source.source,
    propsSha256: source.propsSha256,
  });
  if (source.sourceKey !== expectedKey) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      'persisted sourceKey 与 source 内容重算不一致',
    );
  }
  // 3. logicalPath ↔ source audioArtifactId 绑定：防止 metadata 指 Audio B
  // 而 runtime 路径仍写 Audio A 的 cross-binding
  const boundLogical = buildRuntimeNarrationLogicalPath(
    job.project_id,
    source.source.narrationAudioArtifactId,
  );
  if (source.narration.logicalPath !== boundLogical) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      `narration.logicalPath(${source.narration.logicalPath}) 与 source audioArtifactId 绑定路径(${boundLogical}) 不一致`,
    );
  }
  // 4. attempt binding
  if (source.sourceKey !== attempt.sourceKey || source.propsSha256 !== attempt.propsSha256) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      'attempt 与 final_render_source 的 sourceKey/propsSha256 不一致',
    );
  }
  return source;
}

/**
 * 逐层确保 staging 父目录链安全（Hardening：防 parent-chain symlink escape）：
 * 不存在 → mkdir；存在 → 必须是目录或指向 root 内部目录的 symlink；
 * 最终 realpath 必须 containment 在 realPublicRoot 内（不只依赖 path.resolve 字符串）。
 * M6.3.12 起同时供 runtime-assets staging 复用。
 */
export function ensureSafeDirectoryInsideRoot(realPublicRoot: string, segments: string[]): string {
  let current = realPublicRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const lst = fs.lstatSync(current, {throwIfNoEntry: false});
    if (lst) {
      if (lst.isSymbolicLink()) {
        const real = fs.realpathSync(current);
        if (real !== realPublicRoot && !real.startsWith(realPublicRoot + path.sep)) {
          throw new RuntimeAudioError(
            'RUNTIME_AUDIO_STAGE_ERROR',
            `staging 父目录是指向 root 外部的 symlink: ${current} → ${real}`,
          );
        }
        if (!fs.statSync(current).isDirectory()) {
          throw new RuntimeAudioError(
            'RUNTIME_AUDIO_STAGE_ERROR',
            `staging 父目录 symlink 目标不是目录: ${current}`,
          );
        }
      } else if (!lst.isDirectory()) {
        throw new RuntimeAudioError(
          'RUNTIME_AUDIO_STAGE_ERROR',
          `staging 路径段不是目录: ${current}`,
        );
      }
    } else {
      fs.mkdirSync(current);
    }
  }
  const realCurrent = fs.realpathSync(current);
  if (realCurrent !== realPublicRoot && !realCurrent.startsWith(realPublicRoot + path.sep)) {
    throw new RuntimeAudioError(
      'RUNTIME_AUDIO_STAGE_ERROR',
      `staging 父目录 realpath 越出 bundled public root: ${realCurrent}`,
    );
  }
  return current;
}

/**
 * 若 payload.audio.narration 是 runtime narration 逻辑路径：
 * 完成 attempt→source→historical audio 解析并把 master WAV stage 到 bundled public root。
 * 否则返回 null（Legacy/Preview 完全不进入）。
 */
export function stageRuntimeNarrationAudio(
  job: RenderJobRow,
  parsedPayload: ZhiyingFullCutProps,
  bundleLocation: string,
): {stagedPath: string; sha256: string} | null {
  const narration = parsedPayload.audio.narration;
  if (narration === null) return null;
  // runtime-audio 保留命名空间前缀但形态非法（含反斜杠变体）→ 明确拒绝
  if (narration.startsWith('runtime-audio') && !RUNTIME_NARRATION_PATTERN.test(narration)) {
    throw new RuntimeAudioError(
      'RUNTIME_AUDIO_STAGE_ERROR',
      `runtime narration 逻辑路径形态非法: ${narration}`,
    );
  }
  if (!RUNTIME_NARRATION_PATTERN.test(narration)) return null;
  const expectedLogical = narration;

  const attempt = findAttemptForJob(job);
  const source = loadFinalSource(job, attempt);
  // job immutable payload 必须等于 source immutable props snapshot
  if (!isDeepStrictEqual(parsedPayload, source.props)) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      'job payload 与 final_render_source.props 不一致',
    );
  }
  if (source.narration.logicalPath !== expectedLogical) {
    throw new RuntimeAudioError(
      'FINAL_RENDER_SOURCE_INVALID',
      `narration 逻辑路径不一致：payload=${expectedLogical} source=${source.narration.logicalPath}`,
    );
  }
  if (source.narration.masterFilePath.includes('..') || path.isAbsolute(source.narration.masterFilePath)) {
    throw new RuntimeAudioError(
      'NARRATION_SOURCE_INVALID',
      `masterFilePath 非法: ${source.narration.masterFilePath}`,
    );
  }

  // exact historical audio artifact（不调 getCurrent*——上游前进后旧 job 仍渲染旧音频）
  const audioRow = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ? AND version = ?`)
    .get(
      source.source.narrationAudioArtifactId,
      job.project_id,
      'narration_audio_manifest',
      source.source.narrationAudioArtifactVersion,
    ) as ArtifactRow | undefined;
  if (!audioRow) {
    throw new RuntimeAudioError(
      'NARRATION_SOURCE_INVALID',
      `historical audio artifact ${source.source.narrationAudioArtifactId} v${source.source.narrationAudioArtifactVersion} 缺失`,
    );
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(audioRow.content_json);
  } catch {
    throw new RuntimeAudioError('NARRATION_SOURCE_INVALID', 'historical manifest 不是合法 JSON');
  }
  const manifestParsed = narrationAudioManifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    throw new RuntimeAudioError('NARRATION_SOURCE_INVALID', 'historical manifest 未通过 schema');
  }
  const manifest = manifestParsed.data;
  if (
    manifest.master.filePath !== source.narration.masterFilePath ||
    manifest.master.sha256 !== source.source.masterSha256 ||
    manifest.master.durationMs !== source.source.masterDurationMs
  ) {
    throw new RuntimeAudioError(
      'NARRATION_SOURCE_INVALID',
      'historical manifest master 与 final source snapshot 不一致',
    );
  }

  const dataDir = path.resolve(getDataDir());
  const masterAbs = path.resolve(dataDir, source.narration.masterFilePath);
  if (!masterAbs.startsWith(dataDir + path.sep)) {
    throw new RuntimeAudioError(
      'NARRATION_SOURCE_INVALID',
      `master 路径越出 dataDir: ${source.narration.masterFilePath}`,
    );
  }
  if (!fs.existsSync(masterAbs) || fs.statSync(masterAbs).size <= 44) {
    throw new RuntimeAudioError(
      'NARRATION_FILE_MISSING',
      `master WAV 缺失或过小: ${source.narration.masterFilePath}`,
    );
  }
  const masterSha = sha256File(masterAbs);
  if (masterSha !== source.source.masterSha256) {
    throw new RuntimeAudioError(
      'NARRATION_SHA_MISMATCH',
      `master WAV 实际 sha256 与 snapshot 不符: ${source.narration.masterFilePath}`,
    );
  }

  // stage：destination keyed by immutable audioArtifactId
  const publicRoot = resolveBundledPublicRoot(bundleLocation);
  const destAbs = path.resolve(publicRoot, expectedLogical);
  if (!destAbs.startsWith(publicRoot + path.sep)) {
    throw new RuntimeAudioError(
      'RUNTIME_AUDIO_STAGE_ERROR',
      `stage destination 越出 bundled public root: ${expectedLogical}`,
    );
  }
  // parent-chain symlink 防线：realpath containment，逐层校验
  const realPublicRoot = fs.realpathSync(publicRoot);
  ensureSafeDirectoryInsideRoot(realPublicRoot, ['runtime-audio', job.project_id]);
  // destination file 防线：已存在的 destination 不得是 symlink（不跟随读取/覆盖外部文件）
  const destLstat = fs.lstatSync(destAbs, {throwIfNoEntry: false});
  if (destLstat) {
    if (destLstat.isSymbolicLink()) {
      throw new RuntimeAudioError(
        'RUNTIME_AUDIO_STAGE_ERROR',
        `stage destination 是 symlink（拒绝读取/覆盖外部目标）: ${destAbs}`,
      );
    }
    if (!destLstat.isFile()) {
      throw new RuntimeAudioError(
        'RUNTIME_AUDIO_STAGE_ERROR',
        `stage destination 不是 regular file: ${destAbs}`,
      );
    }
    if (sha256File(destAbs) === masterSha) {
      return {stagedPath: destAbs, sha256: masterSha}; // 内容寻址命中，直接 reuse
    }
    fs.rmSync(destAbs, {force: true}); // corrupted regular cache → 重建
  }
  const tmp = `${destAbs}.${crypto.randomUUID()}.tmp`;
  try {
    fs.copyFileSync(masterAbs, tmp);
    if (sha256File(tmp) !== masterSha) {
      throw new RuntimeAudioError('NARRATION_SHA_MISMATCH', 'staged tmp sha256 校验失败');
    }
    fs.renameSync(tmp, destAbs);
  } finally {
    fs.rmSync(tmp, {force: true});
  }
  return {stagedPath: destAbs, sha256: masterSha};
}

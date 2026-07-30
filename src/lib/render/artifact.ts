/**
 * M6.3.11：Final Render 产物完整性与 manifest（P0）。
 *
 * 契约：
 * - 每个成功 Final Render 有不可变 manifest（render_artifacts 表，job_id 为主键）：
 *   outputPath / outputSha256 / outputSize / duration / encoder / payloadSha256 / bundleKey。
 * - job 只有在 output 文件存在 + ffprobe 校验通过 + SHA256 计算 + manifest 落库之后
 *   才能 status=succeeded（见 worker runJob 的 succeeded gate）。
 * - 下载只按 exact job 解析 manifest，校验文件存在 + size 一致；
 *   任何缺失/不一致 → 明确错误，绝不 fallback 旧视频。
 * - 历史 succeeded job（manifest 缺失）首次访问时惰性回填（同文件 SHA 重算一次）。
 */
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {getDataDir, getDb} from '@/lib/db';

const execFileAsync = promisify(execFile);

/** 可注入的 ffprobe 执行器（测试注入伪实现，生产默认真实 ffprobe）。 */
export type FFprobeExec = (absPath: string) => Promise<string>;

export interface RenderArtifactRow {
  job_id: string;
  project_id: string;
  output_path: string;
  output_sha256: string;
  output_size: number;
  duration_sec: number | null;
  frame_count: number | null;
  encoder: string | null;
  payload_sha256: string | null;
  bundle_key: string | null;
  backfilled: number;
  /** M6.3.12：视觉审计 JSON（auditFinalVisuals；历史行 null）。 */
  audit_json: string | null;
  /** M6.3.12：loudnorm 归一化后实测响度 JSON（历史行 null）。 */
  loudness_json: string | null;
  created_at: string;
}

export interface ProbedOutput {
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  /** M6.3.12：音频流 codec（无音轨为 null；质量门可要求必须存在）。 */
  audioCodec: string | null;
}

/** 流式计算文件 SHA256（不一次性读入内存）。 */
export function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** ffprobe 提取视频流信息；ffprobe 缺失/执行失败/无视频流 → throw。 */
export async function probeRenderOutput(
  absPath: string,
  execFn?: FFprobeExec,
): Promise<ProbedOutput> {
  const stdout = execFn
    ? await execFn(absPath)
    : (
        await execFileAsync('ffprobe', [
          '-hide_banner', '-loglevel', 'error',
          '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration',
          '-of', 'json', absPath,
        ])
      ).stdout;
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{codec_type?: string; codec_name?: string; width?: number; height?: number}>;
    format?: {duration?: string};
  };
  const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  const durationSec = Number(parsed.format?.duration ?? 0);
  if (!video || !video.width || !video.height || !(durationSec > 0)) {
    throw new Error(
      `ffprobe 校验失败：无有效视频流或时长（codec=${video?.codec_name ?? 'none'} ` +
        `${video?.width ?? 0}x${video?.height ?? 0} duration=${durationSec}）`,
    );
  }
  return {
    durationSec,
    width: video.width,
    height: video.height,
    codec: video.codec_name ?? 'unknown',
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * succeeded gate 用的输出校验：文件存在、非零、ffprobe 通过。
 * M6.3.12 质量门扩展（opts）：requireAudio → 必须含音轨；
 * expectDurationSec → 实际时长与预期偏差 >1s 即失败。
 * 通过时带回视频流信息（供 manifest 记录 duration）；
 * 失败返回原因（worker 据此 failJob，绝不上 succeeded）。
 */
export type OutputValidation =
  | {ok: true; info: ProbedOutput}
  | {ok: false; reason: string};

export interface OutputValidationOptions {
  requireAudio?: boolean;
  expectDurationSec?: number;
}

export async function validateRenderOutput(
  absPath: string,
  probeFn?: (p: string) => Promise<ProbedOutput>,
  opts?: OutputValidationOptions,
): Promise<OutputValidation> {
  if (!fs.existsSync(absPath)) return {ok: false, reason: `输出文件不存在: ${absPath}`};
  const size = fs.statSync(absPath).size;
  if (size <= 0) return {ok: false, reason: `输出文件为空: ${absPath}`};
  try {
    const info = await (probeFn ?? probeRenderOutput)(absPath);
    if (opts?.requireAudio && !info.audioCodec) {
      return {ok: false, reason: '质量门失败：输出无音轨（requireAudio）'};
    }
    if (
      opts?.expectDurationSec !== undefined &&
      Math.abs(info.durationSec - opts.expectDurationSec) > 1
    ) {
      return {
        ok: false,
        reason: `质量门失败：时长偏差超限（实际 ${info.durationSec.toFixed(3)}s vs 预期 ${opts.expectDurationSec.toFixed(3)}s）`,
      };
    }
    return {ok: true, info};
  } catch (err) {
    return {ok: false, reason: err instanceof Error ? err.message : String(err)};
  }
}

/** output_path 统一为数据目录相对路径；绝对路径原样兼容。 */
export function resolveOutputAbs(outputPath: string): string {
  return path.isAbsolute(outputPath) ? outputPath : path.join(getDataDir(), outputPath);
}

export function getRenderArtifact(jobId: string): RenderArtifactRow | undefined {
  return getDb()
    .prepare('SELECT * FROM render_artifacts WHERE job_id = ?')
    .get(jobId) as RenderArtifactRow | undefined;
}

export function persistRenderArtifact(
  row: Omit<RenderArtifactRow, 'created_at' | 'backfilled' | 'audit_json' | 'loudness_json'> & {
    backfilled?: number;
    audit_json?: string | null;
    loudness_json?: string | null;
  },
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO render_artifacts
       (job_id, project_id, output_path, output_sha256, output_size, duration_sec,
        frame_count, encoder, payload_sha256, bundle_key, backfilled, audit_json,
        loudness_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.job_id, row.project_id, row.output_path, row.output_sha256, row.output_size,
      row.duration_sec, row.frame_count, row.encoder, row.payload_sha256, row.bundle_key,
      row.backfilled ?? 0, row.audit_json ?? null, row.loudness_json ?? null,
      new Date().toISOString(),
    );
}

/**
 * 历史 succeeded job 惰性回填 manifest（M6.3.11 之前的产物没有 manifest）。
 * 文件缺失/校验失败 → 返回 null（调用方据此报错，不 fallback）。
 */
export async function backfillRenderArtifact(
  job: {
    id: string;
    project_id: string;
    output_path: string | null;
  },
  probeFn?: (p: string) => Promise<ProbedOutput>,
): Promise<RenderArtifactRow | null> {
  if (!job.output_path) return null;
  const abs = resolveOutputAbs(job.output_path);
  if (!fs.existsSync(abs)) return null;
  let probed: ProbedOutput | null = null;
  try {
    probed = await (probeFn ?? probeRenderOutput)(abs);
  } catch {
    return null;
  }
  const sha = await sha256File(abs);
  const size = fs.statSync(abs).size;
  persistRenderArtifact({
    job_id: job.id,
    project_id: job.project_id,
    output_path: job.output_path,
    output_sha256: sha,
    output_size: size,
    duration_sec: probed.durationSec,
    frame_count: null,
    encoder: null,
    payload_sha256: null,
    bundle_key: null,
    backfilled: 1,
  });
  return getRenderArtifact(job.id) ?? null;
}

export type JobArtifactResolution =
  | {ok: true; absPath: string; artifact: RenderArtifactRow}
  | {ok: false; status: number; code: string; message: string};

/**
 * 下载/播放共用的 exact-job artifact 解析（Phase 17 单一 identity）。
 * fail-closed：manifest 缺失且回填失败、文件缺失、size 不一致 → 明确错误。
 */
export async function resolveJobArtifact(
  job: {
    id: string;
    project_id: string;
    status: string;
    progress: number;
    output_path: string | null;
  },
  probeFn?: (p: string) => Promise<ProbedOutput>,
): Promise<JobArtifactResolution> {
  if (job.status !== 'succeeded' || !job.output_path) {
    return {
      ok: false, status: 409, code: 'job_not_finished',
      message: `渲染未完成（status=${job.status}）`,
    };
  }
  let artifact = getRenderArtifact(job.id);
  if (!artifact) {
    artifact = (await backfillRenderArtifact(job, probeFn)) ?? undefined;
    if (!artifact) {
      return {
        ok: false, status: 409, code: 'artifact_unvalidated',
        message: '产物缺少有效 manifest（文件缺失或校验失败），拒绝提供下载',
      };
    }
  }
  // manifest 指向的路径必须与 job 记录一致（防 DB 污染后串读其他 job 文件）
  if (artifact.output_path !== job.output_path) {
    return {
      ok: false, status: 409, code: 'artifact_path_mismatch',
      message: 'manifest 与 job 记录的输出路径不一致',
    };
  }
  const absPath = resolveOutputAbs(artifact.output_path);
  if (!fs.existsSync(absPath)) {
    return {
      ok: false, status: 404, code: 'output_missing',
      message: '渲染产物文件不存在（可能已被清理）',
    };
  }
  if (fs.statSync(absPath).size !== artifact.output_size) {
    return {
      ok: false, status: 409, code: 'artifact_mismatch',
      message: '产物文件与 manifest 不一致（size 变化），拒绝提供下载',
    };
  }
  return {ok: true, absPath, artifact};
}

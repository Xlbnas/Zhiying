import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDataDir} from '@/lib/db';
import {getTtsProvider} from '@/lib/tts';
import {TtsError} from '@/lib/tts/types';
import {
  completeTtsJob,
  failTtsJob,
  heartbeatTtsJob,
  isTtsCancelRequested,
  markTtsCancelled,
  requeueTtsJob,
  ttsJobPayloadSchema,
  type TtsJobRow,
} from '@/lib/tts-jobs';

/**
 * TTS 任务执行器（M3-B §三十六–四十三）。
 *
 * 流程：payload 校验 → cancel precheck → provider.synthesize（AbortSignal 贯通）
 * → 写 tmp WAV → 验证（RIFF/大小/ffprobe audio stream/duration>0）
 * → sha256 → 原子 rename → completeTtsJob。
 * 零 Remotion/Chrome 依赖；cancel/shutdown/recovery 语义与 llm-executor 对齐。
 * IndexTTS2 单次 infer 未承诺 mid-inference 可中断——cancel 语义为
 * 「Node 尽快停止等待/不提交结果」，不声称 GPU kernel 即时停止。
 */

const HEARTBEAT_INTERVAL_MS = 5000;
const NON_RETRYABLE_CODES = new Set(['CONFIG_ERROR', 'INVALID_AUDIO', 'PAYLOAD_INVALID']);

export interface TtsExecutorContext {
  isShuttingDown: () => boolean;
  log: (...args: unknown[]) => void;
  shutdownSignal?: AbortSignal;
}

export interface TtsExecutorDeps {
  provider?: import('@/lib/tts/types').TtsProvider;
  heartbeatMs?: number;
  ffprobeImpl?: (filePath: string) => AudioProbe;
}

export interface AudioProbe {
  durationMs: number;
  codec: string;
  sampleRate: number;
  channels: number;
}

/** ffprobe 实测音频元数据（唯一时长真相）。 */
export function probeAudio(filePath: string): AudioProbe {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath,
  ], {encoding: 'utf8'});
  const json = JSON.parse(out) as {
    format?: {duration?: string};
    streams?: Array<{codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number}>;
  };
  const stream = json.streams?.find((s) => s.codec_type === 'audio');
  if (!stream) {
    throw new TtsError('INVALID_AUDIO', 'ffprobe 未找到 audio stream');
  }
  const durationSec = Number(json.format?.duration ?? 0);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new TtsError('INVALID_AUDIO', `ffprobe duration 非法: ${json.format?.duration}`);
  }
  return {
    durationMs: Math.round(durationSec * 1000),
    codec: stream.codec_name ?? 'unknown',
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: stream.channels ?? 0,
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export async function runTtsJob(
  job: TtsJobRow,
  ctx: TtsExecutorContext,
  deps: TtsExecutorDeps = {},
): Promise<void> {
  const {log} = ctx;
  const probe = deps.ffprobeImpl ?? probeAudio;
  let tmpPath: string | null = null;

  const cleanupTmp = (): void => {
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, {force: true});
      tmpPath = null;
    }
  };

  try {
    // 排队期间被请求取消：直接 cancelled
    if (isTtsCancelRequested(job.id)) {
      markTtsCancelled(job.id);
      log(`tts job ${job.id} cancelled before start`);
      return;
    }

    // payload 快照校验
    let payload: ReturnType<typeof ttsJobPayloadSchema.parse>;
    try {
      payload = ttsJobPayloadSchema.parse(JSON.parse(job.payload_json));
    } catch (err) {
      failTtsJob(
        job.id,
        'PAYLOAD_INVALID',
        `payload_json 校验失败：${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
        {retryable: false},
      );
      return;
    }

    const provider = deps.provider ?? getTtsProvider();
    const controller = new AbortController();
    const onShutdownAbort = (): void => controller.abort();
    ctx.shutdownSignal?.addEventListener('abort', onShutdownAbort, {once: true});
    const timer = setInterval(() => {
      heartbeatTtsJob(job.id);
      if (isTtsCancelRequested(job.id)) {
        controller.abort();
      }
    }, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);

    try {
      log(
        `tts job ${job.id} start: project=${job.project_id} unit=${payload.unitId} ` +
          `provider=${provider.name} voice=${job.voice_profile_id}@${job.voice_profile_revision}`,
      );
      const result = await provider.synthesize(
        {
          text: payload.unitText,
          voiceProfile: {id: job.voice_profile_id, revision: job.voice_profile_revision},
          unitId: payload.unitId,
          emotion: {mode: 'none'},
        },
        controller.signal,
      );

      // Commit Fence：写盘前最终 cancel/shutdown 检查（不提交已取消结果）
      if (ctx.isShuttingDown()) {
        requeueTtsJob(job.id);
        log(`tts job ${job.id} requeued due to shutdown（fence，未写盘）`);
        return;
      }
      if (isTtsCancelRequested(job.id)) {
        markTtsCancelled(job.id);
        log(`tts job ${job.id} cancelled（fence，未写盘）`);
        return;
      }

      // 原子写盘：tmp → 验证 → rename
      const relDir = path.posix.join(
        'projects', job.project_id, 'audio', 'units', String(payload.narrationPlanArtifactVersion),
      );
      const relFinal = path.posix.join(relDir, `${payload.unitId}-${job.id}.wav`);
      const absDir = path.join(getDataDir(), relDir);
      fs.mkdirSync(absDir, {recursive: true});
      tmpPath = path.join(getDataDir(), relDir, `${payload.unitId}-${job.id}.tmp`);
      fs.writeFileSync(tmpPath, result.audio);

      // 验证：存在/大小/RIFF/ffprobe audio stream/duration>0
      if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 44) {
        throw new TtsError('INVALID_AUDIO', '写出文件缺失或过小');
      }
      const head = Buffer.alloc(4);
      const fd = fs.openSync(tmpPath, 'r');
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (head.toString('ascii') !== 'RIFF') {
        throw new TtsError('INVALID_AUDIO', '写出内容不是合法 WAV（缺 RIFF 头）');
      }
      const probeResult = probe(tmpPath);
      const sha256 = sha256File(tmpPath);
      fs.renameSync(tmpPath, path.join(getDataDir(), relFinal));
      tmpPath = null;

      if (!completeTtsJob(job.id, relFinal, probeResult.durationMs, sha256)) {
        log(`tts job ${job.id} complete 未生效（任务已不在 running）`);
      }
      log(
        `tts job ${job.id} succeeded: ${payload.unitId} ${probeResult.durationMs}ms ` +
          `${probeResult.codec}/${probeResult.sampleRate}Hz/${probeResult.channels}ch sha256=${sha256.slice(0, 12)}…`,
      );
    } catch (err) {
      cleanupTmp();
      throw err;
    } finally {
      clearInterval(timer);
      ctx.shutdownSignal?.removeEventListener('abort', onShutdownAbort);
    }
  } catch (err) {
    cleanupTmp();
    if (ctx.isShuttingDown()) {
      requeueTtsJob(job.id);
      log(`tts job ${job.id} requeued due to shutdown`);
      return;
    }
    if ((err instanceof TtsError && err.code === 'CANCELLED') || isTtsCancelRequested(job.id)) {
      markTtsCancelled(job.id);
      log(`tts job ${job.id} cancelled`);
      return;
    }
    if (err instanceof TtsError) {
      const retryable = !NON_RETRYABLE_CODES.has(err.code);
      const finalized = failTtsJob(job.id, err.code, err.message.slice(0, 500), {retryable});
      log(`tts job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): ${err.code} → ${finalized}`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    failTtsJob(job.id, 'TTS_ERROR', message.slice(0, 500), {retryable: true});
    log(`tts job ${job.id} failed (attempt ${job.attempt}/${job.max_attempts}): ${message}`);
  }
}

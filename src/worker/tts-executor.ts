import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDataDir} from '@/lib/db';
import {getTtsProviderByName} from '@/lib/tts';
import {TtsError, type TtsProvider} from '@/lib/tts/types';
import {
  anyTtsJobPayloadSchema,
  failTtsJob,
  finalizeTtsJobSuccess,
  heartbeatTtsJob,
  isTtsCancelRequested,
  markTtsCancelled,
  payloadSpokenText,
  requeueTtsJob,
  ttsJobResultSchema,
  type TtsJobRow,
} from '@/lib/tts-jobs';
import {releaseResourceLeaseForJob, heartbeatResourceLease, getResourceLeaseMs} from '@/lib/resources/leases';
import {describeLeakage, findDirectiveLeakage} from '@/lib/narration/leakage';

/**
 * TTS 任务执行器（M3-B §三十六–四十三，M3-B Hardening §五–十三）。
 *
 * 流程：payload 校验 → cancel precheck → 按 job.provider 快照解析 Provider（Registry）
 * → provider.synthesize（AbortSignal 贯通）→ 返回快照与 job 一致性校验
 * → 写 tmp WAV → 验证（RIFF/大小/ffprobe audio stream/duration>0）
 * → sha256 → rename final → finalizeTtsJobSuccess 原子裁决（cancel/success 谁先谁赢）
 * → 非 SUCCEEDED 删除 final WAV。
 * 零 Remotion/Chrome 依赖；cancel/shutdown/recovery 语义与 llm-executor 对齐。
 * IndexTTS2 单次 infer 未承诺 mid-inference 可中断——cancel 语义为
 * 「Node 尽快停止等待/不提交结果」，不声称 GPU kernel 即时停止。
 */

const HEARTBEAT_INTERVAL_MS = 5000;
const NON_RETRYABLE_CODES = new Set([
  'CONFIG_ERROR',
  'INVALID_AUDIO',
  'PAYLOAD_INVALID',
  'PAYLOAD_CONTAMINATED',
  'PROVIDER_INVALID_RESPONSE',
]);

export interface TtsExecutorContext {
  isShuttingDown: () => boolean;
  log: (...args: unknown[]) => void;
  shutdownSignal?: AbortSignal;
  /**
   * M7.3A.2：scheduler 在 claim 时取得的 production_gpu lease token。
   * 执行期间随 job heartbeat 一起续约，避免长时间合成（>lease TTL）期间
   * lease 过期被其他 worker 抢占。
   */
  resourceLease?: {group: 'production_gpu'; ownerToken: string};
}

export interface TtsExecutorDeps {
  /** 测试注入：按 provider name 覆盖 Registry（key 必须等于 job.provider 才生效）。 */
  providers?: Record<string, TtsProvider>;
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
    try {
      // 排队期间被请求取消：直接 cancelled
      if (isTtsCancelRequested(job.id)) {
      markTtsCancelled(job.id);
      log(`tts job ${job.id} cancelled before start`);
      return;
    }

    // payload 快照校验（M7.1：union 兼容 v1.0 unitText 与 v1.1 spokenText+delivery）
    let payload: ReturnType<typeof anyTtsJobPayloadSchema.parse>;
    try {
      payload = anyTtsJobPayloadSchema.parse(JSON.parse(job.payload_json));
    } catch (err) {
      failTtsJob(
        job.id,
        'PAYLOAD_INVALID',
        `payload_json 校验失败：${err instanceof Error ? err.message.slice(0, 300) : String(err)}`,
        {retryable: false},
      );
      return;
    }

    // Gate C（M7.2.1 P0 hotfix）：provider 调用前的最后一道防线。
    // payload 朗读文本含导演指令/DSL 语法位（@delivery/@pause/@silence/括号指令/…）
    // → terminal failure（non-retryable，绝不重试消耗），零 provider 调用。
    // 历史污染 job 即使已入队也在此被拦截，永远到不了 IndexTTS2。
    const spokenLeaks = findDirectiveLeakage(payloadSpokenText(payload));
    if (spokenLeaks.length > 0) {
      failTtsJob(
        job.id,
        'PAYLOAD_CONTAMINATED',
        `payload 朗读文本含导演指令/DSL 语法位，拒绝调用 Provider：` +
          `${describeLeakage(spokenLeaks)}`.slice(0, 500),
        {retryable: false},
      );
      log(`tts job ${job.id} failed: PAYLOAD_CONTAMINATED（gate C，provider calls=0）`);
      return;
    }

    // 执行期唯一来源：job.provider 快照（Registry）；未知 → CONFIG_ERROR（不 fallback）
    const provider = deps.providers?.[job.provider] ?? getTtsProviderByName(job.provider);
    const controller = new AbortController();
    const onShutdownAbort = (): void => controller.abort();
    ctx.shutdownSignal?.addEventListener('abort', onShutdownAbort, {once: true});
    const timer = setInterval(() => {
      heartbeatTtsJob(job.id);
      // M7.3A.2：长时间 TTS 任务期间同步续约 production_gpu lease，
      // 防止 lease 过期后其他 worker 抢占 GPU。
      if (ctx.resourceLease?.group === 'production_gpu') {
        heartbeatResourceLease('production_gpu', ctx.resourceLease.ownerToken, getResourceLeaseMs());
      }
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
          text: payloadSpokenText(payload),
          voiceProfile: {id: job.voice_profile_id, revision: job.voice_profile_revision},
          unitId: payload.unitId,
          // M7.1：v1.1 payload 的 delivery 接通 TtsRequest.style（normal 不传，保持现状声学）
          ...(payload.schemaVersion === 'tts-payload@1.1' && payload.delivery !== 'normal'
            ? {style: {directive: payload.delivery}}
            : {}),
          emotion: {mode: 'none'},
        },
        controller.signal,
      );

      // 返回快照必须与 job 快照一致（§六）：否则是 Provider 契约违约，拒绝提交成功
      if (
        result.provider !== job.provider ||
        result.settings.voiceProfileId !== job.voice_profile_id ||
        result.settings.voiceProfileRevision !== job.voice_profile_revision ||
        result.settings.useRandom !== false
      ) {
        throw new TtsError(
          'PROVIDER_INVALID_RESPONSE',
          `Provider 返回与 job 快照不一致：result.provider=${result.provider} ` +
            `voice=${result.settings.voiceProfileId}@${result.settings.voiceProfileRevision} ` +
            `useRandom=${result.settings.useRandom}（期望 ${job.provider} / ` +
            `${job.voice_profile_id}@${job.voice_profile_revision} / false）`,
        );
      }

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

      // 持久化的 Provider 快照 + ffprobe 元数据（唯一 metadata 来源，zod 把关）
      const persisted = ttsJobResultSchema.safeParse({
        provider: result.provider,
        model: result.model,
        providerVersion: result.providerVersion ?? null,
        providerCommit: result.providerCommit ?? null,
        settings: result.settings,
        audio: {
          codec: probeResult.codec,
          sampleRate: probeResult.sampleRate,
          channels: probeResult.channels,
        },
      });
      if (!persisted.success) {
        throw new TtsError(
          'PROVIDER_INVALID_RESPONSE',
          `Provider 返回 metadata 不合法：${persisted.error.issues[0]?.message ?? 'schema 校验失败'}`,
        );
      }

      const absFinal = path.join(getDataDir(), relFinal);
      fs.renameSync(tmpPath, absFinal);
      tmpPath = null;

      // 终局原子裁决（§十）：cancel 与 success 谁先进入事务谁赢
      const finalized = finalizeTtsJobSuccess(job.id, {
        outputPath: relFinal,
        durationMs: probeResult.durationMs,
        audioSha256: sha256,
        result: persisted.data,
      });
      if (finalized !== 'SUCCEEDED') {
        // §十一：DB 未判成功（cancel 赢 / job 已不在 running）→ 删除刚 rename 的 final WAV
        fs.rmSync(absFinal, {force: true});
        log(`tts job ${job.id} finalize=${finalized}（已清理 final WAV）`);
        return;
      }
      log(
        `tts job ${job.id} succeeded: ${payload.unitId} ${probeResult.durationMs}ms ` +
          `${probeResult.codec}/${probeResult.sampleRate}Hz/${probeResult.channels}ch ` +
          `model=${persisted.data.model} commit=${persisted.data.providerCommit ?? 'n/a'} ` +
          `sha256=${sha256.slice(0, 12)}…`,
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
  } finally {
    try {
      releaseResourceLeaseForJob('production_gpu', 'tts', job.id);
    } catch {
      // lease 释放失败不阻断
    }
  }
}

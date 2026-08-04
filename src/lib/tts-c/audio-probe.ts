/**
 * TTS-C.1A 共享音频工具（lib 层，供 worker executor 与 materialization validator 复用）：
 * - probeAudio：ffprobe 实测音频元数据（唯一时长真相；与 tts-executor 原实现同语义）；
 * - sha256FileBytes：流式 SHA256（regular file 内容校验）。
 * 避免 lib/tts-c 反向依赖 worker 层造成循环。
 */
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {TtsError} from '@/lib/tts/types';

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

/** 流式 SHA256（1MB buffer，不整读入内存）。 */
export async function sha256FileBytes(absPath: string): Promise<string> {
  const fh = await fs.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const hash = crypto.createHash('sha256');
    let pos = 0;
    for (;;) {
      const {bytesRead} = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

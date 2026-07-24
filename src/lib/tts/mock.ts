import {
  TtsError,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
} from './types';

/**
 * Mock TTS Provider（M3-B §十二）：deterministic，零网络。
 * 由 unit text + unit id 生成合法 PCM WAV（48kHz / mono / s16）。
 * 相同输入永远得到相同字节——Mock duration 只用于测试，不代表生产 TTS 时长模型。
 */

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 由输入确定时长（ms）：基础 600ms + 每字符 80ms，上限 6000ms。 */
export function mockDurationMs(text: string): number {
  return Math.min(600 + text.length * 80, 6000);
}

/** 生成确定性 PCM tone WAV（48kHz mono s16）。 */
export function buildMockWav(text: string, unitId: string): Buffer {
  const durationMs = mockDurationMs(text);
  const sampleCount = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const dataSize = sampleCount * CHANNELS * BYTES_PER_SAMPLE;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28);
  buffer.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // 确定性频率（由 unitId hash 决定 220–340Hz 区间）与包络
  const freq = 220 + (fnv1a(unitId) % 120);
  const amp = 8000;
  for (let i = 0; i < sampleCount; i++) {
    const t = i / SAMPLE_RATE;
    // 两端 10ms 淡入淡出，避免爆音
    const edge = Math.min(1, i / (SAMPLE_RATE * 0.01), (sampleCount - i) / (SAMPLE_RATE * 0.01));
    const value = Math.round(amp * edge * Math.sin(2 * Math.PI * freq * t));
    buffer.writeInt16LE(value, headerSize + i * BYTES_PER_SAMPLE);
  }
  return buffer;
}

export class MockTtsProvider implements TtsProvider {
  readonly name = 'mock';

  constructor(private readonly options: {delayMs?: number} = {}) {}

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    if (signal?.aborted) {
      throw new TtsError('CANCELLED', '请求在发出前已被取消');
    }
    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new TtsError('CANCELLED', '请求已被用户取消'));
          },
          {once: true},
        );
      });
    }
    const audio = buildMockWav(request.text, request.unitId);
    return {
      audio,
      format: 'wav',
      provider: 'mock',
      model: 'mock-tone-v1',
      providerCommit: 'mock-deterministic',
      settings: {
        voiceProfileId: request.voiceProfile.id,
        voiceProfileRevision: request.voiceProfile.revision,
        useRandom: false,
      },
    };
  }

  health(): Promise<{ready: boolean; provider: string; model: string}> {
    return Promise.resolve({ready: true, provider: 'mock', model: 'mock-tone-v1'});
  }
}

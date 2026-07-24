import {IndexTts2Provider} from './indextts2';
import {MockTtsProvider} from './mock';
import {TtsError, type TtsProvider, type TtsVoiceProfile} from './types';

/**
 * TTS Provider 选择器（M3-B，与 llm/index.ts 同一安全模型）。
 *
 * - TTS_PROVIDER=mock|indextts2 显式选择。
 * - production：mock → CONFIG_ERROR；未配置 → CONFIG_ERROR；indextts2 无 baseUrl → CONFIG_ERROR。
 * - dev/test：未配置可 fallback mock（warning）；显式 mock 允许。
 */

export interface TtsProviderEnv {
  TTS_PROVIDER?: string;
  INDEXTTS2_BASE_URL?: string;
  NODE_ENV?: string;
}

export const DEFAULT_VOICE_PROFILE: TtsVoiceProfile = {id: 'default', revision: '1'};

export function createTtsProviderFromEnv(
  env: TtsProviderEnv,
  options?: {warn?: (message: string) => void},
): TtsProvider {
  const warn = options?.warn ?? ((message: string) => console.warn(message));
  const isProduction = env.NODE_ENV === 'production';
  const providerName = env.TTS_PROVIDER?.trim().toLowerCase();

  if (providerName === 'mock') {
    if (isProduction) {
      throw new TtsError('CONFIG_ERROR', 'production 环境禁止使用 Mock TTS Provider');
    }
    return new MockTtsProvider();
  }
  if (providerName === 'indextts2') {
    const baseUrl = env.INDEXTTS2_BASE_URL;
    if (!baseUrl || baseUrl.trim().length === 0) {
      throw new TtsError('CONFIG_ERROR', 'TTS_PROVIDER=indextts2 但未配置 INDEXTTS2_BASE_URL');
    }
    return new IndexTts2Provider({baseUrl});
  }
  if (!providerName) {
    if (isProduction) {
      throw new TtsError('CONFIG_ERROR', 'production 环境必须显式配置 TTS_PROVIDER');
    }
    warn('[tts] 未配置 TTS_PROVIDER，开发/测试环境 fallback 为 Mock TTS Provider');
    return new MockTtsProvider();
  }
  throw new TtsError('CONFIG_ERROR', `未知 TTS_PROVIDER: "${env.TTS_PROVIDER}"`);
}

let cached: TtsProvider | null = null;

export function getTtsProvider(): TtsProvider {
  if (!cached) {
    cached = createTtsProviderFromEnv(process.env);
  }
  return cached;
}

/** 仅测试用：重置单例缓存。 */
export function resetTtsProviderForTest(): void {
  cached = null;
}

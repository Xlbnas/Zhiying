/**
 * Provider 选择器（M2-B 安全规则）。
 *
 * - LLM_PROVIDER=mock|deepseek 显式选择。
 * - production（NODE_ENV=production）：
 *     mock           → CONFIG_ERROR
 *     未配置 provider → CONFIG_ERROR
 *     deepseek 无 Key → CONFIG_ERROR
 *   禁止 production 自动 fallback Mock（防止生产悄悄产生假数据）。
 * - development / test：
 *     允许显式 mock；未配置 provider 可 fallback mock，但必须输出 warning。
 * - LLM_PROVIDER=deepseek 而缺少 DEEPSEEK_API_KEY：任何环境一律 CONFIG_ERROR。
 */

import {DeepSeekProvider} from './deepseek';
import {MockLLMProvider} from './mock';
import {LLMError, type LLMProvider} from './types';

export interface ProviderEnv {
  LLM_PROVIDER?: string;
  DEEPSEEK_API_KEY?: string;
  NODE_ENV?: string;
}

/** 纯函数：按环境构造 Provider（测试可直接注入 env，不污染 process.env）。 */
export function createProviderFromEnv(
  env: ProviderEnv,
  options?: {warn?: (message: string) => void},
): LLMProvider {
  const warn = options?.warn ?? ((message: string) => console.warn(message));
  const isProduction = env.NODE_ENV === 'production';
  const providerName = env.LLM_PROVIDER?.trim().toLowerCase();

  if (providerName === 'mock') {
    if (isProduction) {
      throw new LLMError(
        'CONFIG_ERROR',
        'production 环境禁止使用 Mock Provider（LLM_PROVIDER=mock）',
      );
    }
    return new MockLLMProvider();
  }

  if (providerName === 'deepseek') {
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new LLMError(
        'CONFIG_ERROR',
        'LLM_PROVIDER=deepseek 但未配置 DEEPSEEK_API_KEY',
      );
    }
    return new DeepSeekProvider({apiKey});
  }

  if (!providerName) {
    if (isProduction) {
      throw new LLMError(
        'CONFIG_ERROR',
        'production 环境必须显式配置 LLM_PROVIDER（禁止隐式 fallback）',
      );
    }
    warn('[llm] 未配置 LLM_PROVIDER，开发/测试环境 fallback 为 Mock Provider');
    return new MockLLMProvider();
  }

  throw new LLMError('CONFIG_ERROR', `未知 LLM_PROVIDER: "${env.LLM_PROVIDER}"`);
}

let cached: LLMProvider | null = null;

/** 进程级单例（API/Worker 共用）；测试请用 createProviderFromEnv。 */
export function getProvider(): LLMProvider {
  if (!cached) {
    cached = createProviderFromEnv(process.env);
  }
  return cached;
}

/** 仅测试用：重置单例缓存。 */
export function resetProviderForTest(): void {
  cached = null;
}

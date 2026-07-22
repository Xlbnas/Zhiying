/**
 * DeepSeek Provider（M2-B）。
 *
 * - Node 原生 fetch（可注入 fetchImpl 供测试），不引入 OpenAI SDK。
 * - OpenAI 兼容端点 POST {baseUrl}/chat/completions，显式 stream:false。
 * - thinking 显式发送（enabled/disabled），不依赖供应商默认值；
 *   reasoning_effort 仅在 enabled 时发送（官方取值 high/max）。
 * - JSON 阶段发送 response_format:{type:'json_object'}。
 * - 思考模式不支持 temperature/top_p 等采样参数，一律不发送。
 * - timeout（AbortController）+ 网络瞬时失败/429/5xx 最多 retry 1 次，禁止无限 retry。
 * - 完整解析官方 usage：prompt_tokens / prompt_cache_hit_tokens /
 *   prompt_cache_miss_tokens / completion_tokens / completion_tokens_details.reasoning_tokens。
 * - API Key 只进 Authorization 头；永不 console.log / 入库 / 进错误堆栈。
 *
 * 响应约定（与 executor 分工）：
 * - 2xx 且结构完整 → 原样返回 LLMResponse（text 可能为空、finishReason 可能为
 *   'length'；由 executor 在记录 usage 后判定 EMPTY_RESPONSE / OUTPUT_TRUNCATED）。
 * - 2xx 但结构不完整（缺 choices / 缺 usage）→ PROVIDER_INVALID_RESPONSE，
 *   此时没有可靠 usage，不伪造成本。
 */

import {
  clipText,
  LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from './types';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 2; // 首次 + 最多 retry 1 次
const RETRY_DELAY_MS = 500;

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** 测试注入用；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionUsageJson {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {reasoning_tokens?: number};
}

interface ChatCompletionJson {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {content?: string | null};
    finish_reason?: string;
  }>;
  usage?: ChatCompletionUsageJson;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LLMError('CONFIG_ERROR', 'DeepSeek Provider 缺少 API Key（DEEPSEEK_API_KEY）');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildBody(request);
    let lastError: LLMError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attemptOnce(body);
      } catch (err) {
        const llmErr =
          err instanceof LLMError
            ? err
            : new LLMError('PROVIDER_HTTP_ERROR', `网络请求失败：${String(err)}`, {
                retryable: true,
                cause: err,
              });
        lastError = llmErr;
        if (!llmErr.retryable || attempt === MAX_ATTEMPTS) {
          throw llmErr;
        }
        await sleep(RETRY_DELAY_MS);
      }
    }
    // 不可达（循环必然 return/throw），仅为类型收敛。
    throw lastError ?? new LLMError('PROVIDER_HTTP_ERROR', '未知请求失败');
  }

  private buildBody(request: LLMRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [
        {role: 'system', content: request.system},
        {role: 'user', content: request.user},
      ],
      stream: false,
      thinking: {type: request.thinking},
    };
    if (request.thinking === 'enabled') {
      body.reasoning_effort = request.reasoningEffort ?? 'high';
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.outputMode === 'json') {
      body.response_format = {type: 'json_object'};
    }
    return body;
  }

  private async attemptOnce(body: Record<string, unknown>): Promise<LLMResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError('PROVIDER_TIMEOUT', `DeepSeek 请求超时（${this.timeoutMs}ms）`, {
          retryable: true,
          cause: err,
        });
      }
      throw new LLMError('PROVIDER_HTTP_ERROR', `DeepSeek 网络错误：${String(err)}`, {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const snippet = clipText(await res.text().catch(() => ''), 500);
      const retryable = res.status === 429 || res.status >= 500;
      throw new LLMError(
        'PROVIDER_HTTP_ERROR',
        `DeepSeek HTTP ${res.status}：${snippet}`,
        {status: res.status, retryable},
      );
    }

    let json: ChatCompletionJson;
    try {
      json = (await res.json()) as ChatCompletionJson;
    } catch (err) {
      throw new LLMError('PROVIDER_INVALID_RESPONSE', 'DeepSeek 响应不是合法 JSON', {
        status: res.status,
        cause: err,
      });
    }

    const choice = json.choices?.[0];
    if (!choice || typeof json.id !== 'string' || typeof json.model !== 'string') {
      throw new LLMError(
        'PROVIDER_INVALID_RESPONSE',
        `DeepSeek 响应缺少 id/model/choices：${clipText(JSON.stringify(json), 300)}`,
        {status: res.status},
      );
    }
    const usage = parseUsage(json.usage);
    if (!usage) {
      throw new LLMError(
        'PROVIDER_INVALID_RESPONSE',
        'DeepSeek 响应缺少 usage，按契约不伪造成本',
        {status: res.status},
      );
    }

    return {
      text: choice.message?.content ?? '',
      requestId: json.id,
      model: json.model,
      finishReason: choice.finish_reason ?? '',
      usage,
    };
  }
}

function parseUsage(raw: ChatCompletionUsageJson | undefined): LLMUsage | null {
  if (!raw) return null;
  const {prompt_tokens: prompt, completion_tokens: completion} = raw;
  if (typeof prompt !== 'number' || typeof completion !== 'number') return null;
  const cacheHit = raw.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = raw.prompt_cache_miss_tokens ?? Math.max(prompt - cacheHit, 0);
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  return {
    promptTokens: prompt,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    completionTokens: completion,
    reasoningTokens: typeof reasoning === 'number' ? reasoning : undefined,
  };
}

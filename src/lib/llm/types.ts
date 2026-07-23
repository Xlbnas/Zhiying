/**
 * 知影 LLM Provider 契约（M2-B，M2 实施计划 §1.4）。
 *
 * 边界：
 * - 本层只负责「请求 → 响应 + usage 快照」，不写 DB、不碰 workflow。
 * - 程序逻辑一律通过 LLMError.code 判断错误类型，禁止解析 message 文本。
 */

export type LLMOutputMode = 'text' | 'json';

/** thinking 必须由 stage config 显式决定，不得依赖供应商默认值。 */
export type LLMThinking = 'enabled' | 'disabled';

/** DeepSeek 官方：reasoning_effort 仅支持 high / max（low/medium 会被映射为 high）。 */
export type LLMReasoningEffort = 'high' | 'max';

export interface LLMRequest {
  model: string;
  system: string;
  user: string;
  outputMode: LLMOutputMode;
  thinking: LLMThinking;
  /** thinking=enabled 时显式给出；disabled 时不发送。 */
  reasoningEffort?: LLMReasoningEffort;
  maxTokens?: number;
  /** 外部取消信号（Worker graceful cancel）；与 Provider 内部 timeout 严格区分。 */
  signal?: AbortSignal;
  /** 调用方元信息（如 stage），Provider 不发送给供应商，仅供 Mock/日志使用。 */
  meta?: {stage?: string};
}

/** 官方 usage 完整解析（DeepSeek：缓存命中/未命中分列；reasoning 已含于 completion）。 */
export interface LLMUsage {
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  /** thinking 模式的思维链 tokens；已包含在 completionTokens 内，不得重复计费。 */
  reasoningTokens?: number;
}

export interface LLMResponse {
  text: string;
  requestId: string;
  model: string;
  finishReason: string;
  usage: LLMUsage;
}

export const LLM_ERROR_CODES = [
  'CONFIG_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_HTTP_ERROR',
  'PROVIDER_INVALID_RESPONSE',
  'EMPTY_RESPONSE',
  'OUTPUT_TRUNCATED',
  'VALIDATION_FAILED',
  'CANCELLED',
] as const;

export type LLMErrorCode = (typeof LLM_ERROR_CODES)[number];

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  /** 供应商 HTTP 状态码（如有）。 */
  readonly status?: number;
  /** 是否值得再做一次 provider 层 retry（网络瞬时失败 / 429 / 5xx）。 */
  readonly retryable: boolean;

  constructor(
    code: LLMErrorCode,
    message: string,
    options?: {status?: number; retryable?: boolean; cause?: unknown},
  ) {
    super(message, options?.cause === undefined ? undefined : {cause: options.cause});
    this.name = 'LLMError';
    this.code = code;
    this.status = options?.status;
    this.retryable = options?.retryable ?? false;
  }
}

export interface LLMProvider {
  readonly name: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}

/** 环境变量读取的最小契约（NodeJS.ProcessEnv 与子集字面量均可传入）。 */
export type LlmEnv = Record<string, string | undefined>;

/**
 * 截断文本用于错误信息/日志（限制长度，且不包含任何 secret——
 * API Key 只存在于 Authorization 头，从不进入 message 或堆栈）。
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

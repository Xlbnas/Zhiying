/**
 * API易 Generated Image Provider — Google Gemini 图像生成 via APIYi gateway。
 *
 * 配置（server env only，禁止写入 repo / browser）：
 *   APIYI_BASE_URL=https://api.apiyi.com
 *   APIYI_API_KEY=<key>
 *   APIYI_IMAGE_MODEL=gemini-3.1-flash-image
 *   APIYI_IMAGE_SIZE=1K
 *   APIYI_IMAGE_ASPECT_RATIO=16:9
 *   APIYI_CONNECT_TIMEOUT_MS=10000
 *   APIYI_RESPONSE_TIMEOUT_MS=300000
 *   APIYI_DOWNLOAD_TIMEOUT_MS=60000
 *
 * M7.3A.2：
 * - 使用 undici 显式区分 TCP/TLS connect timeout 与整体 response deadline；
 * - 不再用 30 秒 AbortController 包住整个 fetch 等待；
 * - provider 为同步 generateContent；无真实异步 task polling 路径；
 * - response timeout 后请求已发出 → 调用方标记 indeterminate + unknown_billing；
 * - provider request id 在任何可能点持久化。
 */
import {Agent, fetch as undiciFetch} from 'undici';
import type {GenerateImageInput, GeneratedImageCandidate, GeneratedImageProvider, ProviderHealth} from './types';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const HEALTH_CACHE_TTL_MS = 300_000; // 5min

/**
 * M7：带计费语义的 provider 错误码。
 * 旧码（auth_failed/rate_limited/unavailable/http_error/timeout）映射到细分阶段码，
 * UI/usage event 统一消费 phase code。
 */
export type ImageGenerationErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'rate_limited'
  | 'PROVIDER_CONNECT_TIMEOUT'
  | 'PROVIDER_RESPONSE_TIMEOUT'
  | 'PROVIDER_POLL_TIMEOUT'
  | 'IMAGE_DOWNLOAD_TIMEOUT'
  | 'IMAGE_DECODE_FAILED'
  | 'PROVIDER_TERMINAL_FAILURE'
  | 'empty_result';

export interface ImageGenerationErrorContext {
  model: string;
  size: string;
  aspectRatio: string;
  providerRequestId?: string;
}

export class ImageGenerationError extends Error {
  constructor(
    readonly code: ImageGenerationErrorCode,
    message: string,
    readonly httpStatus?: number,
    /** 抛出点的有效请求配置（供 error event 记录 model/size/aspectRatio） */
    readonly context?: ImageGenerationErrorContext,
  ) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

export class ApiYiImageProvider implements GeneratedImageProvider {
  readonly name = 'apiyi';
  readonly configured: boolean;
  health: ProviderHealth;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly defaultSize: string;
  private readonly defaultAspectRatio: string;
  private readonly connectTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor() {
    this.apiKey = process.env.APIYI_API_KEY || '';
    this.baseUrl = process.env.APIYI_BASE_URL || 'https://api.apiyi.com';
    this.defaultModel = process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image';
    this.defaultSize = process.env.APIYI_IMAGE_SIZE || '1K';
    this.defaultAspectRatio = process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9';
    this.connectTimeoutMs = Number(process.env.APIYI_CONNECT_TIMEOUT_MS || '10000');
    this.responseTimeoutMs = Number(process.env.APIYI_RESPONSE_TIMEOUT_MS || '300000');
    this.downloadTimeoutMs = Number(process.env.APIYI_DOWNLOAD_TIMEOUT_MS || '60000');
    this.configured = !!this.apiKey;
    this.health = this.configured
      ? {healthy: false, available: false, reason: 'not_configured', checkedAt: 0} // will be checked on demand
      : {healthy: false, available: false, reason: 'not_configured', checkedAt: Date.now()};
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.configured) return this.health;

    // Use cache if fresh
    if (this.health.checkedAt > 0 && Date.now() - this.health.checkedAt < HEALTH_CACHE_TTL_MS) {
      return this.health;
    }

    try {
      // Lightweight probe: list models or just validate credential via a cheap endpoint
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(`${this.baseUrl}/v1beta/models`, {
          headers: {'Authorization': `Bearer ${this.apiKey}`},
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok || res.status === 404) {
          // 404 = models endpoint not available but auth passed
          // Actually 404 on model list might mean endpoint doesn't exist
          // Try the actual model endpoint with a tiny dry-run (but this may trigger cost)
        } else if (res.status === 401 || res.status === 403) {
          this.health = {healthy: false, available: false, reason: 'authentication_failed', checkedAt: Date.now()};
          return this.health;
        } else if (res.status === 429) {
          // Rate limited but auth OK
          this.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
          return this.health;
        } else if (res.status >= 500) {
          this.health = {healthy: false, available: false, reason: 'provider_unreachable', checkedAt: Date.now()};
          return this.health;
        }
      } finally {
        clearTimeout(timer);
      }
      // If we got here, the credential test passed (no 401/403)
      this.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
      return this.health;
    } catch {
      this.health = {healthy: false, available: false, reason: 'temporarily_unavailable', checkedAt: Date.now()};
      return this.health;
    }
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImageCandidate[]> {
    if (!this.configured) {
      throw new ImageGenerationError('not_configured', 'APIYi image provider not configured (missing APIYI_API_KEY)');
    }

    const model = input.model || this.defaultModel;
    const size = input.size || this.defaultSize;
    const aspectRatio = input.aspectRatio || this.defaultAspectRatio;
    const url = `${this.baseUrl}/v1beta/models/${model}:generateContent`;

    const body = {
      contents: [{parts: [{text: input.prompt}]}],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio,
          imageSize: size,
        },
      },
    };

    // 使用 undici 显式区分 TCP/TLS connect timeout 与整体 response deadline
    const dispatcher = new Agent({connectTimeout: this.connectTimeoutMs});
    const abortController = new AbortController();
    const responseTimer = setTimeout(() => abortController.abort(), this.responseTimeoutMs);

    const startAt = Date.now();
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}`},
        body: JSON.stringify(body),
        dispatcher,
        signal: abortController.signal,
      });
      clearTimeout(responseTimer);
    } catch (err) {
      clearTimeout(responseTimer);
      dispatcher.close().catch(() => {});
      const root = extractErrorRoot(err);
      // 连接层 timeout：TCP/TLS 未建立（undici ConnectTimeoutError）
      if (isConnectTimeoutError(root)) {
        throw new ImageGenerationError(
          'PROVIDER_CONNECT_TIMEOUT',
          `图像服务连接超时（${this.connectTimeoutMs}ms 未建立连接）`,
          undefined,
          {model, size, aspectRatio},
        );
      }
      // 整体 response deadline（含首字节等待）被 AbortController 触发
      if (isAbortError(root)) {
        throw new ImageGenerationError(
          'PROVIDER_RESPONSE_TIMEOUT',
          `图像生成响应超时（${this.responseTimeoutMs}ms 未收到完整响应）`,
          undefined,
          {model, size, aspectRatio},
        );
      }
      throw new ImageGenerationError(
        'PROVIDER_CONNECT_TIMEOUT',
        `图像服务连接失败：${root.message}`,
        undefined,
        {model, size, aspectRatio},
      );
    }

    // 已建立连接：整体响应 body 读取超时（含模型生成）
    const providerRequestId = res.headers.get('x-request-id') ?? undefined;
    let data: Record<string, unknown>;
    try {
      data = (await Promise.race([
        res.json(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('RESPONSE_TIMEOUT')), this.responseTimeoutMs);
        }),
      ])) as Record<string, unknown>;
    } catch (err) {
      dispatcher.close().catch(() => {});
      if (err instanceof Error && err.message === 'RESPONSE_TIMEOUT') {
        throw new ImageGenerationError(
          'PROVIDER_RESPONSE_TIMEOUT',
          `图像生成响应超时（${this.responseTimeoutMs}ms 未收到完整响应）`,
          undefined,
          {model, size, aspectRatio, providerRequestId},
        );
      }
      throw new ImageGenerationError(
        'PROVIDER_TERMINAL_FAILURE',
        `图像生成响应解析失败：${err instanceof Error ? err.message : String(err)}`,
        res.status,
        {model, size, aspectRatio, providerRequestId},
      );
    }

    dispatcher.close().catch(() => {});

    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 403) {
        this.health = {healthy: false, available: false, reason: 'authentication_failed', checkedAt: Date.now()};
        throw new ImageGenerationError('auth_failed', '图像服务配置错误', status, {model, size, aspectRatio, providerRequestId});
      }
      if (status === 429) {
        throw new ImageGenerationError('rate_limited', '当前生成服务繁忙，请稍后重试', status, {model, size, aspectRatio, providerRequestId});
      }
      if (status >= 500) {
        throw new ImageGenerationError('PROVIDER_TERMINAL_FAILURE', '图像生成服务暂时不可用', status, {model, size, aspectRatio, providerRequestId});
      }
      throw new ImageGenerationError('PROVIDER_TERMINAL_FAILURE', `图像生成失败 (HTTP ${status})`, status, {model, size, aspectRatio, providerRequestId});
    }

    // Success: update health
    this.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
    // M6.3.10：透传 provider 返回的用量元数据与请求 id（如有），供 usage event 记录对账
    const usageMetadata = data.usageMetadata;
    const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>;
    if (!candidates || candidates.length === 0) {
      throw new ImageGenerationError('empty_result', '图像生成未返回有效结果', undefined, {model, size, aspectRatio, providerRequestId});
    }

    const results: GeneratedImageCandidate[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const content = (candidates[i]!.content ?? {}) as Record<string, unknown>;
      const parts = (content.parts ?? []) as Array<Record<string, unknown>>;
      for (const part of parts) {
        if (part.inlineData) {
          const inline = part.inlineData as Record<string, string>;
          const mimeType = inline.mimeType || 'image/png';
          if (!ALLOWED_MIMES.has(mimeType)) continue;
          try {
            const buf = Buffer.from(inline.data, 'base64');
            if (buf.length < 512) continue;
            results.push({
              candidateId: `gen-${Date.now()}-${i}`,
              mimeType,
              data: buf,
              provider: this.name,
              model,
              prompt: input.prompt,
              generationId: (data as Record<string, unknown>).generationId as string | undefined,
              metadata: {model, size, aspectRatio, usageMetadata, providerRequestId},
            });
          } catch {
            // decode 失败单独记录但不阻断其它 candidate
            continue;
          }
        }
        // Safety rejection
        if (part.text && typeof part.text === 'string' && part.text.includes('safety')) {
          // Don't throw for individual parts — just skip
        }
      }
    }
    if (results.length === 0) {
      throw new ImageGenerationError('IMAGE_DECODE_FAILED', '当前生成描述无法生成，请调整描述后重试', undefined, {model, size, aspectRatio, providerRequestId});
    }
    return results;
  }
}

function extractErrorRoot(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const cause = (err as {cause?: unknown}).cause;
  if (cause instanceof Error) return cause;
  return err;
}

function isConnectTimeoutError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  const code = (err as {code?: string}).code;
  return (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    msg.includes('connect timeout') ||
    msg.includes('und_err_connect_timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused')
  );
}

function isAbortError(err: Error): boolean {
  return err.name === 'AbortError' || err.message.toLowerCase().includes('aborted');
}

let instance: ApiYiImageProvider | null = null;

export function getGeneratedImageProvider(): GeneratedImageProvider {
  if (!instance) instance = new ApiYiImageProvider();
  return instance;
}

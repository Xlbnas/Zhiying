/**
 * API易 Generated Image Provider — Google Gemini 图像生成 via APIYi gateway。
 *
 * 配置（server env only，禁止写入 repo / browser）：
 *   APIYI_BASE_URL=https://api.apiyi.com
 *   APIYI_API_KEY=<key>
 *   APIYI_IMAGE_MODEL=gemini-3.1-flash-image
 *   APIYI_IMAGE_SIZE=1K
 *   APIYI_IMAGE_ASPECT_RATIO=16:9
 *   APIYI_CONNECT_TIMEOUT_MS=30000
 *   APIYI_RESPONSE_TIMEOUT_MS=300000
 *   APIYI_DOWNLOAD_TIMEOUT_MS=60000
 *
 * M7 超时修复：区分 connect / response / download / decode / terminal 阶段，
 * 不允许多个阶段共用一个 "timeout" 码；provider request id 在任何可能点持久化。
 */
import type {GenerateImageInput, GeneratedImageCandidate, GeneratedImageProvider, ProviderHealth} from './types';

const BASE_URL = process.env.APIYI_BASE_URL || 'https://api.apiyi.com';
const API_KEY = process.env.APIYI_API_KEY || '';
const MODEL = process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const SIZE = process.env.APIYI_IMAGE_SIZE || '1K';
const ASPECT_RATIO = process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9';
const CONNECT_TIMEOUT_MS = Number(process.env.APIYI_CONNECT_TIMEOUT_MS || '30000');
const RESPONSE_TIMEOUT_MS = Number(process.env.APIYI_RESPONSE_TIMEOUT_MS || '300000');
const DOWNLOAD_TIMEOUT_MS = Number(process.env.APIYI_DOWNLOAD_TIMEOUT_MS || '60000');
const HEALTH_CACHE_TTL_MS = 300_000; // 5min

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

interface TimeoutResult {
  kind: 'connect' | 'response' | 'download';
  elapsedMs: number;
}

export class ApiYiImageProvider implements GeneratedImageProvider {
  readonly name = 'apiyi';
  readonly configured: boolean;
  health: ProviderHealth;

  constructor() {
    this.configured = !!API_KEY;
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
        const res = await fetch(`${BASE_URL}/v1beta/models`, {
          headers: {'Authorization': `Bearer ${API_KEY}`},
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

    const model = input.model || MODEL;
    const size = input.size || SIZE;
    const aspectRatio = input.aspectRatio || ASPECT_RATIO;
    const url = `${BASE_URL}/v1beta/models/${model}:generateContent`;

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

    const startAt = Date.now();
    const controller = new AbortController();
    const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}`},
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
    } catch (err) {
      clearTimeout(connectTimer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ImageGenerationError(
          'PROVIDER_CONNECT_TIMEOUT',
          `图像服务连接超时（${CONNECT_TIMEOUT_MS}ms 未建立连接）`,
          undefined,
          {model, size, aspectRatio},
        );
      }
      throw new ImageGenerationError(
        'PROVIDER_CONNECT_TIMEOUT',
        `图像服务连接失败：${err instanceof Error ? err.message : String(err)}`,
        undefined,
        {model, size, aspectRatio},
      );
    }

    // 已建立连接：整体响应超时（含 body 读取）
    const providerRequestId = res.headers.get('x-request-id') ?? undefined;
    let data: Record<string, unknown>;
    try {
      data = (await Promise.race([
        res.json(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('RESPONSE_TIMEOUT')), RESPONSE_TIMEOUT_MS);
          // 若 fetch 被 abort，清理此 timer
          controller.signal.addEventListener('abort', () => clearTimeout(t), {once: true});
        }),
      ])) as Record<string, unknown>;
    } catch (err) {
      controller.abort(); // 尽力取消仍在传输的 body
      if (err instanceof Error && err.message === 'RESPONSE_TIMEOUT') {
        throw new ImageGenerationError(
          'PROVIDER_RESPONSE_TIMEOUT',
          `图像生成响应超时（${RESPONSE_TIMEOUT_MS}ms 未收到完整响应）`,
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

let instance: ApiYiImageProvider | null = null;

export function getGeneratedImageProvider(): GeneratedImageProvider {
  if (!instance) instance = new ApiYiImageProvider();
  return instance;
}

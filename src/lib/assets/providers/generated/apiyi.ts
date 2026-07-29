/**
 * API易 Generated Image Provider — Google Gemini 图像生成 via APIYi gateway。
 *
 * 配置（server env only，禁止写入 repo / browser）：
 *   APIYI_BASE_URL=https://api.apiyi.com
 *   APIYI_API_KEY=<key>
 *   APIYI_IMAGE_MODEL=gemini-3.1-flash-image
 *   APIYI_IMAGE_SIZE=1K
 *   APIYI_IMAGE_ASPECT_RATIO=16:9
 *   APIYI_IMAGE_TIMEOUT_MS=300000
 */
import type {GenerateImageInput, GeneratedImageCandidate, GeneratedImageProvider, ProviderHealth} from './types';

const BASE_URL = process.env.APIYI_BASE_URL || 'https://api.apiyi.com';
const API_KEY = process.env.APIYI_API_KEY || '';
const MODEL = process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const SIZE = process.env.APIYI_IMAGE_SIZE || '1K';
const ASPECT_RATIO = process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9';
const TIMEOUT_MS = Number(process.env.APIYI_IMAGE_TIMEOUT_MS || '300000');
const HEALTH_CACHE_TTL_MS = 300_000; // 5min

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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
    if (!this.configured) throw new Error('APIYi image provider not configured (missing APIYI_API_KEY)');

    const model = input.model || MODEL;
    const url = `${BASE_URL}/v1beta/models/${model}:generateContent`;

    const body = {
      contents: [{parts: [{text: input.prompt}]}],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: input.aspectRatio || ASPECT_RATIO,
          imageSize: input.size || SIZE,
        },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}`},
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const status = res.status;
        if (status === 401 || status === 403) {
          this.health = {healthy: false, available: false, reason: 'authentication_failed', checkedAt: Date.now()};
          throw new Error('图像服务配置错误');
        }
        if (status === 429) throw new Error('当前生成服务繁忙，请稍后重试');
        if (status >= 500) throw new Error('图像生成服务暂时不可用');
        throw new Error(`图像生成失败 (HTTP ${status})`);
      }
      // Success: update health
      this.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
      const data = (await res.json()) as Record<string, unknown>;
      const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>;
      if (!candidates || candidates.length === 0) throw new Error('图像生成未返回有效结果');

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
                metadata: {model, size: input.size || SIZE},
              });
            } catch { /* skip corrupt base64 */ }
          }
          // Safety rejection
          if (part.text && typeof part.text === 'string' && part.text.includes('safety')) {
            // Don't throw for individual parts — just skip
          }
        }
      }
      if (results.length === 0) throw new Error('当前生成描述无法生成，请调整描述后重试');
      return results;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('图像生成超时，请重试');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

let instance: ApiYiImageProvider | null = null;

export function getGeneratedImageProvider(): GeneratedImageProvider {
  if (!instance) instance = new ApiYiImageProvider();
  return instance;
}

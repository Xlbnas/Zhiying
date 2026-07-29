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
import type {GenerateImageInput, GeneratedImageCandidate, GeneratedImageProvider} from './types';

const BASE_URL = process.env.APIYI_BASE_URL || 'https://api.apiyi.com';
const API_KEY = process.env.APIYI_API_KEY || '';
const MODEL = process.env.APIYI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const SIZE = process.env.APIYI_IMAGE_SIZE || '1K';
const ASPECT_RATIO = process.env.APIYI_IMAGE_ASPECT_RATIO || '16:9';
const TIMEOUT_MS = Number(process.env.APIYI_IMAGE_TIMEOUT_MS || '300000');

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class ApiYiImageProvider implements GeneratedImageProvider {
  readonly name = 'apiyi';
  readonly available: boolean;

  constructor() {
    this.available = !!API_KEY;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImageCandidate[]> {
    if (!this.available) throw new Error('APIYi image provider not configured (missing APIYI_API_KEY)');

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
        if (status === 401 || status === 403) throw new Error('图像服务配置错误');
        if (status === 429) throw new Error('当前生成服务繁忙，请稍后重试');
        if (status >= 500) throw new Error('图像生成服务暂时不可用');
        throw new Error(`图像生成失败 (HTTP ${status})`);
      }
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

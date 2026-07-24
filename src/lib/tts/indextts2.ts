import {
  TtsError,
  type TtsProvider,
  type TtsProviderHealth,
  type TtsRequest,
  type TtsResult,
} from './types';

/**
 * IndexTTS2 Sidecar Provider（M3-B §四/十三–十六）。
 *
 * 架构：Node Worker → HTTP → 独立 GPU sidecar（模型常驻显存）。
 * 不在 Node/Next 进程内加载 Python/模型；不调用 Gradio API。
 *
 * Sidecar contract：
 *   GET  /health           → {ready, provider, model, repoCommit, fp16}
 *   POST /v1/synthesize    → audio/wav bytes
 *
 * 第一版：音色稳定优先——use_random=false；emotion 默认 none；
 * Prosody 不映射为 duration/speed 控制（保留进 manifest，appliedToTts=false）。
 */

export interface IndexTts2ProviderOptions {
  /** sidecar base url，如 http://127.0.0.1:9880（必填，来自环境变量）。 */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const CLIP_TEXT_MAX = 500;

export class IndexTts2Provider implements TtsProvider {
  readonly name = 'indextts2';

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: IndexTts2ProviderOptions) {
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new TtsError('CONFIG_ERROR', 'IndexTTS2 sidecar 未配置 baseUrl（INDEXTTS2_BASE_URL）');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<TtsProviderHealth> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new TtsError('PROVIDER_UNAVAILABLE', `IndexTTS2 sidecar 不可达：${String(err)}`, {
        cause: err,
      });
    }
    if (!res.ok) {
      throw new TtsError('PROVIDER_HTTP_ERROR', `health HTTP ${res.status}`, {status: res.status});
    }
    const json = (await res.json().catch(() => null)) as {
      ready?: boolean;
      provider?: string;
      model?: string;
      repoCommit?: string;
      fp16?: boolean;
    } | null;
    return {
      ready: json?.ready === true,
      provider: json?.provider ?? 'indextts2',
      model: json?.model,
      repoCommit: json?.repoCommit,
      fp16: json?.fp16,
    };
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    if (signal?.aborted) {
      throw new TtsError('CANCELLED', '请求在发出前已被取消');
    }
    // health gate：sidecar 未 ready 不发起合成
    const health = await this.health();
    if (!health.ready) {
      throw new TtsError('PROVIDER_UNAVAILABLE', 'IndexTTS2 sidecar 未 ready（模型加载中或未启动）');
    }

    const controller = new AbortController();
    let cancelledByUser = false;
    const onAbort = (): void => {
      cancelledByUser = true;
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/synthesize`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'audio/wav'},
        body: JSON.stringify({
          text: request.text,
          voiceProfile: request.voiceProfile.id,
          voiceRevision: request.voiceProfile.revision,
          useRandom: false,
          emotion: request.emotion?.mode ?? 'none',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (cancelledByUser || signal?.aborted) {
          throw new TtsError('CANCELLED', '请求已被用户取消', {cause: err});
        }
        throw new TtsError('PROVIDER_TIMEOUT', `IndexTTS2 请求超时（${this.timeoutMs}ms）`, {
          cause: err,
        });
      }
      throw new TtsError('PROVIDER_HTTP_ERROR', `IndexTTS2 网络错误：${String(err)}`, {cause: err});
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, CLIP_TEXT_MAX);
      throw new TtsError('PROVIDER_HTTP_ERROR', `IndexTTS2 HTTP ${res.status}：${snippet}`, {
        status: res.status,
      });
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('audio/wav') && !contentType.includes('audio/x-wav') && !contentType.includes('application/octet-stream')) {
      throw new TtsError('PROVIDER_INVALID_RESPONSE', `IndexTTS2 返回非音频 content-type: ${contentType}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF') {
      throw new TtsError('INVALID_AUDIO', 'IndexTTS2 返回内容不是合法 WAV');
    }
    return {
      audio,
      format: 'wav',
      provider: 'indextts2',
      model: health.model ?? 'IndexTTS-2',
      providerCommit: health.repoCommit,
      settings: {
        voiceProfileId: request.voiceProfile.id,
        voiceProfileRevision: request.voiceProfile.revision,
        useRandom: false,
      },
    };
  }
}

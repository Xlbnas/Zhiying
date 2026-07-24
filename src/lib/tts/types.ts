/**
 * TTS Provider 契约（M3-B §八–十二）。
 *
 * 边界：Provider 只负责 text + voice/style config → audio；
 * 不查 DB / Narration Plan / workflow stages。
 * 时长唯一真相：生成 WAV 后由 ffprobe 实测（Provider 不宣称 duration）。
 */

export interface TtsVoiceProfile {
  id: string;
  revision: string;
}

export interface TtsRequest {
  /** 真正朗读的正文（Narration Plan speech unit text）。 */
  text: string;
  voiceProfile: TtsVoiceProfile;
  /** Narration Plan unit id（trace 用，Provider 不透传给供应商时必须剔除）。 */
  unitId: string;
  style?: {
    directive?: string | null;
  };
  emotion?: {
    mode: 'none' | 'text' | 'vector';
  };
}

export interface TtsResult {
  audio: Buffer;
  format: 'wav';
  provider: string;
  model: string;
  providerVersion?: string;
  providerCommit?: string;
  settings: {
    voiceProfileId: string;
    voiceProfileRevision: string;
    useRandom: boolean;
  };
}

export interface TtsProviderHealth {
  ready: boolean;
  provider: string;
  model?: string;
  repoCommit?: string;
  fp16?: boolean;
  detail?: string;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult>;
  health?(): Promise<TtsProviderHealth>;
}

export const TTS_ERROR_CODES = [
  'CONFIG_ERROR',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_HTTP_ERROR',
  'PROVIDER_INVALID_RESPONSE',
  'INVALID_AUDIO',
  'CANCELLED',
] as const;

export type TtsErrorCode = (typeof TTS_ERROR_CODES)[number];

export class TtsError extends Error {
  constructor(
    public readonly code: TtsErrorCode,
    message: string,
    options?: {status?: number; cause?: unknown},
  ) {
    super(message, options?.cause === undefined ? undefined : {cause: options.cause});
    this.name = 'TtsError';
    this.status = options?.status;
  }
  readonly status?: number;
}

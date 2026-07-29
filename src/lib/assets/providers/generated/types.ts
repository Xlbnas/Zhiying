/**
 * M6.3 Generated Image Provider abstraction。
 * Vendor-neutral：不绑定 API易 / 任何具体服务。
 */
export interface GenerateImageInput {
  prompt: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
}

export interface GeneratedImageCandidate {
  candidateId: string;
  mimeType: string;
  /** Raw image bytes（已 base64 decode） */
  data: Buffer;
  width?: number;
  height?: number;
  provider: string;
  model: string;
  prompt: string;
  /** Provider-specific generation id（如有） */
  generationId?: string;
  /** Provider response metadata */
  metadata?: Record<string, unknown>;
}

export interface GeneratedImageProvider {
  readonly name: string;
  readonly configured: boolean;
  /** 最近 health check 结果（缓存，避免每次检查都调用 API） */
  health: ProviderHealth;
  generate(input: GenerateImageInput): Promise<GeneratedImageCandidate[]>;
  /** 执行一次轻量 credential probe（不产生图片费用） */
  checkHealth(): Promise<ProviderHealth>;
}

export interface ProviderHealth {
  healthy: boolean;
  available: boolean; // configured && healthy
  reason: 'not_configured' | 'healthy' | 'authentication_failed' | 'provider_unreachable' | 'temporarily_unavailable';
  checkedAt: number;
}

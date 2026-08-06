/**
 * TTS-C.1B.3 adapter 内部 HTTP client（T3 reload / T4 registry-status acknowledgment）。
 *
 * 语义（frozen §7.3 T3/T4 + adapter 1B.1 contract）：
 *   - `POST /reload`：不传任何 path/body；2xx → 返回新 registry status（严格 JSON shape 校验）；
 *     non-2xx（adapter 明确拒绝，含 LKG degraded）→ `rejected`（结构化 error code）；
 *     fetch throw / timeout / connection reset → `network_error`（**结果不确定**，调用方按
 *     frozen indeterminate 规则处理，不得猜测成功或失败）。
 *   - `GET /registry-status`：唯一 activation acknowledgment 观察面（不能用 /health 替代）；
 *     2xx → 严格 JSON shape 校验；其余 → `network_error` / `invalid`。
 *   - 明确 timeout（AbortSignal.timeout）；不引入 auth/token/签名（内部受控网络）。
 */
import {RegistryContractError} from './registry-contract-error';

export const REGISTRY_STATE_UNKNOWN = 'REGISTRY_STATE_UNKNOWN';
export const ADAPTER_RELOAD_REJECTED = 'ADAPTER_RELOAD_REJECTED';
export const ADAPTER_STATUS_INVALID = 'ADAPTER_STATUS_INVALID';

export interface AdapterRegistryStatus {
  ready: boolean;
  degraded: boolean;
  schemaVersion: string | null;
  loadedRegistrySha256: string | null;
  loadedRegistryGeneration: number | null;
  publisherSchemaVersion: string | null;
  speakerCount: number | null;
  detail: string | null;
  lastReloadError: string | null;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** 严格 JSON shape 校验（adapter /registry-status 与 /reload 响应同 shape）。 */
export function parseAdapterRegistryStatus(raw: unknown): AdapterRegistryStatus {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'registry status 顶层必须对象');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.ready !== 'boolean') throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'ready 必须 boolean');
  if (typeof o.degraded !== 'boolean') throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'degraded 必须 boolean');
  if (!isNullableString(o.schemaVersion)) throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'schemaVersion 必须 string|null');
  if (!isNullableString(o.loadedRegistrySha256)) throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'loadedRegistrySha256 必须 string|null');
  if (o.loadedRegistrySha256 !== null && !SHA256_HEX_RE.test(o.loadedRegistrySha256)) {
    throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'loadedRegistrySha256 必须 64 位小写 hex');
  }
  if (o.loadedRegistryGeneration !== null && (typeof o.loadedRegistryGeneration !== 'number' || !Number.isInteger(o.loadedRegistryGeneration))) {
    throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'loadedRegistryGeneration 必须 integer|null');
  }
  if (!isNullableString(o.publisherSchemaVersion)) throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'publisherSchemaVersion 必须 string|null');
  if (o.speakerCount !== null && (typeof o.speakerCount !== 'number' || !Number.isInteger(o.speakerCount))) {
    throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'speakerCount 必须 integer|null');
  }
  if (!isNullableString(o.detail)) throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'detail 必须 string|null');
  if (!isNullableString(o.lastReloadError)) throw new RegistryContractError(ADAPTER_STATUS_INVALID, 'lastReloadError 必须 string|null');
  return {
    ready: o.ready,
    degraded: o.degraded,
    schemaVersion: o.schemaVersion,
    loadedRegistrySha256: o.loadedRegistrySha256,
    loadedRegistryGeneration: o.loadedRegistryGeneration,
    publisherSchemaVersion: o.publisherSchemaVersion,
    speakerCount: o.speakerCount,
    detail: o.detail,
    lastReloadError: o.lastReloadError,
  };
}

export type ReloadResult =
  | {kind: 'ok'; status: AdapterRegistryStatus}
  | {kind: 'rejected'; httpStatus: number; errorCode: string | null; message: string}
  | {kind: 'network_error'; error: string}
  | {kind: 'invalid'; error: string};

export type RegistryStatusResult =
  | {kind: 'ok'; status: AdapterRegistryStatus}
  | {kind: 'network_error'; error: string}
  | {kind: 'invalid'; error: string};

export interface AdapterClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class AdapterClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AdapterClientOptions) {
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new RegistryContractError('CONFIG_ERROR', 'adapter baseUrl 未配置');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** POST /reload（不传 path）。rejected 与 network_error 严格区分。 */
  async reload(): Promise<ReloadResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/reload`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {kind: 'network_error', error: `reload 网络错误（结果不确定）: ${(err as Error).message}`};
    }
    if (!res.ok) {
      let code: string | null = null;
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as Record<string, unknown>;
        if (typeof body?.error === 'object' && body.error !== null && typeof (body.error as Record<string, unknown>).code === 'string') {
          code = (body.error as Record<string, unknown>).code as string;
        }
        if (typeof body?.error === 'object' && body.error !== null && typeof (body.error as Record<string, unknown>).message === 'string') {
          message = (body.error as Record<string, unknown>).message as string;
        }
      } catch {
        // body 非 JSON——保留 HTTP 状态
      }
      return {kind: 'rejected', httpStatus: res.status, errorCode: code, message};
    }
    try {
      const status = parseAdapterRegistryStatus(await res.json());
      return {kind: 'ok', status};
    } catch (err) {
      return {kind: 'invalid', error: `reload 响应 JSON 校验失败: ${(err as Error).message}`};
    }
  }

  /** GET /registry-status——唯一 activation acknowledgment 观察面。 */
  async registryStatus(): Promise<RegistryStatusResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/registry-status`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return {kind: 'network_error', error: `registry-status 网络错误: ${(err as Error).message}`};
    }
    if (!res.ok) {
      return {kind: 'network_error', error: `registry-status HTTP ${res.status}`};
    }
    try {
      const status = parseAdapterRegistryStatus(await res.json());
      return {kind: 'ok', status};
    } catch (err) {
      return {kind: 'invalid', error: `registry-status JSON 校验失败: ${(err as Error).message}`};
    }
  }
}

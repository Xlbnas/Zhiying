/**
 * TTS-C.1B.2 registry contract 错误（统一类型化错误面）。
 * 错误码复用 frozen adapter 语义（VOICE_REGISTRY_INVALID / VOICE_REGISTRY_UNSUPPORTED_SCHEMA /
 * REFERENCE_VOICE_MISSING / REFERENCE_SHA256_MISMATCH）与 1B.2 新增操作语义码（LEGACY_IMPORT_* /
 * PUBLICATION_*）。不新增任何 hash/checksum 层。
 */
export class RegistryContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistryContractError';
    this.code = code;
  }
}

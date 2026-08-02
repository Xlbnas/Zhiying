/**
 * TTS-A Voice Library 集中常量（设计文档 docs/TTS_A_VOICE_LIBRARY_DESIGN.md §2/§3）。
 * 修改任何 canonical 参数必须 bump 对应版本常量（fingerprint 随之失效，fail-closed）。
 */

export const VOICE_PROFILE_SCHEMA_VERSION = 'voice-profile@1.0';
export const VOICE_PROFILE_REVISION_SCHEMA_VERSION = 'voice-profile-revision@1.0';

/** canonicalization 规则版本（容器/codec/sr/channels/参数全部由服务端固定）。 */
export const VOICE_CANONICALIZATION_VERSION = 'voice-canonical@1.0';

/** adapter 兼容键：可被 api-adapter 以 registry voiceProfile@voiceRevision + sha256 引用。 */
export const ADAPTER_COMPATIBILITY_KEY = 'indextts2-adapter-registry@1';

/** 当前唯一允许的 provider。 */
export const VOICE_PROVIDER = 'indextts2';

// canonical WAV 契约（冻结）：RIFF/WAVE + pcm_s16le + mono + 48000Hz
export const CANONICAL_SAMPLE_RATE = 48000;
export const CANONICAL_CHANNELS = 1;
export const CANONICAL_CODEC = 'pcm_s16le';
export const CANONICAL_FILENAME = 'reference.wav';

// 时长/大小限制（adapter 无明确限制 → 临时保守范围）
export const MIN_REFERENCE_AUDIO_MS = 1000;
export const MAX_REFERENCE_AUDIO_MS = 60000;
export const MAX_REFERENCE_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB

// subprocess timeout（参数数组 spawn，无 shell）
export const FFPROBE_TIMEOUT_MS = 15000;
export const FFMPEG_TIMEOUT_MS = 60000;

// 字段长度上限
export const DISPLAY_NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const TRANSCRIPT_MAX = 4000;
export const LANGUAGE_MAX = 35;
export const REQUEST_ID_MAX = 128;
export const ORIGINAL_FILENAME_DISPLAY_MAX = 120;

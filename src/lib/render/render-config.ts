/**
 * Final Render 性能配置（M5-PERF；worker 与 benchmark 共用）。
 * REMOTION_CONCURRENCY：1-32 整数显式并发；缺失/非法 → null（Remotion 默认）。
 * REMOTION_GPU_ENABLED=true：Chromium ANGLE/EGL 硬件后端（需容器可见 NVIDIA
 * GPU）；其他值/缺失 → software path（可一键回退）。
 * REMOTION_NVENC=true（M6.3.10）：视频编码优先 h264_nvenc（需容器 GPU 访问）；
 * 真实编码探测失败 → libx264 crf 18 回退，且 fallbackReason 必须落 usage
 * event metadata + worker log（禁止静默 fallback）。
 * REMOTION_NVENC_BITRATE：NVENC 视频码率（默认 8M；NVENC 与 crf 互斥，
 * 故以 bitrate 控质量；输出分辨率/帧率/封装不变）。
 */

export function resolveRenderConcurrency(
  raw: string | undefined = process.env.REMOTION_CONCURRENCY,
): number | null {
  const value = raw?.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    // eslint-disable-next-line no-console
    console.warn(`[render-config] REMOTION_CONCURRENCY="${value}" 非法（需 1-32 整数），回退 Remotion 默认`);
    return null;
  }
  return n;
}

export function resolveGpuEnabled(
  raw: string | undefined = process.env.REMOTION_GPU_ENABLED,
): boolean {
  return raw === 'true';
}

export function resolveNvencEnabled(
  raw: string | undefined = process.env.REMOTION_NVENC,
): boolean {
  return raw === 'true';
}

export function resolveNvencBitrate(
  raw: string | undefined = process.env.REMOTION_NVENC_BITRATE,
): string {
  const value = raw?.trim();
  return value && value.length > 0 ? value : '8M';
}

export interface RenderPerfConfig {
  concurrency: number | null;
  gpuEnabled: boolean;
  /** 注入 selectComposition/renderMedia 的 chromiumOptions（GPU 开启时）。 */
  chromiumOptions?: {gl: 'angle-egl'};
  nvencEnabled: boolean;
  nvencBitrate: string;
}

export function loadRenderPerfConfig(): RenderPerfConfig {
  const concurrency = resolveRenderConcurrency();
  const gpuEnabled = resolveGpuEnabled();
  return {
    concurrency,
    gpuEnabled,
    ...(gpuEnabled ? {chromiumOptions: {gl: 'angle-egl' as const}} : {}),
    nvencEnabled: resolveNvencEnabled(),
    nvencBitrate: resolveNvencBitrate(),
  };
}

export function describeRenderPerfConfig(config: RenderPerfConfig): string {
  return `Final Render concurrency: ${config.concurrency ?? 'auto(Remotion default)'}, ` +
    `GPU mode: ${config.gpuEnabled ? 'hardware(angle-egl)' : 'software(default)'}, ` +
    `NVENC: ${config.nvencEnabled ? `enabled(bitrate=${config.nvencBitrate})` : 'disabled'}`;
}

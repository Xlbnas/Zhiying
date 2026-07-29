/**
 * NVENC 可用性真实探测（M6.3.10）。
 *
 * Remotion 自带 probe 只跑 `ffmpeg -encoders` 匹配名字——镜像内 ffmpeg 编译了
 * h264_nvenc 就会误判可用，即使容器没有 GPU 设备访问。这里执行一次真实的
 * 8 帧空编码：libnvidia-encode 加载、驱动、设备节点任一缺失都会失败。
 *
 * 结果进程内缓存；探测失败 → 调用方必须走 CPU 编码并把 reason 记入
 * usage event metadata（禁止静默 fallback）。
 */
import {execFile} from 'node:child_process';

export interface NvencProbeResult {
  ok: boolean;
  encoder: 'h264_nvenc';
  reason?: string;
}

let cached: NvencProbeResult | null = null;

export function probeNvencSupport(
  impl: (cb: (err: Error | null) => void) => void = defaultProbe,
): Promise<NvencProbeResult> {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    impl((err) => {
      cached = err
        ? {ok: false, encoder: 'h264_nvenc', reason: err.message.slice(0, 300)}
        : {ok: true, encoder: 'h264_nvenc'};
      resolve(cached);
    });
  });
}

function defaultProbe(cb: (err: Error | null) => void): void {
  execFile(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.27:r=30',
      '-frames:v', '8',
      '-c:v', 'h264_nvenc',
      '-f', 'null', '-',
    ],
    {timeout: 30_000},
    (err, _stdout, stderr) => {
      if (!err) { cb(null); return; }
      const detail = typeof stderr === 'string' && stderr.trim().length > 0
        ? stderr.trim().split('\n').slice(-2).join(' | ')
        : err.message;
      cb(new Error(`h264_nvenc 真实编码探测失败：${detail}`));
    },
  );
}

/** 仅测试用：清空进程内缓存。 */
export function resetNvencProbeCache(): void {
  cached = null;
}

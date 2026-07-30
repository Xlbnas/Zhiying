/**
 * M5-PERF Final Render 同源 benchmark harness。
 *
 * 从 render_jobs.payload_json 读取与生产完全相同的渲染输入（同 project、同
 * composition、同分辨率、同 codec、同 CRF、同 artifact），只渲染固定
 * frameRange（默认前 900 帧），输出耗时/FPS/文件大小。
 *
 * 用法（容器内）：
 *   node --import tsx scripts/bench-render.ts --job <renderJobId> --frames 900
 * 配置经共享 render-config（REMOTION_CONCURRENCY / REMOTION_GPU_ENABLED）。
 * 输出：/app/data/bench/<jobId>-f<frames>.mp4（容器内数据目录下）
 */

import fs from 'node:fs';
import path from 'node:path';

import {renderMedia, selectComposition} from '@remotion/renderer';
import {getDataDir} from '../src/lib/db';
import {getDb} from '../src/lib/db';
import {describeRenderPerfConfig, loadRenderPerfConfig} from '../src/lib/render/render-config';
import {
  COMPOSITION_ID,
  COMPOSITION_ID_NO_SUBTITLES,
  zhiyingFullCutPropsSchema,
} from '../src/lib/scene-schema';

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1]! : null;
}

async function main(): Promise<void> {
  const jobId = arg('job');
  const frames = Number(arg('frames') ?? '900');
  if (!jobId) throw new Error('缺少 --job <renderJobId>');
  if (!Number.isInteger(frames) || frames < 30) throw new Error('--frames 需 >= 30 的整数');

  const config = loadRenderPerfConfig();
  console.log(`[bench] ${describeRenderPerfConfig(config)}`);

  const db = getDb();
  const job = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(jobId) as
    | {id: string; kind: string; payload_json: string}
    | undefined;
  if (!job) throw new Error(`render job 不存在: ${jobId}`);
  const parsed = zhiyingFullCutPropsSchema.parse(JSON.parse(job.payload_json));
  const inputProps = {
    ...parsed,
    showSubtitles: job.kind !== 'no-subtitles',
  };
  const compositionId = job.kind === 'no-subtitles' ? COMPOSITION_ID_NO_SUBTITLES : COMPOSITION_ID;

  const bundleLocation = path.join(getDataDir(), 'bundle-cache', 'freud-mg-v1.0');
  if (!fs.existsSync(path.join(bundleLocation, 'index.html'))) {
    throw new Error(`bundle cache 缺失: ${bundleLocation}（需生产渲染已建立缓存）`);
  }
  console.log(`[bench] bundle cache hit: ${bundleLocation}`);

  const port = 32100 + (process.pid % 1000);
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps,
    port,
    ...(config.chromiumOptions ? {chromiumOptions: config.chromiumOptions} : {}),
  });
  const totalFrames = composition.durationInFrames;
  const frameRange: [number, number] = [0, Math.min(frames, totalFrames)];
  console.log(`[bench] composition=${compositionId} total=${totalFrames}f range=[${frameRange[0]}, ${frameRange[1]})`);

  const nvenc = process.argv.includes('--nvenc');
  const outDir = path.join(getDataDir(), 'bench');
  fs.mkdirSync(outDir, {recursive: true});
  const outAbs = path.join(outDir, `${jobId.slice(0, 8)}-f${frameRange[1]}${nvenc ? '-nvenc' : ''}${config.gpuEnabled ? '-gpu' : ''}.mp4`);

  const start = Date.now();
  let lastLog = 0;
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    // 与 worker 同源（src/worker/index.ts）：NVENC 与 crf 互斥
    ...(nvenc
      ? {hardwareAcceleration: 'required' as const, videoBitrate: config.nvencBitrate}
      : {crf: 18 as const}),
    frameRange,
    outputLocation: outAbs,
    inputProps,
    port,
    concurrency: config.concurrency,
    ...(config.chromiumOptions ? {chromiumOptions: config.chromiumOptions} : {}),
    onProgress: (p: {progress: number; renderedFrames: number}) => {
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        const elapsed = (now - start) / 1000;
        console.log(`[bench] ${p.renderedFrames}/${frameRange[1]} frames, ${(p.renderedFrames / elapsed).toFixed(2)} fps, elapsed ${elapsed.toFixed(0)}s`);
      }
    },
  });
  const elapsedSec = (Date.now() - start) / 1000;
  const size = fs.statSync(outAbs).size;
  const fps = frameRange[1] / elapsedSec;
  console.log(`[bench] RESULT ${JSON.stringify({
    frames: frameRange[1],
    elapsedSec: Math.round(elapsedSec * 10) / 10,
    fps: Math.round(fps * 100) / 100,
    outBytes: size,
    concurrency: config.concurrency ?? 'auto',
    gpu: config.gpuEnabled,
  })}`);
}

main().catch((err) => {
  console.error('[bench] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

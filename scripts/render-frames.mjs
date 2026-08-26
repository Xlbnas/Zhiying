#!/usr/bin/env node
/**
 * render-frames.mjs —— Player/Renderer 帧一致性验证的 Renderer 侧取帧工具（M1 验收资产）
 *
 * 用法：
 *   node scripts/render-frames.mjs <projectId> [frames]
 *   frames 为逗号分隔帧号，默认 0,1000,9000
 *   环境变量 BASE_URL 指定服务地址（默认 http://localhost:3000）
 *
 * 行为：
 * 1. 用 @remotion/bundler 打包 src/remotion/index.ts → data/bundle-cache/freud-mg-v1.0
 *    （与 worker 缓存路径一致，webpackOverride 与 src/worker/index.ts 保持相同配置，
 *      含 esbuild-loader 的 jsx:'automatic' 强制项；缓存存在则跳过打包）
 * 2. 从运行中的 API 拉 ZhiyingFullCutProps（与 Player 同源）
 * 3. renderStill 输出 PNG 到 data/still-test/frame-<N>.png
 *
 * 配套：Player 侧截图（pf-<N>.png）由 agent-browser 取得后，
 * 用 scripts/frame-compare/compare.cjs 做像素对比（见 scripts/README.md）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const bundleDir = path.join(dataDir, 'bundle-cache', 'freud-mg-v1.0');
const outDir = path.join(dataDir, 'still-test');
const projectId = process.argv[2];
const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const inputPropsPath = process.env.INPUT_PROPS;

if (!projectId) {
  console.error('usage: node scripts/render-frames.mjs <projectId> [frames 逗号分隔]');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

// 1. bundle（若缓存已存在则跳过）
// 注意：webpackOverride 必须与 src/worker/index.ts 保持一致 ——
// esbuild-loader 需要显式 jsx:'automatic'，否则 tsconfig 的 jsx:'preserve'
// 会让 esbuild 输出无导入的 React.createElement，渲染时抛 "React is not defined"。
const marker = path.join(bundleDir, 'index.html');
let serveUrl;
if (fs.existsSync(marker) && process.env.FORCE_BUNDLE !== '1') {
  console.log('[still] bundle cache hit');
  serveUrl = bundleDir;
} else {
  console.log('[still] bundling…');
  if (process.env.FORCE_BUNDLE === '1') {
    fs.rmSync(bundleDir, {recursive: true, force: true});
  }
  serveUrl = await bundle({
    entryPoint: path.join(root, 'src', 'remotion', 'index.ts'),
    outDir: bundleDir,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: { ...(config.resolve?.alias ?? {}), '@': path.join(root, 'src') },
      },
      module: {
        ...config.module,
        rules: (config.module?.rules ?? []).map((rule) => {
          if (!rule || typeof rule !== 'object' || !('use' in rule)) return rule;
          const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
          const patched = uses.map((u) => {
            if (
              u &&
              typeof u === 'object' &&
              'loader' in u &&
              typeof u.loader === 'string' &&
              u.loader.includes('esbuild-loader')
            ) {
              const baseOptions =
                u.options && typeof u.options === 'object' ? u.options : {};
              return { ...u, options: { ...baseOptions, jsx: 'automatic' } };
            }
            return u;
          });
          return { ...rule, use: patched };
        }),
      },
    }),
    onProgress: (p) => console.log(`[still] bundle ${Math.round(p)}%`),
  });
}
console.log('[still] bundle ready:', serveUrl);

// 渲染静态服务端口：每次运行随机（渲染失败后端口未必释放，固定端口重跑必撞）
const RENDER_PORT = 4000 + Math.floor(Math.random() * 10000);

// 2. input props from an exact local preview fixture or the existing API.
// INPUT_PROPS is preview-only and preserves the historical API behaviour by default.
const inputProps = inputPropsPath
  ? JSON.parse(fs.readFileSync(path.resolve(root, inputPropsPath), 'utf8'))
  : await (async () => {
      const res = await fetch(`${baseUrl}/api/projects/${projectId}/scenes`);
      if (!res.ok) throw new Error(`scenes API HTTP ${res.status}`);
      return res.json();
    })();
console.log(
  `[still] props: scenes=${inputProps.data.scenes.length} subtitles=${inputProps.subtitles.length} narration=${inputProps.audio.narration}`,
);

// 3. select composition
const composition = await selectComposition({
  serveUrl,
  id: 'ZhiyingFullCut',
  inputProps,
  port: RENDER_PORT,
});
console.log(
  `[still] composition: ${composition.id} ${composition.width}x${composition.height}@${composition.fps} ${composition.durationInFrames}f`,
);

// 4. renderStill（默认 0/1000/9000 三帧；可用第二参数覆盖：逗号分隔帧号）
const frames = (process.argv[3] ?? '0,1000,9000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);
for (const frame of frames) {
  const output = path.join(outDir, `frame-${frame}.png`);
  await renderStill({
    composition,
    serveUrl,
    inputProps,
    frame,
    output,
    port: RENDER_PORT,
  });
  const size = fs.statSync(output).size;
  console.log(`[still] frame ${frame} → ${output} (${size} bytes)`);
}
console.log('[still] ALL OK');

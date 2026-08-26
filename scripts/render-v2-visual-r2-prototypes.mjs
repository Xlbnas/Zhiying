#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const propsPath = path.resolve(root, process.argv[2] ?? 'outputs/v2-visual-r2/prototypes/preview-props.json');
const outputDir = path.resolve(root, 'outputs/v2-visual-r2/prototypes');
const bundleDir = path.resolve(root, 'outputs/v2-visual-r2/bundle-preview');
const inputProps = JSON.parse(fs.readFileSync(propsPath, 'utf8'));

const configuredPrototypes = process.argv.includes('--remaining') ? [
  {name: 'D-history', frameRange: [920, 2820]},
  {name: 'E-applied-mechanisms', frameRange: [3832, 5513]},
  {name: 'F-final-close', frameRange: [6754, 7306]},
] : [
  {name: 'A-hook', frameRange: [0, 919]},
  {name: 'B-mechanism', frameRange: [2821, 3831]},
  {name: 'C-evaluation-conclusion', frameRange: [5514, 6753]},
];
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const prototypes = only ? configuredPrototypes.filter((prototype) => prototype.name === only) : configuredPrototypes;
if (prototypes.length === 0) throw new Error(`Unknown --only prototype: ${only}`);

fs.mkdirSync(outputDir, {recursive: true});
fs.rmSync(bundleDir, {recursive: true, force: true});

console.log('[v2-r2-preview] bundling exact local source');
const serveUrl = await bundle({
  entryPoint: path.resolve(root, 'src/remotion/index.ts'),
  outDir: bundleDir,
  webpackOverride: (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      alias: {...(config.resolve?.alias ?? {}), '@': path.resolve(root, 'src')},
    },
    module: {
      ...config.module,
      rules: (config.module?.rules ?? []).map((rule) => {
        if (!rule || typeof rule !== 'object' || !('use' in rule)) return rule;
        const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
        return {
          ...rule,
          use: uses.map((entry) => {
            if (!entry || typeof entry !== 'object' || !('loader' in entry) ||
                typeof entry.loader !== 'string' || !entry.loader.includes('esbuild-loader')) {
              return entry;
            }
            const options = entry.options && typeof entry.options === 'object' ? entry.options : {};
            return {...entry, options: {...options, jsx: 'automatic'}};
          }),
        };
      }),
    },
  }),
  onProgress: (progress) => console.log(`[v2-r2-preview] bundle ${Math.round(progress)}%`),
});

for (const [index, prototype] of prototypes.entries()) {
  const port = 34000 + (process.pid % 1000) + index;
  const composition = await selectComposition({
    serveUrl,
    id: 'ZhiyingFullCut',
    inputProps,
    port,
  });
  const outputLocation = path.join(outputDir, `${prototype.name}.mp4`);
  fs.rmSync(outputLocation, {force: true});
  const started = Date.now();
  let lastLog = 0;
  console.log(`[v2-r2-preview] ${prototype.name} frames=${prototype.frameRange.join('-')}`);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: 20,
    frameRange: prototype.frameRange,
    outputLocation,
    inputProps,
    port,
    concurrency: 4,
    onProgress: ({renderedFrames}) => {
      const now = Date.now();
      if (now - lastLog >= 5000) {
        lastLog = now;
        console.log(`[v2-r2-preview] ${prototype.name} rendered=${renderedFrames} elapsed=${Math.round((now - started) / 1000)}s`);
      }
    },
  });
  console.log(`[v2-r2-preview] ${prototype.name} ready bytes=${fs.statSync(outputLocation).size}`);
}

console.log('[v2-r2-preview] ALL PROTOTYPES READY');

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
};
const propsPath = path.resolve(root, process.argv[2] ?? 'outputs/v2-visual-r2/prototypes/preview-props.json');
const outputDir = path.resolve(root, valueAfter('--output-dir') ?? 'outputs/v2-visual-r2/prototypes');
const bundleDir = path.join(outputDir, 'bundle-preview');
const sourceProps = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
const rendererVersion = valueAfter('--renderer-version');
if (rendererVersion && !['v2-visual-r2@2', 'dark-editorial-v1@1', 'dark-editorial-v1@2'].includes(rendererVersion)) {
  throw new Error(`Unsupported renderer version: ${rendererVersion}`);
}
const inputProps = {
  ...sourceProps,
  data: {
    ...sourceProps.data,
    scenes: rendererVersion
      ? sourceProps.data.scenes.map((scene) => ({
          ...scene,
          templateProps: {...(scene.templateProps ?? {}), v2VisualR2: {version: rendererVersion}},
        }))
      : sourceProps.data.scenes,
  },
  audio: process.argv.includes('--with-audio')
    ? {...sourceProps.audio, narration: 'runtime-audio/3778ffb0-c430-4499-9f7f-2590f45cb8cb/r3a-exact-master.wav'}
    : sourceProps.audio,
};

const semanticCleanup = process.argv.includes('--semantic-cleanup');
const pacingQc = process.argv.includes('--pacing-qc');
const configuredPrototypes = pacingQc ? [
  {name: 'pacing-history-entry', frameRange: [860, 979]},
  {name: 'pacing-mechanism-entry', frameRange: [2761, 2880]},
  {name: 'pacing-applied-entry', frameRange: [3772, 3891]},
  {name: 'pacing-evaluation-entry', frameRange: [5454, 5573]},
  {name: 'pacing-closing-entry', frameRange: [6694, 6813]},
] : semanticCleanup ? [
  {name: 'semantic-A-S001-S003', frameRange: [0, 424]},
  {name: 'semantic-B-S011-S013', frameRange: [2821, 3571]},
  {name: 'semantic-C1-S019-S021', frameRange: [5187, 6105]},
  {name: 'semantic-C2-S024', frameRange: [6754, 6984]},
] : process.argv.includes('--remaining') ? [
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

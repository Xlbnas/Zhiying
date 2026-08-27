#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

const root = path.resolve(import.meta.dirname, '..');
const propsPath = path.resolve(root, process.argv[2] ?? 'outputs/r3a-previews/preview-props.json');
const outputDir = path.resolve(root, 'outputs/r3a-previews');
const bundleDir = path.join(outputDir, 'bundle');
const baseProps = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

const prototypes = [
  {id: 'history', ranges: [[920, 2820]]},
  {id: 'language', ranges: [[0, 419], [2821, 3569]]},
  {id: 'editorial', ranges: [[4620, 6749]]},
].filter((prototype) => !only || prototype.id === only);
if (prototypes.length === 0) throw new Error(`Unknown --only value: ${only}`);

fs.mkdirSync(outputDir, {recursive: true});
fs.rmSync(bundleDir, {recursive: true, force: true});
const serveUrl = await bundle({
  entryPoint: path.resolve(root, 'src/remotion/index.ts'),
  outDir: bundleDir,
  webpackOverride: (config) => ({
    ...config,
    resolve: {...config.resolve, alias: {...(config.resolve?.alias ?? {}), '@': path.resolve(root, 'src')}},
    module: {
      ...config.module,
      rules: (config.module?.rules ?? []).map((rule) => {
        if (!rule || typeof rule !== 'object' || !('use' in rule)) return rule;
        const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
        return {...rule, use: uses.map((entry) => {
          if (!entry || typeof entry !== 'object' || !('loader' in entry) || typeof entry.loader !== 'string' || !entry.loader.includes('esbuild-loader')) return entry;
          const options = entry.options && typeof entry.options === 'object' ? entry.options : {};
          return {...entry, options: {...options, jsx: 'automatic'}};
        })};
      }),
    },
  }),
  onProgress: (progress) => console.log(`[r3a] bundle ${Math.round(progress)}%`),
});

for (const prototype of prototypes) {
  for (const burned of [false, true]) {
    const mode = burned ? 'burned' : 'clean';
    const inputProps = {...baseProps, showSubtitles: burned};
    const parts = [];
    for (const [partIndex, frameRange] of prototype.ranges.entries()) {
      const port = 36000 + (process.pid % 1000) + partIndex;
      const composition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps, port});
      const part = path.join(outputDir, `.${prototype.id}-${mode}-part-${partIndex}.mp4`);
      fs.rmSync(part, {force: true});
      let lastLog = 0;
      const started = Date.now();
      console.log(`[r3a] ${prototype.id}-${mode} part=${partIndex + 1}/${prototype.ranges.length} frames=${frameRange.join('-')}`);
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        crf: 20,
        frameRange,
        outputLocation: part,
        inputProps,
        port,
        concurrency: 4,
        onProgress: ({renderedFrames}) => {
          const now = Date.now();
          if (now - lastLog >= 5000) {
            lastLog = now;
            console.log(`[r3a] ${prototype.id}-${mode} rendered=${renderedFrames} elapsed=${Math.round((now - started) / 1000)}s`);
          }
        },
      });
      parts.push(part);
    }

    const output = path.join(outputDir, `preview-${prototype.id}-${mode}.mp4`);
    fs.rmSync(output, {force: true});
    if (parts.length === 1) {
      fs.renameSync(parts[0], output);
    } else {
      const listPath = path.join(outputDir, `.${prototype.id}-${mode}-concat.txt`);
      fs.writeFileSync(listPath, `${parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join('\n')}\n`);
      const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output], {encoding: 'utf8'});
      if (result.status !== 0) throw new Error(`ffmpeg concat failed: ${result.stderr}`);
      fs.rmSync(listPath, {force: true});
      for (const part of parts) fs.rmSync(part, {force: true});
    }
    console.log(`[r3a] ready ${output} bytes=${fs.statSync(output).size}`);
  }
}

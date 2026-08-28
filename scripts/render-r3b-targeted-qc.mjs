#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';

const root = path.resolve(import.meta.dirname, '..');
const propsPath = path.resolve(root, process.argv[2] ?? 'outputs/r3a-previews/preview-props.json');
const outputDir = path.resolve(root, 'outputs/r3b-targeted-qc');
const bundleDir = path.join(outputDir, 'bundle');
const clipsDir = path.join(outputDir, 'clean-clips');
const maxFramesDir = path.join(outputDir, 'max-frames');
const stripsDir = path.join(outputDir, 'motion-strips');
const burnedDir = path.join(outputDir, 'burned-spots');
const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
const affected = new Set([
  'S001', 'S002', 'S003', 'S005', 'S006', 'S007', 'S008', 'S009', 'S010',
  'S011', 'S012', 'S013', 'S017', 'S018', 'S020', 'S021', 'S022', 'S023',
]);
const burnedSpots = new Set(['S007', 'S013', 'S023']);
const scenes = props.data.scenes.filter((scene) => affected.has(scene.id));

if (props.data.project.projectId !== '3778ffb0-c430-4499-9f7f-2590f45cb8cb' || scenes.length !== affected.size) {
  throw new Error('R3-B targeted QC requires the frozen 25-scene project and all affected scenes');
}
if (!scenes.every((scene) => scene.templateProps?.v2VisualR2?.version === 'dark-editorial-v1@1')) {
  throw new Error('R3-B targeted QC requires explicit dark-editorial-v1@1');
}

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}

fs.rmSync(outputDir, {recursive: true, force: true});
for (const directory of [bundleDir, clipsDir, maxFramesDir, stripsDir, burnedDir]) fs.mkdirSync(directory, {recursive: true});

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
  onProgress: (progress) => console.log(`[r3b-qc] bundle ${Math.round(progress)}%`),
});

const cleanProps = {...props, showSubtitles: false};
const burnedProps = {...props, showSubtitles: true};
const cleanComposition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: cleanProps, port: 37101});
const burnedComposition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: burnedProps, port: 37102});
const evidence = [];

for (const scene of scenes) {
  const sceneEnd = scene.startFrame + scene.durationInFrames - 1;
  const maxFrame = Math.min(sceneEnd - 6, scene.startFrame + Math.floor(scene.durationInFrames * .82));
  const clipStart = Math.max(scene.startFrame, maxFrame - 30);
  const clipEnd = Math.min(sceneEnd, clipStart + 59);
  const cleanClip = path.join(clipsDir, `${scene.id}-clean.mp4`);
  console.log(`[r3b-qc] ${scene.id} clean frames=${clipStart}-${clipEnd}`);
  await renderMedia({
    composition: cleanComposition,
    serveUrl,
    codec: 'h264',
    crf: 20,
    frameRange: [clipStart, clipEnd],
    outputLocation: cleanClip,
    inputProps: cleanProps,
    port: 37110 + Number(scene.id.slice(1)),
    concurrency: 4,
  });

  const maxFramePath = path.join(maxFramesDir, `${scene.id}-max.png`);
  const localMaxSeconds = (maxFrame - clipStart) / 30;
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', localMaxSeconds.toFixed(3), '-i', cleanClip, '-frames:v', '1', maxFramePath]);
  const stripPath = path.join(stripsDir, `${scene.id}-strip.png`);
  const stripFrameDir = path.join(stripsDir, `.${scene.id}-frames`);
  fs.mkdirSync(stripFrameDir, {recursive: true});
  const stripFrames = [.08, .38, .68, .92].map((ratio) => Math.min(sceneEnd, scene.startFrame + Math.floor((scene.durationInFrames - 1) * ratio)));
  for (const [index, frame] of stripFrames.entries()) {
    await renderStill({
      composition: cleanComposition,
      serveUrl,
      frame,
      output: path.join(stripFrameDir, `${index}.png`),
      inputProps: cleanProps,
      port: 37310 + Number(scene.id.slice(1)),
    });
  }
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...stripFrames.flatMap((_, index) => ['-i', path.join(stripFrameDir, `${index}.png`)]), '-filter_complex', '[0:v]scale=480:270[x0];[1:v]scale=480:270[x1];[2:v]scale=480:270[x2];[3:v]scale=480:270[x3];[x0][x1][x2][x3]hstack=inputs=4', '-frames:v', '1', stripPath]);
  fs.rmSync(stripFrameDir, {recursive: true, force: true});

  let burnedClip = null;
  if (burnedSpots.has(scene.id)) {
    burnedClip = path.join(burnedDir, `${scene.id}-burned.mp4`);
    console.log(`[r3b-qc] ${scene.id} burned frames=${clipStart}-${clipEnd}`);
    await renderMedia({
      composition: burnedComposition,
      serveUrl,
      codec: 'h264',
      crf: 20,
      frameRange: [clipStart, clipEnd],
      outputLocation: burnedClip,
      inputProps: burnedProps,
      port: 37210 + Number(scene.id.slice(1)),
      concurrency: 4,
    });
  }
  evidence.push({sceneId: scene.id, sceneStartFrame: scene.startFrame, sceneEndFrame: sceneEnd, maxFrame, clipStart, clipEnd, stripFrames, cleanClip, maxFramePath, stripPath, burnedClip});
}

const maxGlob = path.join(maxFramesDir, '*-max.png');
for (const [name, scale, tile] of [
  ['corrected-contact-sheet-1080.png', '480:270', '6x3'],
  ['corrected-contact-sheet-720.png', '320:180', '6x3'],
  ['corrected-contact-sheet-mobile.png', '390:219', '3x6'],
]) {
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1', '-pattern_type', 'glob', '-i', maxGlob, '-vf', `scale=${scale},tile=${tile}:nb_frames=18:padding=4:margin=4:color=black`, '-frames:v', '1', path.join(outputDir, name)]);
}

const manifest = {
  schemaVersion: 'r3b-targeted-qc@1',
  generatedAt: new Date().toISOString(),
  projectId: props.data.project.projectId,
  rendererVersion: 'dark-editorial-v1@1',
  affectedScenes: scenes.map((scene) => scene.id),
  burnedSpotScenes: [...burnedSpots],
  resolutions: ['1920x1080 source', '1280x720 review equivalent', '390px mobile-width review cell'],
  evidence,
};
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({outputDir, scenes: evidence.length, burnedSpots: burnedSpots.size}, null, 2));

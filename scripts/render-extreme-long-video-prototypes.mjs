#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

const root = process.cwd();
const outputDir = path.join(root, 'outputs/extreme-long-video/prototypes');
const bundleDir = path.join(outputDir, 'bundle');
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8'));
const familyFor = (scene) => scene.templateProps?.memoryLab?.family;
const requested = [
  [1, 'fragment-assembly', '01-opening-fragments', null, false],
  [2, 'source-document', '02-bartlett-source', null, 'Kathlamet'],
  [3, 'experimental-stage', '03-loftus-experiment', null],
  [4, 'semantic-field', '04-drm-demonstration', null],
  [5, 'trace-comparison', '05-candidate-mechanisms', null],
  [6, 'procedure-safeguard', '06-confidence-feedback', 'confidence-feedback'],
  [7, 'longitudinal-record', '07-flashbulb-t0', null],
  [8, 'procedure-safeguard', '08-eyewitness-contamination', 'contamination'],
  [9, 'classification-funnel', '09-memory-belief-categories', null],
  [10, 'procedure-safeguard', '10-external-verification', 'external-verification'],
];
const prototypes = requested.map(([chapter, family, name, variant, assetQuery = null]) => {
  const scene = design.scenes.find((candidate) => candidate.chapter === chapter && familyFor(candidate) === family && (!variant || candidate.templateProps?.memoryLab?.variant === variant) && (!assetQuery || candidate.assetRequirements?.some((requirement) => requirement.query.includes(assetQuery))))
    ?? design.scenes.find((candidate) => candidate.chapter === chapter);
  if (!scene) throw new Error(`No scene for chapter ${chapter}`);
  return {name, scene, frameRange: [scene.startFrame, Math.min(scene.startFrame + 179, scene.startFrame + scene.durationInFrames - 1)]};
});

const archiveDir = path.join(root, 'outputs/extreme-long-video/assets/archive');
const previewAssetDir = path.join(root, 'public/extreme-long-video-preview');
const provenance = JSON.parse(fs.readFileSync(path.join(archiveDir, 'provenance.json'), 'utf8'));
const previewBindings = [
  [/Bartlett/, '01-frederic-bartlett.jpg'],
  [/Loftus/, '03-elizabeth-loftus.jpg'],
  [/amygdala/, '04-gray-amygdala.png'],
  [/lineup/, '05-lineup-room-a.jpg'],
  [/family/, '07-indiana-family.jpg'],
  [/questionnaire|record/, '15-notebook-page-37.jpg'],
  [/Kathlamet/, '20-kathlamet-texts.jpg'],
];
fs.mkdirSync(previewAssetDir, {recursive: true});
const assetMap = {};
for (const scene of design.scenes) {
  const requirement = scene.assetRequirements?.[0];
  if (!requirement) continue;
  const match = previewBindings.find(([pattern]) => pattern.test(requirement.query));
  if (!match) continue;
  const filename = match[1];
  const record = provenance.assets.find((asset) => asset.filename === filename);
  if (!record || record.acquisitionState !== 'physical-file-and-item-metadata-verified') continue;
  const source = path.join(archiveDir, filename);
  if (!fs.existsSync(source)) continue;
  fs.copyFileSync(source, path.join(previewAssetDir, filename));
  assetMap[scene.id] = [{assetId: `preview-${filename}`, publicPath: `extreme-long-video-preview/${filename}`, mediaType: 'image', width: null, height: null, description: requirement.subject, attribution: `${record.creator || record.title} · ${record.license} · Wikimedia Commons`, sourceUrl: record.sourceUrl}];
}

const props = {
  data: {
    schemaVersion: '1.0',
    templateVersion: 'memory-lab-editorial@1',
    project: {
      title: '你记得的，真的发生过吗？',
      projectId: 'extreme-long-video-preview',
      composition: 'ZhiyingFullCut',
      fps: 30,
      width: 1920,
      height: 1080,
      durationSec: design.scenes.at(-1).end,
      durationInFrames: design.scenes.at(-1).startFrame + design.scenes.at(-1).durationInFrames,
      timingBasis: 'design-preview-only',
      sceneCount: design.scenes.length,
      showPilotIntro: false,
    },
    chapterTiming: design.chapterTiming,
    scenes: design.scenes,
    assetMap,
  },
  subtitles: [],
  audio: {narration: null, bgm: null, sfx: null},
  showSubtitles: false,
  renderMode: 'preview',
};

fs.mkdirSync(outputDir, {recursive: true});
fs.rmSync(bundleDir, {recursive: true, force: true});
fs.writeFileSync(path.join(outputDir, 'preview-props.json'), `${JSON.stringify(props, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, 'prototype-selection.json'), `${JSON.stringify(prototypes.map(({name, scene, frameRange}) => ({name, sceneId: scene.id, chapter: scene.chapter, family: familyFor(scene), frameRange})), null, 2)}\n`);

console.log('[extreme-long-video] bundling preview source');
const serveUrl = await bundle({
  entryPoint: path.join(root, 'src/remotion/index.ts'),
  outDir: bundleDir,
  webpackOverride: (config) => ({
    ...config,
    resolve: {...config.resolve, alias: {...(config.resolve?.alias ?? {}), '@': path.join(root, 'src')}},
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
  onProgress: (progress) => console.log(`[extreme-long-video] bundle ${Math.round(progress)}%`),
});

for (const [index, prototype] of prototypes.entries()) {
  const composition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: props, port: 35000 + (process.pid % 500) + index});
  const outputLocation = path.join(outputDir, `${prototype.name}.mp4`);
  fs.rmSync(outputLocation, {force: true});
  console.log(`[extreme-long-video] ${prototype.name} ${prototype.scene.id} frames=${prototype.frameRange.join('-')}`);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: 20,
    frameRange: prototype.frameRange,
    outputLocation,
    inputProps: props,
    port: 35000 + (process.pid % 500) + index,
    concurrency: 4,
  });
}

fs.rmSync(bundleDir, {recursive: true, force: true});
console.log('[extreme-long-video] prototypes ready');

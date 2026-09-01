#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';

const root = process.cwd();
const outputDir = path.join(root, 'outputs/extreme-long-video/visual-grammar-v21');
const stillDir = path.join(outputDir, 'stills');
const bundleDir = path.join(outputDir, '.bundle');
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8'));
const archiveDir = path.join(root, 'outputs/extreme-long-video/assets/archive');
const previewAssetDir = path.join(root, 'public/extreme-long-video-preview');
const provenance = JSON.parse(fs.readFileSync(path.join(archiveDir, 'provenance.json'), 'utf8'));
const bindings = new Map([['S015', '20-kathlamet-texts.jpg'], ['S022', '03-elizabeth-loftus.jpg'], ['S067', '11-radio-listeners.jpg'], ['S078', '05-lineup-room-a.jpg'], ['S079', '06-lineup-room-b.jpg'], ['S098', '07-indiana-family.jpg'], ['S106', '15-notebook-page-37.jpg']]);
fs.mkdirSync(stillDir, {recursive: true});
fs.mkdirSync(previewAssetDir, {recursive: true});
const assetMap = {};
for (const scene of design.scenes) {
  const requirement = scene.assetRequirements?.[0];
  const filename = requirement ? bindings.get(scene.id) : undefined;
  if (!filename) continue;
  const record = provenance.assets.find((asset) => asset.filename === filename); const source = path.join(archiveDir, filename);
  if (!record || !fs.existsSync(source)) continue;
  fs.copyFileSync(source, path.join(previewAssetDir, filename));
  assetMap[scene.id] = [{assetId: `preview-${filename}`, publicPath: `extreme-long-video-preview/${filename}`, mediaType: 'image', width: null, height: null, description: requirement.subject, attribution: `${record.creator || record.title} · ${record.license}`, sourceUrl: record.sourceUrl}];
}
const requiredArchiveIds = design.scenes.filter((scene) => scene.assetRequirements?.length).map((scene) => scene.id);
if (requiredArchiveIds.some((sceneId) => !assetMap[sceneId])) throw new Error(`unbound archive preview asset: ${requiredArchiveIds.filter((sceneId) => !assetMap[sceneId]).join(', ')}`);
const unboundEvidence = design.scenes.filter((scene) => scene.templateProps?.memoryLab?.family === 'EVIDENCE_ARCHIVE' && !assetMap[scene.id]).map((scene) => scene.id);
if (unboundEvidence.length) throw new Error(`EVIDENCE_ARCHIVE cannot render an empty surface: ${unboundEvidence.join(', ')}`);
const props = {data: {schemaVersion: '1.0', templateVersion: 'memory-lab-editorial@1', project: {title: '记忆研究 — V2 静态预览', projectId: 'extreme-long-video-local-preview', composition: 'ZhiyingFullCut', fps: 30, width: 1920, height: 1080, durationSec: design.scenes.at(-1).end, durationInFrames: design.scenes.at(-1).startFrame + design.scenes.at(-1).durationInFrames, timingBasis: 'design-preview-only', sceneCount: design.scenes.length, showPilotIntro: false}, chapterTiming: design.chapterTiming, scenes: design.scenes, assetMap}, subtitles: [], audio: {narration: null, bgm: null, sfx: null}, showSubtitles: false, renderMode: 'preview'};
fs.writeFileSync(path.join(outputDir, 'preview-props.json'), `${JSON.stringify(props, null, 2)}\n`);
fs.rmSync(bundleDir, {recursive: true, force: true});
const serveUrl = await bundle({entryPoint: path.join(root, 'src/remotion/index.ts'), outDir: bundleDir, webpackOverride: (config) => ({...config, resolve: {...config.resolve, alias: {...(config.resolve?.alias ?? {}), '@': path.join(root, 'src')}}, module: {...config.module, rules: (config.module?.rules ?? []).map((rule) => { if (!rule || typeof rule !== 'object' || !('use' in rule)) return rule; const uses = Array.isArray(rule.use) ? rule.use : [rule.use]; return {...rule, use: uses.map((entry) => { if (!entry || typeof entry !== 'object' || !('loader' in entry) || typeof entry.loader !== 'string' || !entry.loader.includes('esbuild-loader')) return entry; const options = entry.options && typeof entry.options === 'object' ? entry.options : {}; return {...entry, options: {...options, jsx: 'automatic'}}; })}; })}})});
const composition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: props});
const storyboardGroups = [
  {id: 'A-0000-0330', scenes: ['S001', 'S003', 'S005', 'S011', 'S013', 'S015', 'S018', 'S022', 'S024']},
  {id: 'B-0500-0830', scenes: ['S035', 'S039', 'S043', 'S047', 'S052', 'S057', 'S062', 'S067', 'S068']},
  {id: 'C-0945-1330', scenes: ['S067', 'S069', 'S071', 'S074', 'S078', 'S081', 'S085', 'S089', 'S091']},
  {id: 'D-1315-1652', scenes: ['S090', 'S092', 'S094', 'S098', 'S101', 'S106', 'S107', 'S109', 'S111']},
];
const selectedIds = [...new Set(storyboardGroups.flatMap((group) => group.scenes))];
const selectedScenes = selectedIds.map((sceneId) => design.scenes.find((scene) => scene.id === sceneId)).filter(Boolean);
for (const scene of selectedScenes) {
  const output = path.join(stillDir, `${scene.id}.png`);
  await renderStill({composition, serveUrl, frame: scene.startFrame + Math.floor(scene.durationInFrames * .58), output, inputProps: props, imageFormat: 'png'});
}
for (const group of storyboardGroups) {
  const inputs = group.scenes.map((sceneId) => path.join(stillDir, `${sceneId}.png`));
  const columns = 3; const tileWidth = 560; const tileHeight = 315;
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...inputs.flatMap((input) => ['-i', input]), '-filter_complex', `${inputs.map((_, index) => `[${index}:v]scale=${tileWidth}:${tileHeight}[v${index}]`).join(';')};${inputs.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${inputs.length}:layout=${inputs.map((_, index) => `${(index % columns) * tileWidth}_${Math.floor(index / columns) * tileHeight}`).join('|')}`, '-frames:v', '1', path.join(outputDir, `${group.id}-contact-sheet.png`)]);
}
fs.rmSync(bundleDir, {recursive: true, force: true});
console.log(JSON.stringify({kind: 'static-storyboard-only', outputDir, storyboards: storyboardGroups.map((group) => ({id: group.id, frames: group.scenes.length})), mp4Created: 0}, null, 2));

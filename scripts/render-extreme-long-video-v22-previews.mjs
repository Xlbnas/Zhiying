#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';

const root = process.cwd();
const v221 = process.argv.includes('--v221');
const v222 = process.argv.includes('--v222');
const versionSlug = v222 ? 'v222' : v221 ? 'v221' : 'v22';
const outputDir = path.join(root, `outputs/extreme-long-video/visual-composition-${versionSlug}`);
const stillDir = path.join(outputDir, 'stills');
const bundleDir = path.join(outputDir, '.bundle');
const publicDir = path.join(root, 'public/extreme-long-video-preview');
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8'));
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'outputs/extreme-long-video/assets/archive/provenance.json'), 'utf8'));
const exactAudioDurationSec = 1013.299375;
const bindings = new Map([['S015', '20-kathlamet-texts.jpg'], ['S022', '03-elizabeth-loftus.jpg'], ['S067', '11-radio-listeners.jpg'], ['S078', '05-lineup-room-a.jpg'], ['S079', '06-lineup-room-b.jpg'], ['S098', '07-indiana-family.jpg'], ['S106', '15-notebook-page-37.jpg']]);
const clips = [
  {id: 'A-opening', start: 0, end: 93},
  {id: 'B-bartlett-loftus', start: 93, end: 215},
  {id: 'C-drm-mechanisms', start: 307, end: 497},
  {id: 'D-confidence-flashbulb', start: 504, end: 692},
  {id: 'E-autobiographical', start: 782, end: 915},
  {id: 'F-conclusion', start: 914, end: 1012},
];
const coralReelClips = [
  {id: 'opening-s002-s003', start: 6, end: 25},
  {id: 'drm-s036-s038', start: 310, end: 334},
  {id: 'structural-not-equal-s041', start: 350, end: 362},
  {id: 'structural-not-equal-s066', start: 575, end: 587},
];
const archiveSceneIds = ['S015', 'S022', 'S067', 'S078', 'S079', 'S098', 'S106'];
const archiveReelClips = archiveSceneIds.map((sceneId) => {
  const scene = design.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`archive scene missing from design: ${sceneId}`);
  return {id: sceneId, start: Math.max(0, scene.start - 2), end: Math.min(exactAudioDurationSec, scene.start + scene.duration + 2)};
});
const stillIds = ['S001', 'S004', 'S008', 'S012', 'S013', 'S015', 'S018', 'S022', 'S025', 'S035', 'S039', 'S044', 'S048', 'S052', 'S056', 'S058', 'S062', 'S066', 'S067', 'S071', 'S077', 'S089', 'S092', 'S095', 'S098', 'S101', 'S102', 'S104', 'S106', 'S108', 'S111'];
const fullMode = process.argv.includes('--full');
const mode = fullMode ? 'full' : process.argv.includes('--archive-reel') ? 'archive-reel' : process.argv.includes('--reel') ? 'reel' : process.argv.includes('--clips') ? 'clips' : 'stills';
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];

fs.mkdirSync(stillDir, {recursive: true}); fs.mkdirSync(publicDir, {recursive: true});
const archiveOutputDir = path.join(root, 'outputs/extreme-long-video/archive-usefulness-v1');
if (mode === 'archive-reel') fs.mkdirSync(archiveOutputDir, {recursive: true});
const assetMap = {};
for (const [sceneId, filename] of bindings) {
  const source = path.join(root, 'outputs/extreme-long-video/assets/archive', filename);
  const record = provenance.assets.find((asset) => asset.filename === filename);
  if (!record || !fs.existsSync(source)) throw new Error(`${sceneId}: preview archive is missing`);
  fs.copyFileSync(source, path.join(publicDir, filename));
  assetMap[sceneId] = [{assetId: `preview-${filename}`, publicPath: `extreme-long-video-preview/${filename}`, mediaType: 'image', width: null, height: null, description: filename, attribution: `${record.creator || record.title} · ${record.license}`, sourceUrl: record.sourceUrl}];
}
const audioSource = path.join(root, 'outputs/extreme-long-video/audio/narration-master.wav');
const audioPublicName = `narration-master-${versionSlug}.wav`;
if (!fs.existsSync(audioSource)) throw new Error('exact current narration master is missing');
const audioPublicPath = path.join(publicDir, audioPublicName);
if (!fs.existsSync(audioPublicPath) || fs.statSync(audioPublicPath).size !== fs.statSync(audioSource).size) fs.copyFileSync(audioSource, audioPublicPath);
const subtitleArtifact = JSON.parse(fs.readFileSync(path.join(root, 'outputs/extreme-long-video/subtitles/subtitle_timing_v2.json'), 'utf8'));
const subtitleCues = subtitleArtifact.cues.map((cue) => ({id: cue.id, segmentId: cue.segmentId, chapter: cue.chapter, text: cue.text, start: cue.startMs / 1000, end: cue.endMs / 1000, position: cue.position}));
const props = {data: {schemaVersion: '1.0', templateVersion: 'memory-lab-editorial@1', project: {title: `记忆研究 — ${v222 ? 'V2.2.2' : v221 ? 'V2.2.1' : 'V2.2'} 动态预览`, projectId: `extreme-long-video-${versionSlug}-local-qc`, composition: 'ZhiyingFullCut', fps: 30, width: 1920, height: 1080, durationSec: exactAudioDurationSec, durationInFrames: Math.ceil(exactAudioDurationSec * 30), timingBasis: `${versionSlug}-preview-current-audio`, sceneCount: design.scenes.length, showPilotIntro: false}, chapterTiming: design.chapterTiming, scenes: design.scenes, assetMap}, subtitles: [], audio: {narration: `extreme-long-video-preview/${audioPublicName}`, bgm: null, sfx: null}, showSubtitles: false, renderMode: 'preview'};
fs.writeFileSync(path.join(outputDir, 'preview-props.json'), `${JSON.stringify(props, null, 2)}\n`);
fs.rmSync(bundleDir, {recursive: true, force: true});
const serveUrl = await bundle({entryPoint: path.join(root, 'src/remotion/index.ts'), outDir: bundleDir, webpackOverride: (config) => ({...config, resolve: {...config.resolve, alias: {...(config.resolve?.alias ?? {}), '@': path.join(root, 'src')}}, module: {...config.module, rules: (config.module?.rules ?? []).map((rule) => {if (!rule || typeof rule !== 'object' || !('use' in rule)) return rule; const uses = Array.isArray(rule.use) ? rule.use : [rule.use]; return {...rule, use: uses.map((entry) => {if (!entry || typeof entry !== 'object' || !('loader' in entry) || typeof entry.loader !== 'string' || !entry.loader.includes('esbuild-loader')) return entry; const options = entry.options && typeof entry.options === 'object' ? entry.options : {}; return {...entry, options: {...options, jsx: 'automatic'}};})};})}}), onProgress: (progress) => console.log(`[v22] bundle ${Math.round(progress)}%`)});
const composition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: props});

if (mode === 'stills') {
  const selected = only ? [only] : stillIds;
  for (const sceneId of selected) {
    const scene = design.scenes.find((item) => item.id === sceneId); if (!scene) throw new Error(`unknown scene: ${sceneId}`);
    await renderStill({composition, serveUrl, frame: scene.startFrame + Math.floor(scene.durationInFrames * .58), output: path.join(stillDir, `${sceneId}.png`), inputProps: props, imageFormat: 'png', scale: 2 / 3});
    console.log(`[v22] still ${sceneId}`);
  }
  if (!only) {
    const inputs = selected.map((sceneId) => path.join(stillDir, `${sceneId}.png`)); const columns = 5; const tileWidth = 384; const tileHeight = 216;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...inputs.flatMap((input) => ['-i', input]), '-filter_complex', `${inputs.map((_, index) => `[${index}:v]scale=${tileWidth}:${tileHeight}[v${index}]`).join(';')};${inputs.map((_, index) => `[v${index}]`).join('')}xstack=inputs=${inputs.length}:layout=${inputs.map((_, index) => `${(index % columns) * tileWidth}_${Math.floor(index / columns) * tileHeight}`).join('|')}`, '-frames:v', '1', path.join(outputDir, 'representative-contact-sheet.jpg')]);
  }
} else if (mode === 'archive-reel') {
  for (const burned of [false, true]) {
    const reelProps = {...props, subtitles: burned ? subtitleCues : [], showSubtitles: burned};
    const reelComposition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: reelProps, port: burned ? 37702 : 37701});
    const parts = [];
    for (const [index, clip] of archiveReelClips.entries()) {
      const part = path.join(archiveOutputDir, `.archive-reel-${burned ? 'burned' : 'clean'}-${index}.mp4`);
      fs.rmSync(part, {force: true});
      await renderMedia({composition: reelComposition, serveUrl, codec: 'h264', crf: 21, frameRange: [Math.round(clip.start * 30), Math.round(clip.end * 30) - 1], outputLocation: part, inputProps: reelProps, concurrency: 4, scale: 2 / 3, port: (burned ? 37800 : 37700) + index});
      parts.push(part);
      console.log(`[archive-v1] reel ${burned ? 'burned' : 'clean'} ${clip.id}`);
    }
    const output = path.join(archiveOutputDir, `archive-reel-${burned ? 'burned' : 'clean'}.mp4`);
    fs.rmSync(output, {force: true});
    const filter = `${parts.map((_, index) => `[${index}:v][${index}:a]`).join('')}concat=n=${parts.length}:v=1:a=1[v][a]`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...parts.flatMap((part) => ['-i', part]), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', output]);
    for (const part of parts) fs.rmSync(part, {force: true});
    console.log(`[archive-v1] ready ${path.basename(output)} bytes=${fs.statSync(output).size}`);
  }
} else if (mode === 'reel') {
  for (const burned of [false, true]) {
    const reelProps = {...props, subtitles: burned ? subtitleCues : [], showSubtitles: burned};
    const reelComposition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: reelProps, port: burned ? 37502 : 37501});
    const parts = [];
    for (const [index, clip] of coralReelClips.entries()) {
      const part = path.join(outputDir, `.coral-reel-${burned ? 'burned' : 'clean'}-${index}.mp4`);
      fs.rmSync(part, {force: true});
      await renderMedia({composition: reelComposition, serveUrl, codec: 'h264', crf: 21, frameRange: [Math.round(clip.start * 30), Math.round(clip.end * 30) - 1], outputLocation: part, inputProps: reelProps, concurrency: 4, scale: 2 / 3, port: (burned ? 37600 : 37500) + index});
      parts.push(part);
      console.log(`[v222] reel ${burned ? 'burned' : 'clean'} ${clip.id}`);
    }
    const output = path.join(outputDir, `coral-overlay-reel-${burned ? 'burned' : 'clean'}.mp4`);
    fs.rmSync(output, {force: true});
    const filter = `${parts.map((_, index) => `[${index}:v][${index}:a]`).join('')}concat=n=${parts.length}:v=1:a=1[v][a]`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...parts.flatMap((part) => ['-i', part]), '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '21', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', output]);
    for (const part of parts) fs.rmSync(part, {force: true});
    console.log(`[v222] ready ${path.basename(output)} bytes=${fs.statSync(output).size}`);
  }
} else if (mode === 'clips') {
  const selected = only ? clips.filter((clip) => clip.id === only) : clips;
  if (!selected.length) throw new Error(`unknown clip: ${only}`);
  for (const clip of selected) {
    const output = path.join(outputDir, `${clip.id}.mp4`); fs.rmSync(output, {force: true});
    const started = Date.now(); let lastLog = 0;
    await renderMedia({composition, serveUrl, codec: 'h264', crf: 21, frameRange: [Math.round(clip.start * 30), Math.round(clip.end * 30) - 1], outputLocation: output, inputProps: props, concurrency: 4, scale: 2 / 3, onProgress: ({renderedFrames}) => {const now = Date.now(); if (now - lastLog >= 10000) {lastLog = now; console.log(`[v22] ${clip.id} rendered=${renderedFrames} elapsed=${Math.round((now - started) / 1000)}s`);}}});
    console.log(`[v22] ready ${clip.id} bytes=${fs.statSync(output).size}`);
  }
} else {
  const burnedOnly = process.argv.includes('--burned-only');
  const cleanOnly = process.argv.includes('--clean-only');
  const checkOnly = process.argv.includes('--check-only');
  for (const burned of burnedOnly ? [true] : cleanOnly ? [false] : [false, true]) {
    const fullProps = {...props, subtitles: burned ? subtitleCues : [], showSubtitles: burned};
    const fullComposition = await selectComposition({serveUrl, id: 'ZhiyingFullCut', inputProps: fullProps, port: burned ? 37402 : 37401});
    await renderStill({composition: fullComposition, serveUrl, frame: 150, output: path.join(outputDir, burned ? 'burned-subtitle-check.png' : 'clean-subtitle-check.png'), inputProps: fullProps, imageFormat: 'png', scale: 2 / 3, port: burned ? 37412 : 37411});
    if (checkOnly) continue;
    const output = path.join(outputDir, v222 ? burned ? 'full-local-preview-720p-v222-burned.mp4' : 'full-local-preview-720p-v222.mp4' : burned ? 'full-local-preview-720p-burned.mp4' : 'full-local-preview-720p.mp4');
    fs.rmSync(output, {force: true});
    const started = Date.now(); let lastLog = 0;
    await renderMedia({composition: fullComposition, serveUrl, codec: 'h264', crf: 21, outputLocation: output, inputProps: fullProps, port: burned ? 37422 : 37421, concurrency: 4, scale: 2 / 3, onProgress: ({renderedFrames}) => {const now = Date.now(); if (now - lastLog >= 10000) {lastLog = now; console.log(`[v221] ${burned ? 'burned' : 'clean'} rendered=${renderedFrames} elapsed=${Math.round((now - started) / 1000)}s`);}}});
    console.log(`[v221] ready ${path.basename(output)} bytes=${fs.statSync(output).size}`);
  }
}
fs.rmSync(bundleDir, {recursive: true, force: true});
console.log(JSON.stringify({kind: mode === 'full' ? 'full-length-clean-and-burned-local-qc' : mode === 'archive-reel' ? 'targeted-archive-usefulness-review-reel' : mode === 'reel' ? 'targeted-coral-overlay-review-reel' : mode === 'clips' ? 'audio-bearing-720p-continuous-previews' : 'representative-720p-stills', outputDir: mode === 'archive-reel' ? archiveOutputDir : outputDir, formalRenderJobsCreated: 0}, null, 2));

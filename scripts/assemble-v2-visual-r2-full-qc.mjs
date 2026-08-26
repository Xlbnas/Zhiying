#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const reconciliation = JSON.parse(fs.readFileSync('/tmp/timing_reconciliation_v2.json', 'utf8'));
const prototypeRoot = path.join(root, 'outputs/v2-visual-r2/prototypes');
const outputDir = path.join(root, 'outputs/v2-visual-r2/full-qc');
const docsDir = path.join(root, 'docs/skill_migration/24_V2_VISUAL_R2');
const windows = [
  {id: 'A', name: 'A-hook', start: 0, end: 920},
  {id: 'D', name: 'D-history', start: 920, end: 2821},
  {id: 'B', name: 'B-mechanism', start: 2821, end: 3832},
  {id: 'E', name: 'E-applied-mechanisms', start: 3832, end: 5514},
  {id: 'C', name: 'C-evaluation-conclusion', start: 5514, end: 6754},
  {id: 'F', name: 'F-final-close', start: 6754, end: 7307},
].map((window) => ({...window, video: path.join(prototypeRoot, `${window.name}.mp4`)}));

function run(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function windowForFrame(frame) {
  const window = windows.find((candidate) => frame >= candidate.start && frame < candidate.end);
  if (!window) throw new Error(`No QC window for global frame ${frame}`);
  return window;
}

function extract(entries, directory, prefix) {
  fs.mkdirSync(directory, {recursive: true});
  const grouped = new Map();
  for (const entry of entries) {
    const window = windowForFrame(entry.globalFrame);
    const list = grouped.get(window.id) ?? [];
    list.push({...entry, window, localFrame: entry.globalFrame - window.start});
    grouped.set(window.id, list);
  }
  for (const [windowId, items] of grouped) {
    const window = items[0].window;
    const uniqueFrames = [...new Set(items.map((item) => item.localFrame))].sort((a, b) => a - b);
    const sourceByFrame = new Map();
    for (let batchIndex = 0; batchIndex < uniqueFrames.length; batchIndex += 30) {
      const batch = uniqueFrames.slice(batchIndex, batchIndex + 30);
      const temporary = path.join(directory, `${prefix}-${windowId}-${String(batchIndex / 30).padStart(2, '0')}-%04d.png`);
      run(['-i', window.video, '-vf', `select='${batch.map((frame) => `eq(n\\,${frame})`).join('+')}',scale=480:270`, '-vsync', '0', temporary]);
      const marker = `${prefix}-${windowId}-${String(batchIndex / 30).padStart(2, '0')}-`;
      const files = fs.readdirSync(directory).filter((name) => name.startsWith(marker) && name.endsWith('.png')).sort();
      if (files.length !== batch.length) throw new Error(`${windowId} selected frames ${files.length} != ${batch.length}`);
      batch.forEach((frame, index) => sourceByFrame.set(frame, files[index]));
    }
    for (const item of items) fs.copyFileSync(path.join(directory, sourceByFrame.get(item.localFrame)), path.join(directory, item.filename));
    for (const filename of sourceByFrame.values()) fs.unlinkSync(path.join(directory, filename));
  }
}

fs.rmSync(outputDir, {recursive: true, force: true});
fs.mkdirSync(outputDir, {recursive: true});

const scenes = reconciliation.scenes.map((scene) => ({
  sceneId: scene.sceneId,
  startFrame: scene.effectiveStartFrame,
  endFrame: scene.effectiveEndFrame,
}));
const scenesPath = path.join(docsDir, 'full-scenes.json');
fs.writeFileSync(scenesPath, `${JSON.stringify({scenes}, null, 2)}\n`);

const secondEntries = Array.from({length: 244}, (_, second) => ({globalFrame: Math.min(second * 30, 7306), filename: `global-second-${String(second).padStart(3, '0')}.png`}));
const secondDir = path.join(outputDir, 'one-second-frames');
extract(secondEntries, secondDir, 'seconds-source');
const sheetDir = path.join(outputDir, 'one-second-contact-sheets');
fs.mkdirSync(sheetDir, {recursive: true});
run(['-framerate', '1', '-start_number', '0', '-i', path.join(secondDir, 'global-second-%03d.png'), '-vf', 'scale=320:180,tile=8x8:nb_frames=64:padding=4:margin=4:color=white', '-vsync', '0', path.join(sheetDir, 'contact-sheet-%02d.png')]);

const sceneStripsDir = path.join(outputDir, 'scene-strips');
fs.mkdirSync(sceneStripsDir, {recursive: true});
for (const window of windows) {
  const source = path.join(prototypeRoot, `${window.id}-evidence/scene-strips`);
  for (const filename of fs.readdirSync(source).filter((name) => name.endsWith('.png'))) fs.copyFileSync(path.join(source, filename), path.join(sceneStripsDir, filename));
}

const transitionDir = path.join(outputDir, 'transition-strips');
fs.mkdirSync(transitionDir, {recursive: true});
for (const window of windows) {
  const source = path.join(prototypeRoot, `${window.id}-evidence/boundary-strips`);
  for (const filename of fs.readdirSync(source).filter((name) => name.endsWith('.png'))) fs.copyFileSync(path.join(source, filename), path.join(transitionDir, filename));
}
const crossBoundaries = [920, 2821, 3832, 5514, 6754];
for (const boundary of crossBoundaries) {
  const next = scenes.find((scene) => scene.startFrame === boundary);
  const previous = scenes[scenes.indexOf(next) - 1];
  const boundaryId = `${previous.sceneId}-${next.sceneId}`;
  const frameDir = path.join(outputDir, 'cross-boundary-frames', boundaryId);
  const entries = Array.from({length: 21}, (_, index) => ({globalFrame: boundary - 10 + index, filename: `${String(index).padStart(2, '0')}.png`}));
  extract(entries, frameDir, 'boundary-source');
  const inputs = entries.flatMap((entry) => ['-i', path.join(frameDir, entry.filename)]);
  const layout = entries.map((_, index) => `${(index % 7) * 240}_${Math.floor(index / 7) * 135}`).join('|');
  run([...inputs, '-filter_complex', `${entries.map((_, index) => `[${index}:v]scale=240:135[x${index}]`).join(';')};${entries.map((_, index) => `[x${index}]`).join('')}xstack=inputs=21:layout=${layout}`, '-frames:v', '1', path.join(transitionDir, `${boundaryId}-strip.png`)]);
}

const motionWindowCount = 49;
const motionWindowFrameDir = path.join(outputDir, 'motion-window-frames');
const motionWindowStripDir = path.join(outputDir, 'motion-window-strips');
fs.mkdirSync(motionWindowStripDir, {recursive: true});
const motionWindows = Array.from({length: motionWindowCount}, (_, index) => {
  const startFrame = Math.floor(index * 7307 / motionWindowCount);
  const endFrame = Math.floor((index + 1) * 7307 / motionWindowCount);
  const span = endFrame - startFrame;
  const sampledFrames = [
    startFrame,
    startFrame + Math.floor((span - 1) * 0.28),
    startFrame + Math.floor((span - 1) * 0.68),
    endFrame - 1,
  ];
  return {
    id: `W${String(index + 1).padStart(2, '0')}`,
    startFrame,
    endFrame,
    durationSeconds: span / 30,
    samples: ['setup', 'action', 'visible-result', 'handoff'].map((role, sampleIndex) => ({
      role,
      globalFrame: sampledFrames[sampleIndex],
      filename: `W${String(index + 1).padStart(2, '0')}-${role}.png`,
    })),
  };
});
extract(motionWindows.flatMap((window) => window.samples), motionWindowFrameDir, 'motion-source');
for (const window of motionWindows) {
  const inputs = window.samples.flatMap((sample) => ['-i', path.join(motionWindowFrameDir, sample.filename)]);
  run([...inputs, '-filter_complex', '[0:v]scale=480:270[x0];[1:v]scale=480:270[x1];[2:v]scale=480:270[x2];[3:v]scale=480:270[x3];[x0][x1][x2][x3]hstack=inputs=4', '-frames:v', '1', path.join(motionWindowStripDir, `${window.id}-strip.png`)]);
}

const manifest = {
  schemaVersion: 'v2-visual-r2-full-qc@1.0',
  frameCoverage: {start: 0, endExclusive: 7307, frames: 7307},
  windows: windows.map(({id, name, start, end, video}) => ({id, name, start, end, frames: end - start, video})),
  oneSecondSamples: secondEntries.length,
  contactSheets: fs.readdirSync(sheetDir).filter((name) => name.endsWith('.png')).length,
  sceneStrips: fs.readdirSync(sceneStripsDir).filter((name) => name.endsWith('.png')).length,
  transitionStrips: fs.readdirSync(transitionDir).filter((name) => name.endsWith('.png')).length,
  motionWindows,
  motionWindowStrips: fs.readdirSync(motionWindowStripDir).filter((name) => name.endsWith('.png')).length,
  crossBoundaries,
};
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));

#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const video = valueAfter('--video');
const scenesPath = valueAfter('--scenes');
const motionPath = valueAfter('--motion');
const outputDir = valueAfter('--output-dir');
if (!video || !scenesPath || !motionPath || !outputDir) {
  console.error('Usage: generate-video-audit-evidence.mjs --video <mp4> --scenes <json> --motion <json> --output-dir <dir>');
  process.exit(2);
}

const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8')).scenes;
const motion = JSON.parse(fs.readFileSync(motionPath, 'utf8'));
const maxInfoByScene = new Map(motion.scenes.map((scene) => [scene.sceneId, scene.maximumInformationFrame]));
const absoluteVideo = path.resolve(video);

function run(args) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function extractSelectedFrames(entries, directory) {
  fs.mkdirSync(directory, {recursive: true});
  const selected = [...new Set(entries.map((entry) => entry.frame))].sort((a, b) => a - b);
  const sourceByFrame = new Map();
  for (let batchIndex = 0; batchIndex < selected.length; batchIndex += 30) {
    const batch = selected.slice(batchIndex, batchIndex + 30);
    const prefix = `selected-${String(batchIndex / 30).padStart(2, '0')}`;
    const temporary = path.join(directory, `${prefix}-%04d.png`);
    run(['-i', absoluteVideo, '-vf', `select='${batch.map((frame) => `eq(n\\,${frame})`).join('+')}',scale=480:270`, '-vsync', '0', temporary]);
    const files = fs.readdirSync(directory).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.png')).sort();
    if (files.length !== batch.length) throw new Error(`selected frame count mismatch: ${files.length} != ${batch.length}`);
    batch.forEach((sourceFrame, index) => sourceByFrame.set(sourceFrame, files[index]));
  }
  for (const entry of entries) {
    fs.copyFileSync(path.join(directory, sourceByFrame.get(entry.frame)), path.join(directory, entry.filename));
  }
  for (const file of sourceByFrame.values()) fs.unlinkSync(path.join(directory, file));
}

fs.mkdirSync(outputDir, {recursive: true});

const secondsDir = path.join(outputDir, 'one-second-frames');
fs.mkdirSync(secondsDir, {recursive: true});
run(['-i', absoluteVideo, '-vf', 'fps=1,scale=480:270', '-vsync', '0', path.join(secondsDir, 'second-%03d.png')]);

const sheetsDir = path.join(outputDir, 'one-second-contact-sheets');
fs.mkdirSync(sheetsDir, {recursive: true});
run([
  '-i', absoluteVideo,
  '-vf', 'fps=1,scale=320:180,tile=8x8:nb_frames=64:padding=4:margin=4:color=white',
  '-vsync', '0', path.join(sheetsDir, 'contact-sheet-%02d.png'),
]);

const sceneEntries = [];
const sceneManifest = [];
for (const scene of scenes) {
  const length = scene.endFrame - scene.startFrame;
  const points = [
    ['entry', scene.startFrame + 1],
    ['q25', scene.startFrame + Math.round(length * 0.25)],
    ['midpoint', scene.startFrame + Math.round(length * 0.5)],
    ['maximum-information', maxInfoByScene.get(scene.sceneId)],
    ['q75', scene.startFrame + Math.round(length * 0.75)],
    ['handoff', scene.endFrame - 2],
  ];
  const items = points.map(([label, frame]) => ({label, frame, filename: `${scene.sceneId}-${label}.png`}));
  sceneManifest.push({...scene, frames: items});
  sceneEntries.push(...items);
}
const sceneFramesDir = path.join(outputDir, 'scene-frames');
extractSelectedFrames(sceneEntries, sceneFramesDir);

const sceneStripsDir = path.join(outputDir, 'scene-strips');
fs.mkdirSync(sceneStripsDir, {recursive: true});
for (const scene of sceneManifest) {
  const inputs = scene.frames.flatMap((item) => ['-i', path.join(sceneFramesDir, item.filename)]);
  run([...inputs, '-filter_complex', 'xstack=inputs=6:layout=0_0|480_0|960_0|1440_0|1920_0|2400_0', '-frames:v', '1', path.join(sceneStripsDir, `${scene.sceneId}-strip.png`)]);
}

const boundaryEntries = [];
const boundaryManifest = [];
for (let index = 1; index < scenes.length; index += 1) {
  const boundary = scenes[index].startFrame;
  const boundaryId = `${scenes[index - 1].sceneId}-${scenes[index].sceneId}`;
  const frames = Array.from({length: 21}, (_, offset) => boundary - 10 + offset);
  const items = frames.map((sourceFrame, offset) => ({
    frame: sourceFrame,
    filename: `${boundaryId}-${String(offset).padStart(2, '0')}.png`,
  }));
  boundaryManifest.push({boundaryId, boundaryFrame: boundary, frames: items});
  boundaryEntries.push(...items);
}
const boundaryFramesDir = path.join(outputDir, 'boundary-frames');
extractSelectedFrames(boundaryEntries, boundaryFramesDir);

const boundaryStripsDir = path.join(outputDir, 'boundary-strips');
fs.mkdirSync(boundaryStripsDir, {recursive: true});
for (const boundary of boundaryManifest) {
  const inputs = boundary.frames.flatMap((item) => ['-i', path.join(boundaryFramesDir, item.filename)]);
  const layout = boundary.frames.map((_, index) => `${(index % 7) * 240}_${Math.floor(index / 7) * 135}`).join('|');
  run([...inputs, '-filter_complex', `[0:v]scale=240:135[x0];${boundary.frames.slice(1).map((_, index) => `[${index + 1}:v]scale=240:135[x${index + 1}]`).join(';')};${boundary.frames.map((_, index) => `[x${index}]`).join('')}xstack=inputs=21:layout=${layout}`,
    '-frames:v', '1', path.join(boundaryStripsDir, `${boundary.boundaryId}-strip.png`)]);
}

const manifest = {
  video: absoluteVideo,
  oneSecondFrames: fs.readdirSync(secondsDir).filter((name) => name.endsWith('.png')).length,
  contactSheets: fs.readdirSync(sheetsDir).filter((name) => name.endsWith('.png')).length,
  scenes: sceneManifest,
  boundaries: boundaryManifest,
};
fs.writeFileSync(path.join(outputDir, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({outputDir, oneSecondFrames: manifest.oneSecondFrames, scenes: scenes.length, boundaries: boundaryManifest.length}));

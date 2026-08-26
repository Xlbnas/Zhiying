#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const reconciliation = JSON.parse(fs.readFileSync('/tmp/timing_reconciliation_v2.json', 'utf8'));
const subtitles = JSON.parse(fs.readFileSync('/tmp/subtitle_timing_v2.json', 'utf8'));
const choreography = JSON.parse(fs.readFileSync(path.join(root, 'src/data/v2-visual-r2-choreography-plan.json'), 'utf8'));
const outputDir = path.join(root, 'docs/skill_migration/24_V2_VISUAL_R2/prototypes');

const prototypes = [
  {id: 'A', name: 'hook', startFrame: 0, endFrame: 920, sceneIds: ['S001', 'S002', 'S003', 'S004']},
  {id: 'B', name: 'mechanism', startFrame: 2821, endFrame: 3832, sceneIds: ['S011', 'S012', 'S013', 'S014']},
  {id: 'C', name: 'evaluation-conclusion', startFrame: 5514, endFrame: 6754, sceneIds: ['S020', 'S021', 'S022', 'S023']},
  {id: 'D', name: 'history', startFrame: 920, endFrame: 2821, sceneIds: ['S005', 'S006', 'S007', 'S008', 'S009', 'S010']},
  {id: 'E', name: 'applied-mechanisms', startFrame: 3832, endFrame: 5514, sceneIds: ['S015', 'S016', 'S017', 'S018', 'S019']},
  {id: 'F', name: 'final-close', startFrame: 6754, endFrame: 7307, sceneIds: ['S024', 'S025']},
];

fs.mkdirSync(outputDir, {recursive: true});
const manifest = {schemaVersion: 'v2-visual-r2-prototype-evidence@1.0', prototypes: []};

for (const prototype of prototypes) {
  const scenes = reconciliation.scenes
    .filter((scene) => prototype.sceneIds.includes(scene.sceneId))
    .map((scene) => ({
      sceneId: scene.sceneId,
      startFrame: scene.effectiveStartFrame - prototype.startFrame,
      endFrame: scene.effectiveEndFrame - prototype.startFrame,
      sourceStartFrame: scene.effectiveStartFrame,
      sourceEndFrame: scene.effectiveEndFrame,
    }));
  const beats = choreography.beats
    .filter((beat) => prototype.sceneIds.includes(beat.sceneId))
    .map((beat) => ({
      ...beat,
      localStartFrame: Math.max(0, beat.startFrame - prototype.startFrame),
      localEndFrame: Math.min(prototype.endFrame - prototype.startFrame, beat.endFrame - prototype.startFrame),
    }));
  const cueIds = new Set(beats.flatMap((beat) => beat.subtitleCueIds));
  const cues = subtitles.cues
    .filter((cue) => cueIds.has(cue.id))
    .map((cue) => ({
      id: cue.id,
      segmentId: cue.segmentId,
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      sourceStartFrame: Math.ceil(cue.startMs * 30 / 1000),
      sourceEndFrame: Math.ceil(cue.endMs * 30 / 1000),
      localStartFrame: Math.max(0, Math.ceil(cue.startMs * 30 / 1000) - prototype.startFrame),
      localEndFrame: Math.min(prototype.endFrame - prototype.startFrame, Math.ceil(cue.endMs * 30 / 1000) - prototype.startFrame),
    }));
  const sceneFile = `${prototype.id}-${prototype.name}-scenes.json`;
  fs.writeFileSync(path.join(outputDir, sceneFile), `${JSON.stringify({scenes}, null, 2)}\n`);
  manifest.prototypes.push({...prototype, frameCount: prototype.endFrame - prototype.startFrame, sceneFile, scenes, beats, cues});
}

fs.writeFileSync(path.join(outputDir, 'prototype-cue-map.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const lines = [
  '# V2 Visual R2 Prototype Cue Map',
  '',
  'All frames are at 30 fps. Source frames remain anchored to exact Subtitle V2 cue boundaries; local frames are offsets inside each preview-only clip.',
  '',
];
for (const prototype of manifest.prototypes) {
  lines.push(`## Prototype ${prototype.id} — ${prototype.name}`, '', `Source frames: ${prototype.startFrame}–${prototype.endFrame - 1}; ${prototype.frameCount} frames.`, '', '| Beat | Scene | Local frames | Cue | Dominant verb | Visible result |', '|---|---|---:|---|---|---|');
  for (const beat of prototype.beats) {
    lines.push(`| ${beat.beatId} | ${beat.sceneId} | ${beat.localStartFrame}–${beat.localEndFrame - 1} | ${beat.subtitleCueIds.join(', ')} | ${beat.dominantVerb} | ${beat.visibleResult} |`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(outputDir, 'PROTOTYPE_CUE_MAP.md'), `${lines.join('\n').trimEnd()}\n`);
console.log(JSON.stringify({outputDir, prototypes: manifest.prototypes.map(({id, frameCount, scenes, beats, cues}) => ({id, frameCount, scenes: scenes.length, beats: beats.length, cues: cues.length}))}, null, 2));

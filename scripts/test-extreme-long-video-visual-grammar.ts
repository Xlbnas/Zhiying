import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {semanticStateCountForDuration, semanticStateStarts} from '../src/remotion/templates/production/MemoryLabEditorialScene';

const root = process.cwd();
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8')) as {scenes: Array<{id: string; start: number; end: number; narrationSummary: string; assetRequirements: unknown[]; templateProps: {memoryLab: {family: string; compositionVariant?: number; compositionMode?: string; backgroundMode?: string; narrationText?: string; visualThesis?: string; visualLabels?: string[]; sequence?: {id: string; phase: number}}}}>} ;
const chinese = (text: string) => text.replace(/[^\u4e00-\u9fff]/g, '');
const overlap = (narration: string, thesis: string) => {
  const source = chinese(narration); const target = chinese(thesis);
  if (!target || source === target) return true;
  for (let width = Math.min(18, target.length); width >= 8; width -= 1) for (let i = 0; i <= target.length - width; i += 1) if (source.includes(target.slice(i, i + width))) return true;
  return false;
};
for (const scene of design.scenes) {
  const data = scene.templateProps.memoryLab;
  assert.equal(data.narrationText, scene.narrationSummary, `${scene.id}: narration authority changed`);
  assert.equal(data.backgroundMode, 'dark', `${scene.id}: default background must be dark`);
  assert.equal(overlap(scene.narrationSummary, data.visualThesis ?? ''), false, `${scene.id}: visual thesis overlaps narration`);
  assert.ok((data.visualLabels ?? []).every((label) => label.length <= 8), `${scene.id}: visual label too long`);
  assert.ok([0, 1, 2].includes(data.compositionVariant ?? -1), `${scene.id}: composition variant missing`);
}
const duplicateTheses = new Map<string, string[]>();
for (const scene of design.scenes) { const thesis = scene.templateProps.memoryLab.visualThesis ?? ''; duplicateTheses.set(thesis, [...(duplicateTheses.get(thesis) ?? []), scene.id]); }
assert.deepEqual([...duplicateTheses.values()].filter((ids) => ids.length > 1), [], 'visual theses must not repeat');
assert.deepEqual(design.scenes.filter((scene) => scene.assetRequirements.length).map((scene) => scene.id), ['S015', 'S022', 'S067', 'S078', 'S079', 'S098', 'S106'], 'archive requirements must match the semantic binding audit');
const modeMinimums = new Map([['VERSION_DIFF', 4], ['KINETIC_CLAIM', 4], ['CONCEPT_SPACE', 6], ['PROCESS_MAP', 7], ['COMPARISON', 7]]);
for (const [family, minimum] of modeMinimums) {
  const modes = new Set(design.scenes.filter((scene) => scene.templateProps.memoryLab.family === family).map((scene) => scene.templateProps.memoryLab.compositionMode).filter(Boolean));
  assert.ok(modes.size >= minimum, `${family}: requires at least ${minimum} semantic composition modes`);
}
const comparisonModes = new Map<string, number>();
for (const scene of design.scenes.filter((item) => item.templateProps.memoryLab.family === 'COMPARISON')) {const mode = scene.templateProps.memoryLab.compositionMode ?? 'missing'; comparisonModes.set(mode, (comparisonModes.get(mode) ?? 0) + 1);}
assert.ok(Math.max(...comparisonModes.values()) <= 6, 'no comparison composition may dominate over six scenes');
const expectedSequences = ['opening-disagreement', 'bartlett-to-loftus', 'drm-mechanisms', 'confidence-eyewitness', 'flashbulb-longitudinal', 'suggested-autobiographical'];
for (const sequenceId of expectedSequences) {
  const rows = design.scenes.filter((scene) => scene.templateProps.memoryLab.sequence?.id === sequenceId);
  assert.ok(rows.length >= 8, `${sequenceId}: sequence world is too short`);
  assert.deepEqual(rows.map((scene) => scene.templateProps.memoryLab.sequence?.phase), rows.map((_, index) => index), `${sequenceId}: phases must be contiguous`);
}
const renderer = fs.readFileSync(path.join(root, 'src/remotion/templates/production/MemoryLabEditorialScene.tsx'), 'utf8');
assert.match(renderer, /const showSceneId = data\.debugOverlay === true \|\| data\.showSceneId === true/);
assert.match(renderer, /showSceneId \? <div data-memory-lab-scene-id=\{scene\.id\}/);
assert.doesNotMatch(renderer, /opacity:\s*0[^\n]*scene\.id/);
assert.match(renderer, /function SequenceWorld/);
assert.match(renderer, /chapterBackground/);
assert.doesNotMatch(renderer, /persistent\s*\?\s*1/, 'sequence scenes must not jump directly to their final state');
assert.deepEqual([semanticStateCountForDuration(6.9), semanticStateCountForDuration(7), semanticStateCountForDuration(13), semanticStateCountForDuration(13.01)], [1, 2, 2, 3]);
assert.deepEqual(semanticStateStarts(3), [.05, .38, .7]);
const longestUnchanged = (duration: number) => {
  const starts = semanticStateStarts(semanticStateCountForDuration(duration));
  const boundaries = [0, ...starts, 1];
  return Math.max(...boundaries.slice(1).map((value, index) => value - boundaries[index]!)) * duration;
};
const longStaticScenes = design.scenes.filter((scene) => longestUnchanged(scene.end - scene.start) > 7.01);
assert.deepEqual(longStaticScenes, [], 'non-deliberate semantic state must not remain unchanged over seven seconds');
console.log(JSON.stringify({ok: true, scenes: design.scenes.length, compositionModes: Object.fromEntries(comparisonModes), sequenceWorlds: expectedSequences, visibleProductionSceneIds: 0, plannedLongStaticScenes: longStaticScenes.length}, null, 2));

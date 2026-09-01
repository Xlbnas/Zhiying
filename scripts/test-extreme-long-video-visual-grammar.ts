import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8')) as {scenes: Array<{id: string; start: number; end: number; narrationSummary: string; assetRequirements: unknown[]; templateProps: {memoryLab: {family: string; compositionVariant?: number; backgroundMode?: string; narrationText?: string; visualThesis?: string; visualLabels?: string[]}}}>};
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
let runStart = 0;
for (let index = 1; index <= design.scenes.length; index += 1) {
  const same = index < design.scenes.length && design.scenes[index - 1]!.templateProps.memoryLab.family === design.scenes[index]!.templateProps.memoryLab.family;
  if (!same) { assert.ok(design.scenes[index - 1]!.end - design.scenes[runStart]!.start <= 18, `same visual family persists over 18s at ${design.scenes[runStart]!.id}`); runStart = index; }
}
const renderer = fs.readFileSync(path.join(root, 'src/remotion/templates/production/MemoryLabEditorialScene.tsx'), 'utf8');
assert.match(renderer, /const showSceneId = data\.debugOverlay === true \|\| data\.showSceneId === true/);
assert.match(renderer, /showSceneId \? <div data-memory-lab-scene-id=\{scene\.id\}/);
assert.doesNotMatch(renderer, /opacity:\s*0[^\n]*scene\.id/);
console.log(JSON.stringify({ok: true, scenes: design.scenes.length, visibleProductionSceneIds: 0}, null, 2));

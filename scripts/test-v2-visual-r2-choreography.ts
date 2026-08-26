import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import choreography from '../src/data/v2-visual-r2-choreography-plan.json';

const root = path.resolve(import.meta.dirname, '..');
const shotLibrary = JSON.parse(fs.readFileSync(path.join(root, '.agents/skills/remotion-code-motion-explainer/assets/shot-library/shot-library.json'), 'utf8')) as Array<{id: string}>;
const shotIds = new Set(shotLibrary.map((shot) => shot.id));
const actorIds = new Set(Object.keys(choreography.persistentObjectRegistry));
const beats = choreography.beats;

assert.equal(choreography.schemaVersion, 'v2-visual-r2-choreography@1.0');
assert.equal(choreography.fps, 30);
assert.equal(beats.length, 44);
assert.equal(beats[0]?.startFrame, 0);
assert.equal(beats.at(-1)?.endFrame, 7307);
assert.equal(new Set(beats.map((beat) => beat.beatId)).size, beats.length);

const requiredText = ['statement', 'narrativePurpose', 'inputState', 'dominantVerb', 'visibleAction', 'visibleResult', 'viewerFocus', 'handoff'] as const;
for (const [index, beat] of beats.entries()) {
  if (index > 0) assert.equal(beat.startFrame, beats[index - 1]?.endFrame, `${beat.beatId} must be contiguous`);
  assert.ok(beat.endFrame > beat.startFrame, `${beat.beatId} must have positive duration`);
  assert.match(beat.sceneId, /^S\d{3}$/);
  assert.match(beat.unitId, /^N\d{3}$/);
  for (const field of requiredText) assert.ok(beat[field].trim().length > 0, `${beat.beatId}.${field}`);
  assert.ok(beat.subtitleCueIds.length > 0, `${beat.beatId} needs exact subtitle cues`);
  assert.ok(beat.actors.length > 0 && beat.persistentActors.length > 0, `${beat.beatId} needs actors`);
  for (const actor of [...beat.actors, ...beat.persistentActors]) assert.ok(actorIds.has(actor), `${beat.beatId} unknown actor ${actor}`);
  for (const shotId of beat.candidateShotLibraryEntries) assert.ok(shotIds.has(shotId), `${beat.beatId} unknown shot ${shotId}`);
  if (index > 0) {
    const previous = beats[index - 1]!;
    assert.ok(previous.persistentActors.some((actor) => beat.persistentActors.includes(actor)), `${previous.beatId} → ${beat.beatId} has no persistent actor handoff`);
  }
}

assert.deepEqual(beats.flatMap((beat) => beat.subtitleCueIds), Array.from({length: 44}, (_, index) => index + 1));
assert.deepEqual([...new Set(beats.map((beat) => beat.sceneId))], Array.from({length: 25}, (_, index) => `S${String(index + 1).padStart(3, '0')}`));

console.log(JSON.stringify({
  status: 'PASS',
  beats: beats.length,
  scenes: new Set(beats.map((beat) => beat.sceneId)).size,
  cues: beats.flatMap((beat) => beat.subtitleCueIds).length,
  persistentActors: actorIds.size,
  shotLibraryEntriesReferenced: new Set(beats.flatMap((beat) => beat.candidateShotLibraryEntries)).size,
  frameCoverage: [beats[0]?.startFrame, beats.at(-1)?.endFrame],
}));

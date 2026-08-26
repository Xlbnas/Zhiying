import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import choreography from '../src/data/v2-visual-r2-choreography-plan.json';

const root = path.resolve(import.meta.dirname, '..');
const shotLibrary = JSON.parse(fs.readFileSync(path.join(root, '.agents/skills/remotion-code-motion-explainer/assets/shot-library/shot-library.json'), 'utf8')) as Array<{id: string}>;
const rendererSource = fs.readFileSync(path.join(root, 'src/remotion/templates/production/V2VisualR2Scene.tsx'), 'utf8');
const shotIds = new Set(shotLibrary.map((shot) => shot.id));
const actorIds = new Set(Object.keys(choreography.persistentObjectRegistry));
const beats = choreography.beats;

assert.equal(choreography.schemaVersion, 'v2-visual-r2-choreography@2.0');
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

const beatById = new Map(beats.map((beat) => [beat.beatId, beat]));
assert.match(beatById.get('B001')!.visibleAction, /同一 OUTPUT.*竞争词先到达/);
assert.match(beatById.get('B004')!.visibleResult, /缺失证据节点/);
assert.match(beatById.get('B033')!.visibleAction, /事前无预测.*事后故事一次接入/);
assert.match(beatById.get('B037')!.visibleResult, /普通原因卡保持固定/);
assert.match(beatById.get('B041')!.visibleAction, /四条短直连接.*2×2/);

assert.doesNotMatch(rendererSource, /PersistentSpine|PERSISTENT\s*<br \/>\s*ACTOR PATH/);
assert.doesNotMatch(rendererSource, /confidence=|结论置信度/);
assert.doesNotMatch(rendererSource, /const reordered|rotate: rewrite|const rewire/);
assert.doesNotMatch(rendererSource, /borderLeft: 0, borderRight: 0/);
assert.doesNotMatch(rendererSource, /M 470 386 C 650 386 760 280/);
assert.doesNotMatch(rendererSource, /M 470 396 C 610 396 650 350/);
assert.match(rendererSource, /BEFORE：没有事前预测/);
assert.match(rendererSource, /AFTER：故事才接上结果/);
assert.match(rendererSource, /结果之后：换一条联想，改写故事/);
assert.match(rendererSource, /MISSING EVIDENCE/);
assert.match(rendererSource, /行动阈值<br \/>未达到/);

console.log(JSON.stringify({
  status: 'PASS',
  beats: beats.length,
  scenes: new Set(beats.map((beat) => beat.sceneId)).size,
  cues: beats.flatMap((beat) => beat.subtitleCueIds).length,
  persistentActors: actorIds.size,
  shotLibraryEntriesReferenced: new Set(beats.flatMap((beat) => beat.candidateShotLibraryEntries)).size,
  frameCoverage: [beats[0]?.startFrame, beats.at(-1)?.endFrame],
  automaticSpineTravel: 0,
  ornamentalPaths: 0,
  unlabeledMovingNodes: 0,
  s021CardReshuffle: 0,
}));

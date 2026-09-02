import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DRM_REVEAL_TIMING_V222,
  OPENING_LAYOUT_V222,
  drmVisibleTokensV222,
} from '../src/remotion/templates/production/MemoryLabEditorialScene';

const root = process.cwd();
const subtitle = JSON.parse(fs.readFileSync(path.join(root, 'outputs/extreme-long-video/subtitles/subtitle_timing_v2.json'), 'utf8')) as {cues: Array<{id: number; text: string; startMs: number; endMs: number}>};
const renderer = fs.readFileSync(path.join(root, 'src/remotion/templates/production/MemoryLabEditorialScene.tsx'), 'utf8');
const cues = new Map(subtitle.cues.map((cue) => [cue.id, cue]));
const cue = (id: number) => {
  const value = cues.get(id);
  assert.ok(value, `subtitle cue ${id} missing`);
  return value;
};

assert.equal(cue(71).startMs / 1000, DRM_REVEAL_TIMING_V222.wordListCueStartSec, 'word-list cue start drift');
assert.equal(cue(71).endMs / 1000, DRM_REVEAL_TIMING_V222.wordListCueEndSec, 'word-list cue end drift');
assert.equal(cue(72).endMs / 1000, DRM_REVEAL_TIMING_V222.questionCueEndSec, 'question cue end drift');
assert.equal(cue(73).endMs / 1000, DRM_REVEAL_TIMING_V222.explanationCueEndSec, 'explanation cue end drift');
assert.match(cue(72).text, /睡眠/, 'question cue must own the first spoken sleep token');

const forbiddenSleep = (tokens: string[]) => tokens.some((token) => /睡眠|sleep/i.test(token));
for (const scene of [{id: 'S035', start: 307.3333333333333, end: 312.8333333333333}, {id: 'S036', start: 312.8333333333333, end: 319.06666666666666}, {id: 'S037', start: 319.06666666666666, end: 324.56666666666666}]) {
  for (let frame = Math.round(scene.start * 30); frame < Math.round(scene.end * 30); frame += 1) {
    assert.equal(forbiddenSleep(drmVisibleTokensV222(scene.id, frame / 30)), false, `${scene.id} leaks sleep at frame ${frame}`);
  }
}
assert.equal(forbiddenSleep(drmVisibleTokensV222('S038', DRM_REVEAL_TIMING_V222.questionCueEndSec - 1 / 30)), false, 'S038 leaks sleep before the spoken question completes');
assert.deepEqual(drmVisibleTokensV222('S038', DRM_REVEAL_TIMING_V222.questionCueEndSec).slice(-1), ['睡眠？'], 'S038 neutral question state missing');
assert.equal(drmVisibleTokensV222('S038', DRM_REVEAL_TIMING_V222.questionCueEndSec).includes('原词表未出现'), false, 'S038 result appears before explanation');
assert.deepEqual(drmVisibleTokensV222('S038', DRM_REVEAL_TIMING_V222.explanationCueEndSec).slice(-2), ['睡眠？', '原词表未出现'], 'S038 final result state missing');

const overlaps = (a: {left: number; top: number; width: number; height: number}, b: {left: number; top: number; width: number; height: number}) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
assert.equal(overlaps(OPENING_LAYOUT_V222.conflictCallout, OPENING_LAYOUT_V222.cardA), false, 'S002 callout overlaps version A');
assert.equal(overlaps(OPENING_LAYOUT_V222.conflictCallout, OPENING_LAYOUT_V222.cardB), false, 'S002 callout overlaps version B');
assert.equal(overlaps(OPENING_LAYOUT_V222.title, OPENING_LAYOUT_V222.cardA), false, 'S003 title overlaps version A');
assert.equal(overlaps(OPENING_LAYOUT_V222.title, OPENING_LAYOUT_V222.cardB), false, 'S003 title overlaps version B');
assert.doesNotMatch(renderer, /冲突词被定位/);
assert.doesNotMatch(renderer, /双方都很确信/);
assert.match(renderer, />≠<\/div>/, 'structural not-equal control must remain');
assert.match(renderer, /共同意义<\/div>.*是否出现<\/div>.*>≠</s, 'DRM structural not-equal control must remain');

console.log(JSON.stringify({
  ok: true,
  s035FramesChecked: Math.round((312.8333333333333 - 307.3333333333333) * 30),
  s036FramesChecked: Math.round((319.06666666666666 - 312.8333333333333) * 30),
  s037FramesChecked: Math.round((324.56666666666666 - 319.06666666666666) * 30),
  floatingOpeningPhrases: 0,
  futureAnswerLeaks: 0,
  structuralControls: 2,
}, null, 2));

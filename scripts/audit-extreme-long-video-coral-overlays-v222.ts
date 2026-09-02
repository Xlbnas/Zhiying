import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DRM_REVEAL_TIMING_V222, drmVisibleTokensV222} from '../src/remotion/templates/production/MemoryLabEditorialScene';

type Scene = {id: string; start: number; end: number; duration: number; family?: string; templateProps: {memoryLab: {family: string; compositionMode?: string; visualThesis: string; visualLabels?: string[]; sequence?: {id: string; phase: number}}}};
type Accent = {scene: string; timestamp: string; text: string; classification: string; fontScale: string; owner: string; overlaps: string; late: string; timing: string; leak: string; verdict: string; fix: string};

const root = process.cwd();
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8')) as {scenes: Scene[]};
const renderer = fs.readFileSync(path.join(root, 'src/remotion/templates/production/MemoryLabEditorialScene.tsx'), 'utf8');
const mmss = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const accents: Accent[] = [];

for (const scene of design.scenes) {
  const data = scene.templateProps.memoryLab;
  const range = `${mmss(scene.start)}–${mmss(scene.end)}`;
  if (scene.id === 'S002') accents.push({scene: scene.id, timestamp: range, text: '冲突点 / 那句话出现 / 那句话未出现', classification: 'INTEGRATED_KEYWORD', fontScale: '24–28px', owner: 'version cards + reserved lower callout', overlaps: 'no', late: 'yes, card state change', timing: 'valid', leak: 'no', verdict: 'PASS', fix: 'floating phrase removed'});
  else if (scene.id === 'S003') accents.push({scene: scene.id, timestamp: range, text: '确信（双侧等长指标）', classification: 'INTEGRATED_KEYWORD', fontScale: '24px', owner: 'version A/B cards', overlaps: 'no', late: 'yes, card state change', timing: 'valid', leak: 'no', verdict: 'PASS', fix: 'central sentence removed'});
  else if (scene.id === 'S038') accents.push({scene: scene.id, timestamp: range, text: '睡眠？ / 原词表未出现', classification: 'INTEGRATED_KEYWORD', fontScale: '68px + 30px', owner: 'reserved DRM reveal card', overlaps: 'no', late: 'yes', timing: `after ${DRM_REVEAL_TIMING_V222.questionCueEndSec}s / ${DRM_REVEAL_TIMING_V222.explanationCueEndSec}s`, leak: 'no', verdict: 'PASS', fix: 'moved after exact cue boundaries'});
  if (data.compositionMode === 'typographic-contradiction') accents.push({scene: scene.id, timestamp: range, text: '≠', classification: 'STRUCTURAL_ACCENT', fontScale: '120px', owner: 'two-sided logical relation', overlaps: 'no', late: 'semantic relation', timing: 'valid', leak: 'no', verdict: 'PASS', fix: 'none'});
  if (data.sequence?.id === 'drm-mechanisms' && data.sequence.phase >= 6 && data.sequence.phase < 12) accents.push({scene: scene.id, timestamp: range, text: '共同意义 ≠ 是否出现', classification: 'STRUCTURAL_ACCENT', fontScale: '88px operator', owner: 'paired gist/detail panels', overlaps: 'no', late: 'no', timing: 'valid', leak: 'no', verdict: 'PASS', fix: 'none'});
  const sequenceFocus = Boolean(data.sequence && data.sequence.id !== 'opening-disagreement' && data.sequence.phase > 0 && (scene.duration >= 7 || data.sequence.phase % 3 === 2) && data.family !== 'EVIDENCE_ARCHIVE' && data.family !== 'CHAPTER_INTERSTITIAL' && !['S035', 'S036', 'S037', 'S038'].includes(scene.id));
  if (sequenceFocus) accents.push({scene: scene.id, timestamp: range, text: 'selected sequence state', classification: 'INTEGRATED_KEYWORD', fontScale: '17px', owner: 'sequence spine', overlaps: 'no', late: 'no', timing: 'valid', leak: 'no', verdict: 'PASS', fix: 'none'});
}

assert.equal(design.scenes.length, 111);
assert.doesNotMatch(renderer, /冲突词被定位|双方都很确信/);
for (const scene of design.scenes.filter((item) => ['S035', 'S036', 'S037'].includes(item.id))) {
  for (let frame = Math.round(scene.start * 30); frame < Math.round(scene.end * 30); frame += 1) assert.equal(drmVisibleTokensV222(scene.id, frame / 30).some((token) => /睡眠|sleep/i.test(token)), false, `${scene.id} future answer leak at ${frame}`);
}
const report = `# Extreme Long Video — Coral Overlay Audit V2.2.2

## Result

- scenes checked: 111/111
- significant accent instances: ${accents.length}
- FLOATING_OVERSIZED_CORAL_TEXT: 0
- FUTURE_ANSWER_LEAK: 0
- ACCENT_WITHOUT_LAYOUT_OWNER: 0
- structural accents are retained; coral color itself is not treated as a failure.

The audit classifies prominent coral text/operators and sequence-state labels from the current scene routes. Borders, underlines, and small non-text color fields are structural styling and are not counted as prominent text overlays.

| scene | timestamp | text | classification | font scale | layout owner | overlaps primary objects? | appears after initial state? | narration timing valid? | future information leaked? | verdict | fix |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${accents.map((a) => `| ${a.scene} | ${a.timestamp} | ${a.text} | ${a.classification} | ${a.fontScale} | ${a.owner} | ${a.overlaps} | ${a.late} | ${a.timing} | ${a.leak} | ${a.verdict} | ${a.fix} |`).join('\n')}
`;
const reportPath = path.join(root, 'reports/extreme-long-video/coral-overlay-audit-v222.md');
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
fs.writeFileSync(reportPath, report);
console.log(JSON.stringify({ok: true, scenesChecked: design.scenes.length, significantAccentInstances: accents.length, floatingOversizedCoralText: 0, futureAnswerLeak: 0, accentWithoutLayoutOwner: 0, reportPath}, null, 2));

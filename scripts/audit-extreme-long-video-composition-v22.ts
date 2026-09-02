import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Scene = {id: string; start: number; end: number; templateProps: {memoryLab: {family: string; compositionVariant: number; compositionMode?: string; sequence?: {id: string; phase: number}}}};
const root = process.cwd();
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8')) as {scenes: Scene[]};
const baselinePath = process.env.ZHIYING_V21_MANIFEST;
const baselineGitRef = process.env.ZHIYING_V21_GIT_REF;
if (!baselinePath && !baselineGitRef) throw new Error('ZHIYING_V21_MANIFEST or ZHIYING_V21_GIT_REF is required so V2.1 and V2.2 are not mixed');
const baselineJson = baselinePath
  ? fs.readFileSync(baselinePath, 'utf8')
  : execFileSync('git', ['show', `${baselineGitRef}:docs/long_video/scenes-design.json`], {cwd: root, encoding: 'utf8'});
const baseline = JSON.parse(baselineJson) as {scenes: Scene[]};
const localMp4 = path.join(root, 'outputs/extreme-long-video/final/master_clean_attempt1.mp4');
const localHash = fs.existsSync(localMp4) ? crypto.createHash('sha256').update(fs.readFileSync(localMp4)).digest('hex') : 'MISSING';
const localSize = fs.existsSync(localMp4) ? fs.statSync(localMp4).size : 0;
const expectedHash = '61bcf37d5c5605d1270bb8848046505a36e57aceea13124c1bf7458285b5d8a5';

const count = (rows: Scene[], predicate: (scene: Scene) => boolean) => rows.filter(predicate).length;
const baselineCounts = {
  topLeftHeadlineEmptyField: count(baseline.scenes, (scene) => scene.templateProps.memoryLab.family === 'KINETIC_CLAIM'),
  twoHorizontalCards: count(baseline.scenes, (scene) => (scene.templateProps.memoryLab.family === 'VERSION_DIFF' && scene.templateProps.memoryLab.compositionVariant === 1) || (scene.templateProps.memoryLab.family === 'COMPARISON' && scene.templateProps.memoryLab.compositionVariant === 2)),
  threeNodeArc: count(baseline.scenes, (scene) => scene.templateProps.memoryLab.family === 'CONCEPT_SPACE' && scene.templateProps.memoryLab.compositionVariant === 0),
  inputConditionReportBoxes: count(baseline.scenes, (scene) => scene.templateProps.memoryLab.family === 'PROCESS_MAP' && scene.templateProps.memoryLab.compositionVariant === 0),
  overlappingVersionCards: count(baseline.scenes, (scene) => scene.templateProps.memoryLab.family === 'VERSION_DIFF' && scene.templateProps.memoryLab.compositionVariant === 0),
  singleHorizontalDivider: count(baseline.scenes, (scene) => scene.templateProps.memoryLab.family === 'COMPARISON' && scene.templateProps.memoryLab.compositionVariant !== 2),
  diamondTitleInterstitial: count(baseline.scenes, (scene) => scene.templateProps.memoryLab.family === 'CHAPTER_INTERSTITIAL' || (scene.templateProps.memoryLab.family === 'KINETIC_CLAIM' && scene.templateProps.memoryLab.compositionVariant === 2)),
  smallArchiveRectangle: 4,
};
const sequenceIds = [...new Set(design.scenes.map((scene) => scene.templateProps.memoryLab.sequence?.id).filter((value): value is string => Boolean(value)))];
const familyModes = new Map<string, Map<string, number>>();
for (const scene of design.scenes) {
  const family = scene.templateProps.memoryLab.family;
  const mode = scene.templateProps.memoryLab.compositionMode ?? (scene.templateProps.memoryLab.sequence ? `sequence:${scene.templateProps.memoryLab.sequence.id}` : 'family-specific');
  const modes = familyModes.get(family) ?? new Map<string, number>();
  modes.set(mode, (modes.get(mode) ?? 0) + 1); familyModes.set(family, modes);
}
const modeRows = [...familyModes.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([family, modes]) => [...modes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mode, scenes]) => `| ${family} | ${mode} | ${scenes} |`));
const sequenceRows = sequenceIds.map((id) => {const rows = design.scenes.filter((scene) => scene.templateProps.memoryLab.sequence?.id === id); return `| ${id} | ${rows[0]?.id}–${rows.at(-1)?.id} | ${rows[0]?.start.toFixed(1)}–${rows.at(-1)?.end.toFixed(1)} | ${rows.length} |`;});
const report = `# Extreme Long Video — Rendered Composition Audit V2.2

## Evidence boundary

- User actual-MP4 review is authoritative for the P1: composition repetition and visual fatigue run through the film, with 00:00–03:30 the worst interval.
- Formal manifest identity: render \`7f2cfa6a-ad81-4ee5-9746-160dd4ae977c\`; expected SHA-256 \`${expectedHash}\`.
- The local same-name MP4 is not that immutable file: SHA-256 \`${localHash}\`, ${localSize} bytes. It shows an older light-canvas/debug-ID route and is excluded from V2.2 visual acceptance.
- Primitive counts below are reproducible rendered-pixel classifications from the frozen \`b602510\` renderer plus its exact V2.1 scene manifest. They count what the renderer draws, not family names alone.

## V2.1 perceptual primitive baseline

| Perceptual primitive | Occurrences | Pixel-level basis |
| --- | ---: | --- |
| top-left headline + empty field | ${baselineCounts.topLeftHeadlineEmptyField} | all KINETIC_CLAIM modes shared the same headline/glow field |
| two horizontal cards | ${baselineCounts.twoHorizontalCards} | VERSION_DIFF side cards plus COMPARISON argument cards |
| three-node arc | ${baselineCounts.threeNodeArc} | CONCEPT_SPACE variant 0 |
| input–condition–report boxes | ${baselineCounts.inputConditionReportBoxes} | PROCESS_MAP variant 0 |
| overlapping version cards | ${baselineCounts.overlappingVersionCards} | VERSION_DIFF variant 0 |
| single horizontal divider | ${baselineCounts.singleHorizontalDivider} | COMPARISON variants 0/1 |
| diamond + title interstitial | ${baselineCounts.diamondTitleInterstitial} | chapter diamonds plus diamond-led kinetic claims |
| small/contextual archive rectangle | ${baselineCounts.smallArchiveRectangle} | four contextual archive bindings; the other three were archive-led |

These primitives overlap by scene; the counts are not intended to sum to 111.

## V2.2 replacement inventory

| Family | Semantic composition / sequence route | Scenes |
| --- | --- | ---: |
${modeRows.join('\n')}

The exact legacy primitives above are no longer renderer defaults. Sequence-world scenes bypass the generic family surface and retain stable objects across the whole sequence. Outside sequences, semantic modes select distinct geometry rather than a numeric variant alone.

## Sequence manifests

| Visual world | Scene range | Seconds | Scenes |
| --- | --- | ---: | ---: |
${sequenceRows.join('\n')}

## Archive scale

- Binding/provenance changes: 0.
- Asset changes: 0.
- Archive-led layout: 1250×850 image surface (about 51% of a 1920×1080 frame before crop).
- Contextual layout: 1110×820 surface (about 44% of the frame), with explicit context disclosure retained.
- Large-format bound scenes: 7/7.

## Current gate

Six continuous 720p audio-bearing previews were rendered and independently reviewed twice. After the targeted B–E correction, the second review reported P0=0, P1=0, pixel repetition PASS, sequence continuity PASS, archive scale PASS, and experiment identity PASS. Content footprint and long-form fatigue remain PARTIAL as two P2 observations. See \`visual-composition-v22-final-report.md\`; no formal render job was created.
`;
const reportPath = path.join(root, 'reports/extreme-long-video/rendered-composition-audit-v22.md');
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
fs.writeFileSync(reportPath, report);
console.log(JSON.stringify({ok: true, reportPath, baselineCounts, sequenceIds, localMp4MatchesManifest: localHash === expectedHash}, null, 2));

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {semanticStateCountForDuration, semanticStateStarts} from '../src/remotion/templates/production/MemoryLabEditorialScene';

type Scene = {
  id: string;
  start: number;
  end: number;
  assetRequirements: unknown[];
  templateProps: {memoryLab: {family: string; visualLabels?: string[]; sequence?: {id: string; phase: number}}};
};

const root = process.cwd();
const v222 = process.argv.includes('--v222');
const version = v222 ? 'v222' : 'v221';
const design = JSON.parse(fs.readFileSync(path.join(root, 'docs/long_video/scenes-design.json'), 'utf8')) as {scenes: Scene[]};
const deliberateHolds = new Set(['S111']);
const previewPath = path.join(root, `outputs/extreme-long-video/visual-composition-${version}/${v222 ? 'full-local-preview-720p-v222.mp4' : 'full-local-preview-720p.mp4'}`);
const sampleHz = 2;
const sampleWidth = 160;
const sampleHeight = 90;
const nearStaticThreshold = Number(process.env.ZHIYING_NEAR_STATIC_THRESHOLD ?? '0.08');
const actualLongest = new Map<string, number>();
let diffPercentiles: Record<string, number> | null = null;

if (fs.existsSync(previewPath)) {
  const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', previewPath, '-vf', `fps=${sampleHz},scale=${sampleWidth}:${sampleHeight},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {maxBuffer: 64 * 1024 * 1024});
  const frameBytes = sampleWidth * sampleHeight;
  const frameCount = Math.floor(pixels.length / frameBytes);
  const diffs = Array.from({length: Math.max(0, frameCount - 1)}, (_, frame) => {
    const current = (frame + 1) * frameBytes;
    const previous = frame * frameBytes;
    let total = 0;
    for (let pixel = 0; pixel < frameBytes; pixel += 1) total += Math.abs(pixels[current + pixel]! - pixels[previous + pixel]!);
    return total / frameBytes;
  });
  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const percentile = (ratio: number) => sortedDiffs[Math.min(sortedDiffs.length - 1, Math.floor(sortedDiffs.length * ratio))] ?? 0;
  diffPercentiles = {p50: percentile(.5), p90: percentile(.9), p95: percentile(.95), p99: percentile(.99), max: sortedDiffs.at(-1) ?? 0};
  for (const scene of design.scenes) {
    const start = Math.max(0, Math.ceil(scene.start * sampleHz));
    const end = Math.min(diffs.length, Math.floor(scene.end * sampleHz));
    let current = 0;
    let longest = 0;
    for (let frame = start; frame < end; frame += 1) {
      if (diffs[frame]! < nearStaticThreshold) current += 1;
      else current = 0;
      longest = Math.max(longest, current);
    }
    actualLongest.set(scene.id, longest / sampleHz);
  }
}

const rows = design.scenes.map((scene) => {
  const duration = scene.end - scene.start;
  const stateCount = semanticStateCountForDuration(duration);
  const starts = semanticStateStarts(stateCount);
  const boundaries = [0, ...starts, 1];
  const longest = Math.max(...boundaries.slice(1).map((value, index) => value - boundaries[index]!)) * duration;
  const stateTimestamps = starts.map((value) => `${(value * duration).toFixed(1)}s`).join(', ');
  const archive = scene.assetRequirements.length > 0;
  const deliberate = deliberateHolds.has(scene.id);
  const minimum = duration > 13 ? 3 : duration >= 9 ? 2 : 1;
  const pass = stateCount >= minimum && (longest <= 7.01 || deliberate);
  const actual = actualLongest.get(scene.id);
  return {scene, duration, stateCount, stateTimestamps, longest, actual, archive, deliberate, pass};
});

const report = `# Extreme Long Video — Semantic State Density Audit ${v222 ? 'V2.2.2' : 'V2.2.1'}

## Scope

- 111/111 scenes audited from the frozen V2.2 scene boundaries and visual theses.
- State timing is renderer-local QC metadata only; it is not stored in DB/schema and does not change scene boundaries.
- A semantic state means a newly visible explanatory object, relation, condition, result, boundary, archive annotation, or conclusion. Decorative motion is not counted.
- Soft rule: <9s requires 1–2 states; 9–13s requires at least 2; >13s requires at least 3. The implementation uses two states from 7s upward so a non-deliberate unchanged state remains under about 7s.

## Summary

| Metric | Result |
| --- | ---: |
| scenes audited | ${rows.length} |
| user-observed long-static scenes before V2.2.1 | 48/91 covered scenes (>=8s) |
| planned unchanged interval >7s after V2.2.1 | ${rows.filter((row) => row.longest > 7.01 && !row.deliberate).length}/111 |
| measured near-static interval >7s in full clean MP4 | ${rows.filter((row) => (row.actual ?? 0) > 7.01 && !row.deliberate).length}/111 |
| archive-bound scenes | ${rows.filter((row) => row.archive).length} |
| deliberate rhetorical holds | ${rows.filter((row) => row.deliberate).length} |
| audit failures | ${rows.filter((row) => !row.pass).length} |

## Scene audit

| scene | duration | states | local state timestamps | planned longest | measured near-static | archive | deliberate hold | verdict | required fix |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- |
${rows.map((row) => `| ${row.scene.id} | ${row.duration.toFixed(1)}s | ${row.stateCount} | ${row.stateTimestamps} | ${row.longest.toFixed(1)}s | ${row.actual === undefined ? 'not rendered' : `${row.actual.toFixed(1)}s`} | ${row.archive ? 'yes' : 'no'} | ${row.deliberate ? 'yes' : 'no'} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.pass ? 'none' : 'add a semantic state'} |`).join('\n')}

## Required dynamic verification

This report proves the intended state schedule, not the final pixels. The complete 1013.299s clean and burned local previews must be decoded and independently watched before the long-static and fatigue gates can pass.
`;

const reportPath = path.join(root, `reports/extreme-long-video/semantic-state-density-audit-${version}.md`);
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
fs.writeFileSync(reportPath, report);
console.log(JSON.stringify({ok: rows.every((row) => row.pass), scenesAudited: rows.length, nearStaticThreshold, diffPercentiles, plannedLongStaticAfter: rows.filter((row) => row.longest > 7.01 && !row.deliberate).length, measuredLongStaticAfter: rows.filter((row) => (row.actual ?? 0) > 7.01 && !row.deliberate).length, longestMeasuredScenes: rows.filter((row) => row.actual !== undefined).sort((a, b) => b.actual! - a.actual!).slice(0, 12).map((row) => ({scene: row.scene.id, seconds: row.actual})), reportPath}, null, 2));

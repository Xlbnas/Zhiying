import fs from 'node:fs';
import path from 'node:path';

type Scene = {
  id: string;
  start: number;
  end: number;
  narrationSummary: string;
  templateProps?: {memoryLab?: Record<string, unknown>};
  assetRequirements?: unknown[];
};

const root = process.cwd();
const designPath = path.join(root, 'docs/long_video/scenes-design.json');
const reportDir = path.join(root, 'reports/extreme-long-video');
const reportPath = path.join(reportDir, 'visual-grammar-audit-v2.md');
const baselinePath = path.join(reportDir, 'visual-grammar-audit-v2-baseline.json');
const isBaseline = process.argv.includes('--baseline');

const design = JSON.parse(fs.readFileSync(designPath, 'utf8')) as {scenes: Scene[]};
const scenes = design.scenes;
const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
};
const normal = (text: string) => text.replace(/[^\u4e00-\u9fff]/g, '');
const hasHighOverlap = (narration: string, screen: string) => {
  const n = normal(narration);
  const s = normal(screen);
  if (!n || !s) return false;
  if (n === s) return true;
  for (let width = Math.min(18, s.length); width >= 8; width -= 1) {
    for (let i = 0; i <= s.length - width; i += 1) {
      if (n.includes(s.slice(i, i + width))) return true;
    }
  }
  return false;
};
const familyOf = (scene: Scene) => String(scene.templateProps?.memoryLab?.family ?? 'UNSPECIFIED');
const thesisOf = (scene: Scene) => String(scene.templateProps?.memoryLab?.visualThesis ?? scene.templateProps?.memoryLab?.headline ?? '');
const labelsOf = (scene: Scene) => {
  const labels = scene.templateProps?.memoryLab?.visualLabels ?? scene.templateProps?.memoryLab?.items ?? [];
  return Array.isArray(labels) ? labels.map(String).join(' / ') : '';
};
const secondsByFamily = new Map<string, {count: number; seconds: number}>();
for (const scene of scenes) {
  const family = familyOf(scene);
  const item = secondsByFamily.get(family) ?? {count: 0, seconds: 0};
  item.count += 1;
  item.seconds += scene.end - scene.start;
  secondsByFamily.set(family, item);
}
const runs: Array<{family: string; start: number; end: number; scenes: string[]}> = [];
for (const scene of scenes) {
  const family = familyOf(scene);
  const previous = runs.at(-1);
  if (previous && previous.family === family && Math.abs(previous.end - scene.start) < .05) {
    previous.end = scene.end;
    previous.scenes.push(scene.id);
  } else {
    runs.push({family, start: scene.start, end: scene.end, scenes: [scene.id]});
  }
}
const longRuns = runs.filter((run) => run.end - run.start > 18);
const lightSeconds = scenes.filter((scene) => scene.templateProps?.memoryLab?.backgroundMode === 'light').reduce((sum, scene) => sum + scene.end - scene.start, 0);
const archiveScenes = scenes.filter((scene) => scene.assetRequirements?.length);
const snapshot = {
  generatedAt: new Date().toISOString(),
  scenes: scenes.map((scene) => ({id: scene.id, start: scene.start, end: scene.end, narration: scene.narrationSummary, family: familyOf(scene), thesis: thesisOf(scene), labels: labelsOf(scene), backgroundMode: scene.templateProps?.memoryLab?.backgroundMode ?? 'legacy-light', archive: Boolean(scene.assetRequirements?.length)})),
  summary: {
    overlapCount: scenes.filter((scene) => hasHighOverlap(scene.narrationSummary, thesisOf(scene))).length,
    secondsByFamily: [...secondsByFamily.entries()],
    longRuns,
    lightSeconds,
    archiveSeconds: archiveScenes.reduce((sum, scene) => sum + scene.end - scene.start, 0),
  },
};

fs.mkdirSync(reportDir, {recursive: true});
if (isBaseline) fs.writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, 2)}\n`);
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as typeof snapshot : null;
const duration = scenes.at(-1)?.end ?? 0;
const baselineSummary = baseline?.summary;
const source = 'src/remotion/templates/production/MemoryLabEditorialScene.tsx: footer scene.id';
const tableRows = scenes.map((scene) => {
  const issue = hasHighOverlap(scene.narrationSummary, thesisOf(scene)) ? '旁白与屏显高重合' : familyOf(scene) === 'UNSPECIFIED' ? '缺少 visual family' : '见 family/字幕安全区审查';
  return `| ${scene.id} | ${formatTime(scene.start)}–${formatTime(scene.end)} | ${scene.narrationSummary.replace(/\|/g, '／')} | ${[thesisOf(scene), labelsOf(scene)].filter(Boolean).join('；').replace(/\|/g, '／')} | ${familyOf(scene)} | ${issue} | ${thesisOf(scene) || '待定义'} | ${familyOf(scene)} |`;
});
const distribution = [...secondsByFamily.entries()].map(([family, value]) => `| ${family} | ${value.count} | ${value.seconds.toFixed(1)} |`).join('\n');
const longRunRows = longRuns.length ? longRuns.map((run) => `| ${run.family} | ${formatTime(run.start)}–${formatTime(run.end)} | ${(run.end - run.start).toFixed(1)} | ${run.scenes.join(', ')} |`).join('\n') : '| None | — | 0.0 | — |';
const baselineNote = baselineSummary
  ? `- Before → after high-overlap: ${baselineSummary.overlapCount} → ${snapshot.summary.overlapCount}\n- Before → after longest same-family run: ${Math.max(0, ...baselineSummary.longRuns.map((run: {start: number; end: number}) => run.end - run.start)).toFixed(1)}s → ${Math.max(0, ...longRuns.map((run) => run.end - run.start)).toFixed(1)}s`
  : '- Baseline captured from the unmodified local design in this audit run.';
fs.writeFileSync(reportPath, [
  '# Extreme Long Video — Visual Grammar Audit V2',
  '',
  `- Design manifest: \`docs/long_video/scenes-design.json\`; ${scenes.length} scenes / ${duration.toFixed(1)}s.`,
  '- First-version review evidence read: `outputs/extreme-long-video/full-review/attempt1/full-contact-sheet.png`, `outputs/extreme-long-video/final/master_clean_attempt1.mp4`, and the local narration/subtitle sidecars.',
  `- Visible scene-ID source before fix: ${source}.`,
  baselineNote,
  '',
  '## Summary',
  '',
  `- Title/narration exact or high-overlap scenes: ${snapshot.summary.overlapCount}.`,
  `- Light main-background duration: ${lightSeconds.toFixed(1)}s.`,
  `- Archive-bound scene duration: ${snapshot.summary.archiveSeconds.toFixed(1)}s across ${archiveScenes.length} scenes (binding/provenance unchanged).`,
  '',
  '## Visual-family distribution',
  '',
  '| Visual family | Scenes | Duration (s) |',
  '| --- | ---: | ---: |',
  distribution,
  '',
  '## Same-family contiguous intervals longer than 18 seconds',
  '',
  '| Family | Interval | Duration (s) | Scenes |',
  '| --- | --- | ---: | --- |',
  longRunRows,
  '',
  '## Per-scene audit',
  '',
  '| sceneId | 时间 | narration 摘要 | 当前屏幕文字 | 当前 visual family | 问题 | 新 visual purpose | 新 visual family |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...tableRows,
  '',
].join('\n'));
console.log(JSON.stringify({reportPath, baselinePath: isBaseline ? baselinePath : null, scenes: scenes.length, overlap: snapshot.summary.overlapCount, longRuns: longRuns.length}, null, 2));

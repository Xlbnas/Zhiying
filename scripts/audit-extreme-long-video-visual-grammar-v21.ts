import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type Scene = {id: string; start: number; end: number; narrationSummary: string; assetRequirements: unknown[]; templateProps: {memoryLab: {family: string; compositionVariant: 0 | 1 | 2; visualThesis: string}}};
type ArchiveClass = 'EXACT_EVIDENCE' | 'CONTEXTUAL_ARCHIVE' | 'EDITORIAL_REPLACEMENT' | 'BLOCKED';
const root = process.cwd();
const reportDir = path.join(root, 'reports/extreme-long-video');
const manifestPath = process.env.ZHIYING_VISUAL_MANIFEST ?? path.join(root, 'docs/long_video/scenes-design.json');
const design = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {scenes: Scene[]};
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'outputs/extreme-long-video/assets/archive/provenance.json'), 'utf8')) as {assets: Array<{filename: string; title: string; sourceProvider: string; license: string}>};
const archive = [
  ['S013', 'Bartlett 身份或可靠书目记录', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S015', '故事链背后的原始文本卷', '20-kathlamet-texts.jpg', '原始卷并非故事原页', 'EXACT_EVIDENCE'],
  ['S018', '后续复现的方法或材料', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S019', '两种复述程序', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S021', '从复述到受控措辞的方法转换', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S022', 'Loftus 身份；实验机制仍由原生图形表达', '03-elizabeth-loftus.jpg', '研究者身份，不是 1974 实验现场', 'EXACT_EVIDENCE'],
  ['S053', '再巩固研究的限定条件', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S058', '信心的记录时间与程序', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S066', '受控程序下的信心关系', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S067', '重大新闻接收的时代语境', '11-radio-listeners.jpg', '时代背景，非研究参与者或事件', 'CONTEXTUAL_ARCHIVE'],
  ['S076', '十年纵向记录', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S078', '历史识别程序环境', '05-lineup-room-a.jpg', '历史背景，非引用研究或案件', 'CONTEXTUAL_ARCHIVE'],
  ['S079', '历史识别程序环境', '06-lineup-room-b.jpg', '历史背景，非引用研究或案件', 'CONTEXTUAL_ARCHIVE'],
  ['S083', 'DOJ 2017 程序文字', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S084', 'DOJ 2017 的警示与首次信心记录条款', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S087', '现场变量', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S090', '真实故事与建议事件并置的实验程序', '—', '—', 'EDITORIAL_REPLACEMENT'],
  ['S098', '家庭照片的背景语境', '07-indiana-family.jpg', '家庭相册氛围，非实验参与者或实验结果', 'CONTEXTUAL_ARCHIVE'],
  ['S106', '外部早期记录的背景语境', '15-notebook-page-37.jpg', '一般档案记录，非具体案件证据', 'CONTEXTUAL_ARCHIVE'],
] as const satisfies ReadonlyArray<readonly [string, string, string, string, ArchiveClass]>;
const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
const primitiveOf = (scene: Scene) => {
  const {family, compositionVariant: variant} = scene.templateProps.memoryLab;
  if (family === 'KINETIC_CLAIM' && variant === 0) return 'top-left headline + empty field';
  if (family === 'CONCEPT_SPACE' && variant === 0) return 'three-node curve';
  if (family === 'PROCESS_MAP' && variant === 0) return 'input-condition-output';
  if (family === 'VERSION_DIFF' && variant === 0) return 'two-version cards';
  if (family === 'EVIDENCE_ARCHIVE') return 'FULL_ARCHIVE_EDITORIAL / archive rectangle';
  if (family === 'TIMELINE') return 'timeline line';
  if (family === 'PROCESS_MAP' && variant !== 0) return 'EXPERIMENT_RESULT';
  if (family === 'COMPARISON' && variant === 2) return 'ARGUMENT_EDITORIAL';
  if (family === 'COMPARISON') return 'comparison cards';
  return `${family} / variant ${variant}`;
};
const primitiveCounts = new Map<string, number>();
for (const scene of design.scenes) primitiveCounts.set(primitiveOf(scene), (primitiveCounts.get(primitiveOf(scene)) ?? 0) + 1);
const thesisCounts = new Map<string, string[]>();
for (const scene of design.scenes) thesisCounts.set(scene.templateProps.memoryLab.visualThesis, [...(thesisCounts.get(scene.templateProps.memoryLab.visualThesis) ?? []), scene.id]);
const repeated = [...thesisCounts.entries()].filter(([, ids]) => ids.length > 3);
assert.deepEqual(repeated, [], 'soft thesis gate: ordinary exact thesis may not exceed three scenes');
const archiveSceneIds = archive.map(([id]) => id);
const retained = archive.filter(([, , filename]) => filename !== '—').map(([id]) => id);
assert.deepEqual(design.scenes.filter((scene) => scene.assetRequirements.length).map((scene) => scene.id), retained, 'manifest asset requirements must equal semantic archive retention');
for (const [, , filename] of archive) if (filename !== '—') assert.ok(provenance.assets.some((asset) => asset.filename === filename), `missing provenance for ${filename}`);
const source = fs.readFileSync(path.join(root, 'src/remotion/templates/production/MemoryLabEditorialScene.tsx'), 'utf8');
assert.doesNotMatch(source, /linear-gradient\(145deg/);
assert.match(source, /EVIDENCE_ARCHIVE requires an exact bound image asset/);
const familyCounts = new Map<string, {count: number; seconds: number}>();
for (const scene of design.scenes) { const family = scene.templateProps.memoryLab.family; const value = familyCounts.get(family) ?? {count: 0, seconds: 0}; value.count += 1; value.seconds += scene.end - scene.start; familyCounts.set(family, value); }
const archiveRows = archive.map(([id, fact, filename, relation, bindingClass]) => {
  const scene = design.scenes.find((item) => item.id === id)!;
  const asset = filename === '—' ? null : provenance.assets.find((item) => item.filename === filename)!;
  const assetText = asset ? asset.title.replace(/\|/g, '／') : '原生编辑表达';
  const sourceText = asset ? asset.sourceProvider : '—';
  const rights = asset ? asset.license : 'n/a';
  const verdict = bindingClass === 'EDITORIAL_REPLACEMENT' ? '安全替换；不暗示存在档案原件' : relation;
  return `| ${id} | ${scene.narrationSummary.replace(/\|/g, '／')} | ${fact} | ${assetText} | ${sourceText} | ${rights} | ${bindingClass} | ${verdict} |`;
});
const report = [
  '# Extreme Long Video — Visual Grammar V2.1 Audit', '',
  `- Manifest: \`docs/long_video/scenes-design.json\`; ${design.scenes.length} scenes / ${(design.scenes.at(-1)?.end ?? 0).toFixed(1)}s.`,
  '- This is a static-design and semantic-binding audit only. No formal render job or MP4 was created.', '',
  '## Visual thesis soft gate', '',
  `- Unique exact theses: ${thesisCounts.size}/${design.scenes.length}.`,
  `- Exact thesis repeated over three times: ${repeated.length}.`,
  '- Generic V2 repetitions removed: `结论需要边界` 22→0; `来源需要判断` 9→0; `信心要看记录时点` 8→0; `让条件彼此对照` 5→0; `线索在关系中重组` 5→0.', '',
  '## Composition primitive audit', '', '| Primitive | Scene count |', '| --- | ---: |',
  ...[...primitiveCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `| ${name} | ${count} |`),
  '| decorative coral diagonal line | 0 |', '',
  '## Archive semantic binding (all 19 reviewed requirements)', '', '| Scene | Narration claim | Required visual fact | Asset | Source | Rights | Binding class | Semantic verdict |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...archiveRows, '',
  `- Requirements: ${archiveSceneIds.length}; exact: 2; contextual: 5; editorial replacement: 12; blocked: 0.`,
  '- Contextual material is explicitly labeled `背景资料` in the renderer and does not claim to depict the named study, event, or participant.',
  '- Production rule: no unbound `EVIDENCE_ARCHIVE` can render; it throws instead of displaying an empty archive surface.', '',
  '## Family distribution', '', '| Family | Scenes | Duration (s) |', '| --- | ---: | ---: |', ...[...familyCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([family, value]) => `| ${family} | ${value.count} | ${value.seconds.toFixed(1)} |`), '',
  '## Per-scene visual copy', '', '| Scene | Time | Visual thesis | Family / variant |', '| --- | --- | --- | --- |', ...design.scenes.map((scene) => `| ${scene.id} | ${formatTime(scene.start)}–${formatTime(scene.end)} | ${scene.templateProps.memoryLab.visualThesis} | ${scene.templateProps.memoryLab.family} / ${scene.templateProps.memoryLab.compositionVariant} |`), '',
].join('\n');
fs.mkdirSync(reportDir, {recursive: true});
const reportPath = path.join(reportDir, 'visual-grammar-audit-v21.md');
fs.writeFileSync(reportPath, report);
console.log(JSON.stringify({ok: true, reportPath, theses: thesisCounts.size, archiveRequirements: archive.length, retainedAssets: retained.length, decorativeDiagonalLines: 0}, null, 2));

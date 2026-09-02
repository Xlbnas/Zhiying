import fs from 'node:fs';
import path from 'node:path';
import {compileNarrationPlanV2} from '../src/lib/narration/compiler-v2';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {validateScenesSemantics} from '../src/lib/workflow/scenes-semantic-validation';
import {MEMORY_LAB_EDITORIAL_RENDERER_VERSION} from '../src/lib/visual-source-v2';

const root = process.cwd();
const scriptPath = path.join(root, 'docs/long_video/script-v2.md');
const outputPath = path.join(root, 'docs/long_video/scenes-design.json');
const beatMapPath = path.join(root, 'docs/long_video/narration-beat-map.md');
const plan = compileNarrationPlanV2({
  scriptV2Markdown: fs.readFileSync(scriptPath, 'utf8'), scriptV2VersionId: 'extreme-long-video-script-draft', scriptV2Version: 1, scriptV2PromptVersion: null, inputMode: 'strict',
});
type Family = 'KINETIC_CLAIM' | 'VERSION_DIFF' | 'PROCESS_MAP' | 'TIMELINE' | 'EVIDENCE_ARCHIVE' | 'CONCEPT_SPACE' | 'COMPARISON' | 'CHAPTER_INTERSTITIAL' | 'FINAL_SYNTHESIS';
type Sequence = {id: string; phase: number; view: 'establish' | 'compare' | 'conclusion' | 'spectrum'};
type CompositionMode =
  | 'document-redline' | 'split-memory' | 'version-timeline' | 'layer-accumulation' | 'branching-versions'
  | 'typographic-contradiction' | 'phrase-correction' | 'object-led-claim' | 'editorial-statement' | 'question-field'
  | 'nested-layers' | 'continuum' | 'threshold-field' | 'source-cluster' | 'inside-outside' | 'overlap' | 'foreground-competition' | 'distance-scale'
  | 'literal-flow' | 'branch' | 'feedback-loop' | 'gate' | 'contamination-path' | 'before-after-intervention' | 'parallel-procedures' | 'progressive-accumulation' | 'failure-point'
  | 'split-screen' | 'overlay-difference' | 'before-after' | 'evidence-table' | 'two-axis' | 'paired-documents' | 'image-vs-report' | 'claim-vs-boundary' | 'condition-a-b';
const chapterTitles = new Map(plan.chapters.map((chapter) => [chapter.chapter, chapter.title]));
const chapterFamilies: Record<number, Family[]> = {
  1: ['KINETIC_CLAIM', 'VERSION_DIFF', 'CONCEPT_SPACE', 'KINETIC_CLAIM', 'COMPARISON'],
  2: ['CHAPTER_INTERSTITIAL', 'VERSION_DIFF', 'EVIDENCE_ARCHIVE', 'PROCESS_MAP', 'COMPARISON'],
  3: ['CHAPTER_INTERSTITIAL', 'EVIDENCE_ARCHIVE', 'COMPARISON', 'PROCESS_MAP', 'CONCEPT_SPACE'],
  4: ['CHAPTER_INTERSTITIAL', 'CONCEPT_SPACE', 'KINETIC_CLAIM', 'PROCESS_MAP', 'COMPARISON'],
  5: ['CHAPTER_INTERSTITIAL', 'COMPARISON', 'CONCEPT_SPACE', 'VERSION_DIFF', 'KINETIC_CLAIM'],
  6: ['CHAPTER_INTERSTITIAL', 'TIMELINE', 'PROCESS_MAP', 'COMPARISON', 'KINETIC_CLAIM'],
  7: ['CHAPTER_INTERSTITIAL', 'EVIDENCE_ARCHIVE', 'TIMELINE', 'VERSION_DIFF', 'COMPARISON'],
  8: ['CHAPTER_INTERSTITIAL', 'EVIDENCE_ARCHIVE', 'PROCESS_MAP', 'CONCEPT_SPACE', 'COMPARISON'],
  9: ['CHAPTER_INTERSTITIAL', 'EVIDENCE_ARCHIVE', 'CONCEPT_SPACE', 'VERSION_DIFF', 'COMPARISON'],
  10: ['CHAPTER_INTERSTITIAL', 'KINETIC_CLAIM', 'COMPARISON', 'FINAL_SYNTHESIS', 'KINETIC_CLAIM'],
};
const archiveRules = [
  {match: /巴特利特/, subject: 'Frederic Bartlett portrait or bibliographic record', query: 'Frederic Bartlett public domain portrait archive'}, {match: /幽灵之战/, subject: 'War of the Ghosts source record', query: 'Kathlamet Texts War of the Ghosts public domain scan'}, {match: /文化传统/, subject: 'Kathlamet source and Charles Cultee attribution', query: 'Kathlamet Texts Charles Cultee public domain'}, {match: /一九七四年/, subject: 'Elizabeth Loftus portrait', query: 'Elizabeth Loftus CC BY-SA portrait'}, {match: /车祸影片/, subject: 'period controlled road-safety footage', query: 'public domain road safety crash test archive'}, {match: /动物研究/, subject: 'historical amygdala anatomy plate', query: 'Gray 718 amygdala public domain'}, {match: /重大消息/, subject: 'people receiving major news', query: 'public domain television audience news archive'}, {match: /十年研究/, subject: 'longitudinal questionnaire record', query: 'September 11 flashbulb memory study repository'}, {match: /司法现场/, subject: 'historical police lineup room', query: 'St Louis Police lineup room DPLA no known copyright'}, {match: /主持列队/, subject: 'DOJ photo array procedure memorandum', query: 'US DOJ photo array procedures 2017 pdf'}, {match: /保存完整过程/, subject: 'official witness confidence recording procedure', query: 'US DOJ eyewitness confidence own words policy'}, {match: /迷路商场/, subject: 'ordinary shopping mall setting', query: 'Library of Congress shopping mall public domain'}, {match: /家人提供/, subject: 'historical family album photograph', query: 'public domain family photo 1900 Wikimedia Commons'}, {match: /想象膨胀/, subject: 'historical family album alternative', query: 'public domain family daguerreotype'}, {match: /国家|程序/, subject: 'National Academies eyewitness report citation record', query: 'NASEM Identifying the Culprit 2014'}, {match: /照片、文字、时间戳/, subject: 'archival evidence materials', query: 'public domain diary photograph timestamp archive'},
] as const;
const retainedArchiveScenes = new Set(['S015', 'S022', 'S067', 'S078', 'S079', 'S098', 'S106']);
const archiveDisclosures: Record<string, string> = {
  S015: '原始资料 · 故事链来源，不是故事原页', S022: '研究者肖像 · 非 1974 实验现场', S067: '背景资料 · 非研究参与者或事件',
  S078: '背景资料 · 非引用研究或案件', S079: '背景资料 · 非引用研究或案件', S098: '背景资料 · 非实验参与者或结果', S106: '背景资料 · 非具体案件证据',
};
const special: Record<string, {family: Family; thesis: string; labels: string[]; compositionVariant?: 0 | 1 | 2; sequence?: Sequence}> = {
  S001: {family: 'VERSION_DIFF', thesis: '同一段往事', labels: ['门边', '那句话', '心跳']}, S002: {family: 'VERSION_DIFF', thesis: '两个版本', labels: ['版本 A', '版本 B', '细节冲突']}, S003: {family: 'KINETIC_CLAIM', thesis: '谁记错了？', labels: ['双方', '确信', '冲突']}, S004: {family: 'CONCEPT_SPACE', thesis: '真实感不是凭证', labels: ['鲜明', '情绪', '准确性']}, S005: {family: 'COMPARISON', thesis: '价值仍然存在', labels: ['大体走向', '原句', '顺序']}, S006: {family: 'CONCEPT_SPACE', thesis: '误差藏在细节', labels: ['原话', '来源', '时间']}, S007: {family: 'KINETIC_CLAIM', thesis: '不是全盘否定', labels: ['更精确', '可检验']}, S008: {family: 'KINETIC_CLAIM', thesis: '确定感从哪来？', labels: ['错误', '回想', '确定感']}, S009: {family: 'VERSION_DIFF', thesis: '熟悉会变连贯', labels: ['重复', '版本', '争论']}, S010: {family: 'COMPARISON', thesis: '顺口不等于原样', labels: ['易说出', '原事件']},
  S015: {family: 'EVIDENCE_ARCHIVE', thesis: '故事跨文化传递', labels: ['原始文本', '故事链', '非故事原页']}, S017: {family: 'EVIDENCE_ARCHIVE', thesis: '经典也要复查', labels: ['原研究', '复现', '差异']}, S018: {family: 'VERSION_DIFF', thesis: '延迟后的三种变化', labels: ['遗漏', '合理化', '扭曲']}, S019: {family: 'COMPARISON', thesis: '两条变化路线', labels: ['个人复述', '人际传递']}, S020: {family: 'CONCEPT_SPACE', thesis: '结构先帮助理解', labels: ['理解', '缺口', '补全']}, S021: {family: 'PROCESS_MAP', thesis: '把变化压进瞬间', labels: ['复述', '换问法', '回答']}, S022: {family: 'EVIDENCE_ARCHIVE', thesis: '一个动词的实验', labels: ['1974', '车祸影片', '提问']}, S023: {family: 'COMPARISON', thesis: '换词，结果变了', labels: ['轻撞', '猛撞', '估计']},
  S069: {family: 'TIMELINE', thesis: '先留下 T0', labels: ['事件后', '原始记录'], sequence: {id: 'flashbulb-longitudinal', phase: 0, view: 'establish'}}, S070: {family: 'VERSION_DIFF', thesis: '后来版本有基线', labels: ['T0', '后来报告'], sequence: {id: 'flashbulb-longitudinal', phase: 1, view: 'compare'}}, S071: {family: 'TIMELINE', thesis: '细节会慢慢分叉', labels: ['数周', '数年', '差异'], sequence: {id: 'flashbulb-longitudinal', phase: 2, view: 'compare'}}, S072: {family: 'COMPARISON', thesis: '鲜明感保持更久', labels: ['鲜明感', '确信', '准确性'], sequence: {id: 'flashbulb-longitudinal', phase: 3, view: 'conclusion'}}, S073: {family: 'KINETIC_CLAIM', thesis: '稳定不等于准确', labels: ['后来', 'T0', '一致性'], sequence: {id: 'flashbulb-longitudinal', phase: 4, view: 'conclusion'}},
  S091: {family: 'PROCESS_MAP', thesis: '两轮访谈塑造体验', labels: ['故事', '引导', '报告']}, S092: {family: 'CONCEPT_SPACE', thesis: '体验从何处开始', labels: ['故事', '接受', '距离'], sequence: {id: 'memory-experience-spectrum', phase: 0, view: 'spectrum'}}, S093: {family: 'VERSION_DIFF', thesis: '线索共同塑形', labels: ['权威', '想象', '提取'], sequence: {id: 'memory-experience-spectrum', phase: 1, view: 'spectrum'}}, S094: {family: 'CONCEPT_SPACE', thesis: '体验不是开关', labels: ['可能', '意象', '回忆'], sequence: {id: 'memory-experience-spectrum', phase: 2, view: 'spectrum'}}, S095: {family: 'COMPARISON', thesis: '配合不等于确信', labels: ['实验要求', '内心确信'], sequence: {id: 'memory-experience-spectrum', phase: 3, view: 'conclusion'}}, S100: {family: 'PROCESS_MAP', thesis: '实验需求也会影响', labels: ['任务', '推测', '报告']},
  S032: {family: 'KINETIC_CLAIM', thesis: '误差不只一种来源', labels: ['记忆', '判断', '猜测']}, S035: {family: 'PROCESS_MAP', thesis: '词表实验不等于自传记忆', labels: ['词表', '联想', '误报'], compositionVariant: 1}, S039: {family: 'PROCESS_MAP', thesis: '把诱饵变得可观察', labels: ['材料', '诱饵', '测试']}, S044: {family: 'KINETIC_CLAIM', thesis: '细节能排除相似项', labels: ['细节', '相似', '拒绝']}, S047: {family: 'COMPARISON', thesis: '主旨能补全缺失细节', labels: ['主旨', '细节'], compositionVariant: 2}, S051: {family: 'VERSION_DIFF', thesis: '结构压缩日常', labels: ['原始细节', '主旨', '压缩']}, S052: {family: 'COMPARISON', thesis: '压缩结构会抹平例外', labels: ['常见模式', '例外'], compositionVariant: 2}, S068: {family: 'COMPARISON', thesis: '鲜明感无法保存细节', labels: ['鲜明感', '准确性'], compositionVariant: 2}, S077: {family: 'KINETIC_CLAIM', thesis: '稳定仍要看内容', labels: ['稳定', '版本', '变化']}, S079: {family: 'VERSION_DIFF', thesis: '早期记录才可比较', labels: ['外部基线', '后来版本']}, S081: {family: 'PROCESS_MAP', thesis: '新信息会进入首次报告', labels: ['原始信息', '暗示', '报告'], compositionVariant: 2}, S085: {family: 'PROCESS_MAP', thesis: '首报要在暗示前留下', labels: ['首次报告', '暗示前', '保存'], compositionVariant: 1}, S088: {family: 'KINETIC_CLAIM', thesis: '有些风险不能补救', labels: ['事前', '事后', '限制']}, S090: {family: 'PROCESS_MAP', thesis: '真事掺入虚构事件', labels: ['真实故事', '虚构事件', '报告'], compositionVariant: 2}, S096: {family: 'VERSION_DIFF', thesis: '成功定义决定比例', labels: ['严格口径', '宽口径', '比例'], compositionVariant: 1}, S097: {family: 'PROCESS_MAP', thesis: '效应不能夸大', labels: ['观察结果', '范围', '边界'], compositionVariant: 1}, S101: {family: 'COMPARISON', thesis: '先分开信念与回忆', labels: ['信念', '回忆'], compositionVariant: 2}, S106: {family: 'EVIDENCE_ARCHIVE', thesis: '高风险，要多条证据', labels: ['刑罚', '关系', '不可逆']}, S107: {family: 'FINAL_SYNTHESIS', thesis: '给记忆一条校验路', labels: ['照片', '文字', '时间戳', '证人']}, S108: {family: 'VERSION_DIFF', thesis: '争论先看版本', labels: ['我记得', '你记得', '条件']}, S109: {family: 'FINAL_SYNTHESIS', thesis: '版本如何被保存', labels: ['形成', '重复', '保存']}, S110: {family: 'VERSION_DIFF', thesis: '档案仍有价值', labels: ['线索', '边界', '校验']}, S111: {family: 'KINETIC_CLAIM', thesis: '怀疑不是放弃判断', labels: ['怀疑', '判断', '证据']},
};
const v21Theses: Record<string, string> = {
  S011: '录像比喻会误导', S012: '回想不是重播', S014: '陌生材料进入复述', S015: '故事跨文化传递', S016: '陌生细节先被省略',
  S024: '强动词抬高估计', S025: '事后语言改变报告', S026: '提问会改变报告', S027: '原痕迹没有被证明删除', S028: '来源不是固定标签', S029: '判断来自多种线索', S030: '误导不会同样生效', S031: '多段信息同场竞争', S033: '先比较，再解释',
  S035: '这不是标准化实验', S036: '词表制造联想', S037: '诱饵词没有出现', S038: '熟悉感会误导', S040: '意义也会制造熟悉', S041: '词错不等于童年', S042: '错误不必来自暗示', S043: '正确和错误共用线索',
  S045: '解释不是单一因果', S046: '主旨与细节分开', S047: '主旨会填补缺口', S048: '来源归因待检验', S049: '熟悉感缺少出处', S050: '熟悉感不够回答', S051: '结构压缩日常', S052: '结构也会遮住例外', S053: '再巩固不是万能解释', S054: '再巩固有条件', S055: '提醒后变化有多种解释', S056: '解释必须分开',
  S057: '信心和准确都非绝对', S058: '记录时点决定含义', S059: '高信心依赖条件', S060: '不能搬到庭审', S061: '反馈会改写评价', S062: '确认反馈抬高信心', S063: '反馈不改变当时观察', S064: '保存第一次信心', S065: '现场条件仍关键', S066: '信心不是定罪器', S067: '闪光灯不等于照片', S068: '照片感来自鲜明', S074: '核心信息可以留下', S075: '真实感不保细节', S076: '变化多在早期',
  S078: '司法只有一次起点', S080: '形成条件同样重要', S081: '暗示把新信息带入', S082: '主持人也会给线索', S083: '程序要隔离暗示', S084: '先记录，再解释', S085: '保护首次报告', S086: '原始记录才可追溯', S087: '有些风险无法补救',
  S089: '提示能走多远', S090: '真实故事加虚构', S091: '两轮访谈塑造体验', S096: '宽口径需要复核', S097: '效应不能夸大', S098: '想象会抬高评分', S099: '信念离完整记忆很远', S100: '实验需求也会影响', S101: '分类先于判真', S102: '记忆不只可信或不可信', S103: '高效不是精确', S104: '高风险细节要留证', S105: '确信也要有条件',
};
const thesisFor = (sceneId: string, text: string, family: Family): string => {
  if (v21Theses[sceneId]) return v21Theses[sceneId]!;
  if (/录像|播放/.test(text)) return '记忆不是录像'; if (/复述|延迟/.test(text)) return '版本会随时间变'; if (/边界|不能|不等于|不是/.test(text)) return '结论需要边界'; if (/信心|自信/.test(text)) return '信心要看记录时点'; if (/来源|亲眼|想象|听说/.test(text)) return '来源需要判断'; if (/词|诱饵|睡眠/.test(text)) return '相似并非出现过'; if (/司法|目击|列队|程序/.test(text)) return '程序守住原始信息'; if (/记忆体验|自传体|相信发生/.test(text)) return '体验存在层次'; if (/研究|实验|参与者/.test(text)) return '让条件彼此对照'; if (/外部证据|照片|文字|时间戳/.test(text)) return '让外部材料校验';
  return ({EVIDENCE_ARCHIVE: '回到可查的材料', PROCESS_MAP: '变化需要条件', TIMELINE: '时间留下版本差', CONCEPT_SPACE: '线索在关系中重组', COMPARISON: '两种信息并行', VERSION_DIFF: '版本发生偏移', CHAPTER_INTERSTITIAL: '下一段，换个问题', FINAL_SYNTHESIS: '证据构成校验路', KINETIC_CLAIM: '记忆正在被组织'})[family];
};
const labelsFor = (family: Family): string[] => ({KINETIC_CLAIM: ['记忆', '判断', '边界'], VERSION_DIFF: ['原版本', '后来版本', '差异'], PROCESS_MAP: ['输入', '条件', '报告'], TIMELINE: ['T0', '数周', '数年'], EVIDENCE_ARCHIVE: ['档案', '日期', '来源'], CONCEPT_SPACE: ['线索', '关系', '缺口'], COMPARISON: ['细节', '主旨', '对照'], CHAPTER_INTERSTITIAL: ['下一章'], FINAL_SYNTHESIS: ['照片', '文字', '时间戳', '证人']})[family];
const sceneNumber = (sceneId: string) => Number(sceneId.slice(1));
const sequenceFor = (sceneId: string): Sequence | undefined => {
  const number = sceneNumber(sceneId);
  const ranges = [
    {from: 1, to: 12, id: 'opening-disagreement'},
    {from: 13, to: 25, id: 'bartlett-to-loftus'},
    {from: 35, to: 56, id: 'drm-mechanisms'},
    {from: 58, to: 66, id: 'confidence-eyewitness'},
    {from: 67, to: 77, id: 'flashbulb-longitudinal'},
    {from: 89, to: 101, id: 'suggested-autobiographical'},
  ].find((range) => number >= range.from && number <= range.to);
  if (!ranges) return undefined;
  const phase = number - ranges.from;
  const span = ranges.to - ranges.from;
  const view: Sequence['view'] = phase === 0 ? 'establish' : phase === span ? 'conclusion' : ranges.id === 'suggested-autobiographical' ? 'spectrum' : 'compare';
  return {id: ranges.id, phase, view};
};
const compositionModeFor = (sceneId: string, family: Family, text: string): CompositionMode | undefined => {
  const number = sceneNumber(sceneId);
  if (family === 'VERSION_DIFF') {
    if (/措辞|动词|原句|改写|删除/.test(text)) return 'document-redline';
    if (/双方|我记得|你记得|争过|两个版本/.test(text)) return 'split-memory';
    if (/T0|后来|延迟|早期记录|数周|数年|十年/.test(text)) return 'version-timeline';
    if (/线索|信息|压缩|塑形|叠加/.test(text)) return 'layer-accumulation';
    return (['document-redline', 'version-timeline', 'layer-accumulation', 'branching-versions'] as const)[number % 4];
  }
  if (family === 'KINETIC_CLAIM') {
    if (/不等于|不是|不能|不只|不够|并非/.test(text)) return 'typographic-contradiction';
    if (/误导|夸大|万能|全盘|有条件/.test(text)) return 'phrase-correction';
    if (/词|记录|反馈|细节|来源|档案/.test(text)) return 'object-led-claim';
    if (/谁|哪|为什么|？/.test(text)) return 'question-field';
    return 'editorial-statement';
  }
  if (family === 'CONCEPT_SPACE') {
    if (/层次|完整|嵌套|主旨/.test(text)) return 'nested-layers';
    if (/距离|连续|程度|光谱/.test(text)) return 'continuum';
    if (/阈值|边界|开关/.test(text)) return 'threshold-field';
    if (/来源|线索|多段|共同/.test(text)) return 'source-cluster';
    if (/内外|隔离|程序/.test(text)) return 'inside-outside';
    if (/竞争|干扰/.test(text)) return 'foreground-competition';
    return (['overlap', 'distance-scale', 'nested-layers', 'source-cluster'] as const)[number % 4];
  }
  if (family === 'PROCESS_MAP') {
    if (/换问法|车祸|措辞/.test(text)) return 'before-after-intervention';
    if (/反馈/.test(text)) return 'feedback-loop';
    if (/隔离|保存|保护|程序/.test(text)) return 'gate';
    if (/暗示|误导|掺入|新信息/.test(text)) return 'contamination-path';
    if (/两轮|访谈|重复/.test(text)) return 'progressive-accumulation';
    if (/平行|两种|分别/.test(text)) return 'parallel-procedures';
    if (/失败|风险|不能/.test(text)) return 'failure-point';
    return (['literal-flow', 'branch', 'progressive-accumulation'] as const)[number % 3];
  }
  if (family === 'COMPARISON') {
    if (/前后|后来|变化/.test(text)) return 'before-after';
    if (/条件|实验|程序/.test(text)) return 'condition-a-b';
    if (/证据|记录|材料/.test(text)) return 'evidence-table';
    if (/照片|图像|报告/.test(text)) return 'image-vs-report';
    if (/边界|不能|不等于|限制/.test(text)) return 'claim-vs-boundary';
    return (['split-screen', 'overlay-difference', 'two-axis', 'paired-documents'] as const)[number % 4];
  }
  return undefined;
};
const speech = plan.units.filter((unit) => unit.kind === 'speech');
let cursor = 0;
const chapterIndexes = new Map<number, number>();
const scenes = speech.map((unit, index) => {
  const sceneId = `S${String(index + 1).padStart(3, '0')}`;
  const chapterIndex = chapterIndexes.get(unit.chapter) ?? 0;
  chapterIndexes.set(unit.chapter, chapterIndex + 1);
  const archiveCandidate = archiveRules.find((rule) => rule.match.test(unit.spokenText));
  const archive = retainedArchiveScenes.has(sceneId) ? archiveCandidate : undefined;
  const configured = special[sceneId];
  const suggested = chapterFamilies[unit.chapter]![chapterIndex % chapterFamilies[unit.chapter]!.length]!;
  const nonChapterFallback: Family[] = ['KINETIC_CLAIM', 'CONCEPT_SPACE', 'COMPARISON'];
  const proposedFamily = configured?.family ?? (suggested === 'CHAPTER_INTERSTITIAL' && chapterIndex > 0 ? nonChapterFallback[chapterIndex % nonChapterFallback.length]! : suggested);
  const family = proposedFamily === 'EVIDENCE_ARCHIVE' && !archive ? 'CONCEPT_SPACE' : proposedFamily;
  const durationInFrames = Math.max(165, Math.round(unit.spokenText.length / 4.5 * 30));
  const startFrame = cursor; cursor += durationInFrames;
  const evidenceRole = /不等于|不能|不是|边界|不自动|不能直接|并没有/.test(unit.spokenText) ? '边界' : unit.evidenceIds.length ? (unit.chapter <= 4 ? '原始研究' : unit.chapter >= 7 ? '后续证据' : '解释') : undefined;
  const sequence = sequenceFor(sceneId) ?? configured?.sequence;
  const compositionMode = compositionModeFor(sceneId, family, unit.spokenText);
  return {id: sceneId, chapter: unit.chapter, chapterTitle: chapterTitles.get(unit.chapter)!, start: startFrame / 30, end: cursor / 30, duration: durationInFrames / 30, startFrame, durationInFrames, category: archive ? 'Archive' : 'Minimal', visualType: archive ? 'Archive' : 'Minimal', template: null, sourceTemplate: null,
    templateProps: {memoryLab: {version: MEMORY_LAB_EDITORIAL_RENDERER_VERSION, family, compositionVariant: configured?.compositionVariant ?? (chapterIndex + index) % 3, ...(compositionMode ? {compositionMode} : {}), backgroundMode: 'dark', narrationText: unit.spokenText, visualThesis: configured?.thesis ?? thesisFor(sceneId, unit.spokenText, family), visualLabels: configured?.labels ?? labelsFor(family), label: chapterTitles.get(unit.chapter)!, ...(archiveDisclosures[sceneId] ? {archiveDisclosure: archiveDisclosures[sceneId]} : {}), ...(evidenceRole ? {evidenceRole} : {}), ...(sequence ? {sequence} : {})}},
    assetRequirements: archive ? [{requirementId: `${sceneId}-R01`, kind: 'image' as const, subject: archive.subject, query: archive.query, usage: 'primary' as const, policy: 'public_domain' as const, authenticity: 'authentic_required' as const}] : [], narrationSummary: unit.spokenText, description: `${family}: ${configured?.thesis ?? thesisFor(sceneId, unit.spokenText, family)}`, notes: `exact narration unit ${unit.id}; visual copy separated; archive audit retained=${Boolean(archive)}`, assetIds: [], licenseStatus: archive ? 'review-required' : 'not-applicable', subtitlePosition: 'bottom' as const, transitionIn: index === 0 ? 'fade' : 'cut', transitionOut: index === speech.length - 1 ? 'fade-out' : 'cut'};
});
const chapterTiming = plan.chapters.map((chapter) => {const rows = scenes.filter((scene) => scene.chapter === chapter.chapter); return {chapter: chapter.chapter, title: chapter.title, start: rows[0]!.start, end: rows.at(-1)!.end};});
const design = scenesAiOutputSchema.parse({chapterTiming, scenes});
const semantic = validateScenesSemantics(design); if (!semantic.ok) throw new Error(JSON.stringify(semantic.issues, null, 2));
for (const scene of scenes) {const memoryLab = scene.templateProps.memoryLab; const thesis = String(memoryLab.visualThesis).replace(/[^\u4e00-\u9fff]/g, ''); const narration = String(memoryLab.narrationText).replace(/[^\u4e00-\u9fff]/g, ''); if (String(memoryLab.visualThesis) === String(memoryLab.narrationText) || (thesis.length > 18 && narration.includes(thesis))) throw new Error(`${scene.id} visualThesis duplicates narration`); if ((memoryLab.visualLabels as string[]).some((label) => label.length > 8)) throw new Error(`${scene.id} visual label exceeds 8 characters`);}
if (scenes.filter((scene) => scene.assetRequirements.length).length !== retainedArchiveScenes.size) throw new Error('archive retention drift');
fs.writeFileSync(outputPath, `${JSON.stringify(design, null, 2)}\n`);
fs.writeFileSync(beatMapPath, ['# Extreme Long Video — Narration Beat Map', '', 'Narration remains the exact source for TTS/subtitles. Visual copy is intentionally separate: `visualThesis` is a short screen claim; `visualLabels` carries structure; neither repeats the narration sentence.', '', '| Narration unit | Scene | Chapter | Visual family | Visual thesis |', '| --- | --- | ---: | --- | --- |', ...speech.map((unit, index) => {const scene = scenes[index]!; const memoryLab = scene.templateProps.memoryLab as {family: string; visualThesis: string}; return `| ${unit.id} | ${scene.id} | ${unit.chapter} | ${memoryLab.family} | ${memoryLab.visualThesis} |`; }), ''].join('\n'));
console.log(JSON.stringify({outputPath, beatMapPath, scenes: scenes.length, archiveRequirements: scenes.filter((scene) => scene.assetRequirements.length > 0).length, estimatedSeconds: cursor / 30}, null, 2));

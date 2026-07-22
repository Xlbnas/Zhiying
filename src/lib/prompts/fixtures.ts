/**
 * Mock fixtures（M2-B）：10 个阶段的确定性合法产物。
 * - 相同输入永远得到相同输出（静态文本，无时间戳/随机数）。
 * - JSON fixture 必须通过对应阶段的 zod schema。
 * - 内容仅用于状态机/DB/执行器零成本测试，不代表真实生成质量。
 */

import type {WorkflowStage} from '../workflow/types';

const EVIDENCE_JSON = JSON.stringify({
  evidence: [
    {
      id: 'E01',
      claim: '示例主张：核心概念在原书中有明确定义与章节归属',
      source: 'SOURCE_REQUIRED',
      sourceType: 'primary',
      verification: 'SOURCE_REQUIRED',
      supportLevel: 'medium',
      allowedWording: '原书讨论了该概念（来源待补充核实）',
      forbiddenInference: '不得写成原书证明了该概念的现代有效性',
      notes: 'mock fixture',
    },
    {
      id: 'E02',
      claim: '示例主张：现代实验研究在受控条件下观察到相关现象',
      source: 'SOURCE_REQUIRED',
      sourceType: 'modern-research',
      verification: 'UNVERIFIED',
      supportLevel: 'medium',
      allowedWording: '现代研究在实验条件下观察到该现象（具体文献待核实）',
      forbiddenInference: '不得写成现代研究证明了历史理论',
      notes: 'mock fixture',
    },
    {
      id: 'E03',
      claim: '错误外推示例：单一案例可以推出普遍心理诊断',
      source: '无（禁止推论条目）',
      sourceType: 'forbidden-extrapolation',
      verification: 'UNVERIFIED',
      supportLevel: 'none',
      allowedWording: '禁止使用',
      forbiddenInference: '单案例不得推广到所有人',
      notes: 'mock fixture',
    },
  ],
  gaps: ['示例缺口：核心数据尚无来源支撑（INSUFFICIENT_SOURCES）'],
});

const ARGUMENT_TREE_JSON = JSON.stringify({
  coreQuestion: '示例核心问题：现象背后是普通解释还是另有机制？',
  coreClaim: '示例核心命题：存在另一种可能机制，但现有证据不足以单独证明。[E01]',
  audiencePrior: '观众倾向于把该现象归结为单一常见原因。',
  audienceTarget: '观众获得一种更克制的观察方法，允许答案保持开放。',
  nodes: [
    {
      id: 'N01',
      kind: 'opening',
      title: '现实入口',
      summary: '从日常场景引出疑点（纯叙事，无事实主张）。',
      evidenceIds: [],
      children: ['N02'],
    },
    {
      id: 'N02',
      kind: 'claim',
      title: '第一层怀疑',
      summary: '常见解释成立，但不能自动推出唯一结论。[E01]',
      evidenceIds: ['E01'],
      children: ['N03', 'N04'],
    },
    {
      id: 'N03',
      kind: 'support',
      title: '现代研究支持边界',
      summary: '实验只支持到"现象可被受控诱发"，不支持理论证明。[E02]',
      evidenceIds: ['E02'],
      children: [],
    },
    {
      id: 'N04',
      kind: 'rebuttal',
      title: '主动反驳',
      summary: '替代解释同样成立；错误外推被明确禁用。[E03]',
      evidenceIds: ['E03'],
      children: ['N05'],
    },
    {
      id: 'N05',
      kind: 'ending',
      title: '克制结尾',
      summary: '承认两种可能都开放，把问题留给观众。',
      evidenceIds: [],
      children: [],
    },
  ],
});

const SHOT_LIST_JSON = JSON.stringify({
  shots: [
    {
      id: 'SH001',
      chapter: 1,
      purpose: '现实入口铺垫',
      visualType: 'Reality B-roll',
      durationSec: 6.5,
      audioSpace: '旁白驱动',
      assetNeeds: ['示例素材需求：日常室内场景'],
      transition: 'cut',
      notes: 'mock fixture',
    },
    {
      id: 'SH002',
      chapter: 1,
      purpose: '解释抽象关系',
      visualType: 'MG',
      durationSec: 8,
      audioSpace: '旁白驱动',
      assetNeeds: [],
      transition: 'cut',
      notes: 'mock fixture',
    },
    {
      id: 'SH003',
      chapter: 1,
      purpose: '停顿与边界（画面呼吸）',
      visualType: 'Minimal',
      durationSec: 4,
      audioSpace: '画面呼吸',
      assetNeeds: [],
      transition: 'hold',
      notes: 'mock fixture',
    },
  ],
});

const SCENES_JSON = JSON.stringify({
  chapterTiming: [{chapter: 1, title: '示例章节', start: 0, end: 14.5}],
  scenes: [
    {
      id: 'S001',
      chapter: 1,
      chapterTitle: '示例章节',
      start: 0,
      end: 6.5,
      duration: 6.5,
      startFrame: 0,
      durationInFrames: 195,
      category: 'B-roll',
      visualType: 'Asset',
      template: null,
      sourceTemplate: null,
      narrationSummary: '示例旁白摘要：引出日常场景',
      description: '示例画面职责：现实语境铺垫，单一构图，留白充足。',
      notes: '',
      assetIds: [],
      licenseStatus: 'not-applicable',
      subtitlePosition: 'bottom',
      transitionIn: 'none',
      transitionOut: 'cut',
    },
    {
      id: 'S002',
      chapter: 1,
      chapterTitle: '示例章节',
      start: 6.5,
      end: 14.5,
      duration: 8,
      startFrame: 195,
      durationInFrames: 240,
      category: 'MG',
      visualType: 'MG',
      template: 'MG_ExampleRelation',
      sourceTemplate: 'MG_ExampleRelation',
      narrationSummary: '示例旁白摘要：解释两层关系',
      description: '示例画面职责：快动作呈现两节点关系后长 Hold。',
      notes: 'template 为 mock 占位，真实项目须使用已注册模板',
      assetIds: [],
      licenseStatus: 'not-applicable',
      subtitlePosition: 'lowerThird',
      transitionIn: 'cut',
      transitionOut: 'hold',
    },
  ],
});

const md = (title: string, lines: string[]): string =>
  [`# ${title}`, '', ...lines, '', '> mock fixture（确定性测试产物）'].join('\n');

export const MOCK_FIXTURES: Readonly<Record<WorkflowStage, string>> = {
  project_definition: md('Project Brief', [
    '## 1. 项目概述',
    '示例核心问题可研究、非结论预设。',
    '## 2. 项目变量确认表',
    'TARGET_DURATION = 10 分钟（默认值标注）。',
    '## 3. 范围与禁区',
    '禁区：不做个体心理诊断式断言。',
    '## 4. 观众与平台',
    '示例观众假设与平台限制。',
    '## 5. 目标时长与结构预期',
    '示例章节配比。',
    '## 6. 成功标准',
    '示例可检查标准。',
    '## 7. 风险与人工确认点',
    '示例确认点。',
  ]),
  research: md('Research', [
    '## 1. 研究子问题分解',
    '示例子问题。',
    '## 2. 检索词规划',
    '示例检索词（中英）。',
    '## 3. 来源地图',
    '示例条目：层级=primary，核实状态=SOURCE_REQUIRED。',
    '## 4. 事实争议与分歧点',
    '示例争议。',
    '## 5. 检索缺口',
    'INSUFFICIENT_SOURCES 示例。',
    '## 6. 风险与人工确认点',
    '示例确认点。',
  ]),
  evidence: EVIDENCE_JSON,
  argument_tree: ARGUMENT_TREE_JSON,
  script_v1: md('Script V1', [
    '> 总时长预估 10 分钟；章节时长分配示例。',
    '## 第 1 章 示例章节（00:00–02:00）',
    '示例逻辑版旁白段落一。<!-- E01 -->',
    '示例逻辑版旁白段落二（含主动反驳）。<!-- E02 E03 -->',
  ]),
  script_v2: md('Script V2', [
    '> 与 V1 差异说明：压缩书面语，零新增事实。',
    '## 第 1 章 示例章节（00:00–02:00）',
    '示例口播短句一。（停顿 1s）<!-- E01 -->',
    '示例口播短句二。[画面留白] <!-- E02 -->',
  ]),
  narration_beat_map: md('Narration Beat Map', [
    '> 情绪曲线总述：铺垫→转折→克制落点。',
    '## 第 1 章 示例章节',
    '- 情绪：铺垫→转折',
    '- 语速：中→慢',
    '- 关键停顿：转折前静默 1s（制造悬念）',
    '- 重音：示例关键词',
    '- 画面呼吸：00:40–00:48 旁白退后（让观众消化）',
  ]),
  visual_breakdown: md('Visual Breakdown', [
    '## 1. 视觉语言总述',
    '示例：从项目上下文推导的克制解释型视觉。',
    '## 2. 色彩与字体方向',
    '示例：中性底色 + 单一强调色（红=冲突，上限 10%）。',
    '## 3. 五类视觉职责与配比',
    'Reality B-roll 语境 ≤40%；Archive 历史 ≤15%；MG 解释抽象 ≤30%；Minimal 停顿 ≥10%；Editorial Graphic 数据 ≤10%。连续纯 MG ≤20s。',
    '## 4. 章节视觉系统',
    '示例：第 1 章 B-roll 主导，第 2 章转入 MG。',
    '## 5. 禁用视觉清单',
    'cyberpunk HUD / 科幻仪表盘 / generic AI dashboard / PPT 卡片堆叠。',
    '## 6. 与旁白节奏的配合原则',
    '画面呼吸窗口使用 Minimal。',
  ]),
  shot_list: SHOT_LIST_JSON,
  scenes: SCENES_JSON,
};

/** badSchema 注入用：合法 JSON 但必然不满足任何 JSON 阶段 schema。 */
export const MOCK_BAD_SCHEMA_JSON = '{"wrong":"shape"}';

/** badJson 注入用：根本不可解析。 */
export const MOCK_BAD_JSON_TEXT = '{"evidence": [{"id": "E01", "claim": "截断的坏输出…';

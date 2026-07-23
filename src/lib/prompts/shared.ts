/**
 * Prompt Registry 共享层（M2-B）。
 *
 * 产品化来源：
 * - 《通用AI视频生产_总控提示词》（全局研究/脚本/视觉/MG 原则 → 本文件共享片段）
 * - 《AI视频生产工作流_V1_完整说明》（阶段输入/输出/常见失败 → 各阶段模板）
 * - 阶段提示词模板 01–06（阶段指令语义）
 *
 * 设计：system 保持静态（利于 DeepSeek 前缀缓存命中），项目变量与上游产物
 * 一律走 user；每阶段模板带 promptVersion 常量，改 prompt = 升版本号，旧模板保留。
 */

import type {WorkflowStage} from '../workflow/types';

/** 阶段执行输入。sourceContext 为未来 Sources（M4）预留，M2-B 不提供联网检索。 */
export interface StagePromptInput {
  topic: string;
  coreQuestion: string;
  targetDuration?: string;
  language?: string;
  platform?: string;
  audience?: string;
  videoStyle?: string;
  visualStyle?: string;
  scientificRigor?: string;
  /** 上游阶段产物内容（Markdown 文本或 JSON 字符串），按键名注入。 */
  upstream?: Partial<Record<WorkflowStage, string>>;
  /** 外部来源材料（M4 Sources）。缺省时严禁编造来源。 */
  sourceContext?: string;
}

export interface StagePrompt {
  stage: WorkflowStage;
  /** 版本常量，如 'research@1.0'；写入 project_versions 与 llm_usage。 */
  promptVersion: string;
  outputKind: 'markdown' | 'json';
  system: string;
  buildUser(input: StagePromptInput): string;
  /** outputKind='json' 时必须有（结构校验）。 */
  zodSchema?: import('zod').ZodTypeAny;
  /**
   * 语义校验（可选，结构校验之后执行；M2-E-A Scenes 起）。
   * LLM 输出与人工 JSON 编辑共用同一套规则——返回问题列表（空 = 通过）。
   */
  semanticValidate?: (data: unknown) => Array<{code: string; message: string}>;
}

// ---------- 共享 system 片段（总控提示词全局原则的产品化） ----------

export const SHARED_ROLE = `你是「知影 · AI 知识视频工坊」的生产助手，参与一套可追溯、可阶段审核、可渲染的 AI 知识视频生产。你一次只执行一个生产阶段，绝不跨阶段工作。`;

export const SHARED_RESEARCH_PRINCIPLES = `【研究原则】
- 不得凭记忆写事实密集型内容；重要事实、历史断言、实验结果和数字都必须对应 Evidence ID。
- 区分原始来源、二手来源、现代研究、理论解释、合理推论和禁止推论。
- 理论解释不能写成事实；相关研究不能写成"证明了理论"；行为现象不能自动写成隐藏动机；单个案例不能推广到所有人。
- 心理学、科学、医学、历史、哲学内容必须明确事实、解释、理论与现代证据的边界。
- 争议理论必须安排主动反驳，并说明什么证据可以支持到哪里。`;

export const SHARED_SCRIPT_PRINCIPLES = `【脚本原则】
- 顺序必须是 Argument Tree → Script V1 → Script V2，不得越过上游结构。
- 不写百科式脚本，不把所有知识点都塞进旁白。
- 事实陈述使用可核查语言；理论解释明确主语；现代研究只说明实验支持到哪里。`;

export const SHARED_VISUAL_PRINCIPLES = `【视觉原则】
- MG（Motion Graphics）是解释语言，不是整片视觉：MG 只解释抽象关系；Reality B-roll 负责语境，Archive 负责历史，Minimal 负责停顿和边界，Editorial Graphic 负责数据与关键文字。
- 不使用"一句旁白 = 一个镜头"，不为每句话生成画面，防止整支视频变成动态 PPT。
- 避免连续相同布局与连续纯 MG；避免 cyberpunk HUD、科幻仪表盘、generic AI dashboard、PPT 卡片堆叠。
- 视觉风格必须来自项目上下文（主题/受众/平台/VIDEO_STYLE/VISUAL_STYLE），不得套用任何既有示例项目的风格。`;

export const SHARED_MG_PRINCIPLES = `【MG 原则】
- 使用"快动作 + 长 Hold"：变化快速发生，停顿让观众理解；不让整个 Scene 持续慢动画。
- 旁白不要把 MG 即将展示的节点和箭头逐项朗读。`;

/**
 * 来源边界（M2-B 无 Sources、无联网检索）：
 * 三种显式状态 + 禁止伪造清单。研究/证据类阶段 system 必须包含。
 */
export const SHARED_SOURCE_BOUNDARY = `【来源边界 — 强制】
- 你没有联网检索能力。除用户提供的 sourceContext 外，禁止假装搜索过互联网。
- 禁止伪造：论文、URL、作者、页码、直接引文、Source ID、不存在的书籍章节与实验数据。
- 只能凭模型既有知识给出"已知文献/理论的存在性指引"，且必须逐条降级标注：
  UNVERIFIED（未经来源核实）/ SOURCE_REQUIRED（必须补充来源后才可写入正式措辞）/
  INSUFFICIENT_SOURCES（现有材料不足以支撑该主张）。
- 用户提供了 sourceContext 时，只允许引用其中的材料，并在引用处可回溯到原文。`;

// ---------- user 组装辅助 ----------

/** 项目变量区（对应总控提示词变量区，缺省值显式标注）。 */
export function projectVarsBlock(input: StagePromptInput): string {
  const v = (value: string | undefined, fallback: string): string =>
    value && value.trim().length > 0 ? value : fallback;
  return [
    '【项目变量】',
    `TOPIC = ${input.topic}`,
    `CORE_QUESTION = ${input.coreQuestion}`,
    `TARGET_DURATION = ${v(input.targetDuration, '10 分钟')}`,
    `LANGUAGE = ${v(input.language, '中文')}`,
    `TARGET_PLATFORM = ${v(input.platform, '未指定')}`,
    `AUDIENCE = ${v(input.audience, '未指定')}`,
    `VIDEO_STYLE = ${v(input.videoStyle, '视频论文')}`,
    `VISUAL_STYLE = ${v(input.visualStyle, '由你按项目上下文提案')}`,
    `SCIENTIFIC_RIGOR = ${v(input.scientificRigor, '高')}`,
  ].join('\n');
}

/** 上游产物注入（按声明顺序拼入 user；缺失的上游会显式标注）。 */
export function upstreamBlock(
  input: StagePromptInput,
  stages: WorkflowStage[],
): string {
  if (stages.length === 0) return '';
  const parts = stages.map((stage) => {
    const content = input.upstream?.[stage];
    return `【上游产物：${stage}】\n${content && content.trim().length > 0 ? content : '（缺失，按未完成上游处理并在输出中标注）'}`;
  });
  return parts.join('\n\n');
}

/** sourceContext 区块（M4 预留；缺省时给出边界提示）。 */
export function sourceContextBlock(input: StagePromptInput): string {
  const ctx = input.sourceContext;
  if (ctx && ctx.trim().length > 0) {
    return `【sourceContext — 唯一可引用来源】\n${ctx}`;
  }
  return '【sourceContext】（未提供 — 你没有任何可引用来源，涉来源内容必须按来源边界规则降级标注）';
}

/** 组合 system：角色 + 全局片段 + 阶段指令。 */
export function composeSystem(...parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}

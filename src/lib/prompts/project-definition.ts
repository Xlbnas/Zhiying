/**
 * project_definition 阶段（PHASE 0 — Project Definition）。
 * 输出：Project Brief（Markdown）。
 */

import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  type StagePrompt,
} from './shared';

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】选题定义编辑。你把一个模糊主题变成可研究、可生产、可验收的项目定义。`,
  `【目标】产出 Project Brief：确认项目变量、核心问题、范围、禁区、目标时长、观众先验、平台限制和成功标准。`,
  `【推理与输出行为】
- 若核心问题预设了结论，先改写为可研究的问题（开放、可证伪、有争议空间），并说明改写理由。
- 范围必须同时写明"做什么"和"不做什么"（禁区），禁区要具体到主题侧面与推论类型。
- 成功标准必须可在后续阶段被检查（可验证的表述，不是口号）。`,
  `【输出契约】Markdown，中文，小节顺序固定：
1. 项目概述（主题一句话 + 核心问题 + 改写说明如有）
2. 项目变量确认表（逐项列出并标注默认值/用户指定）
3. 范围与禁区
4. 观众与平台（先验知识、观看场景、平台限制）
5. 目标时长与结构预期（章节数与大致配比）
6. 成功标准（3–5 条，可检查）
7. 风险与人工确认点（3–5 项）`,
  `【禁止行为】
- 不得进入研究/脚本/视觉等任何后续阶段的内容生产。
- 不得罗列空泛形容词代替可检查标准。
- 不得假设观众专业知识水平而不写明假设。`,
  `【自检】输出前确认：核心问题是否可研究（非结论预设）？禁区是否具体？成功标准是否可检查？是否只含本阶段内容？`,
);

export const projectDefinitionPrompt: StagePrompt = {
  stage: 'project_definition',
  promptVersion: 'project-definition@1.0',
  outputKind: 'markdown',
  system,
  buildUser(input) {
    return [projectVarsBlock(input), '请仅执行 project_definition 阶段，输出 Project Brief。'].join(
      '\n\n',
    );
  },
};

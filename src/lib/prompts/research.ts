/**
 * research 阶段（PHASE 1 — Research）。
 * 输出：Research.md（Markdown）。不写正式脚本。
 */

import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SOURCE_BOUNDARY,
  sourceContextBlock,
  upstreamBlock,
  type StagePrompt,
} from './shared';

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】研究策划。你为后续证据库与脚本建立可追溯的研究地图，不写正式脚本。`,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SOURCE_BOUNDARY,
  `【目标】产出 Research.md：检索词规划、来源层级（原始文本 / 权威综述 / 现代研究 / 批评来源）、已知关键文献与理论的存在性指引、事实争议点、检索缺口。`,
  `【推理与输出行为】
- 先按核心问题拆解研究子问题，再为每个子问题规划中英文检索词。
- 每条文献/理论指引都必须标注来源层级与核实状态（UNVERIFIED / SOURCE_REQUIRED）。
- 主动寻找反方与批评来源；只列支持方视为失败。
- 事实争议单独成节，说明各方依据与可支持边界。`,
  `【输出契约】Markdown，中文，小节顺序固定：
1. 研究子问题分解
2. 检索词规划（按子问题，中英双语）
3. 来源地图（按层级分组；每条含 题名/作者/层级/核实状态/与核心问题的关系）
4. 事实争议与分歧点
5. 检索缺口（INSUFFICIENT_SOURCES 清单：哪些主张目前无来源支撑）
6. 风险与人工确认点`,
  `【禁止行为】
- 禁止伪造论文、URL、作者、页码、直接引文或 Source ID；禁止假装执行过联网搜索。
- 不得写任何旁白/脚本段落。
- 不得把理论解释写成事实，把相关研究写成"证明了理论"。`,
  `【自检】输出前确认：是否有反方来源规划？每条指引是否都带核实状态？缺口是否显式列出？是否零脚本内容？`,
);

export const researchPrompt: StagePrompt = {
  stage: 'research',
  promptVersion: 'research@1.0',
  outputKind: 'markdown',
  system,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['project_definition']),
      sourceContextBlock(input),
      '请仅执行 research 阶段，输出 Research.md 内容。',
    ].join('\n\n');
  },
};

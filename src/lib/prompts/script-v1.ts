/**
 * script_v1 阶段（PHASE 4 — Script V1）。
 * 输出：逻辑版旁白 Markdown，保留 Evidence 注释。
 */

import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SCRIPT_PRINCIPLES,
  upstreamBlock,
  type StagePrompt,
} from './shared';

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】逻辑版编剧。你负责逻辑完整、证据注释和反驳保留，不负责口语化。`,
  SHARED_RESEARCH_PRINCIPLES,
  SHARED_SCRIPT_PRINCIPLES,
  `【目标】按目标时长和章节写逻辑版旁白 Script V1：论证树节点全覆盖、证据注释保留、反驳不隐藏。`,
  `【推理与输出行为】
- 严格按论证树推进，不得越过论证树新增主张，不得省略 rebuttal / boundary 节点。
- 每个事实性段落保留 Evidence 注释：段尾用 HTML 注释标注，如 <!-- E04 E10 -->。
- 理论解释明确主语（"弗洛伊德认为…"）；现代研究只说明实验支持到哪里。
- 按 TARGET_DURATION 估算总字数（中文旁白约每分钟 240–280 字），分配章节时长并标注。`,
  `【输出契约】Markdown，中文，结构：
# Script V1
> 总时长预估 / 章节时长分配表
## 第 N 章 章节标题（mm:ss–mm:ss）
旁白正文（段落末尾保留 <!-- Evidence ID --> 注释）
（逐章推进至结尾）`,
  `【禁止行为】
- 不得写百科式堆砌；不得把知识点全塞进旁白。
- 不得隐藏争议、删除反驳、把理论写成已验证事实。
- 不得使用 Evidence 库之外的"事实"；引用未核实内容时必须沿用其降级措辞。
- 不做口语化改写（那是 Script V2 的职责）。`,
  `【自检】输出前确认：论证树节点是否全覆盖？事实段是否都有 Evidence 注释？反驳与边界是否保留？总时长是否符合 TARGET_DURATION？`,
);

export const scriptV1Prompt: StagePrompt = {
  stage: 'script_v1',
  promptVersion: 'script-v1@1.0',
  outputKind: 'markdown',
  system,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['project_definition', 'argument_tree', 'evidence']),
      '请仅执行 script_v1 阶段，输出 Script V1。',
    ].join('\n\n');
  },
};

/**
 * script_v2 阶段（PHASE 5 — Script V2）。
 * 输出：口播版旁白 Markdown。只做口语化，不改论证、不增事实。
 */

import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  SHARED_SCRIPT_PRINCIPLES,
  upstreamBlock,
  type StagePrompt,
} from './shared';

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】口播改编。你把逻辑版脚本变成可以自然朗读的口播稿，对论证结构零改动。`,
  SHARED_SCRIPT_PRINCIPLES,
  `【目标】产出 Script V2：口语化、精简、句长控制、停顿设计、推进感和视觉留白；降低讲课感。`,
  `【推理与输出行为】
- 不改变论证结构与结论，不新增任何未经 Evidence 支持的事实，不删除科学边界与反驳。
- 长句拆短；删掉书面连接词；每句只承载一个信息点。
- 连续概念解释中能交给画面表达的部分，从旁白移除并用 [画面留白] 标注。
- 在关键转折处标注停顿意图，如（停顿 1s）、（放慢）。`,
  `【输出契约】Markdown，中文，结构：
# Script V2
> 与 V1 的差异说明（压缩比例、移除的视觉留白段、零新增事实声明）
## 第 N 章 章节标题（mm:ss–mm:ss）
口播正文（保留 <!-- Evidence ID --> 注释；含停顿/留白标注）`,
  `【禁止行为】
- 不得重写论证、更换案例、增删 Evidence 引用。
- 不得为了"效果"加入夸张断言或未经支持的因果。
- 不得写成镜头脚本（节奏与镜头是下游阶段）。`,
  `【自检】输出前确认：论证结构与 V1 一致？零新增事实？Evidence 注释保留？可自然朗读（句长、停顿）？`,
);

export const scriptV2Prompt: StagePrompt = {
  stage: 'script_v2',
  promptVersion: 'script-v2@1.0',
  outputKind: 'markdown',
  system,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['script_v1', 'evidence']),
      '请仅执行 script_v2 阶段，输出 Script V2。',
    ].join('\n\n');
  },
};

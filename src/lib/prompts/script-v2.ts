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
- 导演指令与口播正文严格分离：正文行只写要朗读的文字，指令一律使用独占行的 directive DSL。
- 可交给画面表达的部分，从旁白移除，并用 @silence 指令表达留白。`,
  `【输出契约】Markdown，中文，结构：
# Script V2
> 与 V1 的差异说明（压缩比例、移除的视觉留白段、零新增事实声明）
## 第 N 章 章节标题（mm:ss–mm:ss）
口播正文行（保留 <!-- Evidence ID --> 注释）

【Directive DSL（闭集 grammar，必须独占一行，正文行禁止混入任何指令）】
- @pause 500ms        → 停顿（时长支持 ms / s / 秒，如 @pause 1s、@pause 0.5秒）
- @silence 1200ms reason=visual_breath   → 画面留白（必须显式时长；reason 可省略，默认 pause）
- @delivery slow      → 后续正文的朗读方式（normal|slow|fast|soft|firm|emphasis），直到再次声明

【禁止行为】
- 禁止在正文行内写任何旧式括号指令，如（停顿 1s）（放慢）（旁白无）。
- 禁止写「旁白：」「画面：」「停顿后旁白：」等前缀；要停顿用 @pause，要留白用 @silence。
- 禁止发明 DSL 之外的新指令（未识别 @directive 会导致编译硬失败）。
- 不得重写论证、更换案例、增删 Evidence 引用。
- 不得为了"效果"加入夸张断言或未经支持的因果。
- 不得写成镜头脚本（节奏与镜头是下游阶段）。`,
  `【自检】输出前确认：论证结构与 V1 一致？零新增事实？Evidence 注释保留？指令全部独占行且只来自 DSL 闭集？正文行无任何括号指令？`,
);

export const scriptV2Prompt: StagePrompt = {
  stage: 'script_v2',
  promptVersion: 'script-v2@2.0',
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

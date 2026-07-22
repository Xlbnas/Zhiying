/**
 * narration_beat_map 阶段（PHASE 6 — Narration Beat Map）。
 * 输出：逐章节奏标注 Markdown。只标注声音节奏，不写镜头。
 */

import {
  composeSystem,
  projectVarsBlock,
  SHARED_ROLE,
  upstreamBlock,
  type StagePrompt,
} from './shared';

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】声音导演。你为旁白设计情绪曲线与呼吸节奏，不设计任何画面。`,
  `【目标】产出 Narration Beat Map：逐章标注情绪、语速、关键停顿、重音，以及允许画面独立表达（旁白安静）的时间窗口。`,
  `【推理与输出行为】
- 以 Script V2 章节为单位；情绪标注要具体到段落功能（铺垫/转折/落点）。
- 语速用相对词（慢/中/快 + 变化方向），不写绝对字速。
- 关键停顿标注意图（让观众消化/制造悬念/转折前静默）。
- 画面呼吸窗口：明确哪些段落旁白应退后，让画面独立表达（只标时间窗口与意图，不写镜头内容）。`,
  `【输出契约】Markdown，中文，结构：
# Narration Beat Map
> 全片情绪曲线一句话总述
## 第 N 章 章节标题
- 情绪：…（铺垫→转折→落点）
- 语速：…（变化方向）
- 关键停顿：…（位置 + 意图）
- 重音：…（关键词/短语）
- 画面呼吸：…（时间窗口 + 意图）
（逐章至结尾）`,
  `【禁止行为】
- 不得写成具体镜头/分镜（功能、素材、转场是下游阶段）。
- 不得改动旁白文本本身。
- 不得遗漏任何章节。`,
  `【自检】输出前确认：逐章覆盖？停顿有意图而非装饰？画面呼吸窗口只标意图不写镜头？`,
);

export const narrationBeatMapPrompt: StagePrompt = {
  stage: 'narration_beat_map',
  promptVersion: 'narration-beat-map@1.0',
  outputKind: 'markdown',
  system,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['script_v2']),
      '请仅执行 narration_beat_map 阶段，输出 Narration Beat Map。',
    ].join('\n\n');
  },
};

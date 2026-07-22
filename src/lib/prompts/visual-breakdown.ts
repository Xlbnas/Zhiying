/**
 * visual_breakdown 阶段（PHASE 7 — Visual Breakdown）。
 * 输出：视觉系统 Markdown。定义五类视觉的职责、比例与禁用样式。
 */

import {
  composeSystem,
  projectVarsBlock,
  SHARED_MG_PRINCIPLES,
  SHARED_ROLE,
  SHARED_VISUAL_PRINCIPLES,
  upstreamBlock,
  type StagePrompt,
} from './shared';

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】视觉总监。你为整片建立视觉系统，让抽象解释与现实语境各司其职。`,
  SHARED_VISUAL_PRINCIPLES,
  SHARED_MG_PRINCIPLES,
  `【目标】产出 Visual Breakdown：色彩与字体方向、Reality B-roll / Archive / MG / Minimal / Editorial Graphic 五类视觉的职责与配比、章节视觉系统、强调色规则、不可使用的视觉。`,
  `【推理与输出行为】
- 视觉语言从项目上下文推导（主题气质、受众、平台、VIDEO_STYLE/VISUAL_STYLE），并说明推导理由。
- 五类视觉逐一定义"负责什么 / 不负责什么"，给出全片配比上限（百分比范围）与连续同类上限。
- 章节视觉系统：逐章指定主导视觉类型与变化理由，避免全片单一节奏。
- 强调色规则：颜色承担语义（如红=冲突/警示），写明使用条件与上限，不做装饰性用色。
- 明确禁用清单：cyberpunk HUD、科幻仪表盘、generic AI dashboard、PPT 卡片堆叠、无语义渐变背景等。`,
  `【输出契约】Markdown，中文，结构：
# Visual Breakdown
1. 视觉语言总述（从项目上下文的推导）
2. 色彩与字体方向（含强调色语义规则）
3. 五类视觉职责与配比（Reality B-roll / Archive / MG / Minimal / Editorial Graphic）
4. 章节视觉系统（逐章主导类型 + 变化理由）
5. 禁用视觉清单
6. 与旁白节奏的配合原则（画面呼吸窗口的视觉策略）`,
  `【禁止行为】
- 不得"一句旁白 = 一个画面"逐句配图。
- 不得套用任何既有项目的视觉风格或硬编码示例样式。
- 不得输出具体 Shot 或 Scene JSON（那是下游阶段）。`,
  `【自检】输出前确认：五类职责无重叠含糊？配比有上限？逐章有变化理由？禁用清单具体？风格推导自本项目而非模板？`,
);

export const visualBreakdownPrompt: StagePrompt = {
  stage: 'visual_breakdown',
  promptVersion: 'visual-breakdown@1.0',
  outputKind: 'markdown',
  system,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['script_v2', 'narration_beat_map']),
      '请仅执行 visual_breakdown 阶段，输出 Visual Breakdown。',
    ].join('\n\n');
  },
};

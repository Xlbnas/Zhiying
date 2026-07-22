/**
 * shot_list 阶段（PHASE 8 — Shot List）。
 * 输出：镜头单元 JSON（zod 校验）。按视觉思想与节奏拆分，而非逐句配图。
 */

import {z} from 'zod';
import {
  composeSystem,
  projectVarsBlock,
  SHARED_MG_PRINCIPLES,
  SHARED_ROLE,
  SHARED_VISUAL_PRINCIPLES,
  upstreamBlock,
  type StagePrompt,
} from './shared';

export const shotVisualTypeSchema = z.enum([
  'Reality B-roll',
  'Archive',
  'MG',
  'Minimal',
  'Editorial Graphic',
]);

export const shotItemSchema = z.object({
  /** 稳定 Shot ID，如 SH001。 */
  id: z.string().min(1),
  chapter: z.number().int().positive(),
  /** 镜头功能（铺垫/转折/解释抽象关系/历史语境/停顿边界…）。 */
  purpose: z.string().min(1),
  visualType: shotVisualTypeSchema,
  durationSec: z.number().positive(),
  /** 声音空间：旁白驱动 / 画面呼吸 / 静默停顿等。 */
  audioSpace: z.string().min(1),
  /** 素材需求描述（B-roll/Archive 内容需求；MG/Minimal 可为空数组）。 */
  assetNeeds: z.array(z.string()).default([]),
  /** 转场语义（cut/hold/fade…，不绑定具体插件）。 */
  transition: z.string().min(1),
  notes: z.string().default(''),
});

export const shotListSchema = z.object({
  shots: z.array(shotItemSchema).min(1),
});

export type ShotList = z.infer<typeof shotListSchema>;

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】分镜策划。你把章节的视觉思想拆成可制作的镜头单元，按节奏而非句子拆分。`,
  SHARED_VISUAL_PRINCIPLES,
  SHARED_MG_PRINCIPLES,
  `【目标】产出 Shot List：每个 Shot 记录功能、视觉类型、时长、声音空间、素材需求和转场。`,
  `【推理与输出行为】
- 一个 Shot 承载一个视觉思想或节奏单元；严禁"一句旁白 = 一个 Shot"。
- 遵守 Visual Breakdown 的五类职责与配比；标注连续同类型/同布局，避免超过其上限。
- 时长分配服从 Narration Beat Map 的情绪与停顿设计；画面呼吸窗口安排 Minimal/无旁白 Shot。
- 素材需求写可执行的内容描述（拍什么/找什么），不写空泛形容词。`,
  `【输出契约】仅输出 JSON（不要 Markdown 代码围栏），结构：
{
  "shots": [
    {"id": "SH001", "chapter": 1, "purpose": "…", "visualType": "Reality B-roll|Archive|MG|Minimal|Editorial Graphic",
     "durationSec": 6.5, "audioSpace": "…", "assetNeeds": ["…"], "transition": "cut", "notes": "…"}
  ]
}`,
  `【禁止行为】
- 不得逐句配图；不得输出 Scene JSON / 模板参数 / 代码（那是下游阶段）。
- 不得违反 Visual Breakdown 的配比与禁用清单。
- 不得输出 JSON 以外的任何文字。`,
  `【自检】输出前确认：每个 Shot 有明确功能？类型配比合规？时长与节奏图一致？无连续同布局超标？JSON 可解析？`,
);

export const shotListPrompt: StagePrompt = {
  stage: 'shot_list',
  promptVersion: 'shot-list@1.0',
  outputKind: 'json',
  system,
  zodSchema: shotListSchema,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      upstreamBlock(input, ['visual_breakdown', 'narration_beat_map']),
      '请仅执行 shot_list 阶段，输出 Shot List JSON。',
    ].join('\n\n');
  },
};

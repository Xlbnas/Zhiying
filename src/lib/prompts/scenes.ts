/**
 * scenes 阶段（PHASE 9 — Scenes JSON）。
 * 输出：{chapterTiming, scenes[]} JSON，复用 M1 sceneSchema / chapterTimingSchema。
 *
 * 系统数据边界：AI 只负责 chapterTiming 与 scenes[]；
 * schemaVersion / templateVersion / composition / fps / width / height 是系统数据，
 * 不在输出契约内（FPS 仅作为帧换算常量经 user 告知）。
 */

import {z} from 'zod';
import {chapterTimingSchema, sceneSchema} from '../scene-schema';
import {
  composeSystem,
  projectVarsBlock,
  SHARED_MG_PRINCIPLES,
  SHARED_ROLE,
  SHARED_VISUAL_PRINCIPLES,
  upstreamBlock,
  type StagePrompt,
} from './shared';

/** AI 输出契约：只含 chapterTiming + scenes[]（系统字段由系统补齐）。 */
export const scenesAiOutputSchema = z.object({
  chapterTiming: z.array(chapterTimingSchema).min(1),
  scenes: z.array(sceneSchema).min(1),
});

export type ScenesAiOutput = z.infer<typeof scenesAiOutputSchema>;

/** 帧换算用的系统常量（M1 契约；AI 不控制，仅用于 startFrame/durationInFrames 计算）。 */
export const SCENES_SYSTEM_FPS = 30;

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】数据化剪辑。你把 Shot List 转成机器可读的 Scene 数据，供渲染链直接消费。`,
  SHARED_VISUAL_PRINCIPLES,
  SHARED_MG_PRINCIPLES,
  `【目标】产出 Scenes JSON：稳定 Scene ID、时间、章节、类型、模板、旁白摘要、画面描述、assetIds、licenseStatus、字幕位置和转场。`,
  `【推理与输出行为】
- Scene ID 稳定且连续：S001、S002 … 顺序递增，时间轴无重叠无空洞（前一场 end = 后一场 start）。
- duration 必须等于 end - start；startFrame = round(start × FPS)，durationInFrames = round(duration × FPS)。
- category ∈ {MG, B-roll, Archive, Minimal, Editorial Graphic}；visualType ∈ {MG, Asset, Archive, Minimal, UI}。
- MG Scene 必须给出 template（稳定英文模板 ID）与 sourceTemplate；非 MG 为 null。
- narrationSummary 是该 Scene 对应旁白的语义摘要，不是旁白原文。
- description 写画面职责与构成（可执行、具体），不是生成式空话。
- assetIds 指向素材 manifest 的 ID；未知素材不得编造 ID，留空数组并在 notes 说明需求。
- licenseStatus ∈ {verified, review-required, not-applicable}；不得用 unknown。
- subtitlePosition ∈ {bottom, mid, lowerThird, midLower}；transitionIn/Out 写转场语义。
- 避免连续相同布局与连续纯 MG（遵守 Visual Breakdown 上限）。`,
  `【输出契约】仅输出 JSON（不要 Markdown 代码围栏），结构：
{
  "chapterTiming": [{"chapter": 1, "title": "…", "start": 0, "end": 65.0}],
  "scenes": [{"id": "S001", "chapter": 1, "chapterTitle": "…", "start": 0, "end": 6.5, "duration": 6.5,
    "startFrame": 0, "durationInFrames": 195, "category": "…", "visualType": "…", "template": null,
    "sourceTemplate": null, "narrationSummary": "…", "description": "…", "notes": "",
    "assetIds": [], "licenseStatus": "not-applicable", "subtitlePosition": "bottom",
    "transitionIn": "none", "transitionOut": "cut"}]
}
chapterTiming 覆盖全部章节且时间连续；scenes 覆盖 0 到全片时长。`,
  `【禁止行为】
- 禁止输出 schemaVersion / templateVersion / composition / fps / width / height —— 这些是系统数据，由系统补齐。
- 禁止编造 assetIds、模板 ID 或授权状态。
- 不得改动 Shot List 的节奏与功能分配。
- 不得输出 JSON 以外的任何文字。`,
  `【自检】输出前确认：ID 连续？时间轴无重叠无空洞？帧字段与 FPS 换算一致？MG 必有 template？授权状态无 unknown？JSON 可解析？`,
);

export const scenesPrompt: StagePrompt = {
  stage: 'scenes',
  promptVersion: 'scenes@1.0',
  outputKind: 'json',
  system,
  zodSchema: scenesAiOutputSchema,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      `【系统参数（仅用于帧换算，禁止出现在输出中）】FPS = ${SCENES_SYSTEM_FPS}`,
      upstreamBlock(input, ['shot_list', 'visual_breakdown', 'script_v2']),
      '请仅执行 scenes 阶段，输出 Scenes JSON。',
    ].join('\n\n');
  },
};

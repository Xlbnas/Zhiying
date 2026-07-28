/**
 * scenes 阶段（PHASE 9 — Scenes JSON）。
 * 输出：{chapterTiming, scenes[]} JSON，复用 M1 sceneSchema / chapterTimingSchema。
 *
 * 系统数据边界：AI 只负责 chapterTiming 与 scenes[]；
 * schemaVersion / templateVersion / composition / fps / width / height 是系统数据，
 * 不在输出契约内（FPS 仅作为帧换算常量经 user 告知）。
 *
 * M5 确定性分层：AI 输出经 zod 后先过 deterministic compiler
 * （src/lib/scenes/compiler.ts）——enum alias、chapter 边界、scene 绝对时间轴、
 * chapterTitle、duration、帧字段全部由程序归一；AI 只需专注场景内容、chapter
 * 归属、category/visualType 语义、模板与时长权重。
 */

import {z} from 'zod';
import {chapterTimingSchema, sceneSchema} from '../scene-schema';
import {normalizeScenesOutput} from '../scenes/compiler';
import {describeMgTemplatesForPrompt} from '../scenes/mg-templates';
import {
  SCENES_SYSTEM_FPS,
  scenesSemanticIssues,
} from '../workflow/scenes-semantic-validation';
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
export {SCENES_SYSTEM_FPS};

const system = composeSystem(
  SHARED_ROLE,
  `【本阶段角色】数据化剪辑。你把 Shot List 转成机器可读的 Scene 数据，供渲染链直接消费。`,
  SHARED_VISUAL_PRINCIPLES,
  SHARED_MG_PRINCIPLES,
  `【目标】产出 Scenes JSON：稳定 Scene ID、时间、章节、类型、模板、旁白摘要、画面描述、assetIds、licenseStatus、字幕位置和转场。`,
  `【推理与输出行为】
- Scene ID 稳定且连续：S001、S002 … 顺序递增。
- start/end/duration 只给**估算时长权重**：系统会按 chapter 归属与时间权重
  程序化重排绝对时间轴（保证 chapter 内连续、不跨章、末场收在章末），
  你不需要、也不应该追求毫秒级自洽；但每个 Scene 必须明确归属一个 chapter，
  且给出符合叙事节奏的相对时长。
- category 必须精确取 {MG, B-roll, Archive, Minimal, Editorial Graphic} 之一；
  visualType 必须精确取 {MG, Asset, Archive, Minimal, UI} 之一（注意两套词表
  不同：上游 Shot 的 "Reality B-roll" 在 Scene 层是 category="B-roll"、
  visualType="Asset"）。
- MG Scene 的 template 与 sourceTemplate 必须**从以下 production 模板中原样选择一个**
  （按视觉意图做语义匹配；禁止自造 ID；找不到合适模板就换 category，不得乱配）：
${describeMgTemplatesForPrompt()}
  非 MG Scene 的 template/sourceTemplate 一律为 null。
- MG Scene 必须同时给出 templateProps（结构化参数，是画面文字与图形的唯一来源）：
  · MG_LayeredDiagram（分层模型如冰山）：{"title":"意识的冰山","layers":[{"label":"意识"},{"label":"前意识"},{"label":"潜意识"}],"caption":"…"}
  · MG_RelationGraph（关系/冲突图如本我自我超我）：{"title":"…","nodes":[{"id":"id","label":"本我"},{"id":"ego","label":"自我"},{"id":"superego","label":"超我"}],"edges":[{"from":"id","to":"superego","label":"冲突"}],"caption":"…"}
  · MG_Timeline（时间线）：{"title":"…","events":[{"label":"《梦的解析》出版","time":"1900"},{"label":"现代心理学评价","time":"今天"}]}
  · MG_ConceptCompare（双概念对比）：{"left":"…","right":"…","note":"…"}
  · MG_MessageFocus（单点聚焦）：{"message":"…","context":"…"}
  · MG_ScheduleNodes（清单/步骤）：{"title":"…","items":[{"label":"…"}]}
  templateProps 的文字必须与 description 表达的画面一致。
- Archive / B-roll Scene 必须给出 assetRequirements（真实素材需求，系统将据此
  获取档案/授权素材）：[{"kind":"image","subject":"画面主体（中文）","query":"检索关键词（英文优先）","usage":"primary","policy":"public_domain"}]
  policy：历史照片/手稿/古籍/建筑用 public_domain；明确需要 AI 生成的概念画面
  用 generated；禁止请求电影/电视剧/商业摄影片段（版权不可自动使用）。
- Minimal / Editorial Graphic 不需要 assetRequirements（Minimal 用排版；
  Editorial Graphic 按 MG 规则给 template + templateProps）。
- narrationSummary 是该 Scene 对应旁白的语义摘要，不是旁白原文。
- description 写画面职责与构成（可执行、具体），不是生成式空话。
- assetIds 一律留空数组（素材由系统获取后绑定，禁止编造 ID）。
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
chapterTiming 按章节顺序给出各章的**估算时长**（start/end 仅表达相对比例，
系统会重建连续边界）；scenes 按叙事顺序覆盖全部章节。`,
  `【禁止行为】
- 禁止输出 schemaVersion / templateVersion / composition / fps / width / height —— 这些是系统数据，由系统补齐。
- 禁止编造 assetIds、模板 ID 或授权状态。
- 不得改动 Shot List 的节奏与功能分配。
- 不得输出 JSON 以外的任何文字。`,
  `【自检】输出前确认：ID 连续？每个 Scene 都明确归属一个存在的 chapter？时长权重符合叙事节奏？MG 的 template/sourceTemplate 全部来自注册表 12 个 ID？授权状态无 unknown？JSON 可解析？`,
);

export const scenesPrompt: StagePrompt = {
  stage: 'scenes',
  promptVersion: 'scenes@1.3',
  outputKind: 'json',
  system,
  zodSchema: scenesAiOutputSchema,
  // M5：zod 之后的 deterministic normalize（enum alias / chapter 边界 /
  // 绝对时间轴 / 帧字段由程序归一），再进语义门禁
  normalizeOutput: normalizeScenesOutput,
  // M2-E-A：结构 zod 之后的确定性语义校验（LLM 输出与人工编辑共用）
  semanticValidate: scenesSemanticIssues,
  buildUser(input) {
    return [
      projectVarsBlock(input),
      `【系统参数（仅用于帧换算，禁止出现在输出中）】FPS = ${SCENES_SYSTEM_FPS}`,
      upstreamBlock(input, ['shot_list', 'visual_breakdown', 'script_v2']),
      '请仅执行 scenes 阶段，输出 Scenes JSON。',
    ].join('\n\n');
  },
};

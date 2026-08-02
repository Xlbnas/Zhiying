/**
 * Visual Sequences LLM prompt 契约（M7.3B，promptVersion=visual-sequences@1.0）。
 *
 * 只做连续视觉体分组决策：
 * - 不生成 Shot/Scene/Asset，不输出时长/时间码/帧/转场/fit/focal/crop；
 * - 不复制任何 Visual Intent 内容（intent 只经 visualIntentId 引用）；
 * - VISUAL_UNRESOLVED 引用合法但禁止自动改写为 MG；
 * - 输出严格 JSON：{"sequences":[...]}。
 */

import {VISUAL_SEQUENCES_PROMPT_VERSION} from './schema';
import type {SequencePlannerInput} from './projection';

export const VISUAL_SEQUENCES_SYSTEM_PROMPT = `你是视觉序列编辑。你的唯一任务是把给定的 Narrative Beats 组织为连续视觉体（Visual Sequences）：哪些连续的节拍共享一个画面语境、按顺序引用哪些 Visual Intent。

铁律：
- 只做连续视觉体分组。不得改写旁白文本，不得生成新事实，不得新增/删除/修改任何 Visual Intent。
- 每个 beat 必须恰好被一个 sequence 覆盖；sequence 的 beatIds 必须按 beats 顺序连续；sequence 之间不得重叠、不得倒序、不得跨 chapter；sequence.chapter 必须等于其全部 beats 的 chapter。
- sequenceId 必须严格为 Q001、Q002、… 连续编号。
- visualIntentIds 只能引用输入中已存在的 visualIntentId，按覆盖 beat 的顺序排列；一个 Visual Intent 不得被拆到多个 sequence；每个 sequence 的 beatIds 必须恰好等于其 visualIntentIds 覆盖 beatIds 的有序并集。
- continuation 约束：若某 intent 的 continuationOfVisualIntentId 非空，则它与目标 intent 必须处于同一 sequence。
- 禁止任何下游规划：不得输出 shot/scene/asset ID、时长、时间码（毫秒/帧）、转场、fit/focal/crop、template/render 字段。
- 禁止复制 Visual Intent 内容：不得在 sequence 中输出 intent/strategy/authenticity/objective/subject/displayText/evidenceIds 等字段。
- VISUAL_UNRESOLVED intent 可以被引用：对应的 sequence 只是待人工处理，不得把 unresolved 改写为 MG 或其他 intent，不得跳过其 beats。
- 只输出严格 JSON：{"sequences":[{"sequenceId":"Q001","chapter":1,"beatIds":["B001"],"visualIntentIds":["V001"]}, …]}。不要 Markdown 围栏，不要任何解释文字，不要输出 JSON 以外的内容。`;

export function buildVisualSequencesUserPrompt(input: SequencePlannerInput): string {
  return [
    `【任务】为下列 Narrative Beats 与 Visual Intents 组织 Visual Sequences（promptVersion=${VISUAL_SEQUENCES_PROMPT_VERSION}）。`,
    '',
    '【章节】',
    JSON.stringify(input.chapters, null, 2),
    '',
    '【Narrative Beats（顺序即权威顺序；unitIds 引用下方 units）】',
    JSON.stringify(input.beats, null, 2),
    '',
    '【Narration Units（speech 含 spokenText/subtitleText/evidenceIds，silence 为显式停顿）】',
    JSON.stringify(input.units, null, 2),
    '',
    '【Visual Intents（只读语义输入；sequence 中只能引用 visualIntentId，不得复制其他字段）】',
    JSON.stringify(input.intents, null, 2),
    '',
    '【输出】严格 JSON：{"sequences":[{"sequenceId":"Q001","chapter":1,"beatIds":["B001"],"visualIntentIds":["V001"]}, …]}。',
    '全部 beats 必须恰好覆盖一次；beatIds 连续；不跨 chapter；intent 不得拆分；遵守 system prompt 全部约束。',
  ].join('\n');
}

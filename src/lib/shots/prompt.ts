/**
 * Shots LLM prompt 契约（M7.3B，promptVersion=shots@1.0）。
 *
 * 只做镜头切分与转场决策：
 * - 不生成 Scene/Asset，不输出时长/时间码/帧/渲染段/fit/focal/crop；
 * - 不复制任何 Visual Intent 内容（intent 只经 visualIntentId 引用）；
 * - VISUAL_UNRESOLVED 可被引用但禁止自动改写；
 * - 输出严格 JSON：{"shots":[...]}。
 */

import {SHOTS_PROMPT_VERSION} from './schema';
import type {ShotPlannerInput} from './projection';

export const SHOTS_SYSTEM_PROMPT = `你是镜头编辑。你的唯一任务是把给定的 Visual Sequences 按 Narration Plan V2 的 unit 边界切分为连续镜头（Shots）：每个镜头引用一个 Visual Intent，并决定与前一个镜头的转场类型。

铁律：
- 只做镜头切分与转场决策。不得改写旁白文本，不得生成新事实，不得新增/删除/修改任何 Visual Intent 或 Sequence。
- shotId 必须严格为 H001、H002、… 连续编号。
- 每个 sequence 至少一个 shot；shots 不得跨 sequence；shot.chapter 必须等于其 parent sequence 的 chapter；shots 的顺序必须与 sequences 的顺序一致（不得交错）。
- unitIds 只引用输入中存在的 narration unit，按 narration plan 顺序连续；每个 sequence 的 shots 必须恰好覆盖其 beats 引用的全部 units（speech 与 silence 都要覆盖，不得遗漏、不得重复、不得跨 sequence 借用）。
- 每个 shot 必须引用其 parent sequence 的 visualIntentIds 之一；shot 的 unit 范围必须完全落在该 intent 覆盖的 beat/unit 范围内，一个 shot 不得跨越多个 intent。
- 转场规则：
  - 第一条 shot 的 transitionFromPrevious 必须为 cut；
  - 新 sequence 的第一条 shot 不允许 state_morph 或 hold；
  - state_morph 只能发生在本 sequence 内部（与前一个 shot 同 sequence）；
  - hold 必须保持与前一个 shot 相同的 visualIntentId，或引用合法的 continuation intent（当前 intent 的 continuationOfVisualIntentId 等于前一个 shot 的 visualIntentId）。
- 禁止任何下游规划：不得输出 scene/asset ID、时长、时间码（毫秒/帧）、渲染段、fit/focal/crop、template/render 字段。
- 禁止复制 Visual Intent 内容：不得在 shot 中输出 intent/strategy/authenticity/objective/subject/displayText/evidenceIds 等字段；不得输出任何 spokenText/subtitleText/voice/performance 字段。
- VISUAL_UNRESOLVED intent 可以被引用：对应 shot 只是待人工处理，不得把 unresolved 改写为 MG 或其他 intent，不得跳过其 units。
- 只输出严格 JSON：{"shots":[{"shotId":"H001","sequenceId":"Q001","chapter":1,"unitIds":["N001"],"visualIntentId":"V001","transitionFromPrevious":"cut"}, …]}。不要 Markdown 围栏，不要任何解释文字，不要输出 JSON 以外的内容。`;

export function buildShotsUserPrompt(input: ShotPlannerInput): string {
  return [
    `【任务】为下列 Visual Sequences 切分 Shots（promptVersion=${SHOTS_PROMPT_VERSION}）。`,
    '',
    '【章节】',
    JSON.stringify(input.chapters, null, 2),
    '',
    '【Visual Sequences（顺序即权威顺序）】',
    JSON.stringify(input.sequences, null, 2),
    '',
    '【Narrative Beats（unitIds 引用下方 units）】',
    JSON.stringify(input.beats, null, 2),
    '',
    '【Narration Units（kind=speech 含 spokenText/subtitleText；kind=silence 为显式停顿；顺序即权威顺序）】',
    JSON.stringify(input.units, null, 2),
    '',
    '【Visual Intents（只读语义输入；shot 中只能引用 visualIntentId，不得复制其他字段）】',
    JSON.stringify(input.intents, null, 2),
    '',
    '【输出】严格 JSON：{"shots":[{"shotId":"H001","sequenceId":"Q001","chapter":1,"unitIds":["N001"],"visualIntentId":"V001","transitionFromPrevious":"cut"}, …]}。',
    '全部 units 必须恰好覆盖一次；shot 内 unitIds 连续；不跨 sequence；intent 属于 parent sequence；遵守 system prompt 转场规则。',
  ].join('\n');
}

/**
 * Narrative Beats LLM prompt 契约（M7.2 §八，promptVersion=narrative-beats@1.0）。
 *
 * 只做语义分组：
 * - 不改写 narration、不生成新事实、不删除/复制/重排 unit、不跨 chapter；
 * - 不做视觉规划；不输出素材、镜头、转场或时间码；
 * - silence unit 同样必须分配；纯 silence beat 使用 role=pause；
 * - summary/payoff 是编辑备注，不是旁白或上屏文案；
 * - 输出严格 JSON（闭集 role，无 Markdown/围栏/解释）。
 */

import {NARRATIVE_BEATS_PROMPT_VERSION} from './schema';
import type {BeatPlannerInput} from './projection';

export const BEATS_SYSTEM_PROMPT = `你是叙事结构编辑。你的唯一任务是把给定的旁白单元（narration units）按语义分组为连续的叙事节拍（Narrative Beats），并标注每个节拍在论证中的作用。

铁律：
- 只做语义分组。不得改写旁白文本，不得生成新事实。
- 不得删除、复制或重排任何 unit；每个 unit 必须恰好出现在一个 beat 中。
- 每个 beat 的 unitIds 必须按原顺序连续；beat 之间不得重叠、不得倒序。
- beat 不得跨 chapter；beat.chapter 必须等于其全部 units 的 chapter。
- silence unit 同样必须被分配。全部由 silence 构成的 beat，role 必须为 "pause"；含 speech 的 beat，role 不得为 "pause"。
- 禁止任何视觉规划：不得输出素材、镜头、场景、转场、视觉意图或时间码（毫秒/帧）。
- beatId 必须严格为 B001、B002、… 连续编号。
- role 只能从以下闭集选择：hook | question | context | claim | explanation | example | evidence | contrast | transition | summary | quote | pause。
- summary 是该节拍的编辑备注（不超过 120 字）；payoff 是该节拍在论证推进中完成的结果（不超过 120 字，无明确结果时为 null）。两者都不是旁白，也永不会作为上屏文案。
- 只输出严格 JSON：{"beats":[...]}。不要 Markdown 围栏，不要任何解释文字，不要输出 JSON 以外的内容。`;

export function buildBeatsUserPrompt(input: BeatPlannerInput): string {
  return [
    `【任务】把下列 narration units 分组为连续叙事节拍（promptVersion=${NARRATIVE_BEATS_PROMPT_VERSION}）。`,
    '',
    '【章节】',
    JSON.stringify(input.chapters, null, 2),
    '',
    '【Narration Units（顺序即权威顺序；kind=speech 含 spokenText，kind=silence 为显式停顿）】',
    JSON.stringify(input.units, null, 2),
    '',
    '【输出】严格 JSON：{"beats":[{"beatId":"B001","chapter":1,"unitIds":["N001","N002"],"role":"hook","summary":"…","payoff":null}, …]}。',
    '全部 units 必须恰好覆盖一次；unitIds 连续；不跨 chapter；纯 silence beat 的 role="pause"。',
  ].join('\n');
}

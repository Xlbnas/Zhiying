import crypto from 'node:crypto';
import {
  MAX_SILENCE_MS,
  NARRATION_PLAN_V2_SCHEMA_VERSION,
  NARRATION_V2_COMPILER_VERSION,
  narrationPlanV2Schema,
  type Delivery,
  type NarrationChapterV2,
  type NarrationPlanV2,
  type NarrationReviewItem,
  type NarrationReviewKind,
  type NarrationUnitV2,
  type SpeechUnitV2,
} from './schema-v2';
import {isDirectiveBracketContent} from './leakage';
import {isSpeakableText, sanitizeSpeechText} from './speech-text';

/**
 * Narration Compiler V2（M7.1）：Script V2 → narration-plan@2.0 typed AST。
 *
 * 两种输入模式（编译结果记录 inputMode，下游只读 AST，禁止再解析原始 markdown）：
 *
 * strict（script-v2@2.0 DSL，新项目契约）：
 * - directive 必须独占一行：@pause 500ms / @silence 1200ms reason=visual_breath /
 *   @delivery slow（作用于后续 speech，直到再次声明）
 * - 正文行不得混入任何旧括号指令 / @ / --- → 发现即 hard fail（无 permissive fallback）
 * - 未知 @directive → hard fail
 *
 * legacy（script-v2@1.x locked 内容的迁移解析器，不覆盖旧 artifact）：
 * - 识别 production 真实变体：（停顿 1s）/（停顿 0.5秒）/（停顿0.5s，放缓）/（放慢）/
 *   （放缓）/（稍快）/（加重）/旁白无/停顿后旁白：/画面：/[画面留白]/---/【脚本结束】
 * - 无时长停顿 / 旁白无 / 画面留白 / 未识别疑似指令 → needsReview，绝不落入 speech
 * - --- / HTML 注释 / 【脚本结束】是明确 metadata，deterministic 剔除（非内容）
 *
 * deterministic：相同 input 永远产生相同 output（无 random/timestamp/LLM）。
 */

export type NarrationV2InputMode = 'strict' | 'legacy';

export class NarrationV2CompileError extends Error {
  constructor(
    public readonly code: 'SCRIPT_V2_INVALID' | 'NARRATION_PLAN_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'NarrationV2CompileError';
  }
}

/** 每个 speech unit 聚合的自然句数（与 v1 对齐，deterministic 常量）。 */
export const SENTENCES_PER_SPEECH_UNIT = 2;

/** script-v2@2.0 的 promptVersion 前缀（plan-v2.ts 据此选择 strict 模式）。 */
export const SCRIPT_V2_DSL_PROMPT_PREFIX = 'script-v2@2';

// ── 章标题（与 v1 同规则：Arabic + Chinese numeral）──
const CN_DIGITS: Record<string, number> = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
const CN_TENS: Record<string, number> = {十:10};
function parseChineseNumeral(raw: string): number | null {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return CN_DIGITS[s] ?? CN_TENS[s] ?? null;
  let tens = 0;
  let ones = 0;
  if (s.startsWith('十')) { tens = 10; ones = CN_DIGITS[s[1]!] ?? 0; }
  else if (s.endsWith('十')) { tens = (CN_DIGITS[s[0]!] ?? 0) * 10; }
  else if (s.includes('十')) {
    const parts = s.split('十');
    tens = (CN_DIGITS[parts[0]!] ?? 0) * 10;
    ones = CN_DIGITS[parts[1]!] ?? 0;
  } else {
    return null;
  }
  return tens + ones;
}

const CHAPTER_HEADING = /^##[　\s]+第[　\s]*([\d一二三四五六七八九十]+)[　\s]*章[　\s:：]*(.+?)[　\s]*$/;
const DECLARED_RANGE = /（\s*\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\s*）\s*$/;
const HEADING = /^#{1,6}\s+/;
const BLOCKQUOTE = /^>/;
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
const EVIDENCE_ID = /E\d+/g;
const SCRIPT_END_MARKER = /【脚本结束】/g;
const HORIZONTAL_RULE_LINE = /^\s*(?:[-*_]\s*){3,}$/;
const SENTENCE = /[^。！？；…]+[。！？；…]*/gs;

// ── DSL（strict）──
const DSL_PAUSE = /^@pause\s+(\d+(?:\.\d+)?)(ms|s|秒)$/;
const DSL_SILENCE = /^@silence\s+(\d+(?:\.\d+)?)(ms|s|秒)(?:\s+reason=(pause|visual_breath))?$/;
const DSL_DELIVERY = /^@delivery\s+(normal|slow|fast|soft|firm|emphasis)$/;

// ── legacy 指令词法 ──
const LEGACY_PAUSE_ITEM = /^停顿(?:\s*(\d+(?:\.\d+)?)\s*(毫秒|ms|s|秒))?$/;
const LEGACY_DELIVERY_ITEM: Record<string, Delivery> = {
  放慢: 'slow',
  放缓: 'slow',
  稍快: 'fast',
  加重: 'emphasis',
};
const LEGACY_NO_NARRATION = /(?:^|[。！？!?；;\s，,])旁白无(?=$|[。！？!?；;\s，,])/;
const LEGACY_NARRATION_PREFIX = /^(停顿后)?旁白[:：]\s*/;
const LEGACY_VISUAL_PREFIX = /^画面[:：]\s*/;
const LEGACY_VISUAL_BREATH = /\[画面留白]/g;
const BRACKET = /（([^（）]*)）/g;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  return (normalized.match(SENTENCE) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function groupSentences(sentences: string[], perUnit: number): string[] {
  const groups: string[] = [];
  for (let i = 0; i < sentences.length; i += perUnit) {
    groups.push(sentences.slice(i, i + perUnit).join(''));
  }
  return groups;
}

/** 解析时长为正整数 ms；非法（NaN/负数/超上限/非有限）返回 null。 */
function parseDurationMs(value: string, unit: string): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const ms = unit === 'ms' || unit === '毫秒' ? num : num * 1000;
  const rounded = Math.round(ms);
  if (!Number.isSafeInteger(rounded) || rounded < 1 || rounded > MAX_SILENCE_MS) return null;
  return rounded;
}

interface Line {
  raw: string;
  trimmed: string;
}

interface ChapterBlock {
  chapter: number;
  title: string;
  lines: Line[];
}

/** 按章切分（章外内容为 metadata：标题/blockquote/空行）。 */
function splitChapterBlocks(markdown: string): ChapterBlock[] {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  const blocks: ChapterBlock[] = [];
  let current: ChapterBlock | null = null;
  for (const rawLine of normalized.split('\n')) {
    const trimmed = rawLine.trim();
    const chapterMatch = CHAPTER_HEADING.exec(trimmed);
    if (chapterMatch) {
      const channel = parseChineseNumeral(chapterMatch[1]!);
      if (channel !== null && channel >= 1) {
        const title = chapterMatch[2]!.replace(DECLARED_RANGE, '').trim();
        if (title.length === 0) {
          throw new NarrationV2CompileError('SCRIPT_V2_INVALID', `第 ${channel} 章缺少标题`);
        }
        current = {chapter: channel, title, lines: []};
        blocks.push(current);
        continue;
      }
    }
    if (current === null) continue; // 章前 metadata 忽略
    current.lines.push({raw: rawLine, trimmed});
  }
  return blocks;
}

/** 编译器内部事件流（typed AST 的中间形态）。 */
type Event =
  | {type: 'text'; text: string}
  | {type: 'silence'; durationMs: number; reason: 'pause' | 'visual_breath'; raw: string}
  | {type: 'delivery'; delivery: Delivery; raw: string}
  | {type: 'evidence'; evidenceIds: string[]}
  | {type: 'review'; kind: NarrationReviewKind; raw: string; reason: string};

function extractEvidence(line: string): {text: string; events: Event[]} {
  const events: Event[] = [];
  const text = line.replace(HTML_COMMENT, (whole, inner: string) => {
    const ids = [...new Set(inner.match(EVIDENCE_ID) ?? [])];
    if (ids.length > 0) events.push({type: 'evidence', evidenceIds: ids});
    return ' ';
  });
  return {text, events};
}

/** strict DSL：逐行解析，未知 directive / 正文指令 → hard fail。 */
function eventsStrict(block: ChapterBlock): Event[] {
  const events: Event[] = [];
  for (const line of block.lines) {
    const t = line.trimmed;
    if (t.length === 0) {
      events.push({type: 'text', text: '\n'}); // 段落边界
      continue;
    }
    if (HEADING.test(t) || BLOCKQUOTE.test(t)) continue; // metadata
    if (HORIZONTAL_RULE_LINE.test(t)) {
      throw new NarrationV2CompileError(
        'SCRIPT_V2_INVALID',
        `script-v2@2.0 正文禁止 horizontal rule：${t.slice(0, 40)}`,
      );
    }
    if (t.startsWith('@')) {
      let m = DSL_PAUSE.exec(t);
      if (m) {
        const durationMs = parseDurationMs(m[1]!, m[2]!);
        if (durationMs === null) {
          throw new NarrationV2CompileError('SCRIPT_V2_INVALID', `@pause 时长非法：${t}`);
        }
        events.push({type: 'silence', durationMs, reason: 'pause', raw: t});
        continue;
      }
      m = DSL_SILENCE.exec(t);
      if (m) {
        const durationMs = parseDurationMs(m[1]!, m[2]!);
        if (durationMs === null) {
          throw new NarrationV2CompileError('SCRIPT_V2_INVALID', `@silence 时长非法：${t}`);
        }
        events.push({
          type: 'silence',
          durationMs,
          reason: (m[3] as 'pause' | 'visual_breath' | undefined) ?? 'pause',
          raw: t,
        });
        continue;
      }
      m = DSL_DELIVERY.exec(t);
      if (m) {
        events.push({type: 'delivery', delivery: m[1] as Delivery, raw: t});
        continue;
      }
      throw new NarrationV2CompileError(
        'SCRIPT_V2_INVALID',
        `未知 @directive（闭集 grammar 只允许 @pause/@silence/@delivery）：${t.slice(0, 60)}`,
      );
    }
    // 正文行：evidence 注释抽取后不得残留任何指令语法位
    const {text, events: ev} = extractEvidence(t);
    events.push(...ev);
    const cleaned = text.trim();
    if (cleaned.length === 0) continue;
    if (isSpeakableText(cleaned) === false && cleaned.replace(SCRIPT_END_MARKER, '').trim().length === 0) {
      continue; // 纯标记行
    }
    const leak = cleaned.replace(SCRIPT_END_MARKER, ' ');
    const bracketLeak = ((): string | null => {
      BRACKET.lastIndex = 0;
      let bm: RegExpExecArray | null;
      while ((bm = BRACKET.exec(leak)) !== null) {
        if (isDirectiveBracketContent(bm[1]!)) return bm[0];
      }
      return null;
    })();
    if (bracketLeak !== null) {
      throw new NarrationV2CompileError(
        'SCRIPT_V2_INVALID',
        `script-v2@2.0 正文禁止混入旧括号指令：${bracketLeak}（请改用独占行 @directive）`,
      );
    }
    if (LEGACY_NARRATION_PREFIX.test(leak) || LEGACY_VISUAL_PREFIX.test(leak) ||
        LEGACY_NO_NARRATION.test(leak) || LEGACY_VISUAL_BREATH.test(leak)) {
      throw new NarrationV2CompileError(
        'SCRIPT_V2_INVALID',
        `script-v2@2.0 正文禁止混入导演指令：${cleaned.slice(0, 60)}`,
      );
    }
    events.push({type: 'text', text: leak.replace(SCRIPT_END_MARKER, ' ')});
  }
  return events;
}

/** legacy（script-v2@1.x）：识别全部 production 真实变体；未识别疑似指令 → needsReview。 */
function eventsLegacy(block: ChapterBlock): Event[] {
  const events: Event[] = [];
  const push = (e: Event): void => {
    events.push(e);
  };
  for (const line of block.lines) {
    let t = line.trimmed;
    if (t.length === 0) {
      push({type: 'text', text: '\n'});
      continue;
    }
    if (HEADING.test(t) || BLOCKQUOTE.test(t)) continue;
    // 明确 metadata：【脚本结束】与整行 ---（deterministic 剔除，非内容）
    t = t.replace(SCRIPT_END_MARKER, ' ');
    if (HORIZONTAL_RULE_LINE.test(t)) continue;
    const {text: noComment, events: ev} = extractEvidence(t);
    events.push(...ev);
    t = noComment.trim();
    if (t.length === 0) continue;

    // @ 开头：legacy 内容不应出现 DSL → 疑似指令进 review，绝不进 speech
    if (t.startsWith('@')) {
      push({type: 'review', kind: 'unknown_directive', raw: t, reason: 'legacy 内容出现未识别 @directive'});
      continue;
    }

    // 画面：前缀 → 视觉指令（非权威 hint，无时长语义）→ review，不进 speech
    const visualMatch = LEGACY_VISUAL_PREFIX.exec(t);
    if (visualMatch) {
      push({type: 'review', kind: 'visual_directive', raw: t, reason: '画面：视觉指令需人工归入 Visual Intent（M7.2+）'});
      continue;
    }

    // [画面留白] → 无时长 visual_breath → review
    LEGACY_VISUAL_BREATH.lastIndex = 0;
    if (LEGACY_VISUAL_BREATH.test(t)) {
      push({type: 'review', kind: 'visual_breath_without_duration', raw: t, reason: '[画面留白] 未声明时长（v2 silence 必须显式 durationMs）'});
      t = t.replace(LEGACY_VISUAL_BREATH, ' ').trim();
      if (t.length === 0) continue;
    }

    // 停顿后旁白：/ 旁白：前缀 → 前缀是指令（停顿无时长 → review），余文进 speech
    const narrationMatch = LEGACY_NARRATION_PREFIX.exec(t);
    if (narrationMatch) {
      if (narrationMatch[1]) {
        push({type: 'review', kind: 'pause_without_duration', raw: narrationMatch[0], reason: '「停顿后旁白：」的停顿未声明时长'});
      }
      t = t.slice(narrationMatch[0].length).trim();
      if (t.length === 0) continue;
    }

    // 旁白无 token → 无明确时长的「无旁白」→ review（冻结 1.1：hard stop/needsReview）
    if (LEGACY_NO_NARRATION.test(t)) {
      push({type: 'review', kind: 'no_narration_without_duration', raw: t, reason: '「旁白无」未声明时长，需人工指定 silence durationMs'});
      t = t.replace(/旁白无/g, ' ').replace(/[，,。\s]+$/, '').trim();
      if (t.length === 0) continue;
    }

    // 括号指令 tokenize：已知指令 → silence/delivery；疑似未知指令 → review；普通括号 → 文本
    let cursor = 0;
    let textRun = '';
    let lineHasText = false;
    const flushText = (): void => {
      const cleaned = textRun.trim();
      textRun = '';
      if (cleaned.length > 0) {
        push({type: 'text', text: cleaned});
        lineHasText = true;
      }
    };
    BRACKET.lastIndex = 0;
    let bm: RegExpExecArray | null;
    while ((bm = BRACKET.exec(t)) !== null) {
      const content = bm[1]!.trim();
      const recognized = isDirectiveBracketContent(content);
      // 句首位置（本行尚未产出任何正文）的未知括号按疑似指令处理：
      // fail-closed 进 needsReview，绝不落入 speech；句中普通括号（如（即潜意识））保留为文本
      const leading =
        !lineHasText && textRun.trim().length === 0 && t.slice(cursor, bm.index).trim().length === 0;
      if (!recognized && !leading) continue;
      flushText();
      textRun += t.slice(cursor, bm.index);
      flushText();
      cursor = bm.index + bm[0].length;
      if (!recognized) {
        push({
          type: 'review',
          kind: 'unknown_directive',
          raw: bm[0],
          reason: '未识别的句首括号（疑似导演指令），需人工确认后归类',
        });
        continue;
      }
      // 复合指令按 ，、, 拆分逐项分类
      const items = content.split(/[，、,]/).map((s) => s.trim()).filter((s) => s.length > 0);
      for (const item of items) {
        const pauseMatch = LEGACY_PAUSE_ITEM.exec(item);
        if (pauseMatch) {
          if (pauseMatch[1] === undefined) {
            push({type: 'review', kind: 'pause_without_duration', raw: bm[0], reason: '（停顿）未声明时长'});
          } else {
            const durationMs = parseDurationMs(pauseMatch[1], pauseMatch[2]!);
            if (durationMs === null) {
              push({type: 'review', kind: 'invalid_directive', raw: bm[0], reason: `停顿时长非法：${item}`});
            } else {
              push({type: 'silence', durationMs, reason: 'pause', raw: bm[0]});
            }
          }
          continue;
        }
        const delivery = LEGACY_DELIVERY_ITEM[item];
        if (delivery) {
          push({type: 'delivery', delivery, raw: bm[0]});
          continue;
        }
        // grammar 内但未知项（如「等待答案的悬念」）或不合 grammar 的疑似指令
        push({type: 'review', kind: 'unknown_directive', raw: bm[0], reason: `未识别的疑似指令项：${item}`});
      }
    }
    textRun += t.slice(cursor);
    flushText();
  }
  return events;
}

/** 事件流 → typed units + needsReview（delivery 状态机 + 句聚合 + evidence 归属）。 */
function buildUnits(
  events: Event[],
  chapterOf: (eventIndex: number) => number,
): {units: NarrationUnitV2[]; needsReview: NarrationReviewItem[]} {
  const units: NarrationUnitV2[] = [];
  const needsReview: NarrationReviewItem[] = [];
  let nextUnit = 1;
  let nextReview = 1;
  let delivery: Delivery = 'normal';
  let pendingLeadingEvidence: string[] = [];
  const chapterSpeeches: SpeechUnitV2[] = [];
  let currentChapter = 1;

  const makeUnitId = (): string => `N${String(nextUnit++).padStart(3, '0')}`;
  const makeReviewId = (): string => `R${String(nextReview++).padStart(3, '0')}`;

  const emitSpeechRun = (runText: string): void => {
    const sentences = splitSentences(runText)
      .filter(isSpeakableText)
      .map(sanitizeSpeechText)
      .filter((s) => s.length > 0);
    if (sentences.length === 0) return;
    const groups = groupSentences(sentences, SENTENCES_PER_SPEECH_UNIT);
    groups.forEach((text, index) => {
      const unit: SpeechUnitV2 = {
        id: makeUnitId(),
        kind: 'speech',
        chapter: currentChapter,
        spokenText: text,
        subtitleText: text, // M7.1：默认字幕=口播；null 由后续编辑/更细编译产生
        delivery,
        evidenceIds: index === 0 ? [...new Set(pendingLeadingEvidence)] : [],
        sourceText: runText,
      };
      if (index === 0) pendingLeadingEvidence = [];
      units.push(unit);
      chapterSpeeches.push(unit);
    });
  };

  let textBuffer: string[] = [];
  events.forEach((event, index) => {
    currentChapter = chapterOf(index);
    if (event.type === 'text') {
      if (event.text === '\n') {
        emitSpeechRun(textBuffer.join(' '));
        textBuffer = [];
        // paragraph 边界：未消费的 leading evidence 丢弃（绝不跨段/跨章偷挂，同 v1 语义）
        pendingLeadingEvidence = [];
      } else {
        textBuffer.push(event.text);
      }
      return;
    }
    emitSpeechRun(textBuffer.join(' '));
    textBuffer = [];
    if (event.type === 'silence') {
      units.push({
        id: makeUnitId(),
        kind: 'silence',
        chapter: currentChapter,
        durationMs: event.durationMs,
        reason: event.reason,
        sourceText: event.raw,
      });
      return;
    }
    if (event.type === 'delivery') {
      delivery = event.delivery;
      return;
    }
    if (event.type === 'evidence') {
      const lastSpeech = chapterSpeeches[chapterSpeeches.length - 1];
      if (lastSpeech && lastSpeech.chapter === currentChapter) {
        lastSpeech.evidenceIds = [...new Set([...lastSpeech.evidenceIds, ...event.evidenceIds])];
      } else {
        pendingLeadingEvidence = [...new Set([...pendingLeadingEvidence, ...event.evidenceIds])];
      }
      return;
    }
    // review
    needsReview.push({
      id: makeReviewId(),
      kind: event.kind,
      chapter: currentChapter,
      raw: event.raw,
      context: `事件 #${index + 1}（第 ${currentChapter} 章）`,
      reason: event.reason,
    });
  });
  emitSpeechRun(textBuffer.join(' '));

  return {units, needsReview};
}

/** 编译：Script V2 Markdown → NarrationPlanV2（经 zod 完整校验）。 */
export function compileNarrationPlanV2(input: {
  scriptV2Markdown: string;
  scriptV2VersionId: string;
  scriptV2Version: number;
  scriptV2PromptVersion: string | null;
  inputMode: NarrationV2InputMode;
}): NarrationPlanV2 {
  const blocks = splitChapterBlocks(input.scriptV2Markdown);
  if (blocks.length === 0) {
    throw new NarrationV2CompileError(
      'SCRIPT_V2_INVALID',
      '没有识别到脚本章节，请检查脚本定稿中的章节标题。',
    );
  }

  // 逐章生成事件流，并记录每个事件的章归属
  const allEvents: Event[] = [];
  const eventChapter: number[] = [];
  const chapters: NarrationChapterV2[] = [];
  for (const block of blocks) {
    const events = input.inputMode === 'strict' ? eventsStrict(block) : eventsLegacy(block);
    for (const event of events) {
      allEvents.push(event);
      eventChapter.push(block.chapter);
    }
    chapters.push({chapter: block.chapter, title: block.title, firstUnitId: null, lastUnitId: null});
  }
  const chapterOf = (index: number): number => eventChapter[index]!;

  const {units, needsReview} = buildUnits(allEvents, chapterOf);
  if (units.length === 0) {
    throw new NarrationV2CompileError('SCRIPT_V2_INVALID', '脚本未产生任何 narration unit');
  }

  for (const chapter of chapters) {
    const ids = units.filter((u) => u.chapter === chapter.chapter).map((u) => u.id);
    chapter.firstUnitId = ids[0] ?? null;
    chapter.lastUnitId = ids[ids.length - 1] ?? null;
  }

  const contentHash = `sha256:${crypto.createHash('sha256').update(input.scriptV2Markdown, 'utf8').digest('hex')}`;
  const candidate = {
    schemaVersion: NARRATION_PLAN_V2_SCHEMA_VERSION,
    compilerVersion: NARRATION_V2_COMPILER_VERSION,
    inputMode: input.inputMode,
    source: {
      scriptV2VersionId: input.scriptV2VersionId,
      scriptV2Version: input.scriptV2Version,
      scriptV2PromptVersion: input.scriptV2PromptVersion,
      scriptV2ContentHash: contentHash,
    },
    chapters,
    units,
    needsReview,
  };
  const parsed = narrationPlanV2Schema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new NarrationV2CompileError(
      'NARRATION_PLAN_INVALID',
      `编译结果未通过契约校验：${first?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

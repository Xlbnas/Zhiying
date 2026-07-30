import {
  NARRATION_COMPILER_VERSION,
  NARRATION_PLAN_SCHEMA_VERSION,
  narrationPlanSchema,
  type NarrationChapter,
  type NarrationPlan,
  type NarrationUnit,
} from './schema';
import {isSpeakableText, sanitizeSpeechText} from './speech-text';

/**
 * Narration Compiler（M3-A）：Script V2 Markdown → Narration Plan。
 *
 * deterministic：相同 input 永远产生相同 output（无 random / timestamp / LLM）。
 * 以 script-v2@1.0 输出契约为准：
 * - `# Script V2` / `> 差异说明` → metadata，不朗读
 * - `## 第 N 章 标题（mm:ss–mm:ss）` → chapter（mm:ss 只是脚本估计，不作 timing）
 * - `（停顿 1s）` / `（停顿 0.5s）` / `（停顿）` → pause unit
 * - `（放慢）` / `（加重）` / `（稍快）` → prosody unit
 * - `[画面留白]` → visual_breath unit
 * - `<!-- E01 E03 -->` → evidenceIds（剥离，不朗读）
 * - 其余段落文本 → speech unit（每 2 个自然句一单元，规则固定）
 */

export class NarrationCompileError extends Error {
  constructor(
    public readonly code: 'SCRIPT_V2_INVALID' | 'NARRATION_PLAN_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'NarrationCompileError';
  }
}

/** 每个 speech unit 聚合的自然句数（deterministic 常量，测试锁定）。 */
export const SENTENCES_PER_SPEECH_UNIT = 2;

// ── Chinese numeral → integer（支持「一」到「九十九」）──
const CN_DIGITS: Record<string, number> = {一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
const CN_TENS: Record<string, number> = {十:10};
function parseChineseNumeral(raw: string): number | null {
  const s = raw.trim();
  // 纯 Arabic digit: "12"
  if (/^\d+$/.test(s)) return Number(s);
  // 单个中文数字: "一" → 1, "十" → 10
  if (s.length === 1) return CN_DIGITS[s] ?? CN_TENS[s] ?? null;
  // "十二" → 12, "二十" → 20, "二十一" → 21
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

/** 章标题识别。支持 Arabic + Chinese numeral：
 *   - `## 第1章 标题` / `## 第 1 章 标题` / `## 第1章：标题` / `## 第1章标题`
 *   - `## 第一章 标题` / `## 第一章：标题` / `## 第十二章 标题`
 *   - `## 第一章　标题`（全角空格 U+3000）
 *   - `## 第一章 明明有害，却无法停止（0:00—0:45）`
 *   章号必须是正整数（Arabic 1–99 或 Chinese 一–九十九）。
 */
const CHAPTER_HEADING = /^##[\u3000\s]+第[\u3000\s]*([\d一二三四五六七八九十]+)[\u3000\s]*章[\u3000\s:：]*(.+?)[\u3000\s]*$/;

/** 系统内部 HTML 注释 marker（非用户内容，生成 pipeline 遗留）。 */
const INTERNAL_COMMENT = /<!--\s*(?:none|E\d+(?:\s*,\s*E\d+)*)\s*-->/gi;
/** 正式声明时间区间（（mm:ss–mm:ss），兼容 – — - 三种破折号）；其他括号标题文本一律保留。 */
const DECLARED_RANGE = /（\s*\d{1,2}:\d{2}\s*[–—-]\s*\d{1,2}:\d{2}\s*）\s*$/;
const HEADING = /^#{1,6}\s+/;
const BLOCKQUOTE = /^>/;
const EVIDENCE_COMMENT = /<!--([\s\S]*?)-->/g;
const EVIDENCE_ID = /E\d+/g;
const PAUSE_WITH_SECONDS = /（停顿\s*(\d+(?:\.\d+)?)\s*s）/g;
const PAUSE_PLAIN = /（停顿）/g;
const PROSODY = /（(放慢|加重|稍快)）/g;
const VISUAL_BREATH = /\[画面留白]/g;
const SENTENCE = /[^。！？；…]+[。！？；…]*/gs;

interface InlineToken {
  type: 'text' | 'pause' | 'prosody' | 'visual_breath' | 'evidence';
  raw: string;
  text?: string;
  pauseMs?: number | null;
  directive?: string;
  evidenceIds?: string[];
}

interface ParsedParagraph {
  chapter: number;
  sourceText: string;
  tokens: InlineToken[];
}

/** 把段落切分为 text-run 与 directive/evidence token（保持原始顺序）。 */
function tokenizeParagraph(chapter: number, sourceText: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // 统一扫描四类标记，按出现位置排序
  const markers: Array<{index: number; length: number; token: InlineToken}> = [];
  const collect = (regex: RegExp, make: (m: RegExpExecArray) => InlineToken): void => {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(sourceText)) !== null) {
      markers.push({index: m.index, length: m[0].length, token: make(m)});
    }
  };
  collect(EVIDENCE_COMMENT, (m) => {
    const ids = [...new Set(m[1]!.match(EVIDENCE_ID) ?? [])];
    return {type: 'evidence', raw: m[0], evidenceIds: ids};
  });
  collect(PAUSE_WITH_SECONDS, (m) => ({
    type: 'pause',
    raw: m[0],
    pauseMs: Math.round(Number(m[1]) * 1000),
  }));
  collect(PAUSE_PLAIN, (m) => ({type: 'pause', raw: m[0], pauseMs: null, directive: '停顿'}));
  collect(PROSODY, (m) => ({type: 'prosody', raw: m[0], directive: m[1]}));
  collect(VISUAL_BREATH, (m) => ({type: 'visual_breath', raw: m[0]}));

  markers.sort((a, b) => a.index - b.index || b.length - a.length);

  let cursor = 0;
  for (const marker of markers) {
    if (marker.index > cursor) {
      tokens.push({
        type: 'text',
        raw: sourceText.slice(cursor, marker.index),
        text: sourceText.slice(cursor, marker.index),
      });
    }
    tokens.push(marker.token);
    cursor = marker.index + marker.length;
  }
  if (cursor < sourceText.length) {
    tokens.push({type: 'text', raw: sourceText.slice(cursor), text: sourceText.slice(cursor)});
  }
  void chapter;
  return tokens;
}

/** 段落级文本归一：换行并空格、折叠空白。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 自然句切分（保留终止标点；deterministic）。 */
function splitSentences(text: string): string[] {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  return (normalized.match(SENTENCE) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** 按固定句数聚合 speech units（超出部分独立成组，不跨 text-run 合并）。 */
function groupSentences(sentences: string[], perUnit: number): string[] {
  const groups: string[] = [];
  for (let i = 0; i < sentences.length; i += perUnit) {
    groups.push(sentences.slice(i, i + perUnit).join(''));
  }
  return groups;
}

function parseScript(markdown: string): {chapters: NarrationChapter[]; paragraphs: ParsedParagraph[]} {
  // CRLF → LF 归一化；trim BOM（\uFEFF）
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const chapters: NarrationChapter[] = [];
  const paragraphs: ParsedParagraph[] = [];
  let currentChapter: number | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text.length === 0 || currentChapter === null) return;
    paragraphs.push({
      chapter: currentChapter,
      sourceText: text,
      tokens: tokenizeParagraph(currentChapter, text),
    });
  };

  for (const line of normalized.split('\n')) {
    // M6.2: 正文剥离系统内部 HTML 注释（<!-- none --> / <!-- E01, E03 -->）
    const trimmed = line.replace(INTERNAL_COMMENT, '').trim();
    if (trimmed.length === 0) {
      // 真空行 → 段落边界（flush）；注释独占行 → 保留原文进 buffer（不断段）
      if (line.trim().length === 0) { flush(); continue; }
      buffer.push(line);
      continue;
    }
    const chapterMatch = CHAPTER_HEADING.exec(trimmed);
    if (chapterMatch) {
      flush();
      const channelRaw = chapterMatch[1]!;
      const channel = parseChineseNumeral(channelRaw);
      if (channel === null || channel < 1) continue; // 非章号 → 跳过
      // 标题仅剥离正式声明时间区间（mm:ss–mm:ss）；
      // 「记忆（上）」「问题（第二部分）」等合法括号标题文本原样保留
      const title = chapterMatch[2]!.replace(DECLARED_RANGE, '').trim();
      if (title.length === 0) {
        throw new NarrationCompileError('SCRIPT_V2_INVALID', `第 ${channel} 章缺少标题`);
      }
      chapters.push({chapter: channel, title, firstUnitId: null, lastUnitId: null});
      currentChapter = channel;
      continue;
    }
    if (HEADING.test(trimmed) || BLOCKQUOTE.test(trimmed)) {
      // 其它标题（# / ### …）与 blockquote 差异说明均为 metadata
      flush();
      continue;
    }
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return {chapters, paragraphs};
}

/**
 * 编译：Script V2 Markdown → NarrationPlan（经 zod 完整校验）。
 * sourceVersion 为 script_v2.locked_version（immutable snapshot）。
 */
export function compileNarrationPlan(input: {
  scriptV2Markdown: string;
  scriptV2Version: number;
  promptVersion: string | null;
}): NarrationPlan {
  const {chapters, paragraphs} = parseScript(input.scriptV2Markdown);
  if (chapters.length === 0) {
    throw new NarrationCompileError(
      'SCRIPT_V2_INVALID',
      '没有识别到脚本章节，请检查脚本定稿中的章节标题。',
    );
  }

  const units: NarrationUnit[] = [];
  let nextId = 1;
  const makeId = (): string => `N${String(nextId++).padStart(3, '0')}`;

  for (const paragraph of paragraphs) {
    // Evidence 绑定状态机（M3-A Hardening）：严格 paragraph 边界——
    // trailing Evidence → 本段最近的 speech unit；
    // leading Evidence → 本段下一个 speech unit；
    // 段内无 speech 的 Evidence 直接丢弃，绝不跨 paragraph 偷挂。
    const paragraphSpeeches: NarrationUnit[] = [];
    let pendingLeading: string[] = [];

    const emitSpeechRun = (runText: string): void => {
      // M6.3.1.3：先剔除不可朗读句（Markdown horizontal rule / 纯标点段），
      // 再 sanitize 保留句（剥离混入句首的分隔符 run）——段内 `---` 只剔除
      // 分隔符本身，不误伤同段合法句子。
      const sentences = splitSentences(runText)
        .filter(isSpeakableText)
        .map(sanitizeSpeechText);
      if (sentences.length === 0) return;
      const groups = groupSentences(sentences, SENTENCES_PER_SPEECH_UNIT);
      groups.forEach((text, index) => {
        const unit: NarrationUnit = {
          id: makeId(),
          chapter: paragraph.chapter,
          kind: 'speech',
          text,
          directive: null,
          pauseMs: null,
          // leading Evidence 归属本段下一个（本 run 首个）speech unit（deterministic）
          evidenceIds: index === 0 ? [...new Set(pendingLeading)] : [],
          sourceText: paragraph.sourceText,
        };
        if (index === 0) pendingLeading = [];
        units.push(unit);
        paragraphSpeeches.push(unit);
      });
    };

    for (const token of paragraph.tokens) {
      if (token.type === 'text') {
        emitSpeechRun(token.text ?? '');
        continue;
      }
      if (token.type === 'evidence') {
        const ids = token.evidenceIds ?? [];
        if (ids.length === 0) continue;
        const lastSpeech = paragraphSpeeches[paragraphSpeeches.length - 1];
        if (lastSpeech) {
          // trailing Evidence：归属本段最近的 speech unit
          lastSpeech.evidenceIds = [...new Set([...lastSpeech.evidenceIds, ...ids])];
        } else {
          // leading Evidence：挂起，待本段下一个 speech unit
          pendingLeading = [...new Set([...pendingLeading, ...ids])];
        }
        continue;
      }
      if (token.type === 'pause') {
        units.push({
          id: makeId(),
          chapter: paragraph.chapter,
          kind: 'pause',
          text: null,
          directive: token.directive ?? null,
          pauseMs: token.pauseMs ?? null,
          evidenceIds: [],
          sourceText: paragraph.sourceText,
        });
        continue;
      }
      if (token.type === 'prosody') {
        units.push({
          id: makeId(),
          chapter: paragraph.chapter,
          kind: 'prosody',
          text: null,
          directive: token.directive ?? null,
          pauseMs: null,
          evidenceIds: [],
          sourceText: paragraph.sourceText,
        });
        continue;
      }
      units.push({
        id: makeId(),
        chapter: paragraph.chapter,
        kind: 'visual_breath',
        text: null,
        directive: null,
        pauseMs: null,
        evidenceIds: [],
        sourceText: paragraph.sourceText,
      });
    }
    // 段尾仍挂起的 leading Evidence：本段无后续 speech → 丢弃（不跨 paragraph）
  }

  // 章 firstUnitId / lastUnitId
  for (const chapter of chapters) {
    const ids = units.filter((u) => u.chapter === chapter.chapter).map((u) => u.id);
    chapter.firstUnitId = ids[0] ?? null;
    chapter.lastUnitId = ids[ids.length - 1] ?? null;
  }

  const candidate = {
    schemaVersion: NARRATION_PLAN_SCHEMA_VERSION,
    compilerVersion: NARRATION_COMPILER_VERSION,
    source: {
      stage: 'script_v2' as const,
      version: input.scriptV2Version,
      promptVersion: input.promptVersion,
    },
    chapters,
    units,
  };
  const parsed = narrationPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new NarrationCompileError(
      'NARRATION_PLAN_INVALID',
      `编译结果未通过契约校验：${first?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

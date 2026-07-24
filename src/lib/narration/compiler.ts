import {
  NARRATION_COMPILER_VERSION,
  NARRATION_PLAN_SCHEMA_VERSION,
  narrationPlanSchema,
  type NarrationChapter,
  type NarrationPlan,
  type NarrationUnit,
} from './schema';

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

const CHAPTER_HEADING = /^##\s+第\s*(\d+)\s*章\s*(.+?)\s*$/;
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

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    const chapterMatch = CHAPTER_HEADING.exec(trimmed);
    if (chapterMatch) {
      flush();
      const chapter = Number(chapterMatch[1]);
      // 标题剥离尾部（mm:ss–mm:ss）声明区间（只是脚本估计，不作 timing）
      const title = chapterMatch[2]!.replace(/（[^（）]*）\s*$/, '').trim();
      if (title.length === 0) {
        throw new NarrationCompileError('SCRIPT_V2_INVALID', `第 ${chapter} 章缺少标题`);
      }
      chapters.push({chapter, title, firstUnitId: null, lastUnitId: null});
      currentChapter = chapter;
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
      'Script V2 不含任何 `## 第 N 章 标题` 章节标记',
    );
  }

  const units: NarrationUnit[] = [];
  let nextId = 1;
  const makeId = (): string => `N${String(nextId++).padStart(3, '0')}`;

  for (const paragraph of paragraphs) {
    // 按 text-run 聚合：每段 text-run 独立切句成组；evidence 归属所在 text-run
    let pendingEvidence: string[] = [];
    const emitSpeechRun = (runText: string, evidenceIds: string[]): void => {
      const sentences = splitSentences(runText);
      if (sentences.length === 0) return;
      const groups = groupSentences(sentences, SENTENCES_PER_SPEECH_UNIT);
      groups.forEach((text, index) => {
        units.push({
          id: makeId(),
          chapter: paragraph.chapter,
          kind: 'speech',
          text,
          directive: null,
          pauseMs: null,
          // evidence 归属该 run 的首个 speech unit（deterministic）
          evidenceIds: index === 0 ? evidenceIds : [],
          sourceText: paragraph.sourceText,
        });
      });
    };

    for (const token of paragraph.tokens) {
      if (token.type === 'text') {
        emitSpeechRun(token.text ?? '', pendingEvidence);
        pendingEvidence = [];
        continue;
      }
      if (token.type === 'evidence') {
        // 并入后续 text-run（若其后没有 speech，则归属同段最后一个 speech unit）
        pendingEvidence = [...pendingEvidence, ...(token.evidenceIds ?? [])];
        if (pendingEvidence.length > 0) {
          const lastSpeech = [...units].reverse().find((u) => u.kind === 'speech' && u.chapter === paragraph.chapter);
          if (lastSpeech) {
            lastSpeech.evidenceIds = [...new Set([...lastSpeech.evidenceIds, ...pendingEvidence])];
            pendingEvidence = [];
          }
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
    // 段落末尾仍挂起的 evidence：归入该段最后一个 speech unit
    if (pendingEvidence.length > 0) {
      const lastSpeech = [...units].reverse().find((u) => u.kind === 'speech' && u.chapter === paragraph.chapter);
      if (lastSpeech) {
        lastSpeech.evidenceIds = [...new Set([...lastSpeech.evidenceIds, ...pendingEvidence])];
      }
    }
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

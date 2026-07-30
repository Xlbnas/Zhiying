/**
 * Directive Leakage 统一内容校验器（M7.1）。
 *
 * 定位：compiler v2 / TTS enqueue / subtitle compile 共用的导演指令泄漏防线。
 * 只识别「指令语法位」，绝不使用简单 includes('停顿')：
 * - 独立 token（旁白无、[画面留白]、【脚本结束】）
 * - 行首/句首 directive prefix（旁白：/ 停顿后旁白：/ 画面：）
 * - 括号 directive grammar（（停顿 0.5s，放缓）/（放慢）/未知括号指令）
 * - metadata marker（HTML 注释、独立 horizontal rule、@directive）
 *
 * 正常语义不误杀：「谈话中出现了短暂停顿。」「制造悬念」等不含指令语法位的
 * 文本必须判定为干净（测试锁定）。
 */

export type LeakageKind =
  | 'bracket_directive'
  | 'narration_prefix'
  | 'no_narration'
  | 'visual_prefix'
  | 'visual_breath_marker'
  | 'horizontal_rule'
  | 'html_comment'
  | 'script_end_marker'
  | 'at_directive';

export interface LeakageMatch {
  kind: LeakageKind;
  match: string;
  index: number;
}

/** 指令关键词（只用于判定括号内容/前缀位置，不用于全文扫描）。 */
const DIRECTIVE_WORD = /停顿|放慢|放缓|稍快|加重|悬念|旁白|画面/;

/**
 * 括号 directive grammar：括号内容完全由指令词、时长、连接符、空白组成。
 * 允许：停顿/放慢/放缓/稍快/加重/等待/悬念/旁白（无）/画面/后/的 + 数字 + . + s/ms/秒/毫秒
 * + ，、,:：/空白。长度上限防误吞正常长括号。
 */
const DIRECTIVE_BRACKET_GRAMMAR =
  /^(?:停顿|放慢|放缓|稍快|加重|等待|悬念|旁白无|旁白|画面|后|的|\d+(?:\.\d+)?|ms|s|秒|毫秒|[，、,:：\s])+$/;

const BRACKET = /（([^（）]*)）/g;
const NARRATION_PREFIX = /(?:^|[。！？!?；;\s])(?:停顿后)?旁白[:：]/g;
const NO_NARRATION = /(?:^|[。！？!?；;\s，,])旁白无(?=$|[。！？!?；;\s，,])/g;
const VISUAL_PREFIX = /(?:^|[。！？!?；;\s])画面[:：]/g;
const VISUAL_BREATH = /\[画面留白]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPT_END = /【脚本结束】/g;
const AT_DIRECTIVE = /(?:^|\s)@[A-Za-z][A-Za-z_-]*/gm;
const HORIZONTAL_RULE_LINE = /^\s*(?:[-*_]\s*){3,}$/;

/** 括号内容是否属于指令（grammar 匹配）或疑似指令（含指令词但不合 grammar）。 */
export function isDirectiveBracketContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  if (!DIRECTIVE_WORD.test(trimmed)) return false;
  if (DIRECTIVE_BRACKET_GRAMMAR.test(trimmed)) return true;
  // 含指令词但不合 grammar（如「（停顿，让观众消化）」）——仍属指令位泄漏
  return true;
}

/** 扫描文本中的全部指令泄漏（deterministic，按出现位置排序）。 */
export function findDirectiveLeakage(text: string): LeakageMatch[] {
  const matches: LeakageMatch[] = [];
  const collect = (regex: RegExp, kind: LeakageKind, group = 0): void => {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const matched = m[group]!;
      matches.push({kind, match: matched, index: m.index + m[0].indexOf(matched)});
    }
  };

  BRACKET.lastIndex = 0;
  let bm: RegExpExecArray | null;
  while ((bm = BRACKET.exec(text)) !== null) {
    if (isDirectiveBracketContent(bm[1]!)) {
      matches.push({kind: 'bracket_directive', match: bm[0], index: bm.index});
    }
  }

  collect(NARRATION_PREFIX, 'narration_prefix');
  collect(NO_NARRATION, 'no_narration');
  collect(VISUAL_PREFIX, 'visual_prefix');
  collect(VISUAL_BREATH, 'visual_breath_marker');
  collect(HTML_COMMENT, 'html_comment');
  collect(SCRIPT_END, 'script_end_marker');
  collect(AT_DIRECTIVE, 'at_directive');

  text.split('\n').forEach((line) => {
    if (HORIZONTAL_RULE_LINE.test(line) && line.trim().length > 0) {
      matches.push({kind: 'horizontal_rule', match: line.trim(), index: text.indexOf(line)});
    }
  });

  return matches.sort((a, b) => a.index - b.index);
}

export function hasDirectiveLeakage(text: string): boolean {
  return findDirectiveLeakage(text).length > 0;
}

/** 供 schema/consumer 使用的简短描述（不泄露全文，只列 kind + 原文片段）。 */
export function describeLeakage(matches: LeakageMatch[]): string {
  return matches
    .slice(0, 5)
    .map((m) => `${m.kind}(${m.match.slice(0, 30)})`)
    .join('; ');
}

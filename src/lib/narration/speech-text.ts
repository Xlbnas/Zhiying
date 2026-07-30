/**
 * Narration Speech Text Sanitizer（M6.3.1.3）：TTS 前的文本可朗读性判定。
 *
 * 背景：LLM 生成的 Script V2 Markdown 会在章节/段落间输出 horizontal rule
 *（`---` / `***` / `___`），compiler 只剥离标题/blockquote/HTML 注释，
 * 分隔符落入正文 → splitSentences 产出 text='---' 的 speech unit →
 * IndexTTS 把 `---` 朗读成噪音。此前全链路唯一防线是「非空」。
 *
 * 本模块提供纯函数防线（无 IO、无状态，deterministic）：
 * - sanitizeSpeechText：剥离 Markdown horizontal rule 与 HTML 注释，归一空白
 * - containsMeaningfulSpeechCharacters：是否存在任何可朗读字符（CJK/字母/数字）
 * - isSpeakableText：sanitize 后非空且含可朗读字符
 *
 * 铁律：绝不删除正常文本中的单个 `-` / `*`——
 * `2026-07-30`、`AI-driven 工作流` 必须原样保留。
 */

/** 可朗读字符：CJK 统一表意文字（含扩展 A 与兼容表意）/ 英文字母 / 数字。 */
const MEANINGFUL_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFFA-Za-z0-9]/;

/** 整行 Markdown horizontal rule：≥3 个 `-` / `*` / `_`（可含空白间隔，如 `- - -`），独占一行。 */
const HORIZONTAL_RULE_LINE = /^\s*(?:[-*_]\s*){3,}$/;

/** 行内独立分隔符 run：≥3 个 `-` / `*` / `_`（可含空白间隔），两侧为空白或文本边界。
 *  只匹配连续 run——`2026-07-30` / `AI-driven` 中单个连字符前后是字母数字，永不误伤。 */
const SEPARATOR_RUN = /(?:^|\s)[-*_](?:\s*[-*_]){2,}(?=\s|$)/g;

/** HTML 注释（可跨行）。 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** 文本是否含有任何可朗读字符（CJK / 英文字母 / 数字任一存在）。 */
export function containsMeaningfulSpeechCharacters(text: string): boolean {
  return MEANINGFUL_CHAR.test(text);
}

/**
 * 剥离 Markdown horizontal rule（整行与行内独立 run）与 HTML 注释，归一空白。
 * 幂等：对已 sanitize 的文本再次调用结果不变。
 */
export function sanitizeSpeechText(text: string): string {
  return text
    .replace(HTML_COMMENT, ' ')
    .split('\n')
    .map((line) => (HORIZONTAL_RULE_LINE.test(line) ? '' : line.replace(SEPARATOR_RUN, ' ')))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 可朗读判定：sanitize 后非空且含可朗读字符。
 * `---` / ` *** ` / `___` / `<!-- none -->` / `……` / 纯标点 / 纯空白 → false。
 */
export function isSpeakableText(text: string): boolean {
  const sanitized = sanitizeSpeechText(text);
  return sanitized.length > 0 && containsMeaningfulSpeechCharacters(sanitized);
}

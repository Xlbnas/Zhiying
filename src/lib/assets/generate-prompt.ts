/**
 * M6.3.9：AI 生成默认 prompt 构建（纯函数，server route 与 client UI 共用）。
 *
 * 画面内容完全来自真实 requirement（subject 已含场景要素，如"时钟显示22:00"），
 * 此处只补充知识视频 B-roll 的风格 / 画幅 / 洁净度约束，不做逐场景特判。
 * 「无字幕、无水印」约束的是后期叠加文字，不禁止画面内容本身的文字元素（如时钟读数）。
 *
 * Production E2E 修正：synthesized subject 可能含旁白指令（如"旁白'明天早上九点'全程覆盖"），
 * 引号文本会被图像模型当作字幕烧录进画面 —— 音频方向不是画面内容，生成前必须剥离。
 */
import type {AssetRequirement} from '../scene-schema';

/** 剥离旁白/音频指令片段（含引号 narration 与裸 旁白xxx 从句），剩余画面描述不变。 */
export function stripNarrationDirectives(subject: string): string {
  return subject
    .replace(/旁白['"“”‘’][^'"“”‘’]*['"“”‘’][^，。；;,、]*/g, '')
    .replace(/旁白[^，。；;,、]*/g, '')
    .replace(/[，、；;,]\s*[，。；;,、]+/g, '，')
    .replace(/^[，。；;,、\s]+|[，。；;,、\s]+$/g, '');
}

export function defaultGeneratePrompt(req: Pick<AssetRequirement, 'subject' | 'query'>): string {
  const raw = req.subject.trim().replace(/\s+/g, ' ');
  const subject = stripNarrationDirectives(raw) || req.query.trim() || raw;
  return `${subject}。克制、真实的知识视频 B-roll 摄影画面，16:9 构图，无字幕、无水印。`;
}

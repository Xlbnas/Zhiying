/**
 * M6.3.9：AI 生成默认 prompt 构建（纯函数，server route 与 client UI 共用）。
 *
 * 画面内容完全来自真实 requirement（subject 已含场景要素，如"时钟显示22:00"），
 * 此处只补充知识视频 B-roll 的风格 / 画幅 / 洁净度约束，不做逐场景特判。
 * 「无字幕、无水印」约束的是后期叠加文字，不禁止画面内容本身的文字元素（如时钟读数）。
 */
import type {AssetRequirement} from '../scene-schema';

export function defaultGeneratePrompt(req: Pick<AssetRequirement, 'subject' | 'query'>): string {
  const subject = req.subject.trim().replace(/\s+/g, ' ');
  return `${subject}。克制、真实的知识视频 B-roll 摄影画面，16:9 构图，无字幕、无水印。`;
}

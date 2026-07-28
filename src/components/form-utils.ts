/**
 * 新建项目表单的纯逻辑与选项常量（M5；与组件分离便于自动测试）。
 */

export const DURATION_MIN = 1;
export const DURATION_MAX = 60;
export const DURATION_DEFAULT = 10;
export const DURATION_QUICK_VALUES = [3, 5, 10, 15, 20] as const;

/** 目标时长（分钟）收敛：非数字/NaN 回退默认值；负数/0 收敛到最小值；超上限收敛到上限。 */
export function clampDurationMinutes(value: number): number {
  if (!Number.isFinite(value)) return DURATION_DEFAULT;
  return Math.min(DURATION_MAX, Math.max(DURATION_MIN, Math.round(value)));
}

/** 提交给 API 的时长字符串（服务端契约保持「N 分钟」）。 */
export function formatDurationPayload(minutes: number): string {
  return `${clampDurationMinutes(minutes)} 分钟`;
}

export const PLATFORM_OPTIONS = ['B站', 'YouTube', '小红书', '抖音', 'TikTok'] as const;

export const LANGUAGE_OPTIONS = ['中文', '英文', '日文', '韩文'] as const;

export const VIDEO_STYLE_OPTIONS = [
  '视频论文',
  '人物科普',
  '知识科普',
  '纪录片',
  '故事讲述',
  '评论分析',
] as const;

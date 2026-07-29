/**
 * Usage Summary 展示格式化（M6.3.10）。
 *
 * 时长采用智能单位：真实有用量但不足 0.01 小时时不得显示 "0.00 小时"。
 *   0        → "0 秒"
 *   < 1 分钟 → "N 秒"
 *   < 1 小时 → "M.M 分钟"
 *   >= 1 小时→ "H.HH 小时"
 */

export function fmtDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0 秒';
  const sec = hours * 3600;
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(1)} 分钟`;
  return `${hours.toFixed(2)} 小时`;
}

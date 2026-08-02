/**
 * 展示层格式化工具（UI agent）。
 * 时间码、时长、日期、ID 统一在此处理，配合 .mono 等宽数字显示。
 */

/** 秒 → "mm:ss" / "h:mm:ss"，无效输入显示占位符 */
export function formatDurationSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 毫秒 → "mm:ss.s"（voice revision 时长），无效输入显示占位符 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  const s = (ms - m * 60000) / 1000;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** ISO 字符串 → "YYYY-MM-DD HH:mm"（本地时区），无效输入显示占位符 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** uuid → 前 8 位短 ID（列表展示用，完整 ID 放 title） */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length <= 8 ? id : id.slice(0, 8);
}

/** render_jobs.kind → 中文标签 */
export function jobKindLabel(kind: string | null | undefined): string {
  if (kind === 'fullcut') return '成片';
  if (kind === 'no-subtitles') return '无字幕版';
  return kind ?? '—';
}

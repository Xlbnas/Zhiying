/**
 * 统一状态 Badge（CONTRACT §6 + UI 规范 §九）。
 * 全站状态色唯一出口：queued / running / succeeded / failed / cancelled。
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: '排队中',
  running: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/** 未知状态降级为 data-status="unknown"，文案原样展示，不静默吞掉 */
export function StatusBadge({status}: {status: string | null | undefined}) {
  const value = status ?? '';
  const known = KNOWN_STATUSES.has(value);
  const dataStatus = known ? value : 'unknown';
  const label = known ? STATUS_LABELS[value as JobStatus] : value || '未知';
  return (
    <span className="badge" data-status={dataStatus}>
      {label}
    </span>
  );
}

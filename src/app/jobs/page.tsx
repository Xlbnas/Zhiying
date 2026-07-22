'use client';

import {useCallback, useEffect, useState} from 'react';
import {StatusBadge} from '@/components/StatusBadge';
import {
  formatDateTime,
  formatDurationSec,
  jobKindLabel,
  shortId,
} from '@/components/format';

/**
 * 任务队列（CONTRACT §6）：
 * 状态 Badge（统一状态色）+ 进度条 + 2s 轮询 /api/jobs，
 * succeeded 后提供 /api/jobs/[id]/download 下载链接。
 * 标签页隐藏时暂停轮询，避免空转。
 */

type JobItem = {
  id: string;
  projectId: string | null;
  kind: string | null;
  status: string | null;
  progress: number;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
};

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function normalizeJob(raw: unknown): JobItem | null {
  const j = asObj(raw);
  if (!j) return null;
  const id = asStr(j.id);
  if (!id) return null;
  return {
    id,
    projectId: asStr(j.project_id) ?? asStr(j.projectId),
    kind: asStr(j.kind),
    status: asStr(j.status),
    progress: asNum(j.progress) ?? 0,
    queuedAt: asStr(j.queued_at) ?? asStr(j.queuedAt),
    startedAt: asStr(j.started_at) ?? asStr(j.startedAt),
    finishedAt: asStr(j.finished_at) ?? asStr(j.finishedAt),
    errorMessage: asStr(j.error_message) ?? asStr(j.errorMessage),
  };
}

function jobDuration(job: JobItem): number | null {
  if (!job.startedAt || !job.finishedAt) return null;
  const ms = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

function progressClass(status: string | null): string {
  if (status === 'succeeded') return 'progress-fill done';
  if (status === 'failed') return 'progress-fill failed';
  if (status === 'running') return 'progress-fill';
  return 'progress-fill idle';
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/jobs', {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      const list = asObj(json)?.jobs;
      const items = Array.isArray(list)
        ? list.map(normalizeJob).filter((j): j is JobItem => j !== null)
        : [];
      setJobs(items);
      setError(null);
    } catch {
      // 轮询失败不清空已有数据，只显示横幅
      setError('任务列表刷新失败，将持续重试');
      setJobs((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2000); // CONTRACT §6：2s 轮询
    return () => clearInterval(timer);
  }, [poll]);

  return (
    <main className="container fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">任务队列</h1>
          <p className="page-sub">每 2 秒自动刷新 · 渲染按队列顺序执行</p>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {jobs === null ? (
        <div className="loading">正在加载任务队列…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">队列是空的</p>
          <p>在项目工作台点击「导出成片」即可创建渲染任务。</p>
        </div>
      ) : (
        <section className="panel" aria-label="渲染任务">
          <div className="job-list">
            {jobs.map((job) => {
              const pct = Math.max(0, Math.min(100, job.progress));
              const duration = jobDuration(job);
              return (
                <div key={job.id} className="job-row">
                  <div>
                    <div className="job-kind">{jobKindLabel(job.kind)}</div>
                    <div className="job-id mono" title={job.id}>
                      #{shortId(job.id)}
                      {job.projectId ? ` · ${shortId(job.projectId)}` : ''}
                    </div>
                  </div>
                  <div className="job-progress">
                    <div
                      className="progress"
                      role="progressbar"
                      aria-valuenow={Math.round(pct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className={progressClass(job.status)}
                        style={{width: `${pct}%`}}
                      />
                    </div>
                    <span className="job-pct mono">{pct.toFixed(1)}%</span>
                  </div>
                  <div>
                    <StatusBadge status={job.status} />
                  </div>
                  <div className="job-times mono">
                    <span>入队 {formatDateTime(job.queuedAt)}</span>
                    {duration !== null ? (
                      <span>耗时 {formatDurationSec(duration)}</span>
                    ) : null}
                  </div>
                  <div>
                    {job.status === 'succeeded' ? (
                      <a
                        className="btn btn-sm"
                        href={`/api/jobs/${job.id}/download`}
                        download
                      >
                        下载 MP4
                      </a>
                    ) : null}
                  </div>
                  {job.status === 'failed' && job.errorMessage ? (
                    <div className="job-error">{job.errorMessage}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

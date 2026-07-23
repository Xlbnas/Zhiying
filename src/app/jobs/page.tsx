'use client';

import {useCallback, useEffect, useState} from 'react';
import {StatusBadge} from '@/components/StatusBadge';
import {
  formatDateTime,
  formatDurationSec,
  jobKindLabel,
  shortId,
} from '@/components/format';
import {STAGE_NAMES} from '@/components/workflow/shared';
import type {WorkflowStage} from '@/lib/workflow/types';

/**
 * 任务队列（CONTRACT §6 + M2-D §三十一）：
 * 同页两区块——LLM 生成任务 + 渲染任务（不强行合并成一张表）。
 * 状态 Badge（统一状态色）+ 2s 轮询 /api/jobs；标签页隐藏时暂停轮询。
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

type LlmJobItem = {
  id: string;
  projectId: string;
  stage: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  provider: string | null;
  model: string | null;
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

function normalizeLlmJob(raw: unknown): LlmJobItem | null {
  const j = asObj(raw);
  if (!j) return null;
  const id = asStr(j.id);
  const projectId = asStr(j.project_id);
  const stage = asStr(j.stage);
  const status = asStr(j.status);
  if (!id || !projectId || !stage || !status) return null;
  return {
    id,
    projectId,
    stage,
    status,
    attempt: asNum(j.attempt) ?? 0,
    maxAttempts: asNum(j.max_attempts) ?? 0,
    queuedAt: asStr(j.queued_at),
    startedAt: asStr(j.started_at),
    finishedAt: asStr(j.finished_at),
    errorCode: asStr(j.error_code),
    errorMessage: asStr(j.error_message),
    provider: asStr(j.provider),
    model: asStr(j.model),
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
  const [llmJobs, setLlmJobs] = useState<LlmJobItem[] | null>(null);
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
      const llmList = asObj(json)?.llmJobs;
      const llmItems = Array.isArray(llmList)
        ? llmList.map(normalizeLlmJob).filter((j): j is LlmJobItem => j !== null)
        : [];
      setLlmJobs(llmItems);
      setError(null);
    } catch {
      // 轮询失败不清空已有数据，只显示横幅
      setError('任务列表刷新失败，将持续重试');
      setJobs((prev) => prev ?? []);
      setLlmJobs((prev) => prev ?? []);
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
          <p className="page-sub">每 2 秒自动刷新 · LLM 与渲染共用单调度器顺序执行</p>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {/* LLM 生成任务区块（M2-D） */}
      <section className="panel" aria-label="LLM 生成任务" style={{marginBottom: 20}}>
        <div className="panel-head">
          <span className="panel-title">LLM 生成任务</span>
          <span className="mono" style={{fontSize: 12, color: 'var(--muted)'}}>
            {llmJobs?.length ?? '—'}
          </span>
        </div>
        {llmJobs === null ? (
          <div className="loading">正在加载…</div>
        ) : llmJobs.length === 0 ? (
          <div className="stage-disabled-note">暂无 LLM 生成任务</div>
        ) : (
          <div className="job-list">
            {llmJobs.map((job) => (
              <div key={job.id} className="job-row">
                <div>
                  <div className="job-kind">
                    {STAGE_NAMES[job.stage as WorkflowStage] ?? job.stage}
                  </div>
                  <div className="job-id mono" title={job.id}>
                    #{shortId(job.id)} · {shortId(job.projectId)}
                  </div>
                </div>
                <div className="job-times mono">
                  <span>
                    尝试 {job.attempt}/{job.maxAttempts}
                  </span>
                  {job.provider || job.model ? (
                    <span>
                      {job.provider ?? '—'} · {job.model ?? '—'}
                    </span>
                  ) : null}
                </div>
                <div>
                  <StatusBadge status={job.status} />
                </div>
                <div className="job-times mono">
                  <span>入队 {formatDateTime(job.queuedAt)}</span>
                  {job.finishedAt ? <span>完成 {formatDateTime(job.finishedAt)}</span> : null}
                </div>
                <div />
                {job.status === 'failed' && job.errorMessage ? (
                  <div className="job-error">
                    {job.errorCode ? `[${job.errorCode}] ` : ''}
                    {job.errorMessage}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {jobs === null ? (
        <div className="loading">正在加载任务队列…</div>
      ) : jobs.length === 0 ? (
        <div className="empty">
          <p className="empty-title">渲染队列是空的</p>
          <p>在项目工作台点击「导出成片」即可创建渲染任务。</p>
        </div>
      ) : (
        <section className="panel" aria-label="渲染任务">
          <div className="panel-head">
            <span className="panel-title">渲染任务</span>
            <span className="mono" style={{fontSize: 12, color: 'var(--muted)'}}>
              {jobs.length}
            </span>
          </div>
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

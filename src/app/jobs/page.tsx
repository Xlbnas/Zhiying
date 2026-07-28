'use client';

import {useCallback, useEffect, useState} from 'react';
import {StatusBadge} from '@/components/StatusBadge';
import {
  formatDateTime,
  formatDurationSec,
  jobKindLabel,
  shortId,
} from '@/components/format';
import {
  groupJobsByProject,
  type LlmJobItem,
  type RenderJobItem,
  type TtsJobItem,
} from '@/components/jobs/grouping';
import {
  parseRenderProgressDetail,
  summarizeRenderProgress,
} from '@/lib/render/progress-detail';
import {STAGE_NAMES} from '@/components/workflow/shared';
import type {WorkflowStage} from '@/lib/workflow/types';

/**
 * 任务队列（CONTRACT §6 + M2-D §三十一；M5 按项目分组收纳）。
 * 三类任务（LLM 生成 / TTS 音频 / 渲染）按项目折叠分组，默认收纳；
 * 组头显示计数与进行中任务的步骤级进度。2s 轮询 /api/jobs。
 */

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function normalizeJob(raw: unknown): RenderJobItem | null {
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
    progressDetail: asStr(j.progress_detail) ?? null,
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

function normalizeTtsJob(raw: unknown): TtsJobItem | null {
  const j = asObj(raw);
  if (!j) return null;
  const id = asStr(j.id);
  const projectId = asStr(j.project_id);
  const unitId = asStr(j.unit_id);
  const status = asStr(j.status);
  if (!id || !projectId || !unitId || !status) return null;
  return {
    id,
    projectId,
    unitId,
    provider: asStr(j.provider) ?? '—',
    voice: `${asStr(j.voice_profile_id) ?? 'default'}@${asStr(j.voice_profile_revision) ?? '1'}`,
    status,
    attempt: asNum(j.attempt) ?? 0,
    maxAttempts: asNum(j.max_attempts) ?? 0,
    durationMs: asNum(j.duration_ms),
    queuedAt: asStr(j.queued_at),
    finishedAt: asStr(j.finished_at),
    errorCode: asStr(j.error_code),
    errorMessage: asStr(j.error_message),
  };
}

function jobDuration(job: RenderJobItem): number | null {
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

function formatEta(etaMs: number | null | undefined): string | null {
  if (etaMs === null || etaMs === undefined || !Number.isFinite(etaMs) || etaMs <= 0) return null;
  const totalSec = Math.round(etaMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `预计剩余 ${mm}:${String(ss).padStart(2, '0')}`;
}

function LlmJobRow({job}: {job: LlmJobItem}) {
  return (
    <div className="job-row">
      <div>
        <div className="job-kind">
          {STAGE_NAMES[job.stage as WorkflowStage] ?? job.stage}
        </div>
        <div className="job-id mono" title={job.id}>
          #{shortId(job.id)}
        </div>
      </div>
      <div className="job-times mono">
        <span>尝试 {job.attempt}/{job.maxAttempts}</span>
        {job.provider || job.model ? (
          <span>{job.provider ?? '—'} · {job.model ?? '—'}</span>
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
  );
}

function TtsJobRow({job}: {job: TtsJobItem}) {
  return (
    <div className="job-row">
      <div>
        <div className="job-kind mono">{job.unitId}</div>
        <div className="job-id mono" title={job.id}>
          #{shortId(job.id)}
        </div>
      </div>
      <div className="job-times mono">
        <span>尝试 {job.attempt}/{job.maxAttempts}</span>
        <span>{job.provider} · {job.voice}</span>
      </div>
      <div>
        <StatusBadge status={job.status} />
      </div>
      <div className="job-times mono">
        <span>入队 {formatDateTime(job.queuedAt)}</span>
        {job.durationMs !== null ? <span>{(job.durationMs / 1000).toFixed(1)}s</span> : null}
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
  );
}

function RenderJobRow({job}: {job: RenderJobItem}) {
  const pct = Math.max(0, Math.min(100, job.progress));
  const duration = jobDuration(job);
  const detail = parseRenderProgressDetail(job.progressDetail);
  const eta = formatEta(detail?.etaMs);
  return (
    <div className="job-row">
      <div>
        <div className="job-kind">{jobKindLabel(job.kind)}</div>
        <div className="job-id mono" title={job.id}>
          #{shortId(job.id)}
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
          <div className={progressClass(job.status)} style={{width: `${pct}%`}} />
        </div>
        <span className="job-pct mono">{pct.toFixed(1)}%</span>
        {job.status === 'running' && detail ? (
          <span className="job-stage-label">
            {detail.label}
            {eta ? ` · ${eta}` : ''}
          </span>
        ) : null}
      </div>
      <div>
        <StatusBadge status={job.status} />
      </div>
      <div className="job-times mono">
        <span>入队 {formatDateTime(job.queuedAt)}</span>
        {duration !== null ? <span>耗时 {formatDurationSec(duration)}</span> : null}
      </div>
      <div>
        {job.status === 'succeeded' ? (
          <a className="btn btn-sm" href={`/api/jobs/${job.id}/download`} download>
            下载 MP4
          </a>
        ) : null}
      </div>
      {job.status === 'failed' && job.errorMessage ? (
        <div className="job-error">{job.errorMessage}</div>
      ) : null}
    </div>
  );
}

export default function JobsPage() {
  const [groups, setGroups] = useState<ReturnType<typeof groupJobsByProject> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const res = await fetch('/api/jobs', {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      const root = asObj(json);
      const read = (key: string): unknown[] => (Array.isArray(root?.[key]) ? (root[key] as unknown[]) : []);
      const renderJobs = read('jobs').map(normalizeJob).filter((j): j is RenderJobItem => j !== null);
      const llmJobs = read('llmJobs').map(normalizeLlmJob).filter((j): j is LlmJobItem => j !== null);
      const ttsJobs = read('ttsJobs').map(normalizeTtsJob).filter((j): j is TtsJobItem => j !== null);
      const projects = read('projects')
        .map((p) => {
          const o = asObj(p);
          const id = asStr(o?.id);
          const title = asStr(o?.title);
          return id && title ? {id, title} : null;
        })
        .filter((p): p is {id: string; title: string} => p !== null);
      setGroups(
        groupJobsByProject({
          llmJobs,
          ttsJobs,
          renderJobs,
          projects,
          summarizeRender: (job) => summarizeRenderProgress(job.progress, job.progressDetail),
        }),
      );
      setError(null);
    } catch {
      // 轮询失败不清空已有数据，只显示横幅
      setError('任务列表刷新失败，将持续重试');
      setGroups((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 2000); // CONTRACT §6：2s 轮询
    return () => clearInterval(timer);
  }, [poll]);

  const totalCount = groups?.reduce((n, g) => n + g.llmJobs.length + g.ttsJobs.length + g.renderJobs.length, 0) ?? 0;

  return (
    <main className="container fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">任务队列</h1>
          <p className="page-sub">按项目分组 · 每 2 秒自动刷新 · 点击项目展开明细</p>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {groups === null ? (
        <div className="loading">正在加载任务队列…</div>
      ) : totalCount === 0 ? (
        <div className="empty">
          <p className="empty-title">还没有任务</p>
          <p>在项目里点击「生成」「生成配音」或「生成最终视频」后，任务会出现在这里。</p>
        </div>
      ) : (
        groups.map((g) => (
          <details key={g.projectId} className="job-group">
            <summary className="job-group-summary">
              <span className="job-group-title">{g.title}</span>
              <span className="job-group-counts mono">
                生成 {g.llmJobs.length} · 配音 {g.ttsJobs.length} · 渲染 {g.renderJobs.length}
              </span>
              {g.activeSummary ? (
                <span className="badge" data-status="running">{g.activeSummary}</span>
              ) : null}
            </summary>
            <div className="job-group-body">
              {g.llmJobs.length > 0 ? (
                <section aria-label={`${g.title} 生成任务`}>
                  <div className="job-kind-heading">生成任务</div>
                  <div className="job-list">
                    {g.llmJobs.map((job) => <LlmJobRow key={job.id} job={job} />)}
                  </div>
                </section>
              ) : null}
              {g.ttsJobs.length > 0 ? (
                <section aria-label={`${g.title} 配音任务`}>
                  <div className="job-kind-heading">配音任务</div>
                  <div className="job-list">
                    {g.ttsJobs.map((job) => <TtsJobRow key={job.id} job={job} />)}
                  </div>
                </section>
              ) : null}
              {g.renderJobs.length > 0 ? (
                <section aria-label={`${g.title} 渲染任务`}>
                  <div className="job-kind-heading">渲染任务</div>
                  <div className="job-list">
                    {g.renderJobs.map((job) => <RenderJobRow key={job.id} job={job} />)}
                  </div>
                </section>
              ) : null}
            </div>
          </details>
        ))
      )}
    </main>
  );
}

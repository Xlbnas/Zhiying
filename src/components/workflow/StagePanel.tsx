'use client';

import {useCallback, useEffect, useState} from 'react';
import {formatDateTime} from '@/components/format';
import {
  LLM_JOB_STATUS_LABELS,
  STAGE_NAMES,
  STAGE_STATE_LABELS,
  type WorkflowStageState,
} from './shared';

/**
 * Stage Panel（M2-C §二十三）：当前只完整实现 project_definition。
 * 查看 / 生成 / 重新生成 / 编辑 / 保存编辑 / 锁定 + 元信息
 * （Prompt Version / Model / Version / Stage Status / Job Status / 成本 / 更新时间）。
 */

interface StageContentResponse {
  stage: WorkflowStageState;
  version: {
    version: number;
    content: string;
    content_type: string;
    source: string;
    prompt_version: string | null;
    model: string | null;
    job_id: string | null;
    created_at: string;
  } | null;
  usage: {requests: number; totalCostCny: number};
}

interface ApiError {
  error?: string;
  message?: string;
}

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.message ?? json?.error ?? `HTTP ${res.status}`;
}

export function StagePanel({
  projectId,
  stageState,
  onChanged,
}: {
  projectId: string;
  stageState: WorkflowStageState;
  onChanged: () => void;
}) {
  const stage = stageState.stage;
  const [data, setData] = useState<StageContentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/stage/${stage}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await readError(res));
      setData((await res.json()) as StageContentResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '阶段内容加载失败');
    }
  }, [projectId, stage]);

  // 阶段版本/状态变化（生成完成、编辑、锁定）时重新拉取内容
  useEffect(() => {
    void load();
  }, [load, stageState.active_version, stageState.status, stageState.updated_at]);

  const runStage = useCallback(
    async (confirmStale: boolean) => {
      setBusy('run');
      setError(null);
      try {
        const res = await fetch('/api/workflow/run-stage', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({projectId, stage, confirmStale}),
        });
        if (!res.ok) {
          const message = await readError(res);
          if (res.status === 409 && message.includes('confirmStale')) {
            setConfirmRegenerate(true);
            return;
          }
          throw new Error(message);
        }
        setConfirmRegenerate(false);
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : '生成任务创建失败');
      } finally {
        setBusy(null);
      }
    },
    [projectId, stage, onChanged],
  );

  const saveEdit = useCallback(async () => {
    setBusy('save');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/stage/${stage}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({content: draft}),
      });
      if (!res.ok) throw new Error(await readError(res));
      setEditing(false);
      onChanged();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(null);
    }
  }, [projectId, stage, draft, onChanged, load]);

  const lock = useCallback(async () => {
    setBusy('lock');
    setError(null);
    try {
      const res = await fetch('/api/workflow/lock-stage', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({projectId, stage}),
      });
      if (!res.ok) throw new Error(await readError(res));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '锁定失败');
    } finally {
      setBusy(null);
    }
  }, [projectId, stage, onChanged]);

  const cancelJob = useCallback(
    async (jobId: string) => {
      setBusy('cancel');
      setError(null);
      try {
        const res = await fetch('/api/workflow/cancel-job', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({jobId}),
        });
        if (!res.ok) throw new Error(await readError(res));
        onChanged();
      } catch (err) {
        setError(err instanceof Error ? err.message : '取消失败');
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  const status = stageState.status;
  const activeJob = stageState.activeJob;
  const latestJob = stageState.latestJob;
  const version = data?.version ?? null;
  const usage = data?.usage ?? null;
  const hasContent = version !== null;
  const canEdit = !activeJob && (status === 'generated' || status === 'edited');
  const canLock = !activeJob && hasContent && status !== 'locked';
  const jobLabel = (s: string): string => LLM_JOB_STATUS_LABELS[s] ?? s;

  return (
    <section className="stage-panel" aria-label={`阶段面板 ${STAGE_NAMES[stage]}`}>
      <div className="stage-panel-head">
        <div>
          <h2 className="stage-panel-title">{STAGE_NAMES[stage]}</h2>
          <p className="stage-panel-sub mono">
            {stage} · {STAGE_STATE_LABELS[status]}
            {stageState.locked_version !== null ? ` · 锁定 v${stageState.locked_version}` : ''}
          </p>
        </div>
        <div className="stage-actions">
          {activeJob ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void cancelJob(activeJob.id)}
            >
              {busy === 'cancel' ? '取消中…' : '取消任务'}
            </button>
          ) : null}
          {!activeJob && status !== 'locked' ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => {
                if (status === 'not_started') {
                  void runStage(false);
                } else {
                  setConfirmRegenerate(true);
                }
              }}
            >
              {busy === 'run'
                ? '提交中…'
                : status === 'not_started'
                  ? '生成'
                  : '重新生成'}
            </button>
          ) : null}
          {!activeJob && status === 'locked' ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => setConfirmRegenerate(true)}
            >
              重新生成
            </button>
          ) : null}
          {canEdit && !editing ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => {
                setDraft(version?.content ?? '');
                setEditing(true);
              }}
            >
              编辑
            </button>
          ) : null}
          {editing ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null || draft.trim().length === 0}
                onClick={() => void saveEdit()}
              >
                {busy === 'save' ? '保存中…' : '保存编辑'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy !== null}
                onClick={() => setEditing(false)}
              >
                放弃
              </button>
            </>
          ) : null}
          {canLock && !editing ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => void lock()}
            >
              {busy === 'lock' ? '锁定中…' : '锁定'}
            </button>
          ) : null}
        </div>
      </div>

      {confirmRegenerate ? (
        <div className="confirm-bar" role="alert">
          <span>重新生成会使后续已完成阶段失效（stale）。确认继续？</span>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null}
              onClick={() => void runStage(true)}
            >
              {busy === 'run' ? '提交中…' : '确认重新生成'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy !== null}
              onClick={() => setConfirmRegenerate(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="stage-meta">
        <span className="badge" data-stage-state={status}>
          {STAGE_STATE_LABELS[status]}
        </span>
        {version ? <span className="mono">v{version.version}</span> : null}
        {version?.prompt_version ? (
          <span>
            Prompt <span className="mono">{version.prompt_version}</span>
          </span>
        ) : null}
        {version?.model ? (
          <span>
            模型 <span className="mono">{version.model}</span>
          </span>
        ) : null}
        {activeJob ? (
          <span className="badge" data-status={activeJob.status}>
            {jobLabel(activeJob.status)}
          </span>
        ) : latestJob ? (
          <span className="badge" data-status={latestJob.status}>
            最近任务 {jobLabel(latestJob.status)}
          </span>
        ) : null}
        {usage && usage.requests > 0 ? (
          <span>
            累计成本 <span className="mono">¥{usage.totalCostCny.toFixed(4)}</span> ·{' '}
            <span className="mono">{usage.requests}</span> 次请求
          </span>
        ) : null}
        <span>
          更新 <span className="mono">{formatDateTime(stageState.updated_at)}</span>
        </span>
      </div>

      {latestJob?.status === 'failed' && latestJob.error_message ? (
        <div className="error-banner" style={{margin: 0, borderRadius: 0}}>
          最近生成失败（{latestJob.error_code ?? 'unknown'}）：{latestJob.error_message}
        </div>
      ) : null}
      {error ? (
        <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div>
      ) : null}

      {activeJob ? (
        <div className="stage-empty">
          <p className="empty-title">
            {activeJob.status === 'queued' ? '任务排队中…' : '正在生成…'}
          </p>
          <p>完成后本页会自动更新，无需刷新。</p>
        </div>
      ) : editing ? (
        <textarea
          className="stage-editor"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="编辑阶段内容"
        />
      ) : hasContent ? (
        <div className="stage-content">{version.content}</div>
      ) : (
        <div className="stage-empty">
          <p className="empty-title">尚未生成</p>
          <p>点击「生成」开始本阶段；生成后可编辑、锁定。</p>
        </div>
      )}
    </section>
  );
}

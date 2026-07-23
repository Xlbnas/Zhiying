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
 * Stage Panel（M2-D §二十五–二十九）：前六阶段泛化。
 * - 查看 / 生成 / 重新生成（locked 弹确认 + affectedDownstream）/ 编辑 / 锁定
 * - Markdown 普通编辑区；JSON monospace + pretty print + 类型标记 + 服务端校验错误展示
 * - 版本历史 Drawer（查看历史 / 回滚：复制为新版本，历史不移动）
 * - stale 阶段：失效提示 + 旧内容保留 + 重新生成
 */

interface StageVersion {
  version: number;
  content: string;
  content_type: string;
  source: string;
  prompt_version: string | null;
  model: string | null;
  job_id: string | null;
  created_at: string;
}

interface StageContentResponse {
  stage: WorkflowStageState;
  version: StageVersion | null;
  usage: {requests: number; totalCostCny: number};
  outputKind: 'markdown' | 'json';
}

interface VersionMeta {
  version: number;
  contentType: string;
  source: string;
  promptVersion: string | null;
  model: string | null;
  note: string | null;
  createdAt: string;
  isActive: boolean;
  isLocked: boolean;
  preview: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  affectedDownstream?: string[];
}

const VERSION_SOURCE_LABELS: Record<string, string> = {
  ai_generate: 'AI 生成',
  manual_edit: '人工编辑',
  repair: 'Repair',
  rollback: 'Rollback',
};

async function readBody(res: Response): Promise<ApiErrorBody> {
  return (await res.json().catch(() => null)) as ApiErrorBody ?? {};
}

async function readError(res: Response): Promise<string> {
  const json = await readBody(res);
  return json.message ?? json.error ?? `HTTP ${res.status}`;
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
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
  const [affected, setAffected] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
          const body = await readBody(res);
          if (res.status === 409 && body.error === 'CONFIRM_STALE_REQUIRED') {
            setAffected(body.affectedDownstream ?? []);
            setConfirmRegenerate(true);
            return;
          }
          throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
        }
        setConfirmRegenerate(false);
        setAffected([]);
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
  const outputKind = data?.outputKind ?? 'markdown';
  const isJson = outputKind === 'json';
  const hasContent = version !== null;
  const canEdit =
    !activeJob && (status === 'generated' || status === 'edited' || status === 'stale');
  const canLock =
    !activeJob && hasContent && status !== 'locked' && status !== 'stale';
  const jobLabel = (s: string): string => LLM_JOB_STATUS_LABELS[s] ?? s;

  return (
    <section className="stage-panel" aria-label={`阶段面板 ${STAGE_NAMES[stage]}`}>
      <div className="stage-panel-head">
        <div>
          <h2 className="stage-panel-title">
            {STAGE_NAMES[stage]}
            {isJson ? <span className="json-type-badge" style={{marginLeft: 10}}>JSON</span> : null}
          </h2>
          <p className="stage-panel-sub mono">
            {stage} · {STAGE_STATE_LABELS[status]}
            {stageState.locked_version !== null ? ` · 锁定 v${stageState.locked_version}` : ''}
          </p>
        </div>
        <div className="stage-actions">
          {hasContent ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDrawerOpen(true)}
            >
              版本历史
            </button>
          ) : null}
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
                if (status === 'not_started' || status === 'stale') {
                  void runStage(false);
                } else {
                  setAffected([]);
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
              onClick={() => {
                setAffected([]);
                setConfirmRegenerate(true);
              }}
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
                setDraft(isJson ? prettyJson(version?.content ?? '') : (version?.content ?? ''));
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

      {status === 'stale' ? (
        <div className="stale-banner" role="alert">
          该阶段基于旧的上游版本，内容已失效。旧内容仍保留，但不能直接锁定——请重新生成，
          或在上游全部重新锁定后人工修订。
        </div>
      ) : null}

      {confirmRegenerate ? (
        <div className="confirm-bar" role="alert">
          <span>
            重新生成会使后续已完成阶段失效（stale）
            {affected.length > 0 ? `：${affected.join('、')}` : ''}。确认继续？
          </span>
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
        <div className="error-banner" style={{margin: 0, borderRadius: 0, whiteSpace: 'pre-wrap'}}>
          {error}
        </div>
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
          className={`stage-editor${isJson ? ' json' : ''}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="编辑阶段内容"
          spellCheck={false}
        />
      ) : hasContent ? (
        <div className={isJson ? 'stage-content mono' : 'stage-content'} style={isJson ? {fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.7} : undefined}>
          {isJson ? prettyJson(version.content) : version.content}
        </div>
      ) : (
        <div className="stage-empty">
          <p className="empty-title">尚未生成</p>
          <p>点击「生成」开始本阶段；生成后可编辑、锁定。</p>
        </div>
      )}

      {drawerOpen ? (
        <VersionHistoryDrawer
          projectId={projectId}
          stage={stage}
          stageLocked={status === 'locked'}
          outputKind={outputKind}
          onClose={() => setDrawerOpen(false)}
          onRolledBack={() => {
            setDrawerOpen(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/** 版本历史 Drawer（§二十七/二十八）：查看历史 + 回滚（复制为新版本）。 */
function VersionHistoryDrawer({
  projectId,
  stage,
  stageLocked,
  outputKind,
  onClose,
  onRolledBack,
}: {
  projectId: string;
  stage: string;
  stageLocked: boolean;
  outputKind: 'markdown' | 'json';
  onClose: () => void;
  onRolledBack: () => void;
}) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [viewing, setViewing] = useState<StageVersion | null>(null);
  const [confirmRollback, setConfirmRollback] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/stage/${stage}/versions`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(await readError(res));
        const json = (await res.json()) as {versions: VersionMeta[]};
        setVersions(json.versions);
      } catch (err) {
        setError(err instanceof Error ? err.message : '版本历史加载失败');
      }
    })();
  }, [projectId, stage]);

  const viewVersion = useCallback(
    async (version: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/stage/${stage}/versions?version=${version}`,
          {cache: 'no-store'},
        );
        if (!res.ok) throw new Error(await readError(res));
        const json = (await res.json()) as {version: StageVersion};
        setViewing(json.version);
      } catch (err) {
        setError(err instanceof Error ? err.message : '版本内容加载失败');
      } finally {
        setBusy(false);
      }
    },
    [projectId, stage],
  );

  const rollback = useCallback(
    async (targetVersion: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/stage/${stage}/rollback`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({targetVersion, confirmStale: true}),
        });
        if (!res.ok) throw new Error(await readError(res));
        onRolledBack();
      } catch (err) {
        setError(err instanceof Error ? err.message : '回滚失败');
        setBusy(false);
      }
    },
    [projectId, stage, onRolledBack],
  );

  return (
    <div className="drawer-overlay" onClick={onClose} role="presentation">
      <aside
        className="drawer"
        aria-label="版本历史"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="drawer-title">
            {viewing ? `v${viewing.version} 内容` : '版本历史'}
          </span>
          <div style={{display: 'flex', gap: 8}}>
            {viewing ? (
              <button type="button" className="btn btn-sm" onClick={() => setViewing(null)}>
                返回列表
              </button>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        {error ? (
          <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div>
        ) : null}
        <div className="drawer-body">
          {viewing ? (
            <div
              className={
                outputKind === 'json' ? 'drawer-content-view json' : 'drawer-content-view'
              }
            >
              {outputKind === 'json' ? prettyJson(viewing.content) : viewing.content}
            </div>
          ) : versions === null ? (
            <div className="loading">正在加载版本历史…</div>
          ) : (
            versions.map((v) => (
              <div key={v.version} className={`version-row${v.isActive ? ' active' : ''}`}>
                <div className="version-top">
                  <span className="version-id mono">v{v.version}</span>
                  <span className="badge" data-version-source={v.source}>
                    {VERSION_SOURCE_LABELS[v.source] ?? v.source}
                  </span>
                  {v.isActive ? <span className="badge" data-stage-state="generated">Active</span> : null}
                  {v.isLocked ? <span className="badge" data-stage-state="locked">Locked</span> : null}
                </div>
                <div className="version-meta">
                  {v.promptVersion ? <span className="mono">{v.promptVersion}</span> : null}
                  {v.model ? <span className="mono">{v.model}</span> : null}
                  <span className="mono">{formatDateTime(v.createdAt)}</span>
                  {v.note ? <span>{v.note}</span> : null}
                </div>
                <div className="version-preview">{v.preview}</div>
                {confirmRollback === v.version ? (
                  <div className="confirm-bar" style={{border: 'none', padding: '8px 0', background: 'transparent'}} role="alert">
                    <span>
                      回滚不会删除后续版本，而是复制 v{v.version} 生成一个新版本。
                      {stageLocked ? '当前阶段已锁定，下游进度将失效（stale）。' : ''}
                    </span>
                    <div className="confirm-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => void rollback(v.version)}
                      >
                        {busy ? '回滚中…' : '确认回滚'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => setConfirmRollback(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="version-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => void viewVersion(v.version)}
                    >
                      查看内容
                    </button>
                    {!v.isActive ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => setConfirmRollback(v.version)}
                      >
                        回滚到 v{v.version}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

'use client';

import {useCallback, useEffect, useState} from 'react';

/**
 * Narration 区（M3-A §二十三/二十四）：Script V2 → Narration Plan。
 * 轻量只读：source 状态 + plan 状态 + unit 统计 + Build + Plan Viewer。
 * 旁白修改请回到 Script V2 manual edit → lock → rebuild（不允许改 plan 双真相）。
 */

interface NarrationUnit {
  id: string;
  chapter: number;
  kind: 'speech' | 'pause' | 'visual_breath' | 'prosody';
  text: string | null;
  directive: string | null;
  pauseMs: number | null;
  evidenceIds: string[];
}

interface NarrationReadiness {
  status: 'ready' | 'stale' | 'missing' | 'not_locked';
  scriptV2Status: string | null;
  scriptV2LockedVersion: number | null;
  latestPlanSourceVersion: number | null;
  currentPlan: {
    schemaVersion: string;
    compilerVersion: string;
    source: {stage: string; version: number; promptVersion: string | null};
    chapters: Array<{chapter: number; title: string}>;
    units: NarrationUnit[];
  } | null;
  artifactVersion: number | null;
}

const STATUS_LABELS: Record<string, string> = {
  ready: '已就绪',
  stale: '已失效',
  missing: '未生成',
  not_locked: '待锁定',
};

const KIND_LABELS: Record<string, string> = {
  speech: '口播',
  pause: '停顿',
  visual_breath: '画面留白',
  prosody: '韵律',
};

export function NarrationPanel({
  projectId,
  scriptV2StageKey,
}: {
  projectId: string;
  /** script_v2 阶段状态指纹（status+updated_at），变化时重新拉取。 */
  scriptV2StageKey: string;
}) {
  const [data, setData] = useState<NarrationReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showUnits, setShowUnits] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-plan`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as NarrationReadiness);
      setError(null);
    } catch {
      setError('Narration 数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, scriptV2StageKey]);

  const build = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-plan`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '构建失败');
    } finally {
      setBusy(false);
    }
  }, [projectId, load]);

  const plan = data?.currentPlan ?? null;
  const counts = plan
    ? {
        speech: plan.units.filter((u) => u.kind === 'speech').length,
        pause: plan.units.filter((u) => u.kind === 'pause').length,
        visual_breath: plan.units.filter((u) => u.kind === 'visual_breath').length,
        prosody: plan.units.filter((u) => u.kind === 'prosody').length,
      }
    : null;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Narration">
      <div className="stage-panel-head">
        <div>
          <h2 className="stage-panel-title">Narration</h2>
          <p className="stage-panel-sub">
            Script V2 → Narration Plan（TTS 输入契约 · 音频阶段 M3-A）
          </p>
        </div>
        <div className="stage-actions">
          {plan ? (
            <button type="button" className="btn btn-sm" onClick={() => setShowUnits((v) => !v)}>
              {showUnits ? '收起 Units' : '查看 Units'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || data?.status === 'not_locked'}
            onClick={() => void build()}
          >
            {busy ? '构建中…' : plan ? '重新构建 Plan' : 'Build Narration Plan'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div>
      ) : null}

      <div className="stage-meta">
        {data ? (
          <>
            <span className="badge" data-stage-state={data.status === 'ready' ? 'locked' : data.status === 'stale' ? 'stale' : 'not_started'}>
              {STATUS_LABELS[data.status]}
            </span>
            <span>
              Source{' '}
              <span className="mono">
                Script V2 {data.scriptV2LockedVersion !== null ? `v${data.scriptV2LockedVersion}` : '—'}（{data.scriptV2Status ?? '—'}）
              </span>
            </span>
            {plan ? (
              <>
                <span>
                  口播 <span className="mono">{counts!.speech}</span> · 停顿{' '}
                  <span className="mono">{counts!.pause}</span> · 留白{' '}
                  <span className="mono">{counts!.visual_breath}</span> · 韵律{' '}
                  <span className="mono">{counts!.prosody}</span>
                </span>
                <span className="mono">
                  {plan.schemaVersion} · compiler@{plan.compilerVersion} · artifact v
                  {data.artifactVersion}
                </span>
              </>
            ) : null}
            {data.status === 'not_locked' ? (
              <span>先锁定 Script V2，才能构建 Narration Plan</span>
            ) : null}
            {data.status === 'stale' ? (
              <span>
                已有 plan 基于 Script V2 v{data.latestPlanSourceVersion}，与当前锁定版本不一致——请重新构建
              </span>
            ) : null}
          </>
        ) : (
          <span>正在检查…</span>
        )}
      </div>

      {showUnits && plan ? (
        <div className="scene-list" style={{maxHeight: 360}}>
          {plan.units.map((unit) => (
            <div key={unit.id} className="scene-row" style={{cursor: 'default', gridTemplateColumns: '72px 1fr auto'}}>
              <span className="scene-id mono">{unit.id}</span>
              <span className="scene-line">
                <span className="badge" data-stage-state={unit.kind === 'speech' ? 'generated' : 'not_started'} style={{marginRight: 8}}>
                  {KIND_LABELS[unit.kind]}
                </span>
                {unit.kind === 'speech'
                  ? unit.text
                  : unit.kind === 'pause'
                    ? unit.pauseMs !== null
                      ? `停顿 ${unit.pauseMs}ms`
                      : `停顿（${unit.directive}）`
                    : unit.kind === 'visual_breath'
                      ? '画面留白（时长由后续阶段决定）'
                      : `韵律：${unit.directive}`}
                {unit.evidenceIds.length > 0 ? (
                  <span className="mono" style={{marginLeft: 8, color: 'var(--muted)'}}>
                    [{unit.evidenceIds.join(' ')}]
                  </span>
                ) : null}
              </span>
              <span className="scene-dur mono">第{unit.chapter}章</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

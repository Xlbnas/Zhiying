'use client';

import {useCallback, useEffect, useState} from 'react';

/**
 * Timing Reconciliation 区（M3-D）：Narration Master + locked Scenes →
 * deterministic effective scene frame timeline。轻量只读 + Build +
 * Scene Timing Viewer（source weight / effective 帧区间对照）。
 * 不提供 timeline editor——改时间请回到上游阶段重建。
 */

interface ReconciledScene {
  sceneId: string;
  chapter: number;
  authoredStartFrame: number;
  authoredDurationInFrames: number;
  sourceWeightStartFrame: number;
  sourceWeightEndFrame: number;
  effectiveStartFrame: number;
  effectiveEndFrame: number;
  effectiveDurationFrames: number;
}

interface ReconciliationReadiness {
  status: 'ready' | 'stale' | 'missing' | 'not_ready';
  compilerVersion: string;
  sources: {
    scenesVersion: number;
    audioArtifactVersion: number;
    subtitleArtifactVersion: number;
  } | null;
  artifactVersion: number | null;
  sceneCount: number;
  masterDurationMs: number | null;
  sourceVisual: {
    authoredTotalFrames: number;
    rendererEndFrame: number;
    weightTotalFrames: number;
  } | null;
  target: {
    totalFrames: number;
    renderedDurationMs: number;
    frameResidualMs: number;
  } | null;
  unresolvedCount: number;
  reconciliation: {scenes: ReconciledScene[]} | null;
}

const STATUS_LABELS: Record<string, string> = {
  ready: '已就绪',
  stale: '已失效',
  missing: '未生成',
  not_ready: '待上游',
};

export function TimingReconciliationPanel({
  projectId,
  /** scenes/script_v2 阶段状态指纹，变化时重新拉取。 */
  sourceStageKey,
}: {
  projectId: string;
  sourceStageKey: string;
}) {
  const [data, setData] = useState<ReconciliationReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showScenes, setShowScenes] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/timing-reconciliation`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ReconciliationReadiness);
      setError(null);
    } catch {
      setError('Timing Reconciliation 数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, sourceStageKey]);

  const build = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/timing-reconciliation`, {method: 'POST'});
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

  if (!data) return null;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Timing Reconciliation">
      <div className="panel-head">
        <span className="panel-title">TIMING RECONCILIATION（M3-D · 帧级 · 比例重定时）</span>
        <div className="panel-head-actions">
          {data.status === 'ready' && data.reconciliation ? (
            <button type="button" className="btn btn-sm" onClick={() => setShowScenes((v) => !v)}>
              {showScenes ? '收起 Scene Timing' : '查看 Scene Timing'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !data.sources}
            onClick={() => void build()}
          >
            {busy
              ? '构建中…'
              : data.status === 'ready'
                ? '重新构建 Reconciliation'
                : 'Build Timing Reconciliation'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div>
      ) : null}

      <div className="stage-meta">
        <span className="badge" data-stage-state={data.status === 'ready' ? 'locked' : data.status === 'stale' ? 'stale' : 'not_started'}>
          {STATUS_LABELS[data.status]}
        </span>
        {data.sources ? (
          <span>
            Scenes <span className="mono">v{data.sources.scenesVersion}</span> · Audio{' '}
            <span className="mono">v{data.sources.audioArtifactVersion}</span> · Subtitle{' '}
            <span className="mono">v{data.sources.subtitleArtifactVersion}</span>
          </span>
        ) : null}
        <span>
          Compiler <span className="mono">v{data.compilerVersion}</span>
        </span>
        {data.status === 'ready' && data.sourceVisual && data.target ? (
          <>
            <span>
              Scenes <span className="mono">{data.sceneCount}</span>
            </span>
            <span>
              Source <span className="mono">{data.sourceVisual.weightTotalFrames}f</span>
              {data.sourceVisual.weightTotalFrames !== data.sourceVisual.authoredTotalFrames ||
              data.sourceVisual.rendererEndFrame !== data.sourceVisual.authoredTotalFrames ? (
                <span className="mono" style={{color: 'var(--muted)'}}>
                  （authored {data.sourceVisual.authoredTotalFrames}f / renderer-end {data.sourceVisual.rendererEndFrame}f）
                </span>
              ) : null}
            </span>
            <span>
              Master <span className="mono">{((data.masterDurationMs ?? 0) / 1000).toFixed(1)}s</span> → Target{' '}
              <span className="mono">{data.target.totalFrames}f</span>
            </span>
            <span>
              Residual <span className="mono">{data.target.frameResidualMs.toFixed(2)}ms</span>
            </span>
            <span>
              Unresolved <span className="mono">{data.unresolvedCount}</span>
            </span>
            <span className="mono">artifact v{data.artifactVersion}</span>
          </>
        ) : null}
        {data.status === 'stale' ? (
          <span>Reconciliation 已过期（source 或 compiler 已前进）——请重新构建</span>
        ) : null}
        {data.status === 'not_ready' ? (
          <span>等待 Scenes 锁定 + Narration Audio + Subtitle Timing 全部就绪</span>
        ) : null}
      </div>

      {showScenes && data.reconciliation ? (
        <div className="scene-list" style={{maxHeight: 320}}>
          {data.reconciliation.scenes.map((scene) => (
            <div key={scene.sceneId} className="scene-row" style={{cursor: 'default', gridTemplateColumns: '72px 1fr auto'}}>
              <span className="scene-id mono">{scene.sceneId}</span>
              <span className="scene-line mono">
                source {scene.sourceWeightStartFrame}–{scene.sourceWeightEndFrame}f → effective{' '}
                {scene.effectiveStartFrame}–{scene.effectiveEndFrame}f
              </span>
              <span className="scene-dur mono">
                {scene.sourceWeightEndFrame - scene.sourceWeightStartFrame}f → {scene.effectiveDurationFrames}f · 第{scene.chapter}章
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

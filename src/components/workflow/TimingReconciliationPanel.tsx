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
      setError('音画时间校准数据加载失败');
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
    <section className="stage-panel" style={{marginTop: 20}} aria-label="音画时间校准">
      <div className="panel-head">
        <span className="panel-title">音画时间校准</span>
        <div className="panel-head-actions">
          {data.status === 'ready' && data.reconciliation ? (
            <button type="button" className="btn btn-sm" onClick={() => setShowScenes((v) => !v)}>
              {showScenes ? '收起场景时间' : '查看场景时间'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !data.sources}
            onClick={() => void build()}
          >
            {busy
              ? '校准中…'
              : data.status === 'ready'
                ? '重新校准'
                : '校准音画时间'}
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
            场景 第{data.sources.scenesVersion}版 · 配音 第{data.sources.audioArtifactVersion}版 · 字幕 第{data.sources.subtitleArtifactVersion}版
          </span>
        ) : null}
        <details style={{alignSelf: 'center'}}>
          <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>技术详情</summary>
          <div className="mono" style={{marginTop: 4, fontSize: 12}}>
            Compiler v{data.compilerVersion}
            {data.artifactVersion !== null ? ` · artifact v${data.artifactVersion}` : ''}
          </div>
        </details>
        {data.status === 'ready' && data.sourceVisual && data.target ? (
          <>
            <span>
              <span className="mono">{data.sceneCount}</span> 个场景
            </span>
            <span>
              源时长 <span className="mono">{data.sourceVisual.weightTotalFrames} 帧</span>
              {data.sourceVisual.weightTotalFrames !== data.sourceVisual.authoredTotalFrames ||
              data.sourceVisual.rendererEndFrame !== data.sourceVisual.authoredTotalFrames ? (
                <span className="mono" style={{color: 'var(--muted)'}}>
                  （创作 {data.sourceVisual.authoredTotalFrames} 帧 / 渲染结束 {data.sourceVisual.rendererEndFrame} 帧）
                </span>
              ) : null}
            </span>
            <span>
              母版 <span className="mono">{((data.masterDurationMs ?? 0) / 1000).toFixed(1)} 秒</span> → 目标时长{' '}
              <span className="mono">{data.target.totalFrames} 帧</span>
            </span>
            <span>
              误差 <span className="mono">{data.target.frameResidualMs.toFixed(2)} 毫秒</span>
            </span>
            <span>
              待确认 <span className="mono">{data.unresolvedCount}</span>
            </span>
          </>
        ) : null}
        {data.status === 'stale' ? (
          <span>校准已过期（素材已更新），请重新校准</span>
        ) : null}
        {data.status === 'not_ready' ? (
          <span>需要先完成：锁定场景数据、生成配音、生成字幕</span>
        ) : null}
      </div>

      {showScenes && data.reconciliation ? (
        <div className="scene-list" style={{maxHeight: 320}}>
          {data.reconciliation.scenes.map((scene) => (
            <div key={scene.sceneId} className="scene-row" style={{cursor: 'default', gridTemplateColumns: '72px 1fr auto'}}>
              <span className="scene-id mono">{scene.sceneId}</span>
              <span className="scene-line mono">
                {scene.sourceWeightStartFrame}–{scene.sourceWeightEndFrame} 帧 →{' '}
                {scene.effectiveStartFrame}–{scene.effectiveEndFrame} 帧
              </span>
              <span className="scene-dur mono">
                {scene.sourceWeightEndFrame - scene.sourceWeightStartFrame} 帧 → {scene.effectiveDurationFrames} 帧 · 第{scene.chapter}章
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

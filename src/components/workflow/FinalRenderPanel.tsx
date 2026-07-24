'use client';

import {useCallback, useEffect, useState} from 'react';
import {FullCutPlayer} from '@/components/FullCutPlayer';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';

/**
 * Final Render 区（M3-E）：四 source 全 current → Render Final Video →
 * narrated + subtitled MP4。Player 预览用 playerPreviewProps（narration=null，
 * 仅视觉+字幕预览）；真实旁白由 Worker 渲染时注入。
 */

interface FinalRenderReadiness {
  ready: boolean;
  blockers: Array<{code: string; message: string}>;
  compilerVersion: string;
  sources: {
    scenesVersion: number;
    audioArtifactVersion: number;
    subtitleArtifactVersion: number;
    reconciliationArtifactVersion: number;
  } | null;
  sceneCount: number;
  subtitleCueCount: number;
  masterDurationMs: number | null;
  targetTotalFrames: number | null;
  durationSec: number | null;
  frameResidualMs: number | null;
  playerPreviewProps: ZhiyingFullCutProps | null;
  latestJob: {
    id: string;
    status: string;
    progress: number;
    outputPath: string | null;
    sourceArtifactVersion: number | null;
  } | null;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function FinalRenderPanel({
  projectId,
  /** 上游阶段状态指纹，变化时重新拉取。 */
  sourceStageKey,
}: {
  projectId: string;
  sourceStageKey: string;
}) {
  const [data, setData] = useState<FinalRenderReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/final-render`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as FinalRenderReadiness);
      setError(null);
    } catch {
      setError('Final Render 数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, sourceStageKey]);

  // job 进行中时轮询
  useEffect(() => {
    if (!data?.latestJob || (data.latestJob.status !== 'queued' && data.latestJob.status !== 'running')) {
      return;
    }
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [data?.latestJob, load]);

  const render = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/final-render`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '渲染任务创建失败');
    } finally {
      setBusy(false);
    }
  }, [projectId, load]);

  if (!data) return null;

  const job = data.latestJob;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Final Render">
      <div className="panel-head">
        <span className="panel-title">FINAL RENDER（M3-E · 旁白 + 字幕成片）</span>
        <div className="panel-head-actions">
          {job?.status === 'succeeded' && job.outputPath ? (
            <a className="btn btn-sm" href={`/api/jobs/${job.id}/download`} download>
              Download MP4
            </a>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!data.ready || busy}
            onClick={() => void render()}
          >
            {busy ? '创建中…' : 'Render Final Video'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div>
      ) : null}

      <div className="stage-meta">
        <span className="badge" data-stage-state={data.ready ? 'locked' : 'not_started'}>
          {data.ready ? '可渲染' : '待上游'}
        </span>
        {data.sources ? (
          <span>
            Scenes <span className="mono">v{data.sources.scenesVersion}</span> · Audio{' '}
            <span className="mono">v{data.sources.audioArtifactVersion}</span> · Subtitle{' '}
            <span className="mono">v{data.sources.subtitleArtifactVersion}</span> · Reconciliation{' '}
            <span className="mono">v{data.sources.reconciliationArtifactVersion}</span>
          </span>
        ) : null}
        <span>
          Final Source Compiler <span className="mono">v{data.compilerVersion}</span>
        </span>
        {data.ready ? (
          <>
            <span>
              Scenes <span className="mono">{data.sceneCount}</span> · Cues{' '}
              <span className="mono">{data.subtitleCueCount}</span>
            </span>
            <span>
              Master <span className="mono">{((data.masterDurationMs ?? 0) / 1000).toFixed(1)}s</span> →{' '}
              <span className="mono">{data.targetTotalFrames}f（{(data.durationSec ?? 0).toFixed(2)}s）</span>
            </span>
            <span>
              Residual <span className="mono">{(data.frameResidualMs ?? 0).toFixed(2)}ms</span>
            </span>
          </>
        ) : null}
        {job ? (
          <span>
            最近渲染{' '}
            <span className="badge" data-status={job.status}>
              {JOB_STATUS_LABELS[job.status] ?? job.status}
              {job.status === 'running' ? ` ${job.progress}%` : ''}
            </span>
            {job.sourceArtifactVersion !== null ? (
              <span className="mono" style={{marginLeft: 6}}>source v{job.sourceArtifactVersion}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {!data.ready && data.blockers.length > 0 ? (
        <div className="stage-empty">
          <ul style={{textAlign: 'left', margin: 0, paddingLeft: 20, lineHeight: 1.9}}>
            {data.blockers.map((blocker, index) => (
              <li key={index}>
                <span className="mono" style={{fontSize: 12}}>[{blocker.code}]</span> {blocker.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.ready && data.playerPreviewProps ? (
        <div className="player-frame">
          <FullCutPlayer inputProps={data.playerPreviewProps} />
        </div>
      ) : null}
    </section>
  );
}

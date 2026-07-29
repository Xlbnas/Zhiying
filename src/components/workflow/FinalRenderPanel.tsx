'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {FullCutPlayer} from '@/components/FullCutPlayer';
import {parseRenderProgressDetail} from '@/lib/render/progress-detail';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';
import {friendlyStageError} from './shared';

/**
 * Final Render 区（M3-E）：四 source 全 current → Render Final Video →
 * narrated + subtitled MP4。Player 预览用 playerPreviewProps（narration=null，
 * 仅视觉+字幕预览）；真实旁白由 Worker 渲染时注入。
 *
 * M6.3.10 轮询：
 * - latestJob queued/running → 2s 轮询进度（frame/百分比实时变化，无需 F5）
 * - latestJob === null → 10s 低频 discovery（渲染可能从面板外入队）
 * - 终态跳变 → onRenderSettled（Usage Summary 自动刷新）；unmount 清理 timer
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
    progressDetail: string | null;
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
  /** M6.3.10：渲染进入终态（succeeded/failed/cancelled）时回调一次。 */
  onRenderSettled,
}: {
  projectId: string;
  sourceStageKey: string;
  onRenderSettled?: () => void;
}) {
  const [data, setData] = useState<FinalRenderReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prevStatusRef = useRef<string | null>(null);
  const settledRef = useRef(onRenderSettled);
  settledRef.current = onRenderSettled;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/final-render`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as FinalRenderReadiness);
      setError(null);
    } catch {
      setError('最终视频数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, sourceStageKey]);

  // 终态跳变检测：active（queued/running）→ terminal 时触发一次 onRenderSettled
  useEffect(() => {
    const status = data?.latestJob?.status ?? null;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    const wasActive = prev === 'queued' || prev === 'running';
    const isTerminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    if (wasActive && isTerminal) settledRef.current?.();
  }, [data?.latestJob?.status]);

  // job 进行中 2s 轮询；无 job 时 10s discovery（面板外入队也能自动出现）
  useEffect(() => {
    const status = data?.latestJob?.status;
    if (status === 'queued' || status === 'running') {
      const timer = setInterval(() => void load(), 2000);
      return () => clearInterval(timer);
    }
    if (data && !data.latestJob) {
      const timer = setInterval(() => void load(), 10000);
      return () => clearInterval(timer);
    }
  }, [data?.latestJob, data, load]);

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
    <section className="stage-panel" style={{marginTop: 20}} aria-label="最终视频">
      <div className="panel-head">
        <span className="panel-title">最终视频</span>
        <div className="panel-head-actions">
          {job?.status === 'succeeded' && job.outputPath ? (
            <a className="btn btn-sm" href={`/api/jobs/${job.id}/download`} download>
              下载视频
            </a>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!data.ready || busy}
            onClick={() => void render()}
          >
            {busy ? '创建中…' : '生成最终视频'}
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
            场景 第{data.sources.scenesVersion}版 · 配音 第{data.sources.audioArtifactVersion}版 · 字幕 第{data.sources.subtitleArtifactVersion}版 · 校准 第{data.sources.reconciliationArtifactVersion}版
          </span>
        ) : null}
        <details style={{alignSelf: 'center'}}>
          <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>技术详情</summary>
          <div className="mono" style={{marginTop: 4, fontSize: 12}}>
            Final Source Compiler v{data.compilerVersion}
          </div>
        </details>
        {data.ready ? (
          <>
            <span>
              <span className="mono">{data.sceneCount}</span> 个场景 ·{' '}
              <span className="mono">{data.subtitleCueCount}</span> 条字幕
            </span>
            <span>
              母版 <span className="mono">{((data.masterDurationMs ?? 0) / 1000).toFixed(1)} 秒</span> →{' '}
              <span className="mono">{data.targetTotalFrames} 帧（{(data.durationSec ?? 0).toFixed(2)} 秒）</span>
            </span>
            <span>
              误差 <span className="mono">{(data.frameResidualMs ?? 0).toFixed(2)} 毫秒</span>
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
            {job.status === 'running' && parseRenderProgressDetail(job.progressDetail) ? (
              <span style={{marginLeft: 6, color: 'var(--muted)', fontSize: 12}}>
                {parseRenderProgressDetail(job.progressDetail)!.label}
              </span>
            ) : null}
            {job.sourceArtifactVersion !== null ? (
              <span className="mono" style={{marginLeft: 6}}>素材 第{job.sourceArtifactVersion}版</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {!data.ready && data.blockers.length > 0 ? (
        <div className="stage-empty">
          <ul style={{textAlign: 'left', margin: 0, paddingLeft: 20, lineHeight: 1.9}}>
            {data.blockers.map((blocker, index) => (
              <li key={index}>
                {friendlyStageError(blocker.code, blocker.message)}
                <details style={{marginTop: 6}}>
                  <summary style={{cursor: 'pointer', opacity: 0.75}}>技术详情</summary>
                  <div className="mono" style={{marginTop: 4, fontSize: 12}}>
                    [{blocker.code}] {blocker.message}
                  </div>
                </details>
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

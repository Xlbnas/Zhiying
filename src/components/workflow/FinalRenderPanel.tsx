'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {FullCutPlayer} from '@/components/FullCutPlayer';
import {createEtaEstimator} from '@/lib/render/eta';
import {parseRenderProgressDetail, round1} from '@/lib/render/progress-detail';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';
import {friendlyStageError} from './shared';

/**
 * Final Render 区（M3-E）：四 source 全 current → Render Final Video →
 * narrated + subtitled MP4。Player 预览用 playerPreviewProps（narration=null，
 * 仅视觉+字幕预览）；真实旁白由 Worker 渲染时注入。
 *
 * M6.3.10 轮询：
 * - latestJob queued/running → 2s 轮询进度（frame/百分比实时变化，无需 F5）
 * - 无 active job（从未渲染或仅终态 job）→ 10s 低频 discovery（渲染可能从面板外入队）
 * - 终态跳变 → onRenderSettled（Usage Summary 自动刷新）；unmount 清理 timer
 * M6.3.13：assetsRefreshKey（素材绑定变化）追加为 load 依赖，asset mutation
 * 后 readiness 自动刷新（asset mutation 不改 project_stages 指纹）。
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
    outputSha256: string | null;
    /** M6.3.12：manifest 中的视觉审计 / 响度测量 JSON（历史 job 为 null）。 */
    auditJson: string | null;
    loudnessJson: string | null;
    sourceArtifactVersion: number | null;
  } | null;
}

/** M6.3.12：产物信息里的响度摘要（loudnorm 归一化后实测）。 */
function summarizeLoudness(loudnessJson: string | null): string | null {
  if (!loudnessJson) return null;
  try {
    const parsed = JSON.parse(loudnessJson) as {
      output?: {inputI?: number; inputTp?: number} | null;
    };
    const out = parsed.output;
    if (!out || typeof out.inputI !== 'number') return null;
    return `响度 ${out.inputI.toFixed(1)} LUFS · 峰值 ${typeof out.inputTp === 'number' ? out.inputTp.toFixed(1) : '?'} dBTP`;
  } catch {
    return null;
  }
}

/** M6.3.12：产物信息里的视觉审计摘要（title/MG 占比 + 复用标记数）。 */
function summarizeVisualAudit(auditJson: string | null): string | null {
  if (!auditJson) return null;
  try {
    const parsed = JSON.parse(auditJson) as {
      titleMgOnly?: {ratio?: number};
      assetReuse?: Array<{suspicious?: boolean}>;
      placeholder?: {scenes?: number};
    };
    const ratio = typeof parsed.titleMgOnly?.ratio === 'number' ? Math.round(parsed.titleMgOnly.ratio * 100) : null;
    const suspicious = (parsed.assetReuse ?? []).filter((r) => r.suspicious).length;
    const parts: string[] = [];
    parts.push(`placeholder ${parsed.placeholder?.scenes ?? 0}`);
    if (ratio !== null) parts.push(`字卡/MG ${ratio}%`);
    if (suspicious > 0) parts.push(`复用素材 ${suspicious}`);
    return `视觉审计 ${parts.join(' · ')}`;
  } catch {
    return null;
  }
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** M6.3.13：预计剩余 —— ≥90s 显示约 X 分钟，否则约 X 秒。 */
function formatRemaining(remainingSec: number): string {
  if (remainingSec >= 90) return `约 ${Math.ceil(remainingSec / 60)} 分钟`;
  return `约 ${Math.max(1, Math.ceil(remainingSec))} 秒`;
}

/** M6.3.13：预计完成时刻 HH:mm。 */
function formatClock(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function FinalRenderPanel({
  projectId,
  /** 上游阶段状态指纹，变化时重新拉取。 */
  sourceStageKey,
  /** M6.3.13：素材绑定变化计数器（asset mutation 不改 project_stages，靠它失效重拉）。 */
  assetsRefreshKey,
  /** M6.3.10：渲染进入终态（succeeded/failed/cancelled）时回调一次。 */
  onRenderSettled,
}: {
  projectId: string;
  sourceStageKey: string;
  assetsRefreshKey?: number;
  onRenderSettled?: () => void;
}) {
  const [data, setData] = useState<FinalRenderReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prevStatusRef = useRef<string | null>(null);
  const settledRef = useRef(onRenderSettled);
  settledRef.current = onRenderSettled;
  // M6.3.13：ETA 估算器跨 2s 轮询保持 EMA 状态；job 切换时以服务端 fps 先验重启
  const etaRef = useRef(createEtaEstimator());
  const etaJobRef = useRef<string | null>(null);

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
  }, [load, sourceStageKey, assetsRefreshKey]);

  // 终态跳变检测：active（queued/running）→ terminal 时触发一次 onRenderSettled
  useEffect(() => {
    const status = data?.latestJob?.status ?? null;
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    const wasActive = prev === 'queued' || prev === 'running';
    const isTerminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    if (wasActive && isTerminal) settledRef.current?.();
  }, [data?.latestJob?.status]);

  // job 进行中 2s 轮询；无 active job 时 10s discovery（面板外入队 / 素材变化
  // 后 readiness 翻转都能自动出现；M6.3.13 补洞：有过终态 job 也继续 discovery）
  useEffect(() => {
    const status = data?.latestJob?.status;
    if (status === 'queued' || status === 'running') {
      const timer = setInterval(() => void load(), 2000);
      return () => clearInterval(timer);
    }
    if (data) {
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

  // M6.3.13：进度单一数据源 —— percent/fps/ETA 均来自 progress_detail 同一快照，
  // 仅在 detail 缺失时回退 render_jobs.progress（Remotion 加权值，与帧数口径不同）
  const runningJob = data?.latestJob?.status === 'running' ? data.latestJob : null;
  const jobDetail = runningJob ? parseRenderProgressDetail(runningJob.progressDetail) : null;
  const etaEstimate = useMemo(() => {
    if (!runningJob || !jobDetail) return null;
    if (etaJobRef.current !== runningJob.id) {
      etaJobRef.current = runningJob.id;
      etaRef.current.reset({fps: jobDetail.fps});
    }
    const frames = jobDetail.encodedFrames ?? jobDetail.renderedFrames;
    if (frames == null || jobDetail.totalFrames == null) return null;
    const atMs = Date.parse(jobDetail.updatedAt);
    return etaRef.current.add({
      frames,
      totalFrames: jobDetail.totalFrames,
      atMs: Number.isFinite(atMs) ? atMs : Date.now(),
      stage: jobDetail.stage,
    });
  }, [runningJob, jobDetail]);

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
              {job.status === 'running' && !jobDetail ? ` ${job.progress}%` : ''}
            </span>
            {job.status === 'running' && jobDetail ? (
              <span style={{marginLeft: 6, color: 'var(--muted)', fontSize: 12}}>
                {jobDetail.label}（{jobDetail.percent ?? job.progress}%）
              </span>
            ) : null}
            {job.sourceArtifactVersion !== null ? (
              <span className="mono" style={{marginLeft: 6}}>素材 第{job.sourceArtifactVersion}版</span>
            ) : null}
          </span>
        ) : null}
        {job?.status === 'running' &&
        jobDetail &&
        (jobDetail.stage === 'encode' || jobDetail.stage === 'render') ? (
          <span style={{color: 'var(--muted)', fontSize: 12}}>
            {etaEstimate
              ? `速度 ${round1(etaEstimate.fps)} fps · 预计剩余 ${formatRemaining(etaEstimate.remainingSec)} · 预计完成 ${formatClock(etaEstimate.finishAt)}`
              : '正在估算…'}
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
          {/* M6.3.11：渲染成功后播放器直接播放实际产物（与「下载视频」同一
              artifact identity，所见即所下）；尚无成功产物时才是实时预览。 */}
          {job?.status === 'succeeded' && job.outputPath ? (
            <video
              controls
              preload="metadata"
              style={{width: '100%', display: 'block', background: '#000'}}
              src={`/api/jobs/${job.id}/download?inline=1`}
            />
          ) : (
            <FullCutPlayer inputProps={data.playerPreviewProps} />
          )}
        </div>
      ) : null}

      {job?.status === 'succeeded' && job.outputPath ? (
        <div className="stage-meta">
          <details style={{alignSelf: 'center'}}>
            <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>产物信息</summary>
            <div className="mono" style={{marginTop: 4, fontSize: 12}}>
              job {job.id}
              {job.outputSha256 ? (
                <>
                  {' · '}sha256 {job.outputSha256.slice(0, 16)}…
                </>
              ) : null}
              {' · '}下载文件名 zhiying-{job.id}.mp4
              {summarizeLoudness(job.loudnessJson) ? (
                <>
                  {' · '}{summarizeLoudness(job.loudnessJson)}
                </>
              ) : null}
              {summarizeVisualAudit(job.auditJson) ? (
                <>
                  {' · '}{summarizeVisualAudit(job.auditJson)}
                </>
              ) : null}
            </div>
          </details>
        </div>
      ) : null}
    </section>
  );
}

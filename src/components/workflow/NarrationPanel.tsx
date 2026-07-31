'use client';

import {useCallback, useEffect, useState} from 'react';
import {canRequestAudioGeneration} from '@/lib/narration/contamination';
import {STAGE_STATE_LABELS, type ActivityResponse} from './shared';

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

interface AudioOverview {
  status: 'ready' | 'generating' | 'failed' | 'stale' | 'missing' | 'not_ready' | 'blocked_contaminated';
  planReady: boolean;
  providerName: string;
  voiceProfile: {id: string; revision: string};
  speechComplete: number;
  speechTotal: number;
  master: {filePath: string; durationMs: number} | null;
  contamination: {
    unitCount: number;
    units: Array<{unitId: string; summary: string}>;
    recoveryRequired: true;
    recoverySteps: string[];
  } | null;
  providerDetail: {
    model: string;
    providerVersion: string | null;
    providerCommit: string | null;
  } | null;
  units: Array<{
    unitId: string;
    kind: 'speech' | 'pause' | 'visual_breath' | 'prosody';
    text: string | null;
    directive: string | null;
    pauseMs: number | null;
    jobStatus: string | null;
    jobId: string | null;
    durationMs: number | null;
    outputPath: string | null;
  }>;
}

interface SubtitleCue {
  id: number;
  segmentId: string;
  unitId: string;
  chapter: number;
  text: string;
  startMs: number;
  endMs: number;
}

interface SubtitleReadiness {
  status: 'ready' | 'stale' | 'missing' | 'not_ready';
  compilerVersion: string;
  sourceAudio: {
    artifactId: string;
    artifactVersion: number;
    masterDurationMs: number;
  } | null;
  artifactVersion: number | null;
  cueCount: number;
  timelineDurationMs: number | null;
  unresolvedCount: number;
  timing: {cues: SubtitleCue[]} | null;
}

function formatCueTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}

const STATUS_LABELS: Record<string, string> = {
  ready: '已就绪',
  stale: '已失效',
  missing: '未生成',
  not_locked: '待锁定',
};

const AUDIO_STATUS_LABELS: Record<string, string> = {
  ready: '已就绪',
  generating: '生成中',
  failed: '失败',
  stale: '已失效',
  missing: '未生成',
  not_ready: '待汇总',
  blocked_contaminated: '已阻断（含控制指令）',
};

const SUBTITLE_STATUS_LABELS: Record<string, string> = {
  ready: '已就绪',
  stale: '已失效',
  missing: '未生成',
  not_ready: '待配音',
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
  activity,
  onActivityMutation,
}: {
  projectId: string;
  /** script_v2 阶段状态指纹（status+updated_at），变化时重新拉取。 */
  scriptV2StageKey: string;
  /** M7：统一 activity 订阅；存在时 audio/subtitle 从 activity 自动刷新，不再单独轮询。 */
  activity?: ActivityResponse | null;
  /** M7.3A.2：任何会创建后台任务的操作成功后通知 Workspace 启动 activity watch。 */
  onActivityMutation?: () => void;
}) {
  const [data, setData] = useState<NarrationReadiness | null>(null);
  const [audio, setAudio] = useState<AudioOverview | null>(null);
  const [subtitle, setSubtitle] = useState<SubtitleReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioBusy, setAudioBusy] = useState<string | null>(null);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [showUnits, setShowUnits] = useState(false);
  const [showCues, setShowCues] = useState(false);

  /** 加载 plan（script_v2 变化时）；audio/subtitle 优先由 activity 订阅驱动。 */
  const loadPlan = useCallback(async () => {
    try {
      const planRes = await fetch(`/api/projects/${projectId}/narration-plan`, {cache: 'no-store'});
      if (!planRes.ok) throw new Error(`HTTP ${planRes.status}`);
      setData((await planRes.json()) as NarrationReadiness);
      setError(null);
    } catch {
      setError('旁白数据加载失败');
    }
  }, [projectId]);

  const loadAudioSubtitle = useCallback(async () => {
    try {
      const [audioRes, subtitleRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/narration-audio`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/subtitle-timing`, {cache: 'no-store'}),
      ]);
      if (audioRes.ok) {
        setAudio((await audioRes.json()) as AudioOverview);
      }
      if (subtitleRes.ok) {
        setSubtitle((await subtitleRes.json()) as SubtitleReadiness);
      }
      setError(null);
    } catch {
      setError('旁白数据加载失败');
    }
  }, [projectId]);

  const load = useCallback(async () => {
    await loadPlan();
    await loadAudioSubtitle();
  }, [loadPlan, loadAudioSubtitle]);

  useEffect(() => {
    void loadPlan();
    // 无 activity 时兜底拉一次音频/字幕
    if (!activity) {
      void loadAudioSubtitle();
    }
  }, [loadPlan, loadAudioSubtitle, scriptV2StageKey, activity]);

  // M7：统一 activity 订阅 → audio/subtitle 自动刷新
  useEffect(() => {
    if (activity?.audioOverview) {
      setAudio(activity.audioOverview);
    }
    if (activity?.subtitleReadiness) {
      setSubtitle(activity.subtitleReadiness);
    }
  }, [activity]);

  const build = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-plan`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      onActivityMutation?.();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '构建失败');
    } finally {
      setBusy(false);
    }
  }, [projectId, load, onActivityMutation]);

  const generateAudio = useCallback(async () => {
    setAudioBusy('generate');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-audio`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      onActivityMutation?.();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '音频任务创建失败');
    } finally {
      setAudioBusy(null);
    }
  }, [projectId, load, onActivityMutation]);

  const cancelAudio = useCallback(async () => {
    setAudioBusy('cancel');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-audio/cancel`, {method: 'POST'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onActivityMutation?.();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消失败');
    } finally {
      setAudioBusy(null);
    }
  }, [projectId, load, onActivityMutation]);

  const buildSubtitles = useCallback(async () => {
    setSubtitleBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/subtitle-timing`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      onActivityMutation?.();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '字幕构建失败');
    } finally {
      setSubtitleBusy(false);
    }
  }, [projectId, load, onActivityMutation]);

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
    <section id="narration-panel" className="stage-panel" style={{marginTop: 20}} aria-label="旁白">
      <div className="stage-panel-head">
        <div>
          <h2 className="stage-panel-title">旁白</h2>
          <p className="stage-panel-sub">
            把脚本整理成可以配音的旁白文本
          </p>
        </div>
        <div className="stage-actions">
          {plan ? (
            <button type="button" className="btn btn-sm" onClick={() => setShowUnits((v) => !v)}>
              {showUnits ? '收起分段' : '查看分段'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || data?.status === 'not_locked'}
            onClick={() => void build()}
          >
            {busy ? '生成中…' : plan ? '重新生成旁白' : '生成旁白'}
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
              基于脚本 V2 第{' '}
              {data.scriptV2LockedVersion !== null ? data.scriptV2LockedVersion : '—'} 版（
              {data.scriptV2Status
                ? (STAGE_STATE_LABELS[data.scriptV2Status as keyof typeof STAGE_STATE_LABELS] ?? data.scriptV2Status)
                : '—'}
              ）
            </span>
            {plan ? (
              <>
                <span>
                  口播 <span className="mono">{counts!.speech}</span> · 停顿{' '}
                  <span className="mono">{counts!.pause}</span> · 留白{' '}
                  <span className="mono">{counts!.visual_breath}</span> · 韵律{' '}
                  <span className="mono">{counts!.prosody}</span>
                </span>
                <details style={{alignSelf: 'center'}}>
                  <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>技术详情</summary>
                  <div className="mono" style={{marginTop: 4, fontSize: 12}}>
                    {plan.schemaVersion} · compiler@{plan.compilerVersion} · artifact v
                    {data.artifactVersion}
                  </div>
                </details>
              </>
            ) : null}
            {data.status === 'not_locked' ? (
              <span>先锁定脚本 V2，才能生成旁白</span>
            ) : null}
            {data.status === 'stale' ? (
              <span>旁白已过期（脚本已更新），请重新生成</span>
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
                      ? `停顿 ${unit.pauseMs} 毫秒`
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

      {/* Narration Audio 区（M3-B）：speech unit → TTS → manifest + master */}
      {audio && data?.status === 'ready' ? (
        <>
          <div className="panel-head" style={{borderTop: '1px solid var(--border)'}}>
            <span className="panel-title">配音</span>
            <div className="panel-head-actions">
              {audio.units.some((u) => u.jobStatus === 'queued' || u.jobStatus === 'running') ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={audioBusy !== null}
                  onClick={() => void cancelAudio()}
                >
                  {audioBusy === 'cancel' ? '取消中…' : '取消配音任务'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={audioBusy !== null || !canRequestAudioGeneration(audio.status)}
                onClick={() => void generateAudio()}
              >
                {audioBusy === 'generate'
                  ? '提交中…'
                  : audio.status === 'ready'
                    ? '配音已就绪'
                    : audio.status === 'blocked_contaminated'
                      ? '已阻断，需重建旁白'
                      : '生成配音'}
              </button>
            </div>
          </div>
          <div className="stage-meta">
            <span className="badge" data-stage-state={audio.status === 'ready' ? 'locked' : audio.status === 'failed' || audio.status === 'blocked_contaminated' ? 'stale' : 'generated'}>
              {AUDIO_STATUS_LABELS[audio.status]}
            </span>
            <span>
              配音服务 <span className="mono">{audio.providerName}</span> · 声音{' '}
              <span className="mono">
                {audio.voiceProfile.id}@{audio.voiceProfile.revision}
              </span>
            </span>
            <span>
              完成 <span className="mono">{audio.speechComplete}/{audio.speechTotal}</span>
            </span>
            {audio.master ? (
              <span>
                母版 <span className="mono">{(audio.master.durationMs / 1000).toFixed(1)} 秒</span>
              </span>
            ) : null}
            {audio.providerDetail ? (
              <details style={{alignSelf: 'center'}}>
                <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>技术详情</summary>
                <div className="mono" style={{marginTop: 4, fontSize: 12}}>
                  模型 {audio.providerDetail.model}
                  {audio.providerDetail.providerCommit
                    ? ` · commit ${audio.providerDetail.providerCommit.slice(0, 12)}`
                    : ''}
                  {` · providerVersion=${audio.providerDetail.providerVersion ?? 'n/a'}`}
                </div>
              </details>
            ) : null}
          </div>
          {audio.contamination ? (
            <div
              role="alert"
              style={{
                margin: '10px 20px',
                padding: '12px 14px',
                border: '1px solid var(--danger, #c0392b)',
                borderRadius: 6,
                background: 'color-mix(in srgb, var(--danger, #c0392b) 8%, transparent)',
              }}
            >
              <strong>当前旁白计划含控制指令，不能生成配音。</strong>
              <div style={{marginTop: 6, fontSize: 13}}>
                检测到 <span className="mono">{audio.contamination.unitCount}</span> 个口播单元含
                @delivery/@pause/@silence 等控制指令。生成配音已被禁用；历史污染音频仅供事故审计，
                不可继续使用。
              </div>
              <details style={{marginTop: 6, fontSize: 12}}>
                <summary style={{cursor: 'pointer'}}>
                  污染单元（{audio.contamination.unitCount}）
                </summary>
                <ul className="mono" style={{margin: '6px 0 0', paddingLeft: 18}}>
                  {audio.contamination.units.slice(0, 10).map((u) => (
                    <li key={u.unitId}>
                      {u.unitId} — {u.summary}
                    </li>
                  ))}
                  {audio.contamination.unitCount > 10 ? <li>…</li> : null}
                </ul>
              </details>
              <div style={{marginTop: 8, fontSize: 13}}>
                <strong>恢复步骤：</strong>
                <ol style={{margin: '4px 0 0', paddingLeft: 20}}>
                  {audio.contamination.recoverySteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            </div>
          ) : null}
          <div className="scene-list" style={{maxHeight: 280}}>
            {audio.units.map((unit) => (
              <div key={unit.unitId} className="scene-row" style={{cursor: 'default', gridTemplateColumns: '72px 1fr auto'}}>
                <span className="scene-id mono">{unit.unitId}</span>
                <span className="scene-line">
                  <span className="badge" data-stage-state={unit.kind === 'speech' ? 'generated' : 'not_started'} style={{marginRight: 8}}>
                    {KIND_LABELS[unit.kind]}
                  </span>
                  {unit.kind === 'speech'
                    ? (unit.text ?? '').slice(0, 42)
                    : unit.kind === 'pause'
                      ? unit.pauseMs !== null
                        ? `停顿 ${unit.pauseMs} 毫秒`
                        : `停顿（${unit.directive}）· 未解析`
                      : unit.kind === 'prosody'
                        ? `韵律：${unit.directive}（未应用）`
                        : '画面留白（时长待定）'}
                </span>
                <span className="scene-dur mono" style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  {unit.kind === 'speech' && unit.jobStatus ? (
                    <span className="badge" data-status={unit.jobStatus}>
                      {audio.contamination && unit.jobStatus === 'succeeded'
                        ? '历史污染音频 · 仅供审计'
                        : unit.jobStatus === 'succeeded'
                          ? '已完成'
                          : unit.jobStatus === 'failed'
                            ? '失败'
                            : unit.jobStatus === 'cancelled'
                              ? '已取消'
                              : unit.jobStatus === 'running'
                                ? '合成中'
                                : '排队中'}
                    </span>
                  ) : null}
                  {unit.durationMs !== null ? `${(unit.durationMs / 1000).toFixed(1)}s` : ''}
                  {unit.kind === 'speech' && unit.jobStatus === 'succeeded' ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <audio
                      controls
                      preload="none"
                      src={`/api/projects/${projectId}/narration-audio/unit/${unit.unitId}`}
                      style={{height: 26, width: 180}}
                    />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {audio.master ? (
            <div style={{padding: '10px 20px', borderTop: '1px solid var(--border)'}}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio
                controls
                preload="none"
                src={`/api/projects/${projectId}/narration-audio/master`}
                style={{width: '100%', height: 32}}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {/* Subtitle Timing 区（M3-C）：Narration Master → deterministic 字幕时间轴 */}
      {subtitle ? (
        <>
          <div className="panel-head" style={{borderTop: '1px solid var(--border)'}}>
            <span className="panel-title">字幕</span>
            <div className="panel-head-actions">
              {subtitle.status === 'ready' && subtitle.timing ? (
                <button type="button" className="btn btn-sm" onClick={() => setShowCues((v) => !v)}>
                  {showCues ? '收起字幕' : '查看字幕'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={subtitleBusy || !subtitle.sourceAudio}
                onClick={() => void buildSubtitles()}
              >
                {subtitleBusy
                  ? '生成中…'
                  : subtitle.status === 'ready'
                    ? '重新生成字幕'
                    : '生成字幕'}
              </button>
            </div>
          </div>
          <div className="stage-meta">
            <span className="badge" data-stage-state={subtitle.status === 'ready' ? 'locked' : subtitle.status === 'stale' ? 'stale' : 'not_started'}>
              {SUBTITLE_STATUS_LABELS[subtitle.status]}
            </span>
            {subtitle.sourceAudio ? (
              <details style={{alignSelf: 'center'}}>
                <summary style={{cursor: 'pointer', opacity: 0.75, fontSize: 12}}>技术详情</summary>
                <div className="mono" style={{marginTop: 4, fontSize: 12}}>
                  Source Audio Manifest v{subtitle.sourceAudio.artifactVersion} · Subtitle Compiler v
                  {subtitle.compilerVersion}
                  {subtitle.artifactVersion !== null ? ` · artifact v${subtitle.artifactVersion}` : ''}
                </div>
              </details>
            ) : null}
            {subtitle.status === 'ready' ? (
              <>
                <span>
                  字幕条数 <span className="mono">{subtitle.cueCount}</span>
                </span>
                <span>
                  总时长 <span className="mono">{((subtitle.timelineDurationMs ?? 0) / 1000).toFixed(1)} 秒</span>
                </span>
                <span>
                  待确认 <span className="mono">{subtitle.unresolvedCount}</span>
                </span>
              </>
            ) : null}
            {subtitle.status === 'stale' ? (
              <span>字幕已过期（配音已更新），请重新生成</span>
            ) : null}
            {subtitle.status === 'not_ready' ? (
              <span>生成配音后才能生成字幕</span>
            ) : null}
          </div>
          {showCues && subtitle.timing ? (
            <div className="scene-list" style={{maxHeight: 320}}>
              {subtitle.timing.cues.map((cue) => (
                <div key={cue.id} className="scene-row" style={{cursor: 'default', gridTemplateColumns: '72px 1fr auto'}}>
                  <span className="scene-id mono">#{cue.id}</span>
                  <span className="scene-line">
                    <span className="mono" style={{marginRight: 8, color: 'var(--muted)'}}>
                      {formatCueTime(cue.startMs)} → {formatCueTime(cue.endMs)}
                    </span>
                    {cue.text}
                  </span>
                  <span className="scene-dur mono">{cue.segmentId} · 第{cue.chapter}章</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

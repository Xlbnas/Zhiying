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

interface AudioOverview {
  status: 'ready' | 'generating' | 'failed' | 'stale' | 'missing' | 'not_ready';
  planReady: boolean;
  providerName: string;
  voiceProfile: {id: string; revision: string};
  speechComplete: number;
  speechTotal: number;
  master: {filePath: string; durationMs: number} | null;
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
  const [audio, setAudio] = useState<AudioOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioBusy, setAudioBusy] = useState<string | null>(null);
  const [showUnits, setShowUnits] = useState(false);

  const load = useCallback(async () => {
    try {
      const [planRes, audioRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/narration-plan`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/narration-audio`, {cache: 'no-store'}),
      ]);
      if (!planRes.ok) throw new Error(`HTTP ${planRes.status}`);
      setData((await planRes.json()) as NarrationReadiness);
      if (audioRes.ok) {
        setAudio((await audioRes.json()) as AudioOverview);
      }
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

  const generateAudio = useCallback(async () => {
    setAudioBusy('generate');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-audio`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '音频任务创建失败');
    } finally {
      setAudioBusy(null);
    }
  }, [projectId, load]);

  const cancelAudio = useCallback(async () => {
    setAudioBusy('cancel');
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-audio/cancel`, {method: 'POST'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '取消失败');
    } finally {
      setAudioBusy(null);
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
                已有 plan 已过期（基于 Script V2 v{data.latestPlanSourceVersion} 或旧编译器，
                与当前锁定版本/编译器不一致）——请重新构建
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

      {/* Narration Audio 区（M3-B）：speech unit → TTS → manifest + master */}
      {audio && data?.status === 'ready' ? (
        <>
          <div className="panel-head" style={{borderTop: '1px solid var(--border)'}}>
            <span className="panel-title">NARRATION AUDIO（M3-B · 无字幕/时长以实测为准）</span>
            <div className="panel-head-actions">
              {audio.units.some((u) => u.jobStatus === 'queued' || u.jobStatus === 'running') ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={audioBusy !== null}
                  onClick={() => void cancelAudio()}
                >
                  {audioBusy === 'cancel' ? '取消中…' : '取消音频任务'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={audioBusy !== null || audio.status === 'ready'}
                onClick={() => void generateAudio()}
              >
                {audioBusy === 'generate'
                  ? '提交中…'
                  : audio.status === 'ready'
                    ? '音频已就绪'
                    : 'Generate Audio'}
              </button>
            </div>
          </div>
          <div className="stage-meta">
            <span className="badge" data-stage-state={audio.status === 'ready' ? 'locked' : audio.status === 'failed' ? 'stale' : 'generated'}>
              {AUDIO_STATUS_LABELS[audio.status]}
            </span>
            <span>
              Provider <span className="mono">{audio.providerName}</span> · Voice{' '}
              <span className="mono">
                {audio.voiceProfile.id}@{audio.voiceProfile.revision}
              </span>
            </span>
            <span>
              完成 <span className="mono">{audio.speechComplete}/{audio.speechTotal}</span>
            </span>
            {audio.master ? (
              <span>
                Master <span className="mono">{(audio.master.durationMs / 1000).toFixed(1)}s</span>
              </span>
            ) : null}
            {audio.providerDetail ? (
              <span title={`providerVersion=${audio.providerDetail.providerVersion ?? 'n/a'}`}>
                模型 <span className="mono">{audio.providerDetail.model}</span>
                {audio.providerDetail.providerCommit ? (
                  <>
                    {' '}· commit <span className="mono">{audio.providerDetail.providerCommit.slice(0, 12)}</span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
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
                        ? `停顿 ${unit.pauseMs}ms`
                        : `停顿（${unit.directive}）· 未解析`
                      : unit.kind === 'prosody'
                        ? `韵律：${unit.directive}（未应用）`
                        : '画面留白（待 timing）'}
                </span>
                <span className="scene-dur mono" style={{display: 'flex', alignItems: 'center', gap: 8}}>
                  {unit.kind === 'speech' && unit.jobStatus ? (
                    <span className="badge" data-status={unit.jobStatus}>
                      {unit.jobStatus === 'succeeded'
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
    </section>
  );
}

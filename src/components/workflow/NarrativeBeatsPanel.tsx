'use client';

/**
 * Narrative Beats 检视面板（M7.2，candidate only）。
 *
 * - 只读列表 + 显式 build/regenerate 控件（regenerate 必须新 requestId）。
 * - source narration artifact 由用户显式选择（GET 返回的
 *   latestEligibleSuggestionArtifactId 仅作为默认选中建议）。
 * - 明确展示「Candidate only — project remains M6」；
 *   无 Activate/Set current/Lock/下游按钮。
 * - Worker-side LLM Dispatch：POST 为 enqueue-only（202 queued/running）。
 *   同一次点击的 requestId 生命周期内轮询 GET（dispatch 状态 + runs），
 *   queued/running 时按钮 disabled——双击不产生第二个 dispatch；
 *   「重新生成」才创建新 requestId。页面加载不自动 POST。
 */

import {useCallback, useEffect, useState} from 'react';

interface NarrationCandidate {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  unitCount: number | null;
  createdAt: string;
}

interface BeatsCandidateSummary {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  createdAt: string;
  beatCount: number | null;
  sourceNarrationPlanV2ArtifactId: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  compilerVersion: string | null;
  attemptCount: number | null;
  requestId: string | null;
  legacyRunMetadataUnavailable?: boolean;
}

interface GenerationRunSummary {
  runId: string;
  requestId: string;
  status: 'running' | 'succeeded' | 'failed' | 'indeterminate';
  sourceArtifactId: string;
  resultArtifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptCount: number;
  usageCount: number;
  costCny: number;
  createdAt: string;
  finishedAt: string | null;
}

interface DispatchJobSummary {
  dispatchId: string;
  requestId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  generationRunId: string | null;
  resultArtifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface ListResponse {
  pipelineVersion: string;
  candidateOnly: boolean;
  narrationCandidates: NarrationCandidate[];
  latestEligibleSuggestionArtifactId: string | null;
  candidates: BeatsCandidateSummary[];
  runs: GenerationRunSummary[];
  dispatchJobs: DispatchJobSummary[];
}

interface BeatDetail {
  beatId: string;
  chapter: number;
  unitIds: string[];
  role: string;
  summary: string;
  payoff: string | null;
  unitRange: {first: string; last: string};
  speechCount: number;
  silenceCount: number;
}

interface DetailResponse {
  status: string;
  statusReason: string | null;
  source: {narrationPlanV2ArtifactId: string};
  generation: {provider: string; model: string; attemptCount: number; requestId: string};
  promptVersion: string;
  compilerVersion: string;
  beatCount: number;
  coverage: {unitTotal: number | null; speechTotal: number | null; silenceTotal: number | null};
  beats: BeatDetail[];
}

const STATUS_LABELS: Record<string, string> = {
  eligible_candidate: 'eligible candidate',
  needs_review: 'needs review',
  stale: 'stale',
  invalid: 'invalid',
};

export function NarrativeBeatsPanel({projectId}: {projectId: string}) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // 本次点击的 requestId 生命周期：queued/running 期间轮询且按钮 disabled，
  // 双击不产生第二个 dispatch；终态后清空，「重新生成」才创建新 requestId。
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'queued' | 'running'>('idle');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/narrative-beats`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setData(json);
      setError(null);
      setSelectedSource((prev) =>
        prev || json.latestEligibleSuggestionArtifactId || json.narrationCandidates[0]?.artifactId || '',
      );
    } catch {
      setError('Narrative Beats 数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // dispatch 轮询：同一 requestId 生命周期内跟踪 queued/running → 终态。
  useEffect(() => {
    if (!activeRequestId || phase === 'idle') return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/narrative-beats`, {cache: 'no-store'});
        if (!res.ok) return; // 下轮重试
        const json = (await res.json()) as ListResponse;
        if (cancelled) return;
        setData(json);
        const run = json.runs.find((r) => r.requestId === activeRequestId);
        const dispatch = (json.dispatchJobs ?? []).find((d) => d.requestId === activeRequestId);
        if (run?.status === 'succeeded' || dispatch?.status === 'succeeded') {
          setActiveRequestId(null);
          setPhase('idle');
          setBuildError(null);
          return;
        }
        if (run && (run.status === 'failed' || run.status === 'indeterminate')) {
          setBuildError(`${run.errorCode ?? 'UNKNOWN'}: ${run.errorMessage ?? ''}`);
          setActiveRequestId(null);
          setPhase('idle');
          return;
        }
        if (dispatch && (dispatch.status === 'failed' || dispatch.status === 'cancelled')) {
          setBuildError(`${dispatch.errorCode ?? 'UNKNOWN'}: ${dispatch.errorMessage ?? ''}`);
          setActiveRequestId(null);
          setPhase('idle');
          return;
        }
        setPhase(dispatch?.status === 'running' || run?.status === 'running' ? 'running' : 'queued');
      } catch {
        // 网络抖动：下轮重试
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRequestId, phase, projectId]);

  const build = async () => {
    if (!selectedSource || phase !== 'idle') return;
    setBuilding(true);
    setBuildError(null);
    // 每次显式操作都生成新 requestId（regenerate 语义；同 requestId 由服务端幂等复用）
    const requestId = crypto.randomUUID();
    try {
      const res = await fetch(`/api/projects/${projectId}/narrative-beats`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          narrationPlanV2ArtifactId: selectedSource,
          requestId,
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        message?: string;
        status?: string;
        errorCode?: string;
      };
      if (res.status === 202) {
        // Worker-side dispatch：queued（等待 worker）或 running（worker 执行中）。
        setActiveRequestId(requestId);
        setPhase(json.status === 'running' ? 'running' : 'queued');
      } else if (!res.ok) {
        // 409 = 同 requestId 终态（failed/indeterminate）；显式 regenerate 需新 requestId。
        setBuildError(
          `${json.error ?? json.errorCode ?? `HTTP ${res.status}`}: ${json.message ?? ''}`,
        );
      } else {
        // 200 reused：幂等命中，直接刷新。
        await load();
      }
    } catch {
      setBuildError('网络错误');
    } finally {
      setBuilding(false);
    }
  };

  const toggleDetail = async (artifactId: string) => {
    if (detailId === artifactId) {
      setDetailId(null);
      setDetail(null);
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/narrative-beats/${artifactId}`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as DetailResponse);
      setDetailId(artifactId);
    } catch {
      setBuildError('candidate 详情加载失败');
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">加载 Narrative Beats…</div>;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Narrative Beats（M7 candidate）">
      <div className="panel-head">
        <span className="panel-title">Narrative Beats（M7）</span>
        <span style={{fontSize: 12, color: 'var(--muted)'}}>
          Candidate only — project remains {data.pipelineVersion.toUpperCase()}
        </span>
      </div>

      <div style={{padding: '0 24px 20px'}}>
        {/* source 选择 + build */}
        <div style={{padding: '16px 0', borderBottom: '1px solid var(--border, #2a2a2a)'}}>
          <div style={{fontSize: 13, marginBottom: 8}}>来源 Narration Plan V2（精确 artifact，人工选择）：</div>
          {data.narrationCandidates.length === 0 ? (
            <div className="stage-empty">
              <p className="empty-title">暂无 narration plan v2 candidate</p>
              <p>请先在 M7 流程中构建 eligible narration plan v2 candidate</p>
            </div>
          ) : (
            <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
              <select
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                style={{fontSize: 12, maxWidth: 520}}
              >
                {data.narrationCandidates.map((c) => (
                  <option key={c.artifactId} value={c.artifactId}>
                    v{c.version} · {STATUS_LABELS[c.status] ?? c.status} · {c.unitCount ?? '?'} units ·{' '}
                    {c.artifactId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={building || phase !== 'idle' || !selectedSource}
                onClick={() => void build()}
              >
                {phase === 'queued'
                  ? '排队中…'
                  : phase === 'running'
                    ? '生成中…'
                    : building
                      ? '提交中…'
                      : data.candidates.length > 0
                        ? '重新生成（新 requestId）'
                        : '生成 Beats Candidate'}
              </button>
              {phase !== 'idle' ? (
                <span style={{fontSize: 12, color: 'var(--accent, #7dd3fc)'}}>
                  {phase === 'queued' ? '已入队，等待 Worker 执行' : 'Worker 生成中'}（requestId{' '}
                  {activeRequestId?.slice(0, 8)}…）
                </span>
              ) : null}
            </div>
          )}
          {buildError ? <div className="error-banner" style={{marginTop: 8}}>{buildError}</div> : null}
        </div>

        {/* candidate 列表 */}
        {data.candidates.length === 0 ? (
          <div className="stage-empty">
            <p className="empty-title">暂无 Narrative Beats candidate</p>
          </div>
        ) : (
          <div style={{paddingTop: 12}}>
            {data.candidates.map((c) => (
              <div key={c.artifactId} style={{padding: '10px 0', borderBottom: '1px solid var(--border, #2a2a2a)'}}>
                <div style={{display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13}}>
                  <button type="button" onClick={() => void toggleDetail(c.artifactId)}>
                    {detailId === c.artifactId ? '收起' : '详情'}
                  </button>
                  <span>v{c.version}</span>
                  <span style={{color: c.status === 'eligible_candidate' ? 'var(--ok, #4ade80)' : 'var(--warn, #facc15)'}}>
                    {STATUS_LABELS[c.status] ?? c.status}
                  </span>
                  <span>{c.beatCount ?? '?'} beats</span>
                  {c.legacyRunMetadataUnavailable ? (
                    <span style={{color: 'var(--muted)', fontSize: 12}}>legacy run metadata unavailable</span>
                  ) : null}
                  <span style={{color: 'var(--muted)', fontSize: 12}}>
                    {c.provider}/{c.model} · {c.promptVersion} · attempts={c.attemptCount ?? '?'} ·{' '}
                    {c.artifactId.slice(0, 8)}
                  </span>
                </div>
                {c.statusReason ? (
                  <div style={{fontSize: 12, color: 'var(--muted)', marginTop: 4}}>{c.statusReason}</div>
                ) : null}

                {detailId === c.artifactId && detail ? (
                  <div style={{marginTop: 10, fontSize: 12}}>
                    <div style={{color: 'var(--muted)', marginBottom: 8}}>
                      source={detail.source.narrationPlanV2ArtifactId.slice(0, 8)} · coverage=
                      {detail.coverage.unitTotal ?? '?'} units（speech {detail.coverage.speechTotal ?? '?'} /
                      silence {detail.coverage.silenceTotal ?? '?'}）· {detail.promptVersion}@
                      {detail.compilerVersion}
                    </div>
                    {detail.beats.map((b) => (
                      <div key={b.beatId} style={{padding: '6px 0', borderTop: '1px dashed var(--border, #2a2a2a)'}}>
                        <span style={{fontWeight: 600}}>{b.beatId}</span>{' '}
                        <span style={{color: 'var(--accent, #7dd3fc)'}}>{b.role}</span>{' '}
                        <span style={{color: 'var(--muted)'}}>
                          第{b.chapter}章 · {b.unitRange.first}–{b.unitRange.last}（speech {b.speechCount} / silence{' '}
                          {b.silenceCount}）
                        </span>
                        <div style={{marginTop: 2}}>{b.summary}</div>
                        {b.payoff ? <div style={{color: 'var(--muted)'}}>payoff：{b.payoff}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* generation runs（M7.2.1 durable single-flight 状态面） */}
        {data.runs.length > 0 ? (
          <div style={{paddingTop: 12}}>
            <div style={{fontSize: 13, marginBottom: 6}}>Generation Runs：</div>
            {data.runs.map((r) => (
              <div
                key={r.runId}
                style={{padding: '6px 0', borderTop: '1px dashed var(--border, #2a2a2a)', fontSize: 12, color: 'var(--muted)'}}
              >
                <span
                  style={{
                    color:
                      r.status === 'succeeded'
                        ? 'var(--ok, #4ade80)'
                        : r.status === 'running'
                          ? 'var(--accent, #7dd3fc)'
                          : 'var(--warn, #facc15)',
                  }}
                >
                  {r.status}
                </span>{' '}
                run={r.runId.slice(0, 8)} · attempts={r.attemptCount} · usage={r.usageCount} · ¥
                {r.costCny.toFixed(4)}
                {r.errorCode ? ` · ${r.errorCode}` : ''}
                {r.resultArtifactId ? ` · artifact=${r.resultArtifactId.slice(0, 8)}` : ''}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

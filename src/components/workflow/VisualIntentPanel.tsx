'use client';

/**
 * Visual Intent Plan 检视面板（M7.3A，candidate only）。
 *
 * - 只读列表 + 显式 build/regenerate 控件（regenerate 必须新 requestId）。
 * - source Narrative Beats artifact 由用户显式选择（GET 返回的
 *   latestEligibleBeatsSuggestionArtifactId 仅作为默认选中建议）。
 * - 明确展示「Candidate only — project remains M6」；
 *   无 Activate/Set current/Lock/Generate Sequence/Generate Shots 按钮。
 */

import {useCallback, useEffect, useState} from 'react';

interface BeatsCandidate {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  beatCount: number | null;
  createdAt: string;
}

interface VisualIntentCandidateSummary {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  createdAt: string;
  intentCount: number | null;
  unresolvedCount: number | null;
  titleCardCount: number | null;
  continuationCount: number | null;
  sourceNarrativeBeatsArtifactId: string | null;
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

interface ListResponse {
  pipelineVersion: string;
  candidateOnly: boolean;
  beatsCandidates: BeatsCandidate[];
  latestEligibleBeatsSuggestionArtifactId: string | null;
  candidates: VisualIntentCandidateSummary[];
  runs: GenerationRunSummary[];
}

interface DisplayTextDetail {
  sourceKind: 'spoken_exact' | 'subtitle_exact' | 'chapter_title';
  sourceUnitId: string | null;
  sourceChapter: number | null;
  text: string;
}

interface IntentDetail {
  visualIntentId: string;
  chapter: number;
  beatIds: string[];
  intent: string;
  strategy: string;
  authenticity: string;
  objective: string;
  subject: {kind: string; label: string | null; evidenceIds: string[]};
  continuationOfVisualIntentId: string | null;
  displayText: DisplayTextDetail | null;
  beatRange: {first: string; last: string};
  beatRoles: Array<string | null>;
}

interface DetailResponse {
  status: string;
  statusReason: string | null;
  source: {narrativeBeatsArtifactId: string; narrationPlanV2ArtifactId: string};
  generation: {provider: string; model: string; attemptCount: number; requestId: string};
  promptVersion: string;
  compilerVersion: string;
  intentCount: number;
  coverage: {beatTotal: number | null; coveredBeatIds: string[]};
  unresolvedCount: number;
  titleCardCount: number;
  continuationCount: number;
  distributions: {
    intent: Record<string, number>;
    strategy: Record<string, number>;
    authenticity: Record<string, number>;
  };
  intents: IntentDetail[];
}

const STATUS_LABELS: Record<string, string> = {
  eligible_candidate: 'eligible candidate',
  needs_review: 'needs review',
  stale: 'stale',
  invalid: 'invalid',
};

function formatDistribution(dist: Record<string, number>): string {
  return Object.entries(dist)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

export function VisualIntentPanel({projectId}: {projectId: string}) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/visual-intents`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setData(json);
      setError(null);
      setSelectedSource((prev) =>
        prev || json.latestEligibleBeatsSuggestionArtifactId || json.beatsCandidates[0]?.artifactId || '',
      );
    } catch {
      setError('Visual Intent 数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const build = async () => {
    if (!selectedSource) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/visual-intents`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        // 每次显式操作都生成新 requestId（regenerate 语义；同 requestId 由服务端幂等复用）
        body: JSON.stringify({
          narrativeBeatsArtifactId: selectedSource,
          requestId: crypto.randomUUID(),
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        message?: string;
        status?: string;
        errorCode?: string;
        retryAfterMs?: number;
      };
      if (res.status === 202) {
        // durable single-flight：同 requestId 的 generation 正在运行，本请求零成本。
        setBuildError(`生成中（run ${json.status ?? 'running'}）——请稍后刷新`);
        window.setTimeout(() => void load(), (json.retryAfterMs ?? 5000) + 1000);
      } else if (!res.ok) {
        // 409 = 同 requestId 终态（failed/indeterminate）；显式 regenerate 需新 requestId。
        setBuildError(
          `${json.error ?? json.errorCode ?? `HTTP ${res.status}`}: ${json.message ?? ''}`,
        );
      } else {
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
      const res = await fetch(`/api/projects/${projectId}/visual-intents/${artifactId}`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as DetailResponse);
      setDetailId(artifactId);
    } catch {
      setBuildError('candidate 详情加载失败');
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">加载 Visual Intent…</div>;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Visual Intent（M7 candidate）">
      <div className="panel-head">
        <span className="panel-title">Visual Intent（M7）</span>
        <span style={{fontSize: 12, color: 'var(--muted)'}}>
          Candidate only — project remains {data.pipelineVersion.toUpperCase()}
        </span>
      </div>

      <div style={{padding: '0 24px 20px'}}>
        {/* source 选择 + build */}
        <div style={{padding: '16px 0', borderBottom: '1px solid var(--border, #2a2a2a)'}}>
          <div style={{fontSize: 13, marginBottom: 8}}>来源 Narrative Beats（精确 artifact，人工选择）：</div>
          {data.beatsCandidates.length === 0 ? (
            <div className="stage-empty">
              <p className="empty-title">暂无 narrative beats candidate</p>
              <p>请先构建 eligible narrative beats candidate</p>
            </div>
          ) : (
            <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
              <select
                value={selectedSource}
                onChange={(e) => setSelectedSource(e.target.value)}
                style={{fontSize: 12, maxWidth: 520}}
              >
                {data.beatsCandidates.map((c) => (
                  <option key={c.artifactId} value={c.artifactId}>
                    v{c.version} · {STATUS_LABELS[c.status] ?? c.status} · {c.beatCount ?? '?'} beats ·{' '}
                    {c.artifactId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <button type="button" disabled={building || !selectedSource} onClick={() => void build()}>
                {building ? '生成中…' : '生成 Visual Intent Candidate'}
              </button>
            </div>
          )}
          {buildError ? <div className="error-banner" style={{marginTop: 8}}>{buildError}</div> : null}
        </div>

        {/* candidate 列表 */}
        {data.candidates.length === 0 ? (
          <div className="stage-empty">
            <p className="empty-title">暂无 Visual Intent candidate</p>
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
                  <span>{c.intentCount ?? '?'} intents</span>
                  {(c.unresolvedCount ?? 0) > 0 ? (
                    <span style={{color: 'var(--warn, #facc15)'}}>unresolved={c.unresolvedCount} 需人工处理</span>
                  ) : null}
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
                    <div style={{color: 'var(--muted)', marginBottom: 4}}>
                      source beats={detail.source.narrativeBeatsArtifactId.slice(0, 8)} · narration=
                      {detail.source.narrationPlanV2ArtifactId.slice(0, 8)} · coverage=
                      {detail.coverage.coveredBeatIds.length}/{detail.coverage.beatTotal ?? '?'} beats ·{' '}
                      {detail.promptVersion}@{detail.compilerVersion}
                    </div>
                    <div style={{color: 'var(--muted)', marginBottom: 8}}>
                      title cards={detail.titleCardCount} · continuations={detail.continuationCount} · intent:{' '}
                      {formatDistribution(detail.distributions.intent)} · strategy:{' '}
                      {formatDistribution(detail.distributions.strategy)} · authenticity:{' '}
                      {formatDistribution(detail.distributions.authenticity)}
                    </div>
                    {detail.intents.map((i) => (
                      <div
                        key={i.visualIntentId}
                        style={{padding: '6px 0', borderTop: '1px dashed var(--border, #2a2a2a)'}}
                      >
                        <span style={{fontWeight: 600}}>{i.visualIntentId}</span>{' '}
                        <span
                          style={{
                            color:
                              i.intent === 'VISUAL_UNRESOLVED'
                                ? 'var(--warn, #facc15)'
                                : 'var(--accent, #7dd3fc)',
                          }}
                        >
                          {i.intent}
                        </span>{' '}
                        <span style={{color: 'var(--muted)'}}>
                          第{i.chapter}章 · {i.beatRange.first}–{i.beatRange.last} · {i.strategy} / {i.authenticity}
                        </span>
                        <div style={{marginTop: 2}}>{i.objective}</div>
                        <div style={{color: 'var(--muted)'}}>
                          subject：{i.subject.kind}
                          {i.subject.label ? `（${i.subject.label}）` : ''}
                          {i.continuationOfVisualIntentId
                            ? ` · 延续 ${i.continuationOfVisualIntentId}`
                            : ''}
                        </div>
                        {i.displayText ? (
                          <div style={{color: 'var(--muted)'}}>
                            title card（{i.displayText.sourceKind}
                            {i.displayText.sourceUnitId ? ` · ${i.displayText.sourceUnitId}` : ''}
                            {i.displayText.sourceChapter !== null ? ` · 第${i.displayText.sourceChapter}章` : ''}
                            ）：{i.displayText.text}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* generation runs（durable single-flight 状态面） */}
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

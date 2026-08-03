'use client';

/**
 * Narration Performance Plan 面板（TTS-B，candidate only）。
 *
 * - 显式选择 exact Assignment → POST 生成 Performance Plan（Web enqueue-only，
 *   202 queued/running；同一次点击的 requestId 生命周期内轮询）；
 * - 展示每个 SpeechUnit：unitId / 原 Narration delivery / deliveryOverride /
 *   pace / energy / emotion；
 * - needs_review / stale / invalid 状态显示；
 * - 修改计划 = 新 immutable candidate（不 PATCH artifact）；
 * - 明确展示：Performance Plan 是 candidate；TTS-C 才会生成音频。
 */

import {useCallback, useEffect, useState} from 'react';

interface AssignmentCandidate {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  createdAt: string;
  sourceVoiceProfileRevisionId: string | null;
}

interface PerfCandidate {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  createdAt: string;
  itemCount: number | null;
  sourceNarrationPlanArtifactId: string | null;
  sourceAssignmentArtifactId: string | null;
  provider: string | null;
  attemptCount: number | null;
}

interface PerfDetail {
  status: string;
  statusReason: string | null;
  items: Array<{
    unitId: string;
    deliveryOverride: string | null;
    pace: string;
    energy: string;
    emotion: {mode: string; label?: string};
  }>;
}

interface RunSummary {
  runId: string;
  requestId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface DispatchSummary {
  dispatchId: string;
  requestId: string;
  status: string;
  errorCode: string | null;
}

interface NarrationPlanCandidate {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  unitCount: number | null;
  speechUnitCount: number | null;
}

interface ListResponse {
  narrationPlanCandidates: NarrationPlanCandidate[];
  candidates: PerfCandidate[];
  runs: RunSummary[];
  dispatchJobs: DispatchSummary[];
}

const STATUS_LABELS: Record<string, string> = {
  current_candidate: 'current candidate',
  stale_source: 'stale source',
  invalid_source: 'invalid source',
  needs_review: 'needs review',
};

const STATUS_COLOR: Record<string, string> = {
  current_candidate: 'var(--ok, #4ade80)',
  stale_source: 'var(--warn, #facc15)',
  invalid_source: '#f87171',
  needs_review: 'var(--warn, #facc15)',
};

export function PerformancePlanPanel({projectId}: {projectId: string}) {
  const [assignments, setAssignments] = useState<AssignmentCandidate[] | null>(null);
  const [data, setData] = useState<ListResponse | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('');
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'queued' | 'running'>('idle');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PerfDetail | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [assignRes, perfRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/voice-assignments`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/narration-performance-plans`, {cache: 'no-store'}),
      ]);
      if (!assignRes.ok || !perfRes.ok) throw new Error('加载失败');
      const assignBody = (await assignRes.json()) as {candidates: AssignmentCandidate[]};
      const perfBody = (await perfRes.json()) as ListResponse;
      setAssignments(assignBody.candidates);
      setData(perfBody);
      if (assignBody.candidates.length > 0 && !selectedAssignment) {
        const current = assignBody.candidates.find((c) => c.status === 'current_candidate');
        setSelectedAssignment((current ?? assignBody.candidates[0]!).artifactId);
      }
      if (perfBody.narrationPlanCandidates.length > 0 && !selectedPlan) {
        const eligible = perfBody.narrationPlanCandidates.find((c) => c.status === 'eligible_candidate');
        setSelectedPlan((eligible ?? perfBody.narrationPlanCandidates[0]!).artifactId);
      }
    } catch {
      setError('Performance/Assignment 数据加载失败');
    }
  }, [projectId, selectedAssignment]);

  useEffect(() => {
    void load();
  }, [load]);

  // 轮询：activeRequestId 生命周期内拉取 GET（dispatch/runs 状态面）
  useEffect(() => {
    if (!activeRequestId || phase === 'idle') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/narration-performance-plans`, {cache: 'no-store'});
        if (!res.ok) return;
        const body = (await res.json()) as ListResponse;
        setData(body);
        const run = body.runs.find((r) => r.requestId === activeRequestId);
        const dispatch = body.dispatchJobs.find((d) => d.requestId === activeRequestId);
        if (run?.status === 'succeeded' || dispatch?.status === 'succeeded') {
          setPhase('idle');
          setActiveRequestId(null);
        } else if (run?.status === 'failed' || run?.status === 'indeterminate' || dispatch?.status === 'failed' || dispatch?.status === 'cancelled') {
          setBuildError(`${run?.errorCode ?? dispatch?.errorCode ?? 'ERROR'}: ${run?.errorMessage ?? ''}`);
          setPhase('idle');
          setActiveRequestId(null);
        } else {
          setPhase(dispatch?.status === 'running' || run?.status === 'running' ? 'running' : 'queued');
        }
      } catch {
        // 轮询失败保持现状
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [activeRequestId, phase, projectId]);

  const toggleDetail = async (artifactId: string) => {
    if (detailId === artifactId) {
      setDetailId(null);
      setDetail(null);
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/narration-performance-plans/${artifactId}`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PerfDetail;
      setDetail(body);
      setDetailId(artifactId);
    } catch {
      setBuildError('candidate 详情加载失败');
    }
  };

  // 需要 narrationPlanArtifactId：从 GET 接口的 narrationPlanCandidates 选择 exact plan
  const buildPlan = async () => {
    if (!selectedAssignment) return;
    setBuilding(true);
    setBuildError(null);
    const requestId = crypto.randomUUID();
    try {
      if (!selectedPlan) {
        setBuildError('尚未指定 Narration Plan（请先生成 narration plan v2）');
        setBuilding(false);
        return;
      }
      const res = await fetch(`/api/projects/${projectId}/narration-performance-plans`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          requestId,
          narrationPlanArtifactId: selectedPlan,
          projectVoiceAssignmentArtifactId: selectedAssignment,
        }),
      });
      const json = (await res.json()) as {status?: string; error?: string; message?: string; errorCode?: string};
      if (res.status === 202) {
        setActiveRequestId(requestId);
        setPhase(json.status === 'running' ? 'running' : 'queued');
      } else if (!res.ok) {
        setBuildError(`${json.error ?? json.errorCode ?? `HTTP ${res.status}`}: ${json.message ?? ''}`);
      } else {
        await load();
      }
    } catch {
      setBuildError('网络错误');
    } finally {
      setBuilding(false);
    }
  };

  if (error) return <div className="error-banner">{error}</div>;
  if (!data || !assignments) return <div className="loading">加载 Performance / Assignment…</div>;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Narration Performance Plan（TTS-B）">
      <div className="panel-head">
        <span className="panel-title">Narration Performance Plan（TTS-B）</span>
        <span style={{fontSize: 12, color: 'var(--muted)'}}>
          Candidate only — TTS-C 才生成音频；无 default/current/active
        </span>
      </div>

      <div style={{padding: '0 24px 20px'}}>
        <div style={{padding: '16px 0', borderBottom: '1px solid var(--border, #2a2a2a)'}}>
          <div style={{fontSize: 13, marginBottom: 8}}>① 生成 Performance Plan：</div>
          {assignments.length === 0 ? (
            <div className="stage-empty">
              <p className="empty-title">暂无 voice assignment candidate</p>
              <p>请先在 Voice Assignment 面板创建 assignment</p>
            </div>
          ) : (
            <>
              <div style={{fontSize: 13, margin: '12px 0 8px'}}>② 选择 exact Narration Plan（v2）：</div>
              <select
                value={selectedPlan}
                onChange={(e) => setSelectedPlan(e.target.value)}
                style={{fontSize: 12, maxWidth: 520}}
              >
                {data.narrationPlanCandidates.map((p) => (
                  <option key={p.artifactId} value={p.artifactId}>
                    v{p.version} · {p.status} · {p.speechUnitCount ?? '?'} speech
                  </option>
                ))}
              </select>
              {data.narrationPlanCandidates.length === 0 && (
                <div style={{color: '#facc15', fontSize: 12, marginTop: 6}}>暂无 narration plan v2 candidate（请先生成旁白计划）</div>
              )}
              <div style={{fontSize: 13, margin: '12px 0 8px'}}>③ 选择 exact Assignment candidate：</div>
              <select
                value={selectedAssignment}
                onChange={(e) => setSelectedAssignment(e.target.value)}
                style={{fontSize: 12, maxWidth: 520}}
              >
                {assignments.map((c) => (
                  <option key={c.artifactId} value={c.artifactId}>
                    v{c.version} · {STATUS_LABELS[c.status] ?? c.status} · rev {c.sourceVoiceProfileRevisionId?.slice(0, 8) ?? '?'}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={building || phase !== 'idle' || !selectedAssignment || !selectedPlan}
                onClick={() => void buildPlan()}
              >
                {phase === 'queued' ? '排队中…' : phase === 'running' ? '生成中…' : building ? '提交中…' : '生成 Performance Plan candidate'}
              </button>
              {buildError && <div style={{color: '#f87171', fontSize: 12, marginTop: 8}}>{buildError}</div>}
            </>
          )}
        </div>

        <div style={{paddingTop: 16}}>
          <div style={{fontSize: 13, marginBottom: 8}}>④ Performance Plan candidates（immutable，修改 = 新 candidate）：</div>
          {data.candidates.length === 0 ? (
            <div className="stage-empty">
              <p className="empty-title">暂无 performance plan candidate</p>
            </div>
          ) : (
            <table style={{width: '100%', fontSize: 12, borderCollapse: 'collapse'}}>
              <thead>
                <tr>
                  <th style={{textAlign: 'left'}}>版本</th>
                  <th style={{textAlign: 'left'}}>状态</th>
                  <th style={{textAlign: 'left'}}>unit 数</th>
                  <th style={{textAlign: 'left'}}>provider</th>
                  <th style={{textAlign: 'left'}}>尝试</th>
                  <th style={{textAlign: 'left'}}>创建时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.candidates.map((c) => (
                  <tr key={c.artifactId} style={{borderTop: '1px solid var(--border, #2a2a2a)'}}>
                    <td>v{c.version}</td>
                    <td style={{color: STATUS_COLOR[c.status] ?? 'inherit'}}>
                      {STATUS_LABELS[c.status] ?? c.status}
                    </td>
                    <td>{c.itemCount ?? '—'}</td>
                    <td>{c.provider ?? '—'}</td>
                    <td>{c.attemptCount ?? '—'}</td>
                    <td>{new Date(c.createdAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        style={{fontSize: 11}}
                        onClick={() => void toggleDetail(c.artifactId)}
                      >
                        {detailId === c.artifactId ? '收起' : '逐句查看'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {detail && (
            <div style={{fontSize: 12, marginTop: 12, padding: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 8}}>
              <div style={{marginBottom: 8}}>
                状态：{STATUS_LABELS[detail.status] ?? detail.status}
                {detail.statusReason ? ` — ${detail.statusReason}` : ''}
              </div>
              <table style={{width: '100%', borderCollapse: 'collapse'}}>
                <thead>
                  <tr>
                    <th style={{textAlign: 'left'}}>unitId</th>
                    <th style={{textAlign: 'left'}}>deliveryOverride</th>
                    <th style={{textAlign: 'left'}}>pace</th>
                    <th style={{textAlign: 'left'}}>energy</th>
                    <th style={{textAlign: 'left'}}>emotion</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it) => (
                    <tr key={it.unitId} style={{borderTop: '1px solid var(--border, #2a2a2a)'}}>
                      <td>{it.unitId}</td>
                      <td>{it.deliveryOverride ?? '（用 source delivery）'}</td>
                      <td>{it.pace}</td>
                      <td>{it.energy}</td>
                      <td>{it.emotion.mode === 'semantic' ? `semantic:${it.emotion.label}` : it.emotion.mode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

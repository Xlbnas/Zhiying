'use client';

/**
 * Project Voice Assignment 面板（TTS-B，candidate only）。
 *
 * - 浏览 active Voice Profiles（GET /api/voice-profiles）+ 展开 revisions
 *   （GET /api/voice-profiles/[id]/revisions）：显示 revision number / duration /
 *   SHA 短摘要 / compatibility / usable；
 * - 用户显式选择 exact revision → POST 创建 Project Voice Assignment candidate；
 * - 显示历史 Assignment candidates + 状态（current_candidate / stale_source /
 *   invalid_source）；
 * - 明确展示：声音尚未触发 TTS；Assignment 是 candidate；无 default/current/active。
 */

import {useCallback, useEffect, useState} from 'react';

interface VoiceProfile {
  id: string;
  displayName: string;
  status: string;
  revisionCount?: number;
}

interface VoiceRevision {
  id: string;
  revisionNumber: number;
  durationMs: number;
  canonicalAudioSha256: string;
  adapterCompatibilityKey: string;
  usable?: boolean;
  unusableReason?: string | null;
}

interface AssignmentCandidate {
  artifactId: string;
  version: number;
  status: string;
  statusReason: string | null;
  createdAt: string;
  sourceVoiceProfileId: string | null;
  sourceVoiceProfileRevisionId: string | null;
  canonicalAudioSha256: string | null;
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

export function VoiceAssignmentPanel({projectId}: {projectId: string}) {
  const [profiles, setProfiles] = useState<VoiceProfile[] | null>(null);
  const [revisions, setRevisions] = useState<VoiceRevision[] | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [selectedRevision, setSelectedRevision] = useState('');
  const [assignments, setAssignments] = useState<AssignmentCandidate[] | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssignmentCandidate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profRes, assignRes] = await Promise.all([
        fetch('/api/voice-profiles', {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/voice-assignments`, {cache: 'no-store'}),
      ]);
      if (!profRes.ok || !assignRes.ok) throw new Error('加载失败');
      const profBody = (await profRes.json()) as {profiles: VoiceProfile[]};
      const assignBody = (await assignRes.json()) as {candidates: AssignmentCandidate[]};
      const active = profBody.profiles.filter((p) => p.status === 'active');
      setProfiles(active);
      setAssignments(assignBody.candidates);
      if (active.length > 0 && !selectedProfile) setSelectedProfile(active[0]!.id);
    } catch {
      setError('Voice/Assignment 数据加载失败');
    }
  }, [projectId, selectedProfile]);

  useEffect(() => {
    void load();
  }, [load]);

  // 选中 profile 变化 → 拉 revisions
  useEffect(() => {
    if (!selectedProfile) return;
    setRevisions(null);
    setSelectedRevision('');
    void (async () => {
      try {
        const res = await fetch(`/api/voice-profiles/${selectedProfile}/revisions`, {cache: 'no-store'});
        if (!res.ok) throw new Error('revisions 加载失败');
        const body = (await res.json()) as {revisions: VoiceRevision[]};
        setRevisions(body.revisions);
        if (body.revisions.length > 0) setSelectedRevision(body.revisions[0]!.id);
      } catch {
        setError('voice revisions 加载失败');
      }
    })();
  }, [selectedProfile]);

  const build = async () => {
    if (!selectedRevision) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/voice-assignments`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          voiceProfileId: selectedProfile,
          voiceProfileRevisionId: selectedRevision,
        }),
      });
      const json = (await res.json()) as {error?: string; message?: string};
      if (!res.ok) {
        setBuildError(`${json.error ?? `HTTP ${res.status}`}: ${json.message ?? ''}`);
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
  if (!profiles || !assignments) return <div className="loading">加载 Voice / Assignment…</div>;

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="Project Voice Assignment（TTS-B）">
      <div className="panel-head">
        <span className="panel-title">Project Voice Assignment（TTS-B）</span>
        <span style={{fontSize: 12, color: 'var(--muted)'}}>
          Candidate only — 声音尚未触发 TTS；无 default/current/active
        </span>
      </div>

      <div style={{padding: '0 24px 20px'}}>
        <div style={{padding: '16px 0', borderBottom: '1px solid var(--border, #2a2a2a)'}}>
          <div style={{fontSize: 13, marginBottom: 8}}>① 选择 Voice Profile（active）：</div>
          {profiles.length === 0 ? (
            <div className="stage-empty">
              <p className="empty-title">暂无 active Voice Profile</p>
              <p>请先在 设置→自定义声音 创建 voice profile 并上传参考音频</p>
            </div>
          ) : (
            <>
              <select
                value={selectedProfile}
                onChange={(e) => setSelectedProfile(e.target.value)}
                style={{fontSize: 12, maxWidth: 420}}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} · {p.id.slice(0, 8)}
                  </option>
                ))}
              </select>

              <div style={{fontSize: 13, margin: '12px 0 8px'}}>② 展开并选择 exact revision：</div>
              {revisions === null ? (
                <div className="loading">加载 revisions…</div>
              ) : revisions.length === 0 ? (
                <div className="stage-empty">
                  <p className="empty-title">该 Profile 暂无 revision</p>
                </div>
              ) : (
                <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                  <select
                    value={selectedRevision}
                    onChange={(e) => setSelectedRevision(e.target.value)}
                    style={{fontSize: 12, maxWidth: 520}}
                  >
                    {revisions.map((r) => (
                      <option key={r.id} value={r.id}>
                        v{r.revisionNumber} · {(r.durationMs / 1000).toFixed(1)}s · sha {r.canonicalAudioSha256.slice(0, 10)} · {r.adapterCompatibilityKey}
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={building || !selectedRevision} onClick={() => void build()}>
                    {building ? '提交中…' : '创建 Assignment candidate'}
                  </button>
                </div>
              )}
              {buildError && <div style={{color: '#f87171', fontSize: 12, marginTop: 8}}>{buildError}</div>}
            </>
          )}
        </div>

        <div style={{paddingTop: 16}}>
          <div style={{fontSize: 13, marginBottom: 8}}>③ Assignment candidates（immutable，历史保留）：</div>
          {assignments.length === 0 ? (
            <div className="stage-empty">
              <p className="empty-title">暂无 voice assignment candidate</p>
              <p>显式选择 exact revision 后创建；新 revision 不改变旧 assignment</p>
            </div>
          ) : (
            <table style={{width: '100%', fontSize: 12, borderCollapse: 'collapse'}}>
              <thead>
                <tr>
                  <th style={{textAlign: 'left'}}>版本</th>
                  <th style={{textAlign: 'left'}}>状态</th>
                  <th style={{textAlign: 'left'}}>exact revision</th>
                  <th style={{textAlign: 'left'}}>sha</th>
                  <th style={{textAlign: 'left'}}>创建时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {assignments.map((c) => (
                  <tr key={c.artifactId} style={{borderTop: '1px solid var(--border, #2a2a2a)'}}>
                    <td>v{c.version}</td>
                    <td style={{color: STATUS_COLOR[c.status] ?? 'inherit'}}>
                      {STATUS_LABELS[c.status] ?? c.status}
                    </td>
                    <td>{c.sourceVoiceProfileRevisionId?.slice(0, 8) ?? '—'}</td>
                    <td>{c.canonicalAudioSha256?.slice(0, 10) ?? '—'}</td>
                    <td>{new Date(c.createdAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        style={{fontSize: 11}}
                        onClick={() => setDetail(detail?.artifactId === c.artifactId ? null : c)}
                      >
                        {detail?.artifactId === c.artifactId ? '收起' : '详情'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {detail && (
            <div style={{fontSize: 12, marginTop: 12, padding: 12, background: 'rgba(255,255,255,0.04)', borderRadius: 8}}>
              <div>状态：{STATUS_LABELS[detail.status] ?? detail.status}{detail.statusReason ? ` — ${detail.statusReason}` : ''}</div>
              <div>voiceProfileId：{detail.sourceVoiceProfileId}</div>
              <div>voiceProfileRevisionId：{detail.sourceVoiceProfileRevisionId}</div>
              <div>canonicalAudioSha256：{detail.canonicalAudioSha256}</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

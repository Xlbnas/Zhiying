'use client';

import {useCallback, useEffect, useRef, useState} from 'react';

interface ResolutionData {
  sceneId: string;
  category: string;
  totalRequired: number;
  ready: number;
  overallStatus: string;
  requirements: RequirementData[];
}

interface RequirementData {
  index: number;
  requirement: {subject: string; query: string; policy: string; kind: string};
  status: string;
  friendlyStatus: string;
  boundAssetId: string | null;
  availableActions: string[];
}

interface ResolverResponse {
  resolutions: ResolutionData[];
}

export function VisualAssetsPanel({projectId, scenesStageKey}: {projectId: string; scenesStageKey: string}) {
  const [data, setData] = useState<ResolverResponse | null>(null);
  const [summary, setSummary] = useState<{needAssets: number; readyAssetScenes: number; pendingAssets: number} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [expandedScene, setExpandedScene] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingScene, setUploadingScene] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r1, r2] = await Promise.all([
        fetch(`/api/projects/${projectId}/assets/resolve`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/assets`, {cache: 'no-store'}),
      ]);
      if (r1.ok) setData((await r1.json()) as ResolverResponse);
      if (r2.ok) {
        const d = await r2.json() as Record<string, unknown>;
        setSummary({needAssets: d.needAssets as number, readyAssetScenes: d.readyAssetScenes as number, pendingAssets: d.pendingAssets as number});
      }
      setError(null);
    } catch {
      setError('素材数据加载失败');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, scenesStageKey]);

  const acquire = useCallback(async () => {
    setAcquiring(true); setResult(null); setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/resolve`, {method: 'POST'});
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as {message?: string})?.message ?? `HTTP ${res.status}`);
      const r = await res.json() as {acquired: number; reused: number; failed: number};
      setResult(`成功 ${r.acquired}，失败 ${r.failed}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取失败');
    } finally { setAcquiring(false); }
  }, [projectId, load]);

  const uploadForScene = useCallback(async (sceneId: string) => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploadingScene(sceneId);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('sceneId', sceneId);
      form.append('requirementIndex', '0');
      const res = await fetch(`/api/projects/${projectId}/assets/upload`, {method: 'POST', body: form});
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as {message?: string})?.message ?? `HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploadingScene(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [projectId, load]);

  if (!summary || summary.needAssets === 0) return null;

  const needScenes = data?.resolutions.filter(s => s.totalRequired > 0) ?? [];

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="视觉素材">
      <div className="panel-head">
        <span className="panel-title">视觉素材</span>
        <div className="panel-head-actions">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
            onChange={(e) => { if (e.target.files?.[0] && uploadingScene) uploadForScene(uploadingScene); }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={acquiring}
            onClick={() => void acquire()}>
            {acquiring ? '获取中…' : '自动准备全部'}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div> : null}

      <div style={{padding: '0 24px 20px'}}>
        <div style={{display: 'flex', gap: 20, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap'}}>
          <span style={{fontSize: 14}}>需要素材：<strong>{summary.needAssets}</strong> 个镜头</span>
          <span style={{fontSize: 14}}>已准备：<strong style={{color: summary.pendingAssets === 0 ? 'var(--success)' : 'var(--accent)'}}>{summary.readyAssetScenes}</strong> / {summary.needAssets}</span>
          {summary.pendingAssets > 0 ? <span style={{fontSize: 12, color: 'var(--muted)'}}>待准备：{summary.pendingAssets} 个</span> : null}
        </div>

        {result ? <div style={{fontSize: 12, color: 'var(--success)', marginBottom: 8}}>{result}</div> : null}

        {/* Per-scene list */}
        {needScenes.length > 0 ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
            {needScenes.map((s) => (
              <div key={s.sceneId} style={{border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden'}}>
                <div style={{display: 'flex', alignItems: 'center', padding: '10px 14px', cursor: 'pointer',
                  background: s.ready === s.totalRequired ? 'var(--success-bg)' : 'var(--surface-raised)',
                }} onClick={() => setExpandedScene(expandedScene === s.sceneId ? null : s.sceneId)}>
                  <span style={{flex: 1, fontSize: 13}}>
                    <strong>{s.sceneId}</strong>
                    {s.requirements[0] ? <> · {s.requirements[0].requirement.subject.slice(0, 40)}</> : null}
                  </span>
                  <span style={{fontSize: 12, color: s.ready === s.totalRequired ? 'var(--success)' : 'var(--accent)', fontWeight: 600}}>
                    {s.ready}/{s.totalRequired}
                  </span>
                  <span style={{marginLeft: 8, fontSize: 11, opacity: 0.6}}>{expandedScene === s.sceneId ? '▲' : '▼'}</span>
                </div>

                {expandedScene === s.sceneId ? (
                  <div style={{padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface)'}}>
                    {s.requirements.map((req) => (
                      <div key={req.index} style={{marginBottom: 10}}>
                        <div style={{fontSize: 12, color: 'var(--muted)', marginBottom: 4}}>
                          {req.requirement.subject} · {req.friendlyStatus}
                        </div>
                        <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                          {req.availableActions.includes('search') && (
                            <button className="btn btn-sm" onClick={() => acquire()}>重新搜索</button>
                          )}
                          {req.availableActions.includes('generate') ? (
                            <button className="btn btn-sm" disabled title="AI 图像生成暂不可用">AI 生成（暂不可用）</button>
                          ) : null}
                          {req.availableActions.includes('upload') && (
                            <button className="btn btn-sm" onClick={() => { setUploadingScene(s.sceneId); fileRef.current?.click(); }}>
                              {uploadingScene === s.sceneId ? '上传中…' : '上传图片'}
                            </button>
                          )}
                          {req.availableActions.includes('switch_to_mg') ? (
                            <button className="btn btn-sm" disabled title="改用 MG 功能即将支持">改用 MG（即将支持）</button>
                          ) : null}
                        </div>
                        <details style={{marginTop: 6}}>
                          <summary style={{cursor: 'pointer', fontSize: 11, opacity: 0.6}}>技术详情</summary>
                          <div style={{fontSize: 10, opacity: 0.5, marginTop: 4}}>
                            sceneId={s.sceneId} reqIndex={req.index} policy={req.requirement.policy}<br />
                            query="{req.requirement.query}" status={req.status}
                          </div>
                        </details>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

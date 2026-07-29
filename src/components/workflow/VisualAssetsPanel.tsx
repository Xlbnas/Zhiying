'use client';

import {useCallback, useEffect, useRef, useState} from 'react';

interface GeneratedCandidateData {
  assetId: string;
  publicPath: string;
  provider: string;
  prompt: string;
  createdAt: string;
}

interface BoundAssetData {
  id: string;
  local_path: string;
  description: string | null;
  source_type: string;
  license_status: string;
  attribution: string | null;
}

interface RequirementData {
  requirementId: string;
  index: number;
  requirement: {subject: string; query: string; policy: string; kind: string};
  status: string;
  friendlyStatus: string;
  boundAssetId: string | null;
  boundAsset: BoundAssetData | null;
  generatedCandidates: GeneratedCandidateData[];
  availableActions: string[];
}

interface ResolutionData {
  sceneId: string;
  category: string;
  totalRequired: number;
  ready: number;
  overallStatus: string;
  requirements: RequirementData[];
}

interface ResolverResponse {
  resolutions: ResolutionData[];
}

interface SummaryData {
  needAssets: number;
  readyRequirements: number;
  pendingAssets: number;
}

const SOURCE_LABELS: Record<string, string> = {
  generated: 'AI 生成',
  upload: '用户上传',
  archive: '档案素材',
  stock: '图库素材',
  local: '本地素材',
};

export function VisualAssetsPanel({projectId, scenesStageKey}: {projectId: string; scenesStageKey: string}) {
  const [data, setData] = useState<ResolverResponse | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [expandedScene, setExpandedScene] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 上传目标：exact scene + requirement（上传与替换共用同一通道）
  const [uploadTarget, setUploadTarget] = useState<{sceneId: string; requirementId: string} | null>(null);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  // 生成目标：exact requirement
  const [genTarget, setGenTarget] = useState<{sceneId: string; requirementId: string} | null>(null);
  const [genPrompt, setGenPrompt] = useState<string>('');
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [genAvailable, setGenAvailable] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null); // 搜索/绑定按钮 busy

  const load = useCallback(async () => {
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(`/api/projects/${projectId}/assets/resolve`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/assets`, {cache: 'no-store'}),
        fetch(`/api/projects/${projectId}/assets/generate`, {cache: 'no-store'}),
      ]);
      if (r1.ok) setData((await r1.json()) as ResolverResponse);
      if (r2.ok) {
        const d = await r2.json() as Record<string, unknown>;
        setSummary({
          needAssets: d.needAssets as number,
          readyRequirements: (d.readyRequirements as number) ?? 0,
          pendingAssets: d.pendingAssets as number,
        });
      }
      if (r3.ok) {
        const g = await r3.json() as {available: boolean};
        setGenAvailable(g.available);
      }
      setError(null);
    } catch {
      setError('素材数据加载失败');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, scenesStageKey]);

  const errMsg = async (res: Response, fallback: string): Promise<string> =>
    ((await res.json().catch(() => null)) as {message?: string})?.message ?? `${fallback}（HTTP ${res.status}）`;

  const acquireAll = useCallback(async () => {
    setAcquiring(true); setResult(null); setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/resolve`, {method: 'POST'});
      if (!res.ok) throw new Error(await errMsg(res, '获取失败'));
      const r = await res.json() as {acquired: number; reused: number; failed: number};
      setResult(`成功 ${r.acquired}，失败 ${r.failed}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取失败');
    } finally { setAcquiring(false); }
  }, [projectId, load]);

  const searchOne = useCallback(async (sceneId: string, requirementId: string) => {
    const key = `${sceneId}:${requirementId}:search`;
    setBusyKey(key); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/resolve`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId, requirementId}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '搜索失败'));
      const r = await res.json() as {status: string; reason?: string};
      setResult(r.status === 'acquired' ? '已找到并绑定素材' : (r.reason ?? '未找到合适素材'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败');
    } finally { setBusyKey(null); }
  }, [projectId, load]);

  const doGenerate = useCallback(async () => {
    if (!genTarget || !genPrompt.trim()) return;
    const key = `${genTarget.sceneId}:${genTarget.requirementId}:generate`;
    setGeneratingKey(key); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/generate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId: genTarget.sceneId, requirementId: genTarget.requirementId, prompt: genPrompt}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '生成失败'));
      setResult('AI 生成完成（候选）。确认效果后点击「使用这张」才会绑定。');
      setGenTarget(null);
      setGenPrompt('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally { setGeneratingKey(null); }
  }, [projectId, genTarget, genPrompt, load]);

  const bindCandidate = useCallback(async (sceneId: string, requirementId: string, assetId: string) => {
    const key = `${sceneId}:${requirementId}:bind:${assetId}`;
    setBusyKey(key); setError(null); setResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets/generated/${assetId}/bind`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({sceneId, requirementId}),
      });
      if (!res.ok) throw new Error(await errMsg(res, '绑定失败'));
      setResult('已绑定该素材');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '绑定失败');
    } finally { setBusyKey(null); }
  }, [projectId, load]);

  const uploadForTarget = useCallback(async (file: File) => {
    if (!uploadTarget) return;
    const key = `${uploadTarget.sceneId}:${uploadTarget.requirementId}:upload`;
    setUploadingKey(key); setError(null); setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('sceneId', uploadTarget.sceneId);
      form.append('requirementId', uploadTarget.requirementId);
      const res = await fetch(`/api/projects/${projectId}/assets/upload`, {method: 'POST', body: form});
      if (!res.ok) throw new Error(await errMsg(res, '上传失败'));
      const r = await res.json() as {replaced?: boolean};
      setResult(r.replaced ? '已替换该需求的素材（旧素材保留在素材库）' : '已上传并绑定素材');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploadingKey(null);
      setUploadTarget(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }, [projectId, uploadTarget, load]);

  if (!summary || summary.needAssets === 0) return null;

  const needScenes = data?.resolutions.filter((s) => s.totalRequired > 0) ?? [];

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="视觉素材">
      <div className="panel-head">
        <span className="panel-title">视觉素材</span>
        <div className="panel-head-actions">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadForTarget(f); }} />
          <button type="button" className="btn btn-primary btn-sm" disabled={acquiring}
            onClick={() => void acquireAll()}>
            {acquiring ? '获取中…' : '自动准备全部'}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div> : null}

      <div style={{padding: '0 24px 20px'}}>
        <div style={{display: 'flex', gap: 20, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap'}}>
          <span style={{fontSize: 14}}>素材需求：<strong>{summary.needAssets}</strong> 项</span>
          <span style={{fontSize: 14}}>已准备：<strong style={{color: summary.pendingAssets === 0 ? 'var(--success)' : 'var(--accent)'}}>{summary.readyRequirements}</strong> / {summary.needAssets}</span>
          {summary.pendingAssets > 0 ? <span style={{fontSize: 12, color: 'var(--muted)'}}>待准备：{summary.pendingAssets} 项</span> : null}
        </div>

        {result ? <div style={{fontSize: 12, color: 'var(--success)', marginBottom: 8}}>{result}</div> : null}

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
                    {s.ready}/{s.totalRequired} 已准备
                  </span>
                  <span style={{marginLeft: 8, fontSize: 11, opacity: 0.6}}>{expandedScene === s.sceneId ? '▲' : '▼'}</span>
                </div>

                {expandedScene === s.sceneId ? (
                  <div style={{padding: '10px 14px', borderTop: '1px solid var(--border)', background: 'var(--surface)'}}>
                    {s.requirements.map((req) => {
                      const reqKey = `${s.sceneId}:${req.requirementId}`;
                      const isReady = req.status === 'ready';
                      return (
                        <div key={req.requirementId} style={{marginBottom: 14, paddingBottom: 12, borderBottom: '1px dashed var(--border)'}}>
                          <div style={{display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap'}}>
                            <span style={{fontSize: 12, fontWeight: 600}}>需求 {req.index + 1}</span>
                            <span style={{fontSize: 12, color: 'var(--muted)'}}>{req.requirement.subject}</span>
                            <span style={{fontSize: 12, fontWeight: 600, color: isReady ? 'var(--success)' : 'var(--accent)'}}>
                              {isReady ? '✓ ' : ''}{req.friendlyStatus}
                            </span>
                          </div>

                          {/* 已绑定素材（exact binding） */}
                          {req.boundAsset ? (
                            <div style={{display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6}}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={`/${req.boundAsset.local_path}`} alt={req.boundAsset.description ?? req.requirement.subject}
                                style={{width: 96, height: 54, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)'}} />
                              <div style={{fontSize: 11, color: 'var(--muted)'}}>
                                <div>{SOURCE_LABELS[req.boundAsset.source_type] ?? req.boundAsset.source_type}
                                  {req.boundAsset.source_type === 'upload' ? '（版权由用户负责，系统未独立审核）' : ''}
                                  {req.boundAsset.source_type === 'generated' ? '（AI 生成素材）' : ''}
                                </div>
                                {req.boundAsset.attribution ? <div style={{opacity: 0.8}}>{req.boundAsset.attribution}</div> : null}
                              </div>
                            </div>
                          ) : null}

                          {/* 操作按钮：全部针对 exact requirement */}
                          <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                            {req.availableActions.includes('search') && (
                              <button className="btn btn-sm" disabled={busyKey === `${reqKey}:search`}
                                onClick={() => void searchOne(s.sceneId, req.requirementId)}>
                                {busyKey === `${reqKey}:search` ? '搜索中…' : '重新搜索'}
                              </button>
                            )}
                            {req.availableActions.includes('generate') ? (
                              genAvailable ? (
                                <button className="btn btn-sm"
                                  onClick={() => {
                                    setGenTarget({sceneId: s.sceneId, requirementId: req.requirementId});
                                    setGenPrompt(req.requirement.subject);
                                  }}>
                                  AI 生成
                                </button>
                              ) : (
                                <button className="btn btn-sm" disabled title="AI 图像生成暂不可用">AI 生成（暂不可用）</button>
                              )
                            ) : null}
                            {req.availableActions.includes('upload') && (
                              <button className="btn btn-sm" disabled={uploadingKey === `${reqKey}:upload`}
                                onClick={() => { setUploadTarget({sceneId: s.sceneId, requirementId: req.requirementId}); fileRef.current?.click(); }}>
                                {uploadingKey === `${reqKey}:upload` ? '上传中…' : '上传图片'}
                              </button>
                            )}
                            {req.availableActions.includes('replace') && (
                              <button className="btn btn-sm" disabled={uploadingKey === `${reqKey}:upload`}
                                onClick={() => { setUploadTarget({sceneId: s.sceneId, requirementId: req.requirementId}); fileRef.current?.click(); }}>
                                {uploadingKey === `${reqKey}:upload` ? '上传中…' : '替换素材'}
                              </button>
                            )}
                            {req.availableActions.includes('switch_to_mg') ? (
                              <button className="btn btn-sm" disabled title="改用 MG 功能即将支持">改用 MG（即将支持）</button>
                            ) : null}
                          </div>

                          {/* AI 生成 prompt 编辑器（针对 exact requirement） */}
                          {genTarget?.requirementId === req.requirementId ? (
                            <div style={{display: 'flex', gap: 6, flexDirection: 'column', width: '100%', marginTop: 6}}>
                              <textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)}
                                placeholder="描述你想要的画面..." rows={2}
                                style={{fontSize: 12, padding: 6, borderRadius: 6, border: '1px solid var(--border)', resize: 'vertical'}} />
                              <div style={{display: 'flex', gap: 6}}>
                                <button className="btn btn-sm btn-primary" disabled={generatingKey === `${reqKey}:generate` || !genPrompt.trim()}
                                  onClick={() => void doGenerate()}>
                                  {generatingKey === `${reqKey}:generate` ? '生成中…' : '开始生成'}
                                </button>
                                <button className="btn btn-sm" onClick={() => { setGenTarget(null); setGenPrompt(''); }}>取消</button>
                              </div>
                            </div>
                          ) : null}

                          {/* 未绑定 AI 生成候选（candidate-first：显式「使用这张」才绑定） */}
                          {req.generatedCandidates.length > 0 ? (
                            <div style={{marginTop: 8}}>
                              <div style={{fontSize: 11, color: 'var(--muted)', marginBottom: 4}}>
                                AI 生成候选（未绑定，不影响就绪状态）：
                              </div>
                              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                                {req.generatedCandidates.map((c) => (
                                  <div key={c.assetId} style={{border: '1px solid var(--border)', borderRadius: 8, padding: 6, background: 'var(--surface-raised)'}}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={`/${c.publicPath}`} alt={c.prompt.slice(0, 60)}
                                      style={{width: 128, height: 72, objectFit: 'cover', borderRadius: 4, display: 'block'}} />
                                    <div style={{fontSize: 10, color: 'var(--muted)', marginTop: 4, maxWidth: 128}}>
                                      AI 生成 · {c.provider}
                                    </div>
                                    <button className="btn btn-sm btn-primary" style={{marginTop: 4}}
                                      disabled={busyKey === `${reqKey}:bind:${c.assetId}`}
                                      onClick={() => void bindCandidate(s.sceneId, req.requirementId, c.assetId)}>
                                      {busyKey === `${reqKey}:bind:${c.assetId}` ? '绑定中…' : '使用这张'}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          <details style={{marginTop: 6}}>
                            <summary style={{cursor: 'pointer', fontSize: 11, opacity: 0.6}}>技术详情</summary>
                            <div style={{fontSize: 10, opacity: 0.5, marginTop: 4}}>
                              sceneId={s.sceneId} requirementId={req.requirementId} policy={req.requirement.policy}<br />
                              query=&quot;{req.requirement.query}&quot; status={req.status}
                            </div>
                          </details>
                        </div>
                      );
                    })}
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

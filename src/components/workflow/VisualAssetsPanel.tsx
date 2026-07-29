'use client';

import {useCallback, useEffect, useState} from 'react';

interface VisualAssetsInfo {
  total: number;
  noAssetNeeded: number;
  needAssets: number;
  readyAssetScenes: number;
  pendingAssets: number;
  missing: Array<{sceneId: string; reason: string}>;
  assets: Array<unknown>;
}

export function VisualAssetsPanel({projectId, scenesStageKey}: {projectId: string; scenesStageKey: string}) {
  const [data, setData] = useState<VisualAssetsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/assets`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as VisualAssetsInfo);
      setError(null);
    } catch {
      setError('素材数据加载失败');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, scenesStageKey]);

  const acquire = useCallback(async () => {
    setAcquiring(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      const r = (await res.json()) as {acquired: number; reused: number; failed: number};
      setResult(`新增 ${r.acquired}，复用 ${r.reused}，失败 ${r.failed}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材获取失败');
    } finally {
      setAcquiring(false);
    }
  }, [projectId, load]);

  if (!data) return null;
  if (data.needAssets === 0) return null; // 无需外部素材则不显示

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="视觉素材">
      <div className="panel-head">
        <span className="panel-title">视觉素材</span>
        <div className="panel-head-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={acquiring}
            onClick={() => void acquire()}>
            {acquiring ? '获取中…' : '准备素材'}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div> : null}

      <div style={{padding: '0 24px 20px'}}>
        <div style={{display: 'flex', gap: 20, alignItems: 'center', marginBottom: 12}}>
          <span style={{fontSize: 14}}>
            需要素材：<strong>{data.needAssets}</strong> 个镜头
          </span>
          <span style={{fontSize: 14}}>
            已准备：<strong style={{color: data.pendingAssets === 0 ? 'var(--success)' : 'var(--accent)'}}>
              {data.readyAssetScenes}
            </strong> / {data.needAssets}
          </span>
          {data.pendingAssets > 0 ? (
            <span style={{fontSize: 12, color: 'var(--muted)'}}>
              待准备：{data.pendingAssets} 个
            </span>
          ) : null}
        </div>

        {result ? (
          <div style={{fontSize: 12, color: 'var(--success)', marginBottom: 8}}>{result}</div>
        ) : null}

        {data.missing.length > 0 ? (
          <details>
            <summary style={{cursor: 'pointer', fontSize: 13, opacity: 0.75}}>
              查看缺失镜头（{data.missing.length}）
            </summary>
            <ul style={{fontSize: 12, margin: '8px 0 0 16px', lineHeight: 1.8}}>
              {data.missing.map((m) => (
                <li key={m.sceneId}>{m.sceneId}: {m.reason}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

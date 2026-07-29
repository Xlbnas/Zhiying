'use client';

import {useRouter} from 'next/navigation';
import {useCallback, useEffect, useState} from 'react';
import {FullCutPlayer} from '@/components/FullCutPlayer';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';
import {friendlyStageError} from './shared';

/**
 * Visual Preview（M2-E-C §二十六/四十六）：
 * locked Scenes → M1 Render Bridge 的预览与人工渲染入口。
 * Player 与 Renderer 共用同一 bridge props（/api/projects/:id/render-preview）。
 * 未 ready 时展示结构化 blockers。本轮产物 = Visual Preview Render（非最终成片）。
 */

interface VisualReadinessInfo {
  ready: boolean;
  total: number;
  noAssetNeeded: number;
  needAssets: number;
  readyScenes: number;
  readyAssetScenes: number;
  pendingAssets: number;
  missing: Array<{sceneId: string; reason: string}>;
}

interface PreviewResponse {
  ready: boolean;
  blockers: Array<{code: string; message: string}>;
  scenesVersion: number | null;
  visualReadiness: VisualReadinessInfo | null;
  props: ZhiyingFullCutProps | null;
}

export function VisualPreview({
  projectId,
  scenesStageKey,
}: {
  projectId: string;
  /** scenes 阶段状态指纹（status+updated_at）：变化时重新拉取 readiness。 */
  scenesStageKey: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const [acquireResult, setAcquireResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/render-preview`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as PreviewResponse);
      setError(null);
    } catch {
      setError('预览数据加载失败');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load, scenesStageKey]);

  const startRender = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/render-preview`, {
        method: 'POST',
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      router.push('/jobs');
    } catch (err) {
      setError(err instanceof Error ? err.message : '渲染任务创建失败');
      setSubmitting(false);
      void load();
    }
  }, [projectId, router, load]);

  const acquireAssets = useCallback(async () => {
    setAcquiring(true);
    setAcquireResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets`, {method: 'POST'});
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {message?: string} | null;
        throw new Error(json?.message ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as {acquired: number; reused: number; failed: number};
      setAcquireResult(`新增 ${result.acquired}，复用 ${result.reused}，失败 ${result.failed}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材获取失败');
    } finally {
      setAcquiring(false);
    }
  }, [projectId, load]);

  return (
    <section className="stage-panel" style={{marginTop: 20}} aria-label="画面预览">
      <div className="stage-panel-head">
        <div>
          <h2 className="stage-panel-title">画面预览</h2>
          <p className="stage-panel-sub">
            根据已锁定的场景数据生成预览（暂无配音字幕）
            {data?.visualReadiness ? (
              <span style={{marginLeft: 12}}>
                {' · '}视觉素材{' '}
                <span style={{
                  color: data.visualReadiness.pendingAssets === 0 ? 'var(--success)' : 'var(--accent)',
                  fontWeight: 600,
                }}>
                  {data.visualReadiness.readyAssetScenes}/{data.visualReadiness.needAssets}
                </span>
                {' 已准备'}
              </span>
            ) : null}
            {data?.scenesVersion !== null && data?.scenesVersion !== undefined ? (
              <details style={{marginTop: 6}}>
                <summary style={{cursor: 'pointer', opacity: 0.75}}>技术详情</summary>
                <div className="mono" style={{marginTop: 4, fontSize: 12}}>
                  scenes v{data.scenesVersion}
                </div>
              </details>
            ) : null}
          </p>
        </div>
        <div className="stage-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!data?.ready || submitting}
            onClick={() => void startRender()}
          >
            {submitting ? '创建中…' : '生成预览'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{error}</div>
      ) : null}

      {/* M6：视觉素材准备 */}
      {data?.visualReadiness && data.visualReadiness.needAssets > 0 ? (
        <div style={{
          padding: '12px 16px', margin: '8px 0',
          background: 'var(--surface-raised)', borderRadius: 8,
          border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{fontSize: 14, fontWeight: 600}}>
            视觉素材{' '}
            <span style={{color: data.visualReadiness.readyAssetScenes === data.visualReadiness.needAssets ? 'var(--success)' : 'var(--accent)'}}>
              {data.visualReadiness.readyAssetScenes}/{data.visualReadiness.needAssets}
            </span>
            {' '}已准备
            {data.visualReadiness.pendingAssets > 0 ? (
              <span style={{color: 'var(--muted)', fontSize: 12, marginLeft: 6}}>
                （{data.visualReadiness.pendingAssets} 个待准备）
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={acquiring}
            onClick={() => void acquireAssets()}
            style={{marginLeft: 'auto'}}
          >
            {acquiring ? '获取中…' : '准备素材'}
          </button>
          {data.visualReadiness.missing.length > 0 ? (
            <details style={{width: '100%', marginTop: 4}}>
              <summary style={{cursor: 'pointer', fontSize: 12, opacity: 0.75}}>
                查看缺失镜头（{data.visualReadiness.missing.length}）
              </summary>
              <ul style={{fontSize: 12, margin: '4px 0 0 16px', lineHeight: 1.8}}>
                {data.visualReadiness.missing.map((m) => (
                  <li key={m.sceneId}>{m.sceneId}: {m.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {acquireResult ? (
            <span style={{fontSize: 12, color: 'var(--success)', width: '100%'}}>{acquireResult}</span>
          ) : null}
        </div>
      ) : null}

      {data === null ? (
        <div className="loading">正在检查渲染条件…</div>
      ) : data.ready && data.props ? (
        <div className="player-frame">
          <FullCutPlayer inputProps={data.props} />
        </div>
      ) : (
        <div className="stage-empty">
          <p className="empty-title">暂不可渲染</p>
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
      )}
    </section>
  );
}

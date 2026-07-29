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
  readyRequirements: number;
  pendingAssets: number;
  missing: Array<{sceneId: string; requirementId: string | null; reason: string}>;
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
                  {data.visualReadiness.readyRequirements}/{data.visualReadiness.needAssets}
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

      {data === null ? (
        <div className="loading">正在检查渲染条件…</div>
      ) : data.ready && data.props ? (
        <div className="player-frame">
          <FullCutPlayer inputProps={data.props} />
        </div>
      ) : (
        <div className="stage-empty">
          {/* M6.1: Legacy scene detection — if blocked by retired M1 templates, show migration UI */}
          {data.blockers.some(b => b.code === 'MG_TEMPLATE_NOT_REGISTERED' || (b.code === 'RENDER_SOURCE_INVALID' && b.message.includes('MG_TEMPLATE_NOT_REGISTERED'))) ? (
            <div style={{textAlign: 'center', marginBottom: 16}}>
              <p className="empty-title" style={{fontSize: 16}}>这个项目使用了旧版画面格式，需要更新画面数据后才能继续生成视频。</p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting}
                onClick={() => {
                  setSubmitting(true);
                  fetch('/api/workflow/run-stage', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({projectId, stage: 'scenes', confirmStale: true}),
                  }).then(r => r.json()).then(d => {
                    if (d.job) { alert('画面数据更新已开始，请稍等片刻后刷新页面查看结果。'); }
                    else { alert('更新请求失败，请稍后重试。'); }
                  }).catch(() => alert('更新请求失败，请稍后重试。'))
                  .finally(() => { setSubmitting(false); load(); });
                }}
              >
                {submitting ? '更新中…' : '更新画面数据'}
              </button>
              <p style={{fontSize: 12, color: 'var(--muted)', marginTop: 8}}>
                基于现有镜头数据重新生成画面，旧版本会保留为历史记录。
              </p>
            </div>
          ) : (
            <p className="empty-title">暂不可渲染</p>
          )}
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

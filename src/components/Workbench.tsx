'use client';

import {useRouter} from 'next/navigation';
import {useCallback, useEffect, useRef, useState} from 'react';
import type {PlayerRef} from '@remotion/player';
import {FullCutPlayer} from '@/components/FullCutPlayer';
import {formatDurationSec} from '@/components/format';
import {
  zhiyingFullCutPropsSchema,
  type Scene,
  type ZhiyingFullCutProps,
} from '@/lib/scene-schema';

/**
 * 项目工作台（CONTRACT §6）：
 * 左侧 Scene 列表（ID / 章节 / 时长 / 模板 / 类型，M1 只读）
 * + 右侧 Remotion Player（同构组件，inputProps 来自 /api/projects/[id]/scenes）
 * + 导出成片 / 导出无字幕版 → POST /api/projects/[id]/render → 跳 /jobs。
 */

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

type RenderKind = 'fullcut' | 'no-subtitles';

export function Workbench({projectId}: {projectId: string}) {
  const router = useRouter();
  const playerRef = useRef<PlayerRef>(null);
  const [props, setProps] = useState<ZhiyingFullCutProps | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [exporting, setExporting] = useState<RenderKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [detailRes, scenesRes] = await Promise.all([
          fetch(`/api/projects/${projectId}`, {cache: 'no-store'}),
          fetch(`/api/projects/${projectId}/scenes`, {cache: 'no-store'}),
        ]);
        if (detailRes.status === 404 || scenesRes.status === 404) {
          if (!cancelled) setError('项目不存在或已被删除');
          return;
        }
        if (!scenesRes.ok) throw new Error(`HTTP ${scenesRes.status}`);

        const detailJson: unknown = detailRes.ok
          ? await detailRes.json().catch(() => null)
          : null;
        const scenesJson: unknown = await scenesRes.json();

        // Player props 走唯一数据真相（scene-schema.ts）校验
        const parsed = zhiyingFullCutPropsSchema.safeParse(scenesJson);
        if (!parsed.success) throw new Error('scenes 数据未通过 schema 校验');

        if (!cancelled) {
          setProps(parsed.data);
          setTitle(
            asStr(asObj(asObj(detailJson)?.project)?.title) ??
              parsed.data.data.project.title,
          );
          setSelectedSceneId(parsed.data.data.scenes[0]?.id ?? null);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('项目数据加载失败，请确认服务已启动');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const onSelectScene = useCallback((scene: Scene) => {
    setSelectedSceneId(scene.id);
    playerRef.current?.seekTo(scene.startFrame);
  }, []);

  const startRender = useCallback(
    async (kind: RenderKind) => {
      setExporting(kind);
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/render`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({kind}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        router.push('/jobs');
      } catch {
        setError('渲染任务创建失败，请稍后重试');
        setExporting(null);
      }
    },
    [projectId, router],
  );

  if (loading) {
    return (
      <main className="container">
        <div className="loading">正在加载工作台…</div>
      </main>
    );
  }

  if (!props) {
    return (
      <main className="container">
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="empty">
          <p className="empty-title">无法打开工作台</p>
          <button type="button" className="btn" onClick={() => router.push('/')}>
            返回项目列表
          </button>
        </div>
      </main>
    );
  }

  const {project, scenes} = {project: props.data.project, scenes: props.data.scenes};

  return (
    <main className="container fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">{title ?? project.title}</h1>
          <p className="page-sub mono">
            {scenes.length} 个场景 · {formatDurationSec(project.durationSec)} ·{' '}
            {project.width}×{project.height} · {project.fps} 帧/秒
          </p>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="workbench">
        {/* 左：Scene 列表（只读） */}
        <section className="panel" aria-label="场景列表">
          <div className="panel-head">
            <span className="panel-title">场景</span>
            <span className="mono" style={{fontSize: 12, color: 'var(--muted)'}}>
              {scenes.length}
            </span>
          </div>
          <div className="scene-list" role="listbox" aria-label="场景">
            {scenes.map((scene) => (
              <button
                key={scene.id}
                type="button"
                role="option"
                aria-selected={scene.id === selectedSceneId}
                className={`scene-row${scene.id === selectedSceneId ? ' selected' : ''}`}
                onClick={() => onSelectScene(scene)}
              >
                <span className="scene-id mono" title={scene.id}>
                  {scene.id}
                </span>
                <span className="scene-line">
                  第{scene.chapter}章 · {scene.category}
                  {scene.visualType ? ` · ${scene.visualType}` : ''}
                </span>
                <span className="scene-dur mono">
                  {formatDurationSec(scene.duration)}
                </span>
                <span className="scene-template mono">
                  {scene.template ?? scene.sourceTemplate ?? '—'}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* 右：Player + 导出 */}
        <section className="panel" aria-label="预览与导出">
          <div className="panel-head">
            <span className="panel-title">预览</span>
            <div className="panel-head-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={exporting !== null}
                onClick={() => void startRender('fullcut')}
              >
                {exporting === 'fullcut' ? '创建中…' : '导出成片'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={exporting !== null}
                onClick={() => void startRender('no-subtitles')}
              >
                {exporting === 'no-subtitles' ? '创建中…' : '导出无字幕版'}
              </button>
            </div>
          </div>
          <div className="player-frame">
            <FullCutPlayer ref={playerRef} inputProps={props} />
          </div>
          <div className="player-meta">
            <span>
              时长 <span className="mono">{formatDurationSec(project.durationSec)}</span>
            </span>
            <span>
              总帧数 <span className="mono">{project.durationInFrames}</span>
            </span>
            <span>
              字幕 <span className="mono">{props.subtitles.length}</span> 条
            </span>
            <span>
              旁白 <span className="mono">{props.audio.narration ? '已挂载' : '无'}</span>
            </span>
          </div>
          <p className="player-hint">点击左侧场景可将播放头定位到该场景起始帧。</p>
        </section>
      </div>
    </main>
  );
}

'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useCallback, useEffect, useRef, useState} from 'react';
import {NewProjectForm} from '@/components/NewProjectForm';
import {StatusBadge} from '@/components/StatusBadge';
import {formatDateTime, formatDurationSec} from '@/components/format';

/**
 * 项目列表（CONTRACT §6）。
 * 编辑部气质：卡片含标题 / 场景数 / 时长 / 最近渲染状态 + 导入按钮。
 * 导入：input[type=file] 读本地 FullCutScenes.json 原文 → POST /api/projects/import。
 *
 * 注：/api/projects 返回 `{projects: [...]}`，列表项中场景数 / 时长 /
 * 最近渲染状态由 API agent 提供；此处对字段命名做了防御性归一化，
 * 字段缺口显示占位符而不报错。
 */

type ProjectListItem = {
  id: string;
  title: string;
  sceneCount: number | null;
  durationSec: number | null;
  updatedAt: string | null;
  lastJobStatus: string | null;
  lastJobKind: string | null;
};

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function normalizeProject(raw: unknown): ProjectListItem | null {
  const p = asObj(raw);
  if (!p) return null;
  const id = asStr(p.id);
  if (!id) return null;
  const stats = asObj(p.stats);
  const lastJob =
    asObj(p.lastJob) ?? asObj(p.last_job) ?? asObj(p.latestJob) ?? asObj(p.latest_job);
  return {
    id,
    title: asStr(p.title) ?? '未命名项目',
    sceneCount: asNum(p.sceneCount) ?? asNum(p.scene_count) ?? asNum(stats?.sceneCount) ?? null,
    durationSec:
      asNum(p.durationSec) ?? asNum(p.duration_sec) ?? asNum(stats?.durationSec) ?? null,
    updatedAt: asStr(p.updated_at) ?? asStr(p.updatedAt) ?? asStr(p.created_at) ?? null,
    lastJobStatus: asStr(lastJob?.status) ?? asStr(p.last_job_status) ?? null,
    lastJobKind: asStr(lastJob?.kind) ?? asStr(p.last_job_kind) ?? null,
  };
}

export default function ProjectsPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/projects', {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      const list = asObj(json)?.projects;
      const items = Array.isArray(list)
        ? list.map(normalizeProject).filter((p): p is ProjectListItem => p !== null)
        : [];
      setProjects(items);
      setError(null);
    } catch {
      setError('项目列表加载失败，请确认服务已启动');
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onImportFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setError(null);
      try {
        const text = await file.text();
        const res = await fetch('/api/projects/import', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: text, // body = FullCutScenes.json 原文（CONTRACT §5）
        });
        if (!res.ok) {
          const detail: unknown = await res.json().catch(() => null);
          const issues = asObj(detail)?.issues;
          const issueCount = Array.isArray(issues) ? issues.length : 0;
          setError(
            res.status === 422
              ? `导入失败：JSON 未通过 schema 校验（${issueCount} 处问题）`
              : `导入失败：HTTP ${res.status}`,
          );
          return;
        }
        const json: unknown = await res.json();
        const id = asStr(asObj(asObj(json)?.project)?.id);
        if (id) {
          router.push(`/project/${id}`);
        } else {
          await refresh();
        }
      } catch {
        setError('导入失败：无法读取文件或网络异常');
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [refresh, router],
  );

  return (
    <main className="container fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">项目</h1>
          <p className="page-sub">
            {projects ? `共 ${projects.length} 个项目` : '加载中…'}
          </p>
        </div>
        <div style={{display: 'flex', gap: 8}}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowNewProject((v) => !v)}
          >
            {showNewProject ? '收起' : '新建项目'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onImportFile(file);
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? '导入中…' : '导入项目'}
          </button>
        </div>
      </div>

      {showNewProject ? (
        <NewProjectForm onClose={() => setShowNewProject(false)} />
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      {projects === null ? (
        <div className="loading">正在加载项目列表…</div>
      ) : projects.length === 0 ? (
        <div className="empty">
          <p className="empty-title">还没有项目</p>
          <p>点击「新建项目」从一个主题开始，或导入一份 FullCutScenes.json。</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((p, i) => (
            <Link
              key={p.id}
              href={`/project/${p.id}`}
              className="project-card"
              aria-label={`打开项目 ${p.title}`}
            >
              <div className="project-card-top">
                <span className="project-index mono">
                  {String(i + 1).padStart(2, '0')}
                </span>
                {p.lastJobStatus ? (
                  <StatusBadge status={p.lastJobStatus} />
                ) : (
                  <span className="badge" data-status="unknown">
                    未渲染
                  </span>
                )}
              </div>
              <h2 className="project-title">{p.title}</h2>
              <div className="project-meta">
                <span>
                  场景 <span className="mono">{p.sceneCount ?? '—'}</span>
                </span>
                <span>
                  时长 <span className="mono">{formatDurationSec(p.durationSec)}</span>
                </span>
                <span>
                  更新 <span className="mono">{formatDateTime(p.updatedAt)}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

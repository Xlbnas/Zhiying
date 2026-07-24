'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import type {WorkflowStage} from '@/lib/workflow/types';
import {isStageEnabled} from '@/lib/workflow/capabilities';
import {Workbench} from '@/components/Workbench';
import {NarrationPanel} from './NarrationPanel';
import {StagePanel} from './StagePanel';
import {VisualPreview} from './VisualPreview';
import {WorkflowStepper} from './WorkflowStepper';
import {STAGE_NAMES, type StagesResponse} from './shared';

/**
 * Workflow Workspace Shell（M2-C §二十/二十一）。
 *
 * 路由策略：
 * - Legacy M1 项目（无 project_stages）：原 M1 工作台 + 「导入项目 · 无工作流历史」提示，
 *   不自动伪造 10 个 stage。
 * - M2 项目：上方 WorkflowStepper（视觉主轴）+ 下方 StagePanel；
 *   存在 locked scenes artifact 时（M2-E 起）再追加 M1 Scene Workbench。
 *
 * 轮询：存在 queued/running 的 llm_job 时每 2s 刷新 /stages，终态后停止。
 */

const POLL_INTERVAL_MS = 2000;

export function WorkflowWorkspace({projectId}: {projectId: string}) {
  const [data, setData] = useState<StagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selected, setSelected] = useState<WorkflowStage>('project_definition');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/stages`, {cache: 'no-store'});
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as StagesResponse);
      setError(null);
    } catch {
      setError('项目数据加载失败，请确认服务已启动');
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActiveJob = data?.stages.some((s) => s.activeJob !== null) ?? false;

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (hasActiveJob) {
      pollRef.current = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasActiveJob, refresh]);

  if (notFound) {
    return (
      <main className="container">
        <div className="empty">
          <p className="empty-title">项目不存在或已被删除</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="container">
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="loading">正在加载工作台…</div>
      </main>
    );
  }

  // Legacy M1：旧导入项目直接进原工作台
  if (data.legacy) {
    return (
      <>
        <div className="container" style={{paddingBottom: 0}}>
          <div className="legacy-note">导入项目 · 无工作流历史（M1 项目）</div>
        </div>
        <Workbench projectId={projectId} />
      </>
    );
  }

  const selectedState =
    data.stages.find((s) => s.stage === selected) ?? data.stages[0];

  return (
    <main className="container fade-in">
      <div className="page-head">
        <div>
          <h1 className="page-title">{data.project.title}</h1>
          <p className="page-sub">
            {data.inputs ? data.inputs.coreQuestion : '工作流项目'}
          </p>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <WorkflowStepper stages={data.stages} selected={selected} onSelect={setSelected} />

      {selectedState && isStageEnabled(selected) ? (
        <StagePanel
          projectId={projectId}
          stageState={selectedState}
          onChanged={() => void refresh()}
        />
      ) : selectedState ? (
        <section className="stage-panel">
          <div className="stage-panel-head">
            <div>
              <h2 className="stage-panel-title">{STAGE_NAMES[selected]}</h2>
              <p className="stage-panel-sub mono">{selected}</p>
            </div>
          </div>
          <div className="stage-disabled-note">
            本阶段尚未开放（当前开放前六阶段，后续阶段随 M2-E 开通）。
          </div>
        </section>
      ) : null}

      <NarrationPanel
        projectId={projectId}
        scriptV2StageKey={
          (() => {
            const sv2 = data.stages.find((s) => s.stage === 'script_v2');
            return sv2 ? `${sv2.status}:${sv2.updated_at}` : 'missing';
          })()
        }
      />

      {data.hasScenesArtifact ? (
        <div style={{marginTop: 32}}>
          <Workbench projectId={projectId} />
        </div>
      ) : (
        <VisualPreview
          projectId={projectId}
          scenesStageKey={
            (() => {
              const scenesStage = data.stages.find((s) => s.stage === 'scenes');
              return scenesStage
                ? `${scenesStage.status}:${scenesStage.updated_at}`
                : 'missing';
            })()
          }
        />
      )}
    </main>
  );
}

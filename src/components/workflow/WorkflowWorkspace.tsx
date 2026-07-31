'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import type {WorkflowStage} from '@/lib/workflow/types';
import {isStageEnabled} from '@/lib/workflow/capabilities';
import {Workbench} from '@/components/Workbench';
import {NarrationPanel} from './NarrationPanel';
import {FinalRenderPanel} from './FinalRenderPanel';
import {StagePanel} from './StagePanel';
import {TimingReconciliationPanel} from './TimingReconciliationPanel';
import {VisualPreview} from './VisualPreview';
import {VisualAssetsPanel} from './VisualAssetsPanel';
import {UsageSummaryPanel} from './UsageSummaryPanel';
import {NarrativeBeatsPanel} from './NarrativeBeatsPanel';
import {VisualIntentPanel} from './VisualIntentPanel';
import {WorkflowStepper} from './WorkflowStepper';
import {ParallelLanes} from './ParallelLanes';
import {nextStageAfter, STAGE_NAMES, type StagesResponse, type ActivityResponse} from './shared';

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
 *
 * M5：
 * - StagePanel 以 key=selected 强制重挂载：切换阶段零旧内容残留（标题与内容
 *   永远一致），配合面板内 loading 态与请求序号防竞态。
 * - 锁定成功 → 成功提示条 + 自动进入下一阶段；最后阶段引导至「旁白」区域。
 */

const POLL_INTERVAL_MS = 2000;

export function WorkflowWorkspace({projectId}: {projectId: string}) {
  const [data, setData] = useState<StagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selected, setSelected] = useState<WorkflowStage>('project_definition');
  const [advanceNotice, setAdvanceNotice] = useState<string | null>(null);
  // M6.3.10：AI 图像生成成功 / 渲染进入终态 → bump 触发 Usage Summary 刷新（无需 F5）
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const bumpUsageRefresh = useCallback(() => setUsageRefreshKey((k) => k + 1), []);
  // M6.3.13：任何素材绑定变化（搜索/上传/AI 候选绑定/改用 MG）→ bump 触发
  // FinalRenderPanel / VisualPreview 重新拉取 readiness（asset mutation 不改
  // project_stages，指纹 key 不变，必须靠显式计数器失效）
  const [assetsRefreshKey, setAssetsRefreshKey] = useState(0);
  const handleAssetsChanged = useCallback(() => {
    setUsageRefreshKey((k) => k + 1); // 保留 M6.3.10 语义：AI 生成后 Usage Summary 刷新
    setAssetsRefreshKey((k) => k + 1);
  }, []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // M7：统一 activity 轮询（DAG readiness + running jobs + audio/subtitle）
  const [activity, setActivity] = useState<ActivityResponse | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const activityPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dagVisible, setDagVisible] = useState(true); // 用户可折叠 DAG 视图

  const handleSelect = useCallback((stage: WorkflowStage) => {
    setAdvanceNotice(null); // 用户手动切换时清除进阶提示
    setSelected(stage);
  }, []);

  const handleLocked = useCallback((stage: WorkflowStage) => {
    const next = nextStageAfter(stage);
    if (next && isStageEnabled(next)) {
      setAdvanceNotice(`「${STAGE_NAMES[stage]}」已锁定，正在进入下一步：${STAGE_NAMES[next]}`);
      setSelected(next);
    } else {
      // 最后阶段（场景数据）：不跳到不存在的阶段，引导至旁白制作区
      setAdvanceNotice(`「${STAGE_NAMES[stage]}」已锁定。十个阶段全部完成，下一步：生成旁白（见下方「旁白」区域）。`);
      document.getElementById('narration-panel')?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
  }, []);

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

  // M7：统一 activity 轮询（2–3s；有 running job 或 DAG 展开时启动）
  const refreshActivity = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/activity`, {cache: 'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActivity((await res.json()) as ActivityResponse);
      setActivityError(null);
    } catch {
      setActivityError('活动状态加载失败');
    }
  }, [projectId]);

  // activity.runningJobs 只包含 queued/running 任务
  const hasRunningJobInActivity = (activity?.runningJobs.length ?? 0) > 0;

  useEffect(() => {
    void refreshActivity();
  }, [refreshActivity]);

  useEffect(() => {
    if (activityPollRef.current) {
      clearInterval(activityPollRef.current);
      activityPollRef.current = null;
    }
    // 启动条件：LLM/TTS/render/dispatch 任一 running/queued（保证 NarrationPanel 自动刷新）
    if (hasRunningJobInActivity || hasActiveJob) {
      activityPollRef.current = setInterval(() => void refreshActivity(), POLL_INTERVAL_MS);
    }
    return () => {
      if (activityPollRef.current) {
        clearInterval(activityPollRef.current);
        activityPollRef.current = null;
      }
    };
  }, [hasRunningJobInActivity, hasActiveJob, refreshActivity]);

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

      <WorkflowStepper stages={data.stages} selected={selected} onSelect={handleSelect} />

      {/* M7：DAG 并行泳道（可折叠；activity 轮询由 activityEnabled 控制） */}
      <section className="stage-panel" style={{marginTop: 12}}>
        <div
          className="panel-head"
          style={{cursor: 'pointer'}}
          onClick={() => setDagVisible((v) => !v)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setDagVisible((v) => !v); }}
          role="button"
          tabIndex={0}
          aria-expanded={dagVisible}
          aria-label="切换并行工作流视图"
        >
          <span className="panel-title">并行工作流（M7）</span>
          <span style={{fontSize: 12, color: 'var(--muted)'}}>
            {dagVisible ? '▼ 展开' : '▶ 折叠'}
          </span>
        </div>
        {activityError ? (
          <div className="error-banner" style={{margin: 0, borderRadius: 0}}>{activityError}</div>
        ) : null}
        {dagVisible && activity ? (
          <ParallelLanes nodes={activity.nodes} runningJobs={activity.runningJobs} />
        ) : null}
      </section>

      {advanceNotice ? (
        <div className="advance-notice" role="status">
          ✓ {advanceNotice}
        </div>
      ) : null}

      {selectedState && isStageEnabled(selected) ? (
        <StagePanel
          key={selected}
          projectId={projectId}
          stageState={selectedState}
          onChanged={() => void refresh()}
          onLocked={handleLocked}
        />
      ) : selectedState ? (
        <section className="stage-panel">
          <div className="stage-panel-head">
            <div>
              <h2 className="stage-panel-title">{STAGE_NAMES[selected]}</h2>
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
        activity={activity}
      />

      <TimingReconciliationPanel
        projectId={projectId}
        sourceStageKey={
          (() => {
            const sv2 = data.stages.find((s) => s.stage === 'script_v2');
            const sc = data.stages.find((s) => s.stage === 'scenes');
            return `${sv2 ? `${sv2.status}:${sv2.updated_at}` : 'missing'}|${sc ? `${sc.status}:${sc.updated_at}` : 'missing'}`;
          })()
        }
      />

      <VisualAssetsPanel
        projectId={projectId}
        onAssetsChanged={handleAssetsChanged}
        scenesStageKey={
          (() => {
            const sc = data.stages.find((s) => s.stage === 'scenes');
            return sc ? `${sc.status}:${sc.updated_at}` : 'missing';
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
          assetsRefreshKey={assetsRefreshKey}
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

      <FinalRenderPanel
        projectId={projectId}
        onRenderSettled={bumpUsageRefresh}
        assetsRefreshKey={assetsRefreshKey}
        sourceStageKey={
          (() => {
            const sv2 = data.stages.find((s) => s.stage === 'script_v2');
            const sc = data.stages.find((s) => s.stage === 'scenes');
            return `${sv2 ? `${sv2.status}:${sv2.updated_at}` : 'missing'}|${sc ? `${sc.status}:${sc.updated_at}` : 'missing'}`;
          })()
        }
      />

      <UsageSummaryPanel projectId={projectId} refreshKey={usageRefreshKey} />

      <NarrativeBeatsPanel projectId={projectId} />

      <VisualIntentPanel projectId={projectId} />
    </main>
  );
}

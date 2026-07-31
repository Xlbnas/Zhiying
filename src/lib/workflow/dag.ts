import type {Db} from '@/lib/db';
import {checkNarrationReadiness} from '@/lib/narration/plan';
import {getLatestEligibleNarrationPlanV2Candidate} from '@/lib/narration/plan-v2';
import {
  getCurrentNarrationAudioArtifact,
  getNarrationAudioOverview,
} from '@/lib/narration/audio';
import {checkSubtitleTimingReadiness} from '@/lib/subtitles/timing';
import {checkTimingReconciliationReadiness} from '@/lib/reconciliation/timing';
import {evaluateVisualReadiness} from '@/lib/assets/readiness';
import {loadCurrentScenes} from '@/lib/scenes/visual-overrides';
import {WORKFLOW_STAGES} from './types';
import {getActiveLease} from '@/lib/resources/leases';
import {
  GPU_EXCLUSIVE_GROUP,
  JOB_TYPE_RESOURCE_CLASS,
  isGpuExclusive,
  type ResourceClass,
} from './resource-classes';
import {
  WORKFLOW_NODES,
  type WorkflowNodeDef,
  type WorkflowNodeState,
  type WorkflowNodeStatus,
} from './dag-shared';

/**
 * 工作流 DAG readiness 计算（M7 依赖/资源感知调度，服务端专用）。
 *
 * 纯图（节点注册表/依赖边/downstreamOf/computeNewlyReadyAfterLock）在
 * ./dag-shared.ts（零 DB 依赖，浏览器端可引用），本模块 re-export 其全部
 * 内容并叠加 computeWorkflowReadiness——lazy 纯计算：只读 project_stages /
 * artifacts / tts_jobs / render_jobs / llm_jobs / asset_bindings，
 * 不改写任何 DB 行。
 *
 * 失效传播边界（与后端现状一致，勿扩大）：
 * 视觉支（narration_beat_map…scenes）与音频支（narration_plan…subtitle_timing）
 * 在 script_v2 之后互为独立分支——视觉支改动不会 stale 音频支，反之亦然；
 * 唯一汇合点是 timing_reconciliation（真实下游集合见 downstreamOf）。
 */

export * from './dag-shared';

export interface WorkflowReadiness {
  nodes: WorkflowNodeState[];
  /** 当前 ready（可启动）的节点 id 集合。 */
  readyNodes: string[];
  /** 全局（跨项目）忙碌资源类别。 */
  busyClasses: ResourceClass[];
  /** production_gpu 互斥组是否被占。 */
  gpuOccupied: boolean;
}

interface JobFlagRow {
  stage: string;
  status: string;
  queued_at: string;
}

const GPU_OCCUPANT_LABELS: Partial<Record<ResourceClass, string>> = {
  render_gpu: 'Final Render',
  tts_gpu: '配音',
  local_image_gpu: '本地生图',
};

/**
 * 全局真正占用资源类别（running / 持有有效 DB lease）。
 * queued 不等于占用；GPU 整机资源以 production_gpu lease 为准，
 * 同时兼容旧数据 running GPU job 无 lease 的过渡情况。
 */
export function listBusyResourceClasses(db: Db): ResourceClass[] {
  const busy = new Set<ResourceClass>();
  const running = (sql: string): number => (db.prepare(sql).get() as {c: number}).c;

  // LLM / dispatch：API 任务，按 running 计
  if (running(`SELECT COUNT(*) AS c FROM llm_jobs WHERE status = 'running'`) > 0) {
    busy.add(JOB_TYPE_RESOURCE_CLASS.llm);
  }
  if (running(`SELECT COUNT(*) AS c FROM generation_dispatch_jobs WHERE status = 'running'`) > 0) {
    busy.add(JOB_TYPE_RESOURCE_CLASS.dispatch);
  }

  // GPU 任务：优先以 production_gpu lease 为准；兼容旧 running job 无 lease
  const gpuLease = getActiveLease('production_gpu');
  if (gpuLease) {
    switch (gpuLease.owner_job_type) {
      case 'render':
        busy.add(JOB_TYPE_RESOURCE_CLASS.render);
        break;
      case 'tts':
        busy.add(JOB_TYPE_RESOURCE_CLASS.tts);
        break;
      case 'asset_generation':
        busy.add('local_image_gpu');
        break;
    }
  } else {
    // 兼容旧数据：无有效 lease 但仍有 running GPU job
    if (running(`SELECT COUNT(*) AS c FROM render_jobs WHERE status = 'running'`) > 0) {
      busy.add(JOB_TYPE_RESOURCE_CLASS.render);
    }
    if (running(`SELECT COUNT(*) AS c FROM tts_jobs WHERE status = 'running'`) > 0) {
      busy.add(JOB_TYPE_RESOURCE_CLASS.tts);
    }
    if (running(`SELECT COUNT(*) AS c FROM asset_generation_jobs WHERE status = 'running'`) > 0) {
      busy.add('local_image_gpu');
    }
  }

  return [...busy];
}

/**
 * lazy 计算全图 readiness（纯读，不改写任何 DB 行）。
 * 节点按依赖拓扑序逐个定态；ready 且 GPU 互斥组被占的节点
 * 后置为 blocked_waiting_resource（带占用方 detail）。
 */
export function computeWorkflowReadiness(db: Db, projectId: string): WorkflowReadiness {
  // ── foundation/visual：project_stages + llm_jobs 聚合 ──
  const stageRows = db
    .prepare('SELECT stage, status FROM project_stages WHERE project_id = ?')
    .all(projectId) as Array<{stage: string; status: string}>;
  const stageStatus = new Map(stageRows.map((r) => [r.stage, r.status]));
  const llmJobs = db
    .prepare(
      `SELECT stage, status, queued_at FROM llm_jobs
       WHERE project_id = ? ORDER BY queued_at ASC`,
    )
    .all(projectId) as JobFlagRow[];
  const activeJobStages = new Set(
    llmJobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.stage),
  );
  const latestJobByStage = new Map<string, JobFlagRow>();
  for (const j of llmJobs) {
    latestJobByStage.set(j.stage, j);
  }

  const statusById = new Map<string, WorkflowNodeStatus>();
  const detailById = new Map<string, string | null>();
  const depsDone = (node: WorkflowNodeDef): boolean =>
    node.dependencies.every((d) => statusById.get(d) === 'done');
  const setStatus = (id: string, status: WorkflowNodeStatus, detail: string | null = null): void => {
    statusById.set(id, status);
    detailById.set(id, detail);
  };

  const stageNodeIds = new Set<string>(WORKFLOW_STAGES);
  for (const node of WORKFLOW_NODES) {
    const id = node.id;
    if (stageNodeIds.has(id)) {
      // foundation/visual stage 节点
      if (stageStatus.get(id) === 'locked') {
        setStatus(id, 'done');
        continue;
      }
      if (activeJobStages.has(id)) {
        setStatus(id, 'running');
        continue;
      }
      const latest = latestJobByStage.get(id);
      if (latest?.status === 'failed') {
        setStatus(id, 'failed', '生成任务失败');
        continue;
      }
      setStatus(id, depsDone(node) ? 'ready' : 'locked');
      continue;
    }

    switch (id) {
      case 'narration_plan': {
        const v1 = checkNarrationReadiness(projectId);
        const v2Eligible = getLatestEligibleNarrationPlanV2Candidate(projectId) !== null;
        if (v1.status === 'ready' || v2Eligible) {
          setStatus(id, 'done');
        } else {
          setStatus(id, depsDone(node) ? 'ready' : 'locked');
        }
        break;
      }
      case 'narration_tts': {
        if (!depsDone(node)) {
          setStatus(id, 'locked');
          break;
        }
        const overview = getNarrationAudioOverview(projectId);
        switch (overview.status) {
          case 'ready':
            setStatus(id, 'done');
            break;
          case 'generating':
            setStatus(
              id,
              'running',
              `配音进度 ${overview.speechComplete}/${overview.speechTotal}`,
            );
            break;
          case 'not_ready':
            // 全部 unit 完成、manifest 未 finalize（GET/POST 惰性触发）
            setStatus(id, 'running', '音频清单汇总中');
            break;
          case 'failed':
            setStatus(id, 'failed', '配音任务失败');
            break;
          case 'blocked_contaminated':
            setStatus(id, 'failed', '旁白文本含导演指令污染');
            break;
          default:
            // missing / stale：可（重新）触发
            setStatus(id, 'ready');
        }
        break;
      }
      case 'narration_audio_manifest': {
        if (getCurrentNarrationAudioArtifact(projectId) !== null) {
          setStatus(id, 'done');
        } else {
          setStatus(id, depsDone(node) ? 'ready' : 'locked');
        }
        break;
      }
      case 'subtitle_timing': {
        const r = checkSubtitleTimingReadiness(projectId);
        if (r.status === 'ready') {
          setStatus(id, 'done');
        } else if (r.status === 'not_ready') {
          setStatus(id, 'locked');
        } else {
          // stale / missing：源已 current，可重新编译
          setStatus(id, depsDone(node) ? 'ready' : 'locked');
        }
        break;
      }
      case 'assets': {
        const current = loadCurrentScenes(projectId);
        if (!current || stageStatus.get('scenes') !== 'locked') {
          setStatus(id, 'locked');
          break;
        }
        const visual = evaluateVisualReadiness(projectId, current.scenes, {
          scenesVersionId: current.versionId,
        });
        if (visual.ready) {
          setStatus(id, 'done');
        } else {
          setStatus(id, 'ready', `待解决素材 ${visual.pendingAssets} 项`);
        }
        break;
      }
      case 'timing_reconciliation': {
        const r = checkTimingReconciliationReadiness(projectId);
        if (r.status === 'ready') {
          setStatus(id, 'done');
        } else if (r.status === 'not_ready') {
          setStatus(id, 'locked');
        } else {
          setStatus(id, depsDone(node) ? 'ready' : 'locked');
        }
        break;
      }
      case 'render': {
        const latest = db
          .prepare(
            `SELECT status FROM render_jobs
             WHERE project_id = ? ORDER BY queued_at DESC LIMIT 1`,
          )
          .get(projectId) as {status: string} | undefined;
        if (latest && (latest.status === 'queued' || latest.status === 'running')) {
          setStatus(id, 'running');
        } else if (latest?.status === 'succeeded') {
          setStatus(id, 'done');
        } else if (latest?.status === 'failed') {
          setStatus(id, 'failed', '渲染任务失败');
        } else {
          // 无任务 / cancelled：按依赖定态
          setStatus(id, depsDone(node) ? 'ready' : 'locked');
        }
        break;
      }
      default:
        setStatus(id, depsDone(node) ? 'ready' : 'locked');
    }
  }

  // ── 资源占用后置：ready + GPU 互斥组被占 → blocked_waiting_resource ──
  const busyClasses = listBusyResourceClasses(db);
  const gpuOccupied = busyClasses.some((c) => isGpuExclusive(c));
  if (gpuOccupied) {
    const occupant = GPU_EXCLUSIVE_GROUP.find((c) => busyClasses.includes(c));
    const occupantLabel = (occupant && GPU_OCCUPANT_LABELS[occupant]) ?? '另一个任务';
    for (const node of WORKFLOW_NODES) {
      if (
        statusById.get(node.id) === 'ready' &&
        isGpuExclusive(node.resourceClass) &&
        node.resourceClass !== occupant
      ) {
        setStatus(
          node.id,
          'blocked_waiting_resource',
          `等待 GPU — ${occupantLabel} 正在占用 production_gpu`,
        );
      }
    }
  }

  const nodes: WorkflowNodeState[] = WORKFLOW_NODES.map((n) => ({
    ...n,
    status: statusById.get(n.id) ?? 'locked',
    detail: detailById.get(n.id) ?? null,
  }));
  return {
    nodes,
    readyNodes: nodes.filter((n) => n.status === 'ready').map((n) => n.id),
    busyClasses,
    gpuOccupied,
  };
}

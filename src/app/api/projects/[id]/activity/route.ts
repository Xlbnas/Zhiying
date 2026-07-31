/**
 * GET /api/projects/[id]/activity — 统一活动快照（M7 工作流 DAG 并行化）。
 *
 * 一次请求聚合：10 阶段状态（同 /stages 口径）+ DAG 全节点 readiness
 * （computeWorkflowReadiness，纯计算不改写 DB）+ 四类队列 running/queued 任务
 * + dispatch/generation runs 摘要 + 资源占用（busyClasses/gpuOccupied）。
 * 供 WorkflowWorkspace 顶层 2–3s 轮询，替代多面板各自高频轮询；
 * 既有面板的轮询逻辑不受影响。
 */
import {getDb} from '@/lib/db';
import {getProjectInput} from '@/lib/project-inputs';
import {isLegacyM1Project} from '@/lib/projects';
import {listStages} from '@/lib/workflow/stages';
import {computeWorkflowReadiness} from '@/lib/workflow/dag';
import {
  JOB_TYPE_RESOURCE_CLASS,
  type ResourceClass,
} from '@/lib/workflow/resource-classes';
import {listDispatchJobs} from '@/lib/llm-generation/dispatch';
import {listGenerationRunSummaries} from '@/lib/llm-generation/runs';
import {BEATS_USAGE_STAGE} from '@/lib/narrative-beats/generate';
import {VISUAL_INTENT_USAGE_STAGE} from '@/lib/visual-intent/generate';
import {getProject, jsonError} from '../../../_lib/shared';

export const runtime = 'nodejs';

interface RunningJobSummary {
  type: 'render' | 'llm' | 'tts' | 'dispatch';
  id: string;
  stage: string | null;
  resourceClass: ResourceClass;
  startedAt: string | null;
}

export function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  return handle(params);
}

async function handle(params: Promise<{id: string}>): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }

  const db = getDb();
  const legacy = isLegacyM1Project(id);

  // 阶段状态（与 /stages route 同口径：latestJob + activeJob）
  const stages = listStages(id).map((row) => {
    const latest = db
      .prepare(
        `SELECT id, status, error_code, error_message, attempt, queued_at, finished_at
         FROM llm_jobs WHERE project_id = ? AND stage = ?
         ORDER BY queued_at DESC LIMIT 1`,
      )
      .get(id, row.stage);
    const active = db
      .prepare(
        `SELECT id, status FROM llm_jobs
         WHERE project_id = ? AND stage = ? AND status IN ('queued', 'running')
         ORDER BY queued_at ASC LIMIT 1`,
      )
      .get(id, row.stage);
    return {...row, latestJob: latest ?? null, activeJob: active ?? null};
  });

  // DAG readiness（纯计算：project_stages + artifacts + tts_jobs + asset_bindings）
  const readiness = computeWorkflowReadiness(db, id);

  // 四类队列的活跃任务（全局资源占用是整机口径，runningJobs 按本项目返回）
  const runningJobs: RunningJobSummary[] = [
    ...(
      db
        .prepare(
          `SELECT id, NULL AS stage, started_at FROM render_jobs
           WHERE project_id = ? AND status IN ('queued','running')`,
        )
        .all(id) as Array<{id: string; stage: null; started_at: string | null}>
    ).map((r) => ({
      type: 'render' as const,
      id: r.id,
      stage: r.stage,
      resourceClass: JOB_TYPE_RESOURCE_CLASS.render,
      startedAt: r.started_at,
    })),
    ...(
      db
        .prepare(
          `SELECT id, stage, started_at FROM llm_jobs
           WHERE project_id = ? AND status IN ('queued','running')`,
        )
        .all(id) as Array<{id: string; stage: string | null; started_at: string | null}>
    ).map((r) => ({
      type: 'llm' as const,
      id: r.id,
      stage: r.stage,
      resourceClass: JOB_TYPE_RESOURCE_CLASS.llm,
      startedAt: r.started_at,
    })),
    ...(
      db
        .prepare(
          `SELECT id, unit_id AS stage, started_at FROM tts_jobs
           WHERE project_id = ? AND status IN ('queued','running')`,
        )
        .all(id) as Array<{id: string; stage: string | null; started_at: string | null}>
    ).map((r) => ({
      type: 'tts' as const,
      id: r.id,
      stage: r.stage,
      resourceClass: JOB_TYPE_RESOURCE_CLASS.tts,
      startedAt: r.started_at,
    })),
    ...(
      db
        .prepare(
          `SELECT id, stage, started_at FROM generation_dispatch_jobs
           WHERE project_id = ? AND status IN ('queued','running')`,
        )
        .all(id) as Array<{id: string; stage: string | null; started_at: string | null}>
    ).map((r) => ({
      type: 'dispatch' as const,
      id: r.id,
      stage: r.stage,
      resourceClass: JOB_TYPE_RESOURCE_CLASS.dispatch,
      startedAt: r.started_at,
    })),
  ];

  // dispatch / generation runs 摘要（M7 两条 LLM build 链）
  const dispatchJobs = listDispatchJobs(db, id);
  const generationRuns = [
    ...listGenerationRunSummaries(db, id, BEATS_USAGE_STAGE),
    ...listGenerationRunSummaries(db, id, VISUAL_INTENT_USAGE_STAGE),
  ];

  let inputs = null;
  try {
    inputs = getProjectInput(id);
  } catch {
    inputs = null;
  }

  return Response.json({
    project,
    stages,
    inputs,
    legacy,
    nodes: readiness.nodes,
    readyNodes: readiness.readyNodes,
    runningJobs,
    dispatchJobs,
    generationRuns,
    resourceUsage: {
      busyClasses: readiness.busyClasses,
      gpuOccupied: readiness.gpuOccupied,
    },
  });
}

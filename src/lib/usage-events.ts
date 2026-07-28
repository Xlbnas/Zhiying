/**
 * M6+ Project Usage Tracking。
 *
 * project_usage_events：统一记录项目各阶段资源消耗。
 * llm events 从 llm_usage 表同步（确定性回填），CPU/GPU 从 worker 实时写入。
 *
 * 费用单位：元（cost_cny REAL，高精度存储；不依赖 provider 返回的 bill）。
 */
import crypto from 'node:crypto';
import {getDb} from '../db';

export type UsageEventKind = 'llm' | 'cpu' | 'gpu' | 'render' | 'tts' | 'asset';

export interface UsageEvent {
  projectId: string;
  kind: UsageEventKind;
  stage?: string | null;
  jobId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheTokens?: number | null;
  costCny?: number | null;
  cpuUsec?: number | null;
  gpuSec?: number | null;
  wallMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

export function recordUsageEvent(event: UsageEvent): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO project_usage_events (
       id, project_id, kind, stage, job_id, provider, model,
       input_tokens, output_tokens, cache_tokens, cost_cny,
       cpu_usec, gpu_sec, wall_ms, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.projectId,
    event.kind,
    event.stage ?? null,
    event.jobId ?? null,
    event.provider ?? null,
    event.model ?? null,
    event.inputTokens ?? null,
    event.outputTokens ?? null,
    event.cacheTokens ?? null,
    event.costCny ?? null,
    event.cpuUsec ?? null,
    event.gpuSec ?? null,
    event.wallMs ?? null,
    event.metadata ? JSON.stringify(event.metadata) : null,
    new Date().toISOString(),
  );
  return id;
}

/** 从 llm_usage 表同步项目 LLM 事件（确定性回填，幂等：同一 request_id 只写一次）。 */
export function syncLlmUsageToEvents(projectId: string): number {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM llm_usage WHERE project_id = ?
     ORDER BY created_at ASC`,
  ).all(projectId) as Array<{
    id: string; project_id: string; stage: string | null; job_id: string | null;
    request_id: string; provider: string; model: string;
    input_tokens: number | null; cached_tokens: number | null; output_tokens: number | null;
    cost_cny: number | null; prompt_version: string | null; created_at: string;
  }>;
  let count = 0;
  for (const row of rows) {
    const exists = db.prepare(
      `SELECT 1 FROM project_usage_events WHERE metadata->>'llmUsageId' = ?`,
    ).get(row.id);
    if (exists) continue;
    recordUsageEvent({
      projectId: row.project_id,
      kind: 'llm',
      stage: row.stage,
      jobId: row.job_id,
      provider: row.provider,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheTokens: row.cached_tokens,
      costCny: row.cost_cny,
      metadata: {llmUsageId: row.id, requestId: row.request_id, promptVersion: row.prompt_version},
    });
    count++;
  }
  return count;
}

export interface UsageSummary {
  projectId: string;
  totalCostCny: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCpuHours: number;
  totalGpuHours: number;
  totalWallHours: number;
  byStage: StageUsage[];
  llmEvents: number;
  cpuEvents: number;
  gpuEvents: number;
  /** 最早有数据的时间 */
  dataStartAt: string | null;
}

export interface StageUsage {
  stage: string;
  costCny: number;
  tokens: number;
  cpuHours: number;
  gpuHours: number;
  wallHours: number;
}

export function getProjectUsageSummary(projectId: string): UsageSummary {
  const db = getDb();

  // 同步 LLM 数据（幂等）
  syncLlmUsageToEvents(projectId);

  const rows = db.prepare(
    `SELECT * FROM project_usage_events WHERE project_id = ? ORDER BY created_at ASC`,
  ).all(projectId) as Array<{
    kind: string; stage: string | null; input_tokens: number | null;
    output_tokens: number | null; cache_tokens: number | null; cost_cny: number | null;
    cpu_usec: number | null; gpu_sec: number | null; wall_ms: number | null;
    created_at: string;
  }>;

  let totalCost = 0;
  let totalTokens = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCache = 0;
  let totalCpuUsec = 0;
  let totalGpuSec = 0;
  let totalWallMs = 0;
  let llmEvents = 0;
  let cpuEvents = 0;
  let gpuEvents = 0;


  const stageMap = new Map<string, StageUsage>();
  const getStage = (s: string | null): StageUsage => {
    const key = s ?? '其他';
    let su = stageMap.get(key);
    if (!su) {
      su = {stage: key, costCny: 0, tokens: 0, cpuHours: 0, gpuHours: 0, wallHours: 0};
      stageMap.set(key, su);
    }
    return su;
  };

  for (const row of rows) {
    const cost = row.cost_cny ?? 0;
    const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    const cpu = row.cpu_usec ?? 0;
    const gpu = row.gpu_sec ?? 0;
    const wall = row.wall_ms ?? 0;

    totalCost += cost;
    totalTokens += tokens;
    totalIn += row.input_tokens ?? 0;
    totalOut += row.output_tokens ?? 0;
    totalCache += row.cache_tokens ?? 0;
    totalCpuUsec += cpu;
    totalGpuSec += gpu;
    totalWallMs += wall;
    if (row.kind === 'llm') llmEvents++;
    if (cpu > 0) cpuEvents++;
    if (gpu > 0) gpuEvents++;

    const su = getStage(row.stage);
    su.costCny += cost;
    su.tokens += tokens;
    su.cpuHours += cpu / 3_600_000_000;
    su.gpuHours += gpu / 3600;
    su.wallHours += wall / 3_600_000;
  }

  const sortedStages = [...stageMap.entries()]
    .sort((a, b) => b[1].costCny - a[1].costCny)
    .map(([, v]) => v);

  return {
    projectId,
    totalCostCny: Math.round(totalCost * 10000) / 10000,
    totalTokens,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    totalCacheTokens: totalCache,
    totalCpuHours: Math.round((totalCpuUsec / 3_600_000_000) * 100) / 100,
    totalGpuHours: Math.round((totalGpuSec / 3600) * 100) / 100,
    totalWallHours: Math.round((totalWallMs / 3_600_000) * 100) / 100,
    byStage: sortedStages,
    llmEvents,
    cpuEvents,
    gpuEvents,
    dataStartAt: rows.length > 0 ? rows[0]!.created_at : null,
  };
}

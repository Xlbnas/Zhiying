/**
 * M6+ Project Usage Tracking。
 *
 * project_usage_events：统一记录项目各阶段资源消耗。
 * llm events 从 llm_usage 表同步（确定性回填），CPU/GPU 从 worker 实时写入，
 * image generation 由 generate route 在每次 provider 调用时写入（M6.3.10），
 * render/tts wall time 从 jobs 表幂等回填（M6.3.10）。
 *
 * 费用单位：元（cost_cny REAL，高精度存储；不依赖 provider 返回的 bill）。
 * 幂等：event.id 由调用方给定（attemptId / render-wall-${jobId} 等确定性 id）
 * 时使用 INSERT OR IGNORE——同一次 provider 请求/同一个 job 永不重复记账。
 */
import crypto from 'node:crypto';
import {getDb} from './db';
import {computeImageCostCny, IMAGE_PRICE_TABLE_VERSION, ImagePricingError} from './usage/image-pricing';

export type UsageEventKind = 'llm' | 'cpu' | 'gpu' | 'render' | 'tts' | 'asset' | 'image';

export interface UsageEvent {
  /** 可选确定性 id（attemptId / 回填 id）；提供时 INSERT OR IGNORE 保证幂等。 */
  id?: string;
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
  /** 回填场景覆盖 created_at（默认 now）。 */
  createdAt?: string;
}

export function recordUsageEvent(event: UsageEvent): {id: string; inserted: boolean} {
  const db = getDb();
  const id = event.id ?? crypto.randomUUID();
  const result = db.prepare(
    `INSERT OR IGNORE INTO project_usage_events (
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
    event.createdAt ?? new Date().toISOString(),
  );
  return {id, inserted: result.changes > 0};
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

// ---------- M6.3.10：图像生成计费 ----------

export type ImageGenerationStatus =
  /** provider 成功产出 candidate → 按价目表计费（含后续被拒绝/未绑定的 candidate） */
  | 'succeeded'
  /** 认证失败（401/403）：请求未进入生成 → cost 0 */
  | 'auth_failed'
  /** 429/超时/5xx/空结果/网络错误：是否产生费用无法确认 → cost 不计入 */
  | 'unknown_billing';

/**
 * provider 错误 code → usage event 状态映射（Phase 4 计费口径）。
 * 返回 null = 未发出计费相关请求（not_configured），不记 event。
 */
export function imageGenerationErrorStatus(code: string): ImageGenerationStatus | null {
  if (code === 'auth_failed') return 'auth_failed';
  if (code === 'not_configured') return null;
  return 'unknown_billing';
}

export interface ImageGenerationUsageInput {
  /** 调用 provider 之前生成的 attemptId（= event id，幂等键）。 */
  attemptId: string;
  projectId: string;
  sceneId: string;
  requirementId: string;
  provider: string;
  model: string;
  requestedSize: string;
  aspectRatio: string;
  imageCount: number;
  status: ImageGenerationStatus;
  generationId?: string;
  providerRequestId?: string;
  usageMetadata?: unknown;
  /** backfill 场景覆盖（历史 asset 的 created_at）。 */
  createdAt?: string;
  /** backfill 标记。 */
  backfilled?: boolean;
  /** backfill 时关联的 asset id。 */
  assetId?: string;
}

export interface ImageGenerationUsageResult {
  id: string;
  inserted: boolean;
  costCny: number | null;
  unitPriceCny: number | null;
  costSource: 'provider_reported' | 'configured_estimate' | 'none';
}

/**
 * 记录一次真实图像生成 attempt（M6.3.10 核心计费原则：成本属于 generation
 * attempt，不属于 accepted/bound asset；拒绝/未绑定/重新生成各自独立计费）。
 *
 * 计费口径（与 LLM "没拿到 response 不记费用" 一致）：
 * - succeeded       → configured_estimate（APIYi 不返回账单金额），单价写入时快照
 * - auth_failed     → cost 0
 * - unknown_billing → cost null（不混入 total，仅技术详情可见）
 * 价目表缺价时不得阻断生成流程：event 仍记录，cost null + pricingError 进 metadata。
 */
export function recordImageGenerationUsage(
  input: ImageGenerationUsageInput,
): ImageGenerationUsageResult {
  let costCny: number | null = null;
  let unitPriceCny: number | null = null;
  let costSource: ImageGenerationUsageResult['costSource'] = 'none';
  let pricingError: string | null = null;

  if (input.status === 'succeeded') {
    try {
      const priced = computeImageCostCny({
        provider: input.provider,
        model: input.model,
        size: input.requestedSize,
        imageCount: input.imageCount,
      });
      costCny = priced.costCny;
      unitPriceCny = priced.unitPriceCny;
      costSource = 'configured_estimate';
    } catch (err) {
      if (err instanceof ImagePricingError) {
        pricingError = err.message;
      } else {
        throw err;
      }
    }
  } else if (input.status === 'auth_failed') {
    costCny = 0;
  }

  const {id, inserted} = recordUsageEvent({
    id: input.attemptId,
    projectId: input.projectId,
    kind: 'image',
    stage: 'image_generation',
    provider: input.provider,
    model: input.model,
    costCny,
    createdAt: input.createdAt,
    metadata: {
      attemptId: input.attemptId,
      sceneId: input.sceneId,
      requirementId: input.requirementId,
      imageCount: input.imageCount,
      requestedSize: input.requestedSize,
      aspectRatio: input.aspectRatio,
      status: input.status,
      costSource,
      unitPriceCny,
      pricingVersion: costSource === 'configured_estimate' ? IMAGE_PRICE_TABLE_VERSION : null,
      pricingError,
      generationId: input.generationId ?? null,
      providerRequestId: input.providerRequestId ?? null,
      usageMetadata: input.usageMetadata ?? null,
      backfilled: input.backfilled === true,
      assetId: input.assetId ?? null,
    },
  });
  if (!inserted) {
    // 幂等命中：同 attempt 已被记录（重复处理/重试），返回已有口径
    return {id, inserted, costCny: null, unitPriceCny: null, costSource: 'none'};
  }
  return {id, inserted, costCny, unitPriceCny, costSource};
}

/**
 * 生成 route 在 candidate 落库后回补 assetId 链接（usage 先于 asset 记录，
 * 费用先行不丢；链接用于 backfill 精确去重）。
 */
export function linkAssetToImageUsageEvent(attemptId: string, assetId: string): void {
  getDb().prepare(
    `UPDATE project_usage_events
     SET metadata = json_set(metadata, '$.assetId', ?)
     WHERE id = ? AND kind = 'image'`,
  ).run(assetId, attemptId);
}

/** 判断某 generated asset 是否已有对应的 image usage event（backfill 去重依据）。 */
export function hasImageUsageForAsset(asset: {
  id: string;
  projectId: string;
  sceneId: string | null;
  createdAt: string;
}): boolean {
  const db = getDb();
  // 精确链接：metadata.assetId = asset.id（新生成 + 已回填 event）
  const linked = db.prepare(
    `SELECT 1 FROM project_usage_events
     WHERE kind = 'image' AND project_id = ? AND metadata->>'assetId' = ?`,
  ).get(asset.projectId, asset.id);
  if (linked) return true;
  // 宽松兜底：同 project+scene 的非回填成功 event 与 asset 同秒级时间窗内
  // （M6.3.10 首版 route 未写 assetId 的 event；provider 调用秒级耗时 +
  // in-flight lock，同窗两次成功生成实际不可能）
  const fuzzy = db.prepare(
    `SELECT 1 FROM project_usage_events
     WHERE kind = 'image' AND project_id = ?
       AND metadata->>'sceneId' = ?
       AND metadata->>'status' = 'succeeded'
       AND COALESCE(metadata->>'backfilled', 'false') != 'true'
       AND ABS((julianday(created_at) - julianday(?)) * 86400000) < 10000
     LIMIT 1`,
  ).get(asset.projectId, asset.sceneId ?? 'unknown', asset.createdAt);
  return fuzzy !== undefined;
}

// ---------- M6.3.10：render / tts wall time 幂等回填 ----------

/**
 * 从 render_jobs / tts_jobs 的 started_at/finished_at 回填 wall time（含历史任务）。
 * 幂等：确定性 id（render-wall-${jobId} / tts-wall-${jobId}）+ INSERT OR IGNORE。
 * CPU/GPU 秒不在此回填（历史无 cgroup 采集），由 worker 实时写入独立 event。
 */
export function syncComputeWallToEvents(projectId: string): number {
  const db = getDb();
  let count = 0;
  const syncJobs = (table: 'render_jobs' | 'tts_jobs', kind: 'render' | 'tts', stage: string): void => {
    const rows = db.prepare(
      `SELECT id, started_at, finished_at FROM ${table}
       WHERE project_id = ? AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
    ).all(projectId) as Array<{id: string; started_at: string; finished_at: string}>;
    for (const row of rows) {
      const wallMs = Date.parse(row.finished_at) - Date.parse(row.started_at);
      if (!Number.isFinite(wallMs) || wallMs < 0) continue;
      const {inserted} = recordUsageEvent({
        id: `${kind}-wall-${row.id}`,
        projectId,
        kind,
        stage,
        jobId: row.id,
        wallMs,
        metadata: {wallSync: true},
      });
      if (inserted) count++;
    }
  };
  syncJobs('render_jobs', 'render', 'render');
  syncJobs('tts_jobs', 'tts', 'tts');
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
  /** M6.3.10：AI 图像生成用量（费用已含在 totalCostCny 中） */
  image: ImageUsageSummary;
  /** 最早有数据的时间 */
  dataStartAt: string | null;
}

export interface ImageUsageSummary {
  /** 成功产出 candidate 的 generation attempt 数（= 计费次数） */
  calls: number;
  /** provider 实际产出的图片总数（含被拒绝/未绑定） */
  images: number;
  costCny: number;
  /** 是否产生费用无法确认的 attempt 数（不计入 costCny） */
  unknownBilling: number;
  /** 认证失败 attempt 数（cost 0） */
  authFailed: number;
  providers: string[];
  models: string[];
  /** 历史回填 event 数（M6.3.10 前无逐次记录） */
  backfilled: number;
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
  // 同步 render/tts wall time（幂等，M6.3.10）
  syncComputeWallToEvents(projectId);

  const rows = db.prepare(
    `SELECT * FROM project_usage_events WHERE project_id = ? ORDER BY created_at ASC`,
  ).all(projectId) as Array<{
    kind: string; stage: string | null; provider: string | null; model: string | null;
    input_tokens: number | null;
    output_tokens: number | null; cache_tokens: number | null; cost_cny: number | null;
    cpu_usec: number | null; gpu_sec: number | null; wall_ms: number | null;
    metadata: string | null;
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

  const image: ImageUsageSummary = {
    calls: 0, images: 0, costCny: 0, unknownBilling: 0, authFailed: 0,
    providers: [], models: [], backfilled: 0,
  };
  const imageProviders = new Set<string>();
  const imageModels = new Set<string>();

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

    if (row.kind === 'image') {
      let meta: Record<string, unknown> = {};
      try { meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : {}; } catch { /* 忽略脏数据 */ }
      const status = typeof meta.status === 'string' ? meta.status : 'succeeded';
      if (status === 'succeeded') {
        image.calls++;
        image.images += typeof meta.imageCount === 'number' ? meta.imageCount : 0;
        image.costCny += row.cost_cny ?? 0;
      } else if (status === 'unknown_billing') {
        image.unknownBilling++;
      } else if (status === 'auth_failed') {
        image.authFailed++;
      }
      if (meta.backfilled === true) image.backfilled++;
      if (row.provider) imageProviders.add(row.provider);
      if (row.model) imageModels.add(row.model);
    }

    const su = getStage(row.stage);
    su.costCny += cost;
    su.tokens += tokens;
    su.cpuHours += cpu / 3_600_000_000;
    su.gpuHours += gpu / 3600;
    su.wallHours += wall / 3_600_000;
  }

  image.costCny = Math.round(image.costCny * 10000) / 10000;
  image.providers = [...imageProviders];
  image.models = [...imageModels];

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
    // M6.3.10：保留 6 位小数，智能单位格式化（fmtDuration）在 UI 层完成，
    // 避免 30 秒级真实用量被 2 位小数舍入成 0。
    totalCpuHours: Math.round((totalCpuUsec / 3_600_000_000) * 1e6) / 1e6,
    totalGpuHours: Math.round((totalGpuSec / 3600) * 1e6) / 1e6,
    totalWallHours: Math.round((totalWallMs / 3_600_000) * 1e6) / 1e6,
    byStage: sortedStages,
    llmEvents,
    cpuEvents,
    gpuEvents,
    image,
    dataStartAt: rows.length > 0 ? rows[0]!.created_at : null,
  };
}

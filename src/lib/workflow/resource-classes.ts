/**
 * 资源类别与并发上限（M7 工作流 DAG 并行调度）。
 *
 * 设计：
 * - 每个 job type / DAG 节点归入一个 ResourceClass，调度器按类做并发上限与互斥；
 * - GPU_EXCLUSIVE_GROUP 三个类共享同一张 production_gpu（如 RTX 2080 Ti），
 *   组内任意两个不同类的任务互斥（同类上限为 1，等价于整机 GPU 同时只跑一个）；
 * - llm_api / remote_image_api / network_io / cpu_compile / db_short_write 与一切兼容；
 * - 并发上限集中在 RESOURCE_LIMIT_ENV / DEFAULT_RESOURCE_LIMITS，
 *   env 覆盖（如 ZHIYING_MAX_LLM_JOBS），不散落硬编码。
 *
 * jobType → resourceClass 映射（现状真实队列，见 src/lib/scheduler.ts）：
 * - render   → render_gpu（Remotion renderMedia / NVENC，占 GPU）
 * - tts      → tts_gpu（IndexTTS2 推理，占 GPU）
 * - llm      → llm_api（10 个 workflow stage 的 DeepSeek 生成，远程 API）
 * - dispatch → llm_api（narrative_beats / visual_intent 的 worker-side LLM build）
 * 注：仓库当前不存在 image_generate / asset_search 等独立 handler 队列
 * （素材获取/AI 生图走同步 API 路径，不入队）；若未来入队，
 * 远程生图应归 remote_image_api、素材下载归 network_io，与 GPU 组兼容。
 */

export const RESOURCE_CLASSES = [
  'llm_api',
  'tts_gpu',
  'render_gpu',
  'local_image_gpu',
  'remote_image_api',
  'network_io',
  'cpu_compile',
  'db_short_write',
] as const;

export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

/** production_gpu 互斥组：组内不同类的任务不得并发。 */
export const GPU_EXCLUSIVE_GROUP: readonly ResourceClass[] = [
  'tts_gpu',
  'render_gpu',
  'local_image_gpu',
];

/** 四类真实队列 → 资源类别（调度器唯一映射真相）。 */
export const JOB_TYPE_RESOURCE_CLASS: Record<
  'render' | 'llm' | 'tts' | 'dispatch',
  ResourceClass
> = {
  render: 'render_gpu',
  llm: 'llm_api',
  tts: 'tts_gpu',
  dispatch: 'llm_api',
};

const GPU_SET = new Set<ResourceClass>(GPU_EXCLUSIVE_GROUP);

export function isGpuExclusive(cls: ResourceClass): boolean {
  return GPU_SET.has(cls);
}

/** 资源类别中文标签（UI waiting_resource / 运行中文案用）。 */
export const RESOURCE_CLASS_LABELS: Record<ResourceClass, string> = {
  llm_api: 'DeepSeek API',
  tts_gpu: 'IndexTTS2 / GPU',
  render_gpu: 'Remotion / GPU',
  local_image_gpu: '本地生图 / GPU',
  remote_image_api: '远程生图 API',
  network_io: '网络下载',
  cpu_compile: '本地编译',
  db_short_write: '数据库写入',
};

/**
 * 兼容性判定：一组资源类别的任务能否同时运行。
 * 规则：任意两个不同的 GPU_EXCLUSIVE_GROUP 成员互斥；其余组合全部兼容。
 */
export function canRunConcurrently(classes: ResourceClass[]): boolean {
  const gpuSeen = new Set<ResourceClass>();
  for (const cls of classes) {
    if (!GPU_SET.has(cls)) {
      continue;
    }
    if (gpuSeen.size > 0 && !gpuSeen.has(cls)) {
      return false;
    }
    gpuSeen.add(cls);
  }
  return true;
}

/** 各类并发上限的 env 覆盖键。 */
export const RESOURCE_LIMIT_ENV: Record<ResourceClass, string> = {
  llm_api: 'ZHIYING_MAX_LLM_JOBS',
  tts_gpu: 'ZHIYING_MAX_TTS_JOBS',
  render_gpu: 'ZHIYING_MAX_RENDER_JOBS',
  local_image_gpu: 'ZHIYING_MAX_LOCAL_IMAGE_JOBS',
  remote_image_api: 'ZHIYING_MAX_REMOTE_IMAGE_JOBS',
  network_io: 'ZHIYING_MAX_NETWORK_JOBS',
  cpu_compile: 'ZHIYING_MAX_CPU_JOBS',
  db_short_write: 'ZHIYING_MAX_DB_WRITE_JOBS',
};

/** 默认并发上限：GPU 各 1，LLM API 4，其余宽松。 */
export const DEFAULT_RESOURCE_LIMITS: Record<ResourceClass, number> = {
  llm_api: 4,
  tts_gpu: 1,
  render_gpu: 1,
  local_image_gpu: 1,
  remote_image_api: 4,
  network_io: 8,
  cpu_compile: 2,
  db_short_write: 16,
};

/**
 * 当前生效的并发上限（每次调用现读 env——测试可即时覆盖；
 * 非法/非正数 env 值回退默认）。
 */
export function getResourceLimits(): Record<ResourceClass, number> {
  const limits = {...DEFAULT_RESOURCE_LIMITS};
  for (const cls of RESOURCE_CLASSES) {
    const raw = process.env[RESOURCE_LIMIT_ENV[cls]];
    if (raw === undefined) {
      continue;
    }
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      limits[cls] = n;
    }
  }
  return limits;
}

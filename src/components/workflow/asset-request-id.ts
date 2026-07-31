/**
 * AI 图像生成 requestId 生命周期（M7.3A.2）。
 *
 * 纯逻辑、框架无关，供 VisualAssetsPanel 使用并可直接单测。
 * 语义：
 * - 同一次「生成」点击生命周期内（双击/重试）复用同一个 requestId，
 *   服务端按 (sceneId, requirementId, requestId) 幂等，双击只产生一个 job；
 * - 任务到达终态（succeeded / failed / indeterminate）后必须 release，
 *   下一次显式「重新生成」才会得到新 requestId → 服务端创建新 job。
 *   若不复用清理，终态 requestId 会被服务端判定 reused=true 且保持终态，
 *   用户将无法再次生成。
 */

export function acquireRequestId(map: Map<string, string>, key: string): string {
  const existing = map.get(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  map.set(key, id);
  return id;
}

export function releaseRequestId(map: Map<string, string>, key: string): void {
  map.delete(key);
}

/**
 * GET /api/projects/[id]/narration-performance-plans/[artifactId] — 单 performance exact
 * 读取。exact GET 不 fallback；跨项目/不存在 → 404；分类状态附 statusReason。
 * 返回每个 SpeechUnit 的 performance item（unitId/deliveryOverride/pace/energy/emotion）
 * 与 source 元数据；不返回路径/文本副本/audio/timing。
 */
import {getProject, jsonError} from '../../../../_lib/shared';
import {
  classifyNarrationPerformancePlan,
  getNarrationPerformancePlan,
} from '@/lib/tts-b/performance';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string; artifactId: string}>},
): Promise<Response> {
  const {id, artifactId} = await params;
  const project = getProject(id);
  if (!project) return jsonError(404, 'project_not_found');
  const ref = getNarrationPerformancePlan(id, artifactId);
  if (!ref) return jsonError(404, 'performance_plan_not_found');
  const candidate = await classifyNarrationPerformancePlan(id, ref.artifact);
  return Response.json({
    artifactId: ref.artifact.id,
    version: ref.artifact.version,
    createdAt: ref.artifact.created_at,
    candidateOnly: true,
    status: candidate.status,
    statusReason: candidate.statusReason,
    schemaVersion: ref.performance.schemaVersion,
    compilerVersion: ref.performance.compilerVersion,
    promptVersion: ref.performance.promptVersion,
    source: ref.performance.source,
    generation: ref.performance.generation,
    items: ref.performance.items,
  });
}

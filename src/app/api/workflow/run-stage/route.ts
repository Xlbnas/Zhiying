/**
 * POST /api/workflow/run-stage — 入队阶段生成任务（M2-D §二十）。
 *
 * body: { projectId, stage, confirmStale? }
 * - 仅开放 capabilities.M2D_ENABLED_STAGES（当前前六阶段）；其余 → 422 STAGE_NOT_ENABLED
 * - 只调用 enqueueWorkflowStageJob（门控 + 上游快照 + 去重 + INSERT 单事务原子完成）
 * - 立即 202；Route Handler 不直接调 LLM
 */
import { z } from 'zod';
import { enqueueWorkflowStageJob } from '@/lib/llm-jobs';
import { isStageEnabled } from '@/lib/workflow/capabilities';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getProject, jsonError, workflowErrorResponse } from '../../_lib/shared';

export const runtime = 'nodejs';

const runStageBodySchema = z.object({
  projectId: z.string().min(1),
  stage: workflowStageSchema,
  confirmStale: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', { message: '请求体不是合法 JSON' });
  }

  try {
    const input = runStageBodySchema.parse(body);
    const { projectId, stage } = input;

    if (!isStageEnabled(stage)) {
      return jsonError(422, 'STAGE_NOT_ENABLED', {
        message: `阶段 ${stage} 尚未开放（当前开放前六阶段，其余随 M2-E 开通）`,
      });
    }
    const project = getProject(projectId);
    if (!project) {
      return jsonError(404, 'project_not_found');
    }

    const job = enqueueWorkflowStageJob(projectId, stage, {
      confirmStale: input.confirmStale ?? false,
    });
    return Response.json({ job }, { status: 202 });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

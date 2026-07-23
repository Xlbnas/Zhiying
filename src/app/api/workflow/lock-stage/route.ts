/**
 * POST /api/workflow/lock-stage — 锁定当前 active 版本（M2-D）。
 *
 * body: { projectId, stage }
 * 仅开放 capabilities.M2D_ENABLED_STAGES；锁定走 M2-A lockStage
 * （要求 active 版本存在、stale 必须先 re-run、上游必须 locked）。
 * 同 stage 存在 queued/running 任务时拒绝（JOB_ALREADY_ACTIVE）。
 */
import { z } from 'zod';
import { assertNoActiveLlmJob } from '@/lib/llm-jobs';
import { isStageEnabled } from '@/lib/workflow/capabilities';
import { getStage, lockStage } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getProject, jsonError, workflowErrorResponse } from '../../_lib/shared';

export const runtime = 'nodejs';

const lockStageBodySchema = z.object({
  projectId: z.string().min(1),
  stage: workflowStageSchema,
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', { message: '请求体不是合法 JSON' });
  }

  try {
    const input = lockStageBodySchema.parse(body);
    const { projectId, stage } = input;

    if (!isStageEnabled(stage)) {
      return jsonError(422, 'STAGE_NOT_ENABLED', {
        message: `阶段 ${stage} 尚未开放（当前开放前六阶段）`,
      });
    }
    const project = getProject(projectId);
    if (!project) {
      return jsonError(404, 'project_not_found');
    }

    assertNoActiveLlmJob(projectId, stage);
    lockStage(projectId, stage);
    return Response.json({ stage: getStage(projectId, stage) });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

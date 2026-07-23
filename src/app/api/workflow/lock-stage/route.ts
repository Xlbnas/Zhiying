/**
 * POST /api/workflow/lock-stage — 锁定当前 active 版本（M2-C §十九）。
 *
 * body: { projectId, stage }
 * M2-C 仅开放 project_definition；锁定走 M2-A lockStage（要求 active 版本存在，
 * stale 必须先 re-run）。
 */
import { z } from 'zod';
import { getStage, lockStage } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getProject, jsonError, workflowErrorResponse } from '../../_lib/shared';

export const runtime = 'nodejs';

const M2C_ENABLED_STAGES = new Set(['project_definition']);

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

    if (!M2C_ENABLED_STAGES.has(stage)) {
      return jsonError(422, 'STAGE_NOT_ENABLED', {
        message: `阶段 ${stage} 尚未开放（M2-C 仅开放 project_definition）`,
      });
    }
    const project = getProject(projectId);
    if (!project) {
      return jsonError(404, 'project_not_found');
    }

    lockStage(projectId, stage);
    return Response.json({ stage: getStage(projectId, stage) });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

/**
 * POST /api/workflow/run-stage — 入队阶段生成任务（M2-C §十七）。
 *
 * body: { projectId, stage, confirmStale? }
 * - M2-C 仅开放 project_definition；其余阶段 → 422 STAGE_NOT_ENABLED
 * - 门控：assertRerunAllowed（上游锁 / locked 需 confirmStale）
 * - 只入队 llm_job（payload 为输入快照），立即 202；Route Handler 不直接调 LLM
 */
import { z } from 'zod';
import { enqueueLlmJob, type LlmJobPayload } from '@/lib/llm-jobs';
import { getProjectInput } from '@/lib/project-inputs';
import { assertRerunAllowed } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getProject, jsonError, workflowErrorResponse } from '../../_lib/shared';

export const runtime = 'nodejs';

const M2C_ENABLED_STAGES = new Set(['project_definition']);

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

    if (!M2C_ENABLED_STAGES.has(stage)) {
      return jsonError(422, 'STAGE_NOT_ENABLED', {
        message: `阶段 ${stage} 尚未开放（M2-C 仅开放 project_definition，其余 M2-D/E 开通）`,
      });
    }
    const project = getProject(projectId);
    if (!project) {
      return jsonError(404, 'project_not_found');
    }

    // M2-A 门控：上游锁检查 + locked 阶段 confirmStale
    assertRerunAllowed(projectId, stage, {
      confirmStale: input.confirmStale ?? false,
    });

    // payload 快照：完整 StagePromptInput（Worker 不重读 UI state）
    const promptInput = getProjectInput(projectId);
    if (!promptInput) {
      return jsonError(409, 'PROJECT_INPUT_MISSING', {
        message: '项目缺少生产参数（project_inputs），无法生成（Legacy M1 项目？）',
      });
    }
    const payload: LlmJobPayload = {
      schemaVersion: '1.0',
      stage,
      promptInput,
    };
    const job = enqueueLlmJob(projectId, payload);
    return Response.json({ job }, { status: 202 });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

/**
 * GET   /api/projects/[id]/stage/[stage] — active 版本内容（M2-C §十六）。
 * PATCH /api/projects/[id]/stage/[stage] — 人工编辑 → editVersion（M2-C §十八）。
 *
 * M2-C 只开放 project_definition；其余阶段一律 STAGE_NOT_ENABLED。
 */
import { getActiveLlmJob } from '@/lib/llm-jobs';
import { getDb } from '@/lib/db';
import { editVersion } from '@/lib/workflow/operations';
import { getStage, requireStage } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { z } from 'zod';
import { getVersion } from '@/lib/workflow/versions';
import { getProject, jsonError, workflowErrorResponse } from '../../../../_lib/shared';

export const runtime = 'nodejs';

/** M2-C 仅开放 project_definition（M2-D/E 逐阶段开通）。 */
const M2C_ENABLED_STAGES = new Set(['project_definition']);

const patchBodySchema = z.object({
  content: z.string().min(1, '内容不能为空'),
  confirmStale: z.boolean().optional(),
});

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; stage: string }> },
): Promise<Response> {
  const { id, stage: stageRaw } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  const stageParsed = workflowStageSchema.safeParse(stageRaw);
  if (!stageParsed.success) {
    return jsonError(422, 'invalid_stage', { message: `未知阶段: ${stageRaw}` });
  }
  try {
    const stage = requireStage(id, stageParsed.data);
    const version =
      stage.active_version === null
        ? null
        : (getVersion(id, stageParsed.data, stage.active_version) ?? null);
    const usage = getDb()
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(cost_cny), 0) AS totalCostCny
         FROM llm_usage WHERE project_id = ? AND stage = ?`,
      )
      .get(id, stageParsed.data) as {requests: number; totalCostCny: number};
    return Response.json({ stage, version, usage });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; stage: string }> },
): Promise<Response> {
  const { id, stage: stageRaw } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  const stageParsed = workflowStageSchema.safeParse(stageRaw);
  if (!stageParsed.success) {
    return jsonError(422, 'invalid_stage', { message: `未知阶段: ${stageRaw}` });
  }
  const stage = stageParsed.data;
  if (!M2C_ENABLED_STAGES.has(stage)) {
    return jsonError(422, 'STAGE_NOT_ENABLED', {
      message: `阶段 ${stage} 尚未开放（M2-C 仅开放 project_definition）`,
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', { message: '请求体不是合法 JSON' });
  }

  try {
    const input = patchBodySchema.parse(body);
    // 同阶段存在 queued/running 任务时拒绝编辑，避免 AI 回写覆盖人工语义
    const active = getActiveLlmJob(id, stage);
    if (active) {
      return jsonError(409, 'JOB_ALREADY_ACTIVE', {
        message: `${stage} 已有进行中的生成任务（${active.id}），请等待完成或先取消`,
      });
    }
    const version = editVersion(
      {
        projectId: id,
        stage,
        content: input.content,
        contentType: 'markdown',
        source: 'manual_edit',
      },
      { confirmStale: input.confirmStale ?? false },
    );
    return Response.json({ stage: getStage(id, stage), version });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

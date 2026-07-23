/**
 * POST /api/projects/[id]/stage/[stage]/rollback — 回滚到历史版本（M2-D §二十三）。
 *
 * body: { targetVersion, confirmStale? }
 * - 仅开放 capabilities.M2D_ENABLED_STAGES
 * - 同 stage 存在 queued/running 任务 → 409 JOB_ALREADY_ACTIVE
 * - 语义：复制旧版本为新 version（source=rollback，历史不移动）→
 *   active_version 指向新版本 → status=edited；locked 阶段需 confirmStale
 * - 禁止 UPDATE active_version = oldVersion 的指针回退
 */
import { z } from 'zod';
import { assertNoActiveLlmJob } from '@/lib/llm-jobs';
import { isStageEnabled } from '@/lib/workflow/capabilities';
import { rollbackToVersion } from '@/lib/workflow/operations';
import { getStage } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getVersion } from '@/lib/workflow/versions';
import { getProject, jsonError, workflowErrorResponse } from '../../../../../_lib/shared';

export const runtime = 'nodejs';

const rollbackBodySchema = z.object({
  targetVersion: z.number().int().positive(),
  confirmStale: z.boolean().optional(),
});

export async function POST(
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
  if (!isStageEnabled(stage)) {
    return jsonError(422, 'STAGE_NOT_ENABLED', {
      message: `阶段 ${stage} 尚未开放（当前开放前六阶段）`,
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', { message: '请求体不是合法 JSON' });
  }

  try {
    const input = rollbackBodySchema.parse(body);
    assertNoActiveLlmJob(id, stage);
    const target = getVersion(id, stage, input.targetVersion);
    if (!target) {
      return jsonError(404, 'VERSION_NOT_FOUND', {
        message: `版本不存在: ${stage} v${input.targetVersion}`,
      });
    }
    const version = rollbackToVersion(id, stage, input.targetVersion, {
      confirmStale: input.confirmStale ?? false,
    });
    return Response.json({ stage: getStage(id, stage), version });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

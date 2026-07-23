/**
 * GET   /api/projects/[id]/stage/[stage] — active 版本内容 + usage 汇总。
 * PATCH /api/projects/[id]/stage/[stage] — 人工编辑 → editVersion（M2-D §十六/十七）。
 *
 * - 仅开放 capabilities.M2D_ENABLED_STAGES；其余 → 422 STAGE_NOT_ENABLED
 * - contentType 来自 Prompt Registry outputKind（不再硬编码 markdown）
 * - JSON 阶段（evidence/argument_tree）：先 JSON.parse 再过阶段 zodSchema，
 *   失败 → 422 INVALID_STAGE_CONTENT（有限长度 issues），非法 JSON 绝不入库；
 *   通过后存储 JSON.stringify(validatedData)
 */
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { assertNoActiveLlmJob } from '@/lib/llm-jobs';
import { clipText } from '@/lib/llm/types';
import { getStagePrompt } from '@/lib/prompts/registry';
import { isStageEnabled } from '@/lib/workflow/capabilities';
import { editVersion } from '@/lib/workflow/operations';
import { getStage, requireStage } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getVersion } from '@/lib/workflow/versions';
import { getProject, jsonError, workflowErrorResponse } from '../../../../_lib/shared';

export const runtime = 'nodejs';

const patchBodySchema = z.object({
  content: z.string().min(1, '内容不能为空'),
  confirmStale: z.boolean().optional(),
});

const MAX_ISSUES = 10;

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
    const {outputKind} = getStagePrompt(stageParsed.data);
    return Response.json({ stage, version, usage, outputKind });
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
    const input = patchBodySchema.parse(body);
    // 同阶段存在 queued/running 任务时拒绝编辑，避免 AI 回写覆盖人工语义
    assertNoActiveLlmJob(id, stage);

    // contentType 唯一真相：Prompt Registry outputKind
    const prompt = getStagePrompt(stage);
    let content = input.content;
    if (prompt.outputKind === 'json') {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(content);
      } catch (err) {
        return jsonError(422, 'INVALID_STAGE_CONTENT', {
          message: `JSON 解析失败：${clipText(err instanceof Error ? err.message : String(err), 300)}`,
        });
      }
      const safe = prompt.zodSchema!.safeParse(parsedJson);
      if (!safe.success) {
        const issues = safe.error.issues
          .slice(0, MAX_ISSUES)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n');
        return jsonError(422, 'INVALID_STAGE_CONTENT', {
          message: clipText(`内容未通过 ${stage} schema 校验：\n${issues}`, 1200),
        });
      }
      // M2-E-A：结构之后的语义校验（与 LLM 输出同一套规则，人工编辑不绕过）
      if (prompt.semanticValidate) {
        const semanticIssues = prompt.semanticValidate(safe.data);
        if (semanticIssues.length > 0) {
          const issues = semanticIssues
            .slice(0, MAX_ISSUES)
            .map((issue) => `[${issue.code}] ${issue.message}`)
            .join('\n');
          return jsonError(422, 'INVALID_STAGE_CONTENT', {
            message: clipText(`内容未通过 ${stage} 语义校验：\n${issues}`, 1200),
          });
        }
      }
      content = JSON.stringify(safe.data);
    }

    const version = editVersion(
      {
        projectId: id,
        stage,
        content,
        contentType: prompt.outputKind,
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

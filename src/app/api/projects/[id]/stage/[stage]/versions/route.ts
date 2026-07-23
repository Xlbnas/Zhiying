/**
 * GET /api/projects/[id]/stage/[stage]/versions — 阶段版本历史（M2-D §二十二）。
 *
 * 默认：metadata 列表（version 倒序 + isActive/isLocked + 短 preview），
 *   不把几十个大 Script 内容塞给浏览器。
 * ?version=N：返回该版本完整内容。
 * 唯一数据源：project_versions。
 */
import { clipText } from '@/lib/llm/types';
import { requireStage } from '@/lib/workflow/stages';
import { workflowStageSchema } from '@/lib/workflow/types';
import { getVersion, listVersions } from '@/lib/workflow/versions';
import { getProject, jsonError, workflowErrorResponse } from '../../../../../_lib/shared';

export const runtime = 'nodejs';

const PREVIEW_LEN = 120;

export async function GET(
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

  try {
    const stageRow = requireStage(id, stage);
    const versionParam = new URL(req.url).searchParams.get('version');
    if (versionParam !== null) {
      const target = Number(versionParam);
      if (!Number.isInteger(target) || target < 1) {
        return jsonError(422, 'invalid_version', { message: `非法版本号: ${versionParam}` });
      }
      const row = getVersion(id, stage, target);
      if (!row) {
        return jsonError(404, 'VERSION_NOT_FOUND', {
          message: `版本不存在: ${stage} v${target}`,
        });
      }
      return Response.json({ version: row });
    }

    const versions = listVersions(id, stage).map((row) => ({
      version: row.version,
      contentType: row.content_type,
      source: row.source,
      promptVersion: row.prompt_version,
      model: row.model,
      note: row.note,
      createdAt: row.created_at,
      isActive: stageRow.active_version === row.version,
      isLocked: stageRow.locked_version === row.version,
      preview: clipText(row.content.replace(/\s+/g, ' ').trim(), PREVIEW_LEN),
    }));
    return Response.json({ stage: stageRow, versions });
  } catch (err) {
    const mapped = workflowErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

/**
 * GET /api/projects/[id]/summary — 项目用量总结。
 */
import {getProjectUsageSummary} from '@/lib/usage-events';
import {getProject, jsonError} from '../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  return Response.json(getProjectUsageSummary(id));
}

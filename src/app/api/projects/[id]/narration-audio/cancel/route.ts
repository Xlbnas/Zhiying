/**
 * POST /api/projects/[id]/narration-audio/cancel — 取消项目全部活跃 TTS 任务。
 * queued → 直接 cancelled；running → requestCancel（Worker 经 AbortSignal 中断）。
 */
import {
  cancelQueuedTtsJob,
  requestCancelTtsJob,
} from '@/lib/tts-jobs';
import { getDb } from '@/lib/db';
import { getProject, jsonError } from '../../../../_lib/shared';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return jsonError(404, 'project_not_found');
  }
  const active = getDb()
    .prepare(
      `SELECT id, status FROM tts_jobs
       WHERE project_id = ? AND status IN ('queued', 'running')`,
    )
    .all(id) as Array<{ id: string; status: string }>;
  let cancelled = 0;
  let marked = 0;
  for (const job of active) {
    if (job.status === 'queued') {
      if (cancelQueuedTtsJob(job.id)) cancelled++;
    } else if (requestCancelTtsJob(job.id)) {
      marked++;
    }
  }
  return Response.json({ cancelled, cancelRequested: marked });
}

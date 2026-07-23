/**
 * POST /api/workflow/cancel-job — 取消 llm_job（M2-C §十六/十四）。
 *
 * body: { jobId }
 * - queued：直接终结为 cancelled（API 侧立即生效）
 * - running：requestCancel 标记，Worker 心跳轮询后经 AbortSignal 中断
 * - 已终结任务：409 JOB_NOT_ACTIVE
 */
import { z } from 'zod';
import {
  cancelQueuedLlmJob,
  getLlmJob,
  requestCancelLlmJob,
} from '@/lib/llm-jobs';
import { jsonError } from '../../_lib/shared';

export const runtime = 'nodejs';

const cancelBodySchema = z.object({
  jobId: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', { message: '请求体不是合法 JSON' });
  }

  const parsed = cancelBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, 'invalid_request', { message: parsed.error.message });
  }
  const { jobId } = parsed.data;

  const job = getLlmJob(jobId);
  if (!job) {
    return jsonError(404, 'JOB_NOT_FOUND', { message: `llm_job 不存在: ${jobId}` });
  }
  if (job.status === 'queued') {
    cancelQueuedLlmJob(jobId);
    return Response.json({ job: getLlmJob(jobId) });
  }
  if (job.status === 'running') {
    requestCancelLlmJob(jobId);
    return Response.json({ job: getLlmJob(jobId) }, { status: 202 });
  }
  return jsonError(409, 'JOB_NOT_ACTIVE', {
    message: `任务已是终态（${job.status}），不能取消`,
  });
}

/**
 * GET /api/jobs/[id]/download — 流式下载渲染产物 mp4（M6.3.11 硬化）。
 *
 * 契约（P0）：
 * - exact job 解析：render_jobs(id) → render_artifacts manifest → 磁盘文件，
 *   三层 identity 必须一致；任何缺失/不一致 → 明确 4xx，绝不 fallback 旧视频。
 * - size 与 manifest 不一致 → 409 artifact_mismatch（文件被替换/污染）。
 * - 历史 job 无 manifest → 惰性回填（重算 SHA 一次），回填失败 → 409。
 * - Cache-Control: private, no-store；URL 本身 job-specific。
 * - ?inline=1 → Content-Disposition: inline（Final Video 播放器播放同一 artifact，
 *   保证 player 与 download 字节同一 identity，Phase 17/25）。
 */
import fs from 'node:fs';
import {Readable} from 'node:stream';
import {getDb} from '@/lib/db';
import {resolveJobArtifact} from '@/lib/render/artifact';
import {jsonError, type RenderJobRow} from '../../../_lib/shared';

export const runtime = 'nodejs';

export async function GET(
  req: Request,
  {params}: {params: Promise<{id: string}>},
): Promise<Response> {
  const {id} = await params;

  const job = getDb()
    .prepare('SELECT * FROM render_jobs WHERE id = ?')
    .get(id) as RenderJobRow | undefined;
  if (!job) {
    return jsonError(404, 'job_not_found');
  }

  const resolution = await resolveJobArtifact(job);
  if (!resolution.ok) {
    return jsonError(resolution.status, resolution.code, {
      message: resolution.message,
      ...(resolution.code === 'job_not_finished'
        ? {status: job.status, progress: job.progress}
        : {}),
    });
  }

  const {absPath, artifact} = resolution;
  const stat = fs.statSync(absPath);
  const nodeStream = fs.createReadStream(absPath);
  // 边界说明：Readable.toWeb 返回 stream/web 的 ReadableStream，
  // 与 DOM lib 的 ReadableStream 结构兼容但类型声明不同源，此处做一次收窄断言。
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const inline = new URL(req.url).searchParams.get('inline') === '1';
  const filename = `zhiying-${job.id}.mp4`;
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`,
      'Cache-Control': 'private, no-store',
      // 产物 identity 头：UI 技术详情 / debug 可直接比对 manifest
      'X-Artifact-Sha256': artifact.output_sha256,
    },
  });
}

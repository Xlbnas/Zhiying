/**
 * GET /api/jobs/[id]/download — 流式下载渲染产物 mp4。
 * job 未完成 → 409；output 文件缺失 → 404。
 * fs.createReadStream 流式返回 + Content-Disposition attachment。
 * CONTRACT §5。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getDataDir, getDb } from '@/lib/db';
import { jsonError, type RenderJobRow } from '../../../_lib/shared';

export const runtime = 'nodejs';

/** output_path 统一约定为「数据目录相对路径」（worker 侧写入），绝对路径原样兼容。 */
function resolveOutputPath(outputPath: string): string {
  return path.isAbsolute(outputPath)
    ? outputPath
    : path.join(getDataDir(), outputPath);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const job = getDb()
    .prepare('SELECT * FROM render_jobs WHERE id = ?')
    .get(id) as RenderJobRow | undefined;
  if (!job) {
    return jsonError(404, 'job_not_found');
  }
  if (job.status !== 'succeeded' || !job.output_path) {
    return jsonError(409, 'job_not_finished', {
      status: job.status,
      progress: job.progress,
    });
  }
  const outputAbs = resolveOutputPath(job.output_path);
  if (!fs.existsSync(outputAbs)) {
    return jsonError(404, 'output_missing', {
      message: '渲染产物文件不存在（可能已被清理）',
    });
  }

  const stat = fs.statSync(outputAbs);
  const nodeStream = fs.createReadStream(outputAbs);
  // 边界说明：Readable.toWeb 返回 stream/web 的 ReadableStream，
  // 与 DOM lib 的 ReadableStream 结构兼容但类型声明不同源，此处做一次收窄断言。
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const filename = path.basename(outputAbs);
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(
        filename,
      )}"`,
      'Cache-Control': 'no-store',
    },
  });
}

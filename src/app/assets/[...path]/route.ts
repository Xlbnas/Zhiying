/**
 * GET /assets/[...path] — 运行时素材文件服务。
 *
 * 背景：Next.js `next start` 只在启动时扫描 public/ 文件清单，
 * 之后写入 public/assets/ 的素材（上传 / AI 生成 / Wikimedia 下载）一律 404。
 * production 的 public/assets 是独立可写卷，素材在运行期持续新增，
 * 因此必须由 route handler 动态从磁盘读取。
 *
 * 安全：path.resolve + 前缀校验防目录穿越；只允许文件、只允许 assets 根下。
 * 缓存：文件名是 UUID（写一次永不改），immutable 安全。
 */
import fs from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export async function GET(
  _req: Request,
  {params}: {params: Promise<{path: string[]}>},
): Promise<Response> {
  const {path: segments} = await params;
  if (!segments || segments.length === 0) {
    return new Response('not found', {status: 404});
  }
  // 拒绝任何穿越片段（双保险：path.resolve 前缀校验是主防线）
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\0'))) {
    return new Response('forbidden', {status: 400});
  }
  const root = path.resolve(process.cwd(), 'public', 'assets');
  const abs = path.resolve(root, ...segments);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return new Response('forbidden', {status: 400});
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return new Response('not found', {status: 404});
  }
  if (!stat.isFile()) {
    return new Response('not found', {status: 404});
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  const data = fs.readFileSync(abs);
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

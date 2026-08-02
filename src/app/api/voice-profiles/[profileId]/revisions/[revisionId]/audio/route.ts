/**
 * GET /api/voice-profiles/[profileId]/revisions/[revisionId]/audio — canonical WAV 下载。
 *
 * - 只经 readRevisionAudio（DB exact lookup，无请求侧 path 参数）；不返回目录列表。
 * - 固定 Content-Type: audio/wav；Cache-Control: private, no-store。
 * - 支持单 Range（bytes=start-end / bytes=-suffix；start/end clamp）→ 206；
 *   非法 Range → 416。文件缺失 / hash 异常 → 404（fail-closed）。
 */
import fs from 'node:fs';
import {Readable} from 'node:stream';
import {readRevisionAudio} from '@/lib/voice-library/audio-file';
import {jsonError} from '../../../../../_lib/shared';

export const runtime = 'nodejs';

interface ByteRange {
  start: number;
  end: number; // inclusive
}

/** 解析单 Range 头；非法 → 'invalid'；无 Range → null。 */
function parseRange(header: string, size: number): ByteRange | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return 'invalid';
  let start: number;
  let end: number;
  if (startRaw === '') {
    // suffix range：最后 N 字节
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      return 'invalid';
    }
    // clamp（start 越界在下方统一 416）
    end = Math.min(end, size - 1);
  }
  if (start > size - 1) return 'invalid';
  return {start, end};
}

export async function GET(
  req: Request,
  {params}: {params: Promise<{profileId: string; revisionId: string}>},
): Promise<Response> {
  const {profileId, revisionId} = await params;
  const audio = await readRevisionAudio(profileId, revisionId);
  if (!audio) return jsonError(404, 'audio_not_found');

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  };

  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    const range = parseRange(rangeHeader, audio.size);
    if (range === 'invalid' || range === null) {
      return new Response(null, {
        status: 416,
        headers: {...baseHeaders, 'Content-Range': `bytes */${audio.size}`},
      });
    }
    const length = range.end - range.start + 1;
    const stream = fs.createReadStream(audio.absPath, {start: range.start, end: range.end});
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${audio.size}`,
        'Content-Length': String(length),
      },
    });
  }

  const stream = fs.createReadStream(audio.absPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {...baseHeaders, 'Content-Length': String(audio.size)},
  });
}

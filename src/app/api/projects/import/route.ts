/**
 * POST /api/projects/import — 导入 FullCutScenes.json。
 * body = 源文件原文（FullCutData，可额外携带 subtitles 字段）。
 * fullCutDataSchema.safeParse 校验，失败 422 + zod issues；
 * 成功创建 project + scenes artifact（无损存储请求体）+ subtitles artifact。
 * CONTRACT §5 / round-trip 无损要求。
 */
import { fullCutDataSchema } from '@/lib/scene-schema';
import {
  createProjectFromImport,
  jsonError,
  subtitleArraySchema,
  type SubtitleCue,
} from '../../_lib/shared';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'invalid_json', {
      message: '请求体不是合法 JSON',
    });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonError(422, 'invalid_shape', {
      message: '请求体必须是 FullCutScenes.json 对应的对象',
    });
  }

  const parsed = fullCutDataSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(422, 'schema_validation_failed', {
      issues: parsed.error.issues,
    });
  }

  // 请求体可选携带 subtitles 字段；有则校验后入库，无则存 []
  let subtitles: SubtitleCue[] = [];
  const bodyObj = raw as Record<string, unknown>;
  if ('subtitles' in bodyObj) {
    const subsParsed = subtitleArraySchema.safeParse(bodyObj.subtitles);
    if (!subsParsed.success) {
      return jsonError(422, 'subtitles_validation_failed', {
        issues: subsParsed.error.issues,
      });
    }
    subtitles = subsParsed.data;
  }

  try {
    const result = createProjectFromImport(raw, parsed.data, subtitles);
    return Response.json(
      {
        project: result.project,
        sceneCount: result.sceneCount,
        subtitleCount: result.subtitleCount,
      },
      { status: 201 },
    );
  } catch (err) {
    return jsonError(500, 'import_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

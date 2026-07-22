/**
 * API 层共享内部模块（_lib 目录不参与 Next 路由）。
 * 仅 API agent 使用；DB / jobs 模块由 Worker agent 按 CONTRACT §3 提供。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import {
  fullCutDataSchema,
  subtitleCueSchema,
  SCHEMA_VERSION,
  TEMPLATE_VERSION,
  COMPOSITION_ID,
  type FullCutData,
  type SubtitleCue,
  type ZhiyingFullCutProps,
} from '@/lib/scene-schema';

export type { SubtitleCue, FullCutData, ZhiyingFullCutProps };

// ---------- DB 行类型（对应 CONTRACT §3 建表语句） ----------

export interface ProjectRow {
  id: string;
  title: string;
  mode: string;
  schema_version: string;
  template_version: string;
  composition_id: string;
  current_stage: string;
  created_at: string;
  updated_at: string;
}

export interface ArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string | null;
  file_path: string | null;
  created_at: string;
}

export interface RenderJobRow {
  id: string;
  project_id: string;
  kind: string;
  status: string;
  progress: number;
  payload_json: string;
  output_path: string | null;
  error_code: string | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
  max_attempts: number;
  cancel_requested: number;
}

// ---------- 查询助手 ----------

export function getProject(id: string): ProjectRow | undefined {
  return getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined;
}

export function latestArtifact(
  projectId: string,
  kind: string,
): ArtifactRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(projectId, kind) as ArtifactRow | undefined;
}

// ---------- 旁白音频解析 ----------

/** 默认旁白路径（staticFile 相对路径，CONTRACT §5） */
export const DEFAULT_NARRATION_PATH = 'full/audio/FullCut_TTS.wav';

/**
 * audio.narration：环境变量 ZHIYING_NARRATION_PATH 覆盖，否则用默认路径；
 * 文件在 public/ 下不存在时返回 null（模板侧 null 则不挂 <Audio>）。
 */
export function resolveNarration(): string | null {
  const rel = (
    process.env.ZHIYING_NARRATION_PATH?.trim() || DEFAULT_NARRATION_PATH
  ).replace(/\\/g, '/');
  const publicRoot = path.join(process.cwd(), 'public');
  const abs = path.join(publicRoot, rel);
  // 防目录穿越：必须仍位于 public/ 内
  if (!abs.startsWith(publicRoot + path.sep) && abs !== publicRoot) {
    return null;
  }
  return fs.existsSync(abs) ? rel : null;
}

// ---------- Props 组装 ----------

export const subtitleArraySchema = z.array(subtitleCueSchema);

/**
 * 从 DB 组装 ZhiyingFullCutProps（Player 与渲染 payload 共用，同构原则）。
 * 数据流：scenes artifact.content_json（import 时无损存储的请求体）
 *   → 剥离可能内嵌的 subtitles 字段 → zod 校验/规范化 → props。
 * 注意：props 层使用 zod 解析结果（应用 schema 默认值），
 * 无损性由存储层保证（content_json 为请求体原文重新序列化）。
 */
export function buildFullCutProps(
  projectId: string,
  opts: { showSubtitles: boolean },
): ZhiyingFullCutProps | null {
  const scenesArtifact = latestArtifact(projectId, 'scenes');
  if (!scenesArtifact?.content_json) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(scenesArtifact.content_json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }

  // 请求体可能携带 subtitles 字段；data 部分需剥离后校验
  const { subtitles: _embedded, ...dataRest } = raw as Record<string, unknown>;
  const dataParsed = fullCutDataSchema.safeParse(dataRest);
  if (!dataParsed.success) return null;

  const subtitlesArtifact = latestArtifact(projectId, 'subtitles');
  let subtitles: SubtitleCue[] = [];
  if (subtitlesArtifact?.content_json) {
    try {
      const subsParsed = subtitleArraySchema.safeParse(
        JSON.parse(subtitlesArtifact.content_json),
      );
      if (subsParsed.success) subtitles = subsParsed.data;
    } catch {
      // 字幕 artifact 损坏时降级为空字幕轨，不阻塞预览/渲染
    }
  }

  return {
    data: dataParsed.data,
    subtitles,
    audio: { narration: resolveNarration() },
    showSubtitles: opts.showSubtitles,
  };
}

// ---------- import 落库 ----------

export interface ImportResult {
  project: ProjectRow;
  sceneCount: number;
  subtitleCount: number;
}

/**
 * 创建 project + scenes artifact + subtitles artifact（单事务）。
 * @param rawBody   请求体 JSON.parse 后的原始对象（无损存储来源）
 * @param data      fullCutDataSchema 校验通过后的数据
 * @param subtitles 请求体中的字幕（无则为 []）
 */
export function createProjectFromImport(
  rawBody: unknown,
  data: FullCutData,
  subtitles: SubtitleCue[],
): ImportResult {
  const db = getDb();
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();

  const insertProject = db.prepare(
    `INSERT INTO projects
       (id, title, mode, schema_version, template_version, composition_id,
        current_stage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertArtifact = db.prepare(
    `INSERT INTO artifacts
       (id, project_id, kind, version, content_json, file_path, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );

  const run = db.transaction(() => {
    insertProject.run(
      projectId,
      data.project.title,
      'rigorous',
      data.schemaVersion || SCHEMA_VERSION,
      data.templateVersion || TEMPLATE_VERSION,
      // composition_id 统一契约常量（samples 源文件里的 project.composition
      // 是旧预览名 "FullCutV1"，仅作数据保留在 artifact 中，不作为渲染入口）
      COMPOSITION_ID,
      'scenes',
      now,
      now,
    );
    // round-trip 无损：请求体原文重新序列化，不改写任何字段
    insertArtifact.run(
      crypto.randomUUID(),
      projectId,
      'scenes',
      1,
      JSON.stringify(rawBody),
      now,
    );
    insertArtifact.run(
      crypto.randomUUID(),
      projectId,
      'subtitles',
      1,
      JSON.stringify(subtitles),
      now,
    );
  });
  run();

  const project = getProject(projectId);
  if (!project) {
    // 理论上不可达：同事务刚写入
    throw new Error('project insert failed');
  }
  return {
    project,
    sceneCount: data.scenes.length,
    subtitleCount: subtitles.length,
  };
}

// ---------- 响应助手 ----------

export function jsonError(
  status: number,
  error: string,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error, ...extra }, { status });
}

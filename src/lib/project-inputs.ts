import {z} from 'zod';
import {getDb} from './db';
import type {StagePromptInput} from './prompts/shared';

/**
 * 项目生产参数持久化（M2-C）。
 *
 * project_inputs 是「项目生产参数」——不是 workflow artifact，
 * 因此不存入 artifacts / project_versions；M1 projects 表零 ALTER。
 * config_json 写入前 zod、读取后 zod（损坏即显式报错，不静默降级）。
 */

export const projectInputSchema = z.object({
  topic: z.string().trim().min(1, '主题不能为空'),
  coreQuestion: z.string().trim().min(1, '核心问题不能为空'),
  targetDuration: z.string().trim().min(1).default('10 分钟'),
  language: z.string().trim().min(1).default('中文'),
  platform: z.string().trim().min(1).default('未指定'),
  audience: z.string().trim().min(1).default('未指定'),
  videoStyle: z.string().trim().min(1).default('视频论文'),
  /** 允许空串：空 = 由 AI 按项目上下文提案（见 prompts/shared.projectVarsBlock）。 */
  visualStyle: z.string().trim().default(''),
  scientificRigor: z.enum(['高', '中', '低']).default('高'),
});

export type ProjectInput = z.infer<typeof projectInputSchema>;

export const PROJECT_INPUT_SCHEMA_VERSION = '1.0';

export interface ProjectInputRow {
  project_id: string;
  schema_version: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

/** 【事务内 helper】写入项目参数（调用方负责事务/原子性）。写入前 zod。 */
export function upsertProjectInputTx(projectId: string, input: ProjectInput): void {
  const at = now();
  getDb()
    .prepare(
      `INSERT INTO project_inputs (project_id, schema_version, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         schema_version = excluded.schema_version,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    )
    .run(projectId, PROJECT_INPUT_SCHEMA_VERSION, JSON.stringify(input), at, at);
}

/** 读取项目参数；不存在返回 null；存在但损坏（JSON/zod 失败）抛 Error。 */
export function getProjectInput(projectId: string): ProjectInput | null {
  const row = getDb()
    .prepare('SELECT * FROM project_inputs WHERE project_id = ?')
    .get(projectId) as ProjectInputRow | undefined;
  if (!row) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(row.config_json);
  } catch {
    throw new Error(`project_inputs 损坏（非法 JSON）: ${projectId}`);
  }
  const parsed = projectInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `project_inputs 损坏（schema 校验失败）: ${projectId}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** 转 StagePromptInput（M2-C 无 upstream/sourceContext；M2-D 再注入上游产物）。 */
export function toStagePromptInput(input: ProjectInput): StagePromptInput {
  return {
    topic: input.topic,
    coreQuestion: input.coreQuestion,
    targetDuration: input.targetDuration,
    language: input.language,
    platform: input.platform,
    audience: input.audience,
    videoStyle: input.videoStyle,
    visualStyle: input.visualStyle,
    scientificRigor: input.scientificRigor,
  };
}

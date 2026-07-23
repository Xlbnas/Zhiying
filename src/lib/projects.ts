import crypto from 'node:crypto';
import {getDb} from './db';
import {
  PROJECT_INPUT_SCHEMA_VERSION,
  projectInputSchema,
  type ProjectInput,
  type ProjectInputRow,
} from './project-inputs';
import {initProjectStages, listStages} from './workflow/stages';
import type {ProjectStageRow} from './workflow/types';

/**
 * 项目创建（M2-C）：projects + project_inputs + 10 个 project_stages
 * 必须在单个 SQLite 事务内原子完成——不得出现建了 project 但没有
 * inputs/stages 的半成品。
 */

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

export interface CreateProjectResult {
  project: ProjectRow;
  inputs: ProjectInput;
  stages: ProjectStageRow[];
}

export function getProjectRow(id: string): ProjectRow | undefined {
  return getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined;
}

/** 原子创建：zod 校验 → BEGIN（单事务）→ project + inputs + 10 stages。 */
export function createProjectWithWorkflow(rawInput: unknown): CreateProjectResult {
  const input: ProjectInput = projectInputSchema.parse(rawInput);
  const db = getDb();
  const at = new Date().toISOString();
  const projectId = crypto.randomUUID();

  const tx = db.transaction((): void => {
    db.prepare(
      `INSERT INTO projects
         (id, title, mode, schema_version, template_version, composition_id,
          current_stage, created_at, updated_at)
       VALUES (?, ?, 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut',
               'project_definition', ?, ?)`,
    ).run(projectId, input.topic, at, at);
    db.prepare(
      `INSERT INTO project_inputs (project_id, schema_version, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(projectId, PROJECT_INPUT_SCHEMA_VERSION, JSON.stringify(input), at, at);
    // 内嵌事务（better-sqlite3 嵌套 = savepoint）：任一失败整体回滚
    initProjectStages(projectId);
  });
  tx();

  const project = getProjectRow(projectId);
  if (!project) {
    throw new Error('createProjectWithWorkflow: project insert failed');
  }
  return {project, inputs: input, stages: listStages(projectId)};
}

/** Legacy M1 判定：没有任何 project_stages 行的项目（如旧导入项目）。 */
export function isLegacyM1Project(projectId: string): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM project_stages WHERE project_id = ?')
    .get(projectId) as {c: number};
  return row.c === 0;
}

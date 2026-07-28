import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDb, getDataDir} from './db';
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

// ---------- M6+：项目删除 ----------

export class ProjectDeleteError extends Error {
  constructor(
    public readonly code: 'PROJECT_NOT_FOUND' | 'RUNNING_JOB_EXISTS' | 'FILESYSTEM_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectDeleteError';
  }
}

/** 不区分 kind —— queued/running 任一存在即阻止删除。 */
function hasRunningJob(projectId: string): boolean {
  const db = getDb();
  const render = db
    .prepare(
      `SELECT 1 FROM render_jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    )
    .get(projectId);
  if (render) return true;
  const tts = db
    .prepare(
      `SELECT 1 FROM tts_jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    )
    .get(projectId);
  if (tts) return true;
  const llm = db
    .prepare(
      `SELECT 1 FROM llm_jobs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1`,
    )
    .get(projectId);
  return !!llm;
}

/** 安全删除目录：realpath 校验必须位于 data/public 根下，禁止穿越到外部。 */
function safeRmDir(dirAbs: string, allowedRoots: string[]): void {
  try {
    const real = fs.realpathSync(dirAbs);
    const ok = allowedRoots.some((r) => real === r || real.startsWith(r + path.sep));
    if (!ok) return;
    fs.rmSync(real, {recursive: true, force: true});
  } catch {
    // 不存在或无法解析 → 不报错
  }
}

/**
 * 删除项目及其所有产物（DB records + 磁盘文件），单事务原子操作。
 *
 * 安全约束：
 * - 存在 running/queued job → 409 阻止
 * - 文件删除限定 data/ 和 public/ 以内，经 realpath 边界校验
 */
export function deleteProject(projectId: string): void {
  const db = getDb();
  const project = getProjectRow(projectId);
  if (!project) {
    throw new ProjectDeleteError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
  }
  if (hasRunningJob(projectId)) {
    throw new ProjectDeleteError(
      'RUNNING_JOB_EXISTS',
      '这个项目还有任务正在运行，请等待任务结束后再删除。',
    );
  }

  // 收集文件路径（在事务外，防止事务内 IO）
  const renderPaths: string[] = (db
    .prepare('SELECT output_path FROM render_jobs WHERE project_id = ? AND output_path IS NOT NULL')
    .all(projectId) as Array<{output_path: string}>).map((r) => r.output_path);
  const ttsPaths: string[] = (db
    .prepare('SELECT output_path FROM tts_jobs WHERE project_id = ? AND output_path IS NOT NULL')
    .all(projectId) as Array<{output_path: string}>).map((r) => r.output_path);

  const dataDir = getDataDir();
  const publicDir = path.resolve(process.cwd(), 'public');
  const allowedRoots = [dataDir, publicDir];

  const tx = db.transaction((): void => {
    // 按外键依赖逆序删除（子表先删，主表最后）
    db.prepare('DELETE FROM assets WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM tts_jobs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM llm_usage WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM llm_jobs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM render_jobs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM artifacts WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_versions WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_stages WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_inputs WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  });
  tx();

  // 事务成功后清理磁盘文件
  for (const rel of [...renderPaths, ...ttsPaths]) {
    if (!rel) continue;
    const abs = path.resolve(dataDir, rel);
    try {
      const real = fs.realpathSync(abs);
      if (allowedRoots.some((r) => real === r || real.startsWith(r + path.sep))) {
        fs.rmSync(real, {force: true});
        // 尝试清理空父目录（可选）
        const parent = path.dirname(real);
        if (parent !== dataDir && parent !== publicDir) {
          try { fs.rmdirSync(parent); } catch { /* 非空则保留 */ }
        }
      }
    } catch { /* 文件不存在则跳过 */ }
  }

  // 清理 public/assets/{projectId}/
  safeRmDir(path.join(publicDir, 'assets', projectId), allowedRoots);
  // 清理 data/projects/{projectId}/
  safeRmDir(path.join(dataDir, 'projects', projectId), allowedRoots);
}

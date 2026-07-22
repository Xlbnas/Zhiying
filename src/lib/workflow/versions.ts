import crypto from 'node:crypto';
import {getDb} from '@/lib/db';
import type {
  ContentType,
  ProjectVersionRow,
  VersionSource,
  WorkflowStage,
} from './types';

/**
 * 阶段产物版本操作（M2-A）。
 * 语义：自动保存 ≠ 覆盖唯一副本 —— regenerate / manual edit / rollback
 * 一律产生新 version；历史行永不 UPDATE/DELETE。
 * 版本号按 (project_id, stage) 递增；active_version 指针在 project_stages 上。
 */

function now(): string {
  return new Date().toISOString();
}

export function getVersion(
  projectId: string,
  stage: WorkflowStage,
  version: number,
): ProjectVersionRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM project_versions
       WHERE project_id = ? AND stage = ? AND version = ?`,
    )
    .get(projectId, stage, version) as ProjectVersionRow | undefined;
}

export function listVersions(
  projectId: string,
  stage: WorkflowStage,
): ProjectVersionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM project_versions
       WHERE project_id = ? AND stage = ?
       ORDER BY version DESC`,
    )
    .all(projectId, stage) as ProjectVersionRow[];
}

function nextVersionNumber(projectId: string, stage: WorkflowStage): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(version), 0) + 1 AS v
       FROM project_versions WHERE project_id = ? AND stage = ?`,
    )
    .get(projectId, stage) as {v: number};
  return row.v;
}

export interface CreateVersionInput {
  projectId: string;
  stage: WorkflowStage;
  content: string;
  contentType: ContentType;
  source: VersionSource;
  promptVersion?: string | null;
  model?: string | null;
  jobId?: string | null;
  note?: string | null;
}

/**
 * 创建新版本并把 project_stages.active_version 指向它（单事务）。
 * 状态字段（generated/edited/...）由 stages.ts 的状态机负责，
 * 本函数只保证「版本行 + active_version 指针」原子一致。
 * 返回新行。
 */
export function createVersion(input: CreateVersionInput): ProjectVersionRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const at = now();
  const tx = db.transaction(() => {
    const version = nextVersionNumber(input.projectId, input.stage);
    db.prepare(
      `INSERT INTO project_versions
         (id, project_id, stage, version, content, content_type, source,
          prompt_version, model, job_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.projectId,
      input.stage,
      version,
      input.content,
      input.contentType,
      input.source,
      input.promptVersion ?? null,
      input.model ?? null,
      input.jobId ?? null,
      input.note ?? null,
      at,
    );
    db.prepare(
      `UPDATE project_stages
       SET active_version = ?, updated_at = ?
       WHERE project_id = ? AND stage = ?`,
    ).run(version, at, input.projectId, input.stage);
    return version;
  });
  const version = tx();
  const row = getVersion(input.projectId, input.stage, version);
  if (!row) {
    throw new Error('createVersion: inserted row not found');
  }
  return row;
}

/**
 * 回滚：复制历史版本内容为新版本（source='rollback'），历史记录不移动。
 * 状态推进（edited / stale 传播）由 stages.ts 的 rollbackToVersion 完成。
 */
export function copyVersionAsNew(
  projectId: string,
  stage: WorkflowStage,
  targetVersion: number,
): ProjectVersionRow {
  const target = getVersion(projectId, stage, targetVersion);
  if (!target) {
    throw new Error(
      `rollback target not found: ${projectId}/${stage}/v${targetVersion}`,
    );
  }
  return createVersion({
    projectId,
    stage,
    content: target.content,
    contentType: target.content_type,
    source: 'rollback',
    promptVersion: target.prompt_version,
    model: target.model,
    jobId: null,
    note: `rollback from v${targetVersion}`,
  });
}

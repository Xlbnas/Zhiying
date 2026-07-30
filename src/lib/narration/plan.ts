import crypto from 'node:crypto';
import {getDb} from '../db';
import {isLegacyM1Project} from '../projects';
import {getStage} from '../workflow/stages';
import {getVersion} from '../workflow/versions';
import {
  compileNarrationPlan,
  NarrationCompileError,
} from './compiler';
import {
  NARRATION_COMPILER_VERSION,
  narrationPlanSchema,
  type NarrationPlan,
} from './schema';

/**
 * Narration Plan artifact 层（M3-A）。
 *
 * - source 只允许 script_v2.status==='locked' 的 locked_version（绝不读 active_version）
 * - 幂等：同 (projectId, scriptV2Version, compilerVersion) 复用已有 artifact
 * - stale：script_v2 前进后旧 plan 保留为历史，但不再是 current
 * - 无 DB migration：复用 artifacts 表（kind='narration_plan'）
 */

export const NARRATION_PLAN_ARTIFACT_KIND = 'narration_plan';

export type NarrationPlanErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'SCRIPT_V2_NOT_LOCKED'
  | 'SCRIPT_V2_VERSION_NOT_FOUND'
  | 'SCRIPT_V2_INVALID'
  | 'SCRIPT_V2_DSL_UNSUPPORTED_IN_M6'
  | 'NARRATION_PLAN_INVALID';

export class NarrationPlanError extends Error {
  constructor(
    public readonly code: NarrationPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NarrationPlanError';
  }
}

export interface NarrationPlanArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

function getArtifactById(id: string): NarrationPlanArtifactRow | undefined {
  return getDb()
    .prepare('SELECT * FROM artifacts WHERE id = ?')
    .get(id) as NarrationPlanArtifactRow | undefined;
}

function listPlanArtifacts(projectId: string): NarrationPlanArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, NARRATION_PLAN_ARTIFACT_KIND) as NarrationPlanArtifactRow[];
}

/**
 * 读取持久化 artifact：JSON.parse → narrationPlanSchema.safeParse（M3-A Hardening）。
 * 数据库内容不凭 TypeScript as 信任——Narration Plan 是 M3-B TTS 的直接输入，
 * narrationPlanSchema 是唯一数据契约；非法 artifact 一律返回 null。
 */
function parsePlan(row: NarrationPlanArtifactRow): NarrationPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = narrationPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 读取当前 narration plan（仅当 source 与 script_v2 locked_version 一致且仍 locked）。 */
export function getCurrentNarrationPlan(projectId: string): {
  plan: NarrationPlan;
  artifact: NarrationPlanArtifactRow;
} | null {
  const stage = getStage(projectId, 'script_v2');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    return null;
  }
  for (const row of listPlanArtifacts(projectId)) {
    const plan = parsePlan(row);
    if (
      plan &&
      plan.source.version === stage.locked_version &&
      plan.compilerVersion === NARRATION_COMPILER_VERSION
    ) {
      return {plan, artifact: row};
    }
  }
  return null;
}

export type NarrationPlanStatus = 'ready' | 'stale' | 'missing' | 'not_locked';

export interface NarrationReadiness {
  status: NarrationPlanStatus;
  scriptV2Status: string | null;
  scriptV2LockedVersion: number | null;
  latestPlanSourceVersion: number | null;
  currentPlan: NarrationPlan | null;
  artifactVersion: number | null;
}

/** Narration 区 readiness（纯读）。 */
export function checkNarrationReadiness(projectId: string): NarrationReadiness {
  const stage = getStage(projectId, 'script_v2');
  const scriptV2Status = stage?.status ?? null;
  const scriptV2LockedVersion = stage?.locked_version ?? null;

  let latestSource: number | null = null;
  for (const row of listPlanArtifacts(projectId)) {
    const plan = parsePlan(row);
    if (plan) {
      latestSource = plan.source.version;
      break;
    }
  }

  const locked = scriptV2Status === 'locked' && scriptV2LockedVersion !== null;
  const current = getCurrentNarrationPlan(projectId);
  let status: NarrationPlanStatus;
  if (!locked) {
    status = 'not_locked';
  } else if (current) {
    status = 'ready';
  } else if (latestSource !== null) {
    status = 'stale';
  } else {
    status = 'missing';
  }
  return {
    status,
    scriptV2Status,
    scriptV2LockedVersion,
    latestPlanSourceVersion: latestSource,
    currentPlan: current?.plan ?? null,
    artifactVersion: current?.artifact.version ?? null,
  };
}

/**
 * 构建 / 复用当前 Narration Plan（单 BEGIN IMMEDIATE 原子）：
 * project exists → 非 legacy → script_v2 locked → 读 immutable version →
 * compile → zod 校验 → 幂等复用检查 → INSERT artifact → commit。
 */
export function buildNarrationPlan(projectId: string): {
  plan: NarrationPlan;
  artifact: NarrationPlanArtifactRow;
  reused: boolean;
} {
  const db = getDb();
  const tx = db.transaction((): {
    plan: NarrationPlan;
    artifact: NarrationPlanArtifactRow;
    reused: boolean;
  } => {
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as {id: string} | undefined;
    if (!project) {
      throw new NarrationPlanError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (isLegacyM1Project(projectId)) {
      throw new NarrationPlanError('LEGACY_PROJECT', 'Legacy M1 项目无工作流阶段，无法构建 Narration Plan');
    }
    const stage = getStage(projectId, 'script_v2');
    if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
      throw new NarrationPlanError(
        'SCRIPT_V2_NOT_LOCKED',
        `script_v2 未锁定（当前 ${stage?.status ?? 'missing'}）`,
        );
    }
    const versionRow = getVersion(projectId, 'script_v2', stage.locked_version);
    if (!versionRow) {
      throw new NarrationPlanError(
        'SCRIPT_V2_VERSION_NOT_FOUND',
        `script_v2 locked_version=${stage.locked_version} 对应版本行不存在`,
      );
    }

    // 幂等：同 source version + compilerVersion 直接复用
    for (const row of listPlanArtifacts(projectId)) {
      const plan = parsePlan(row);
      if (
        plan &&
        plan.source.version === stage.locked_version &&
        plan.compilerVersion === NARRATION_COMPILER_VERSION
      ) {
        return {plan, artifact: row, reused: true};
      }
    }

    let plan: NarrationPlan;
    try {
      plan = compileNarrationPlan({
        scriptV2Markdown: versionRow.content,
        scriptV2Version: stage.locked_version,
        promptVersion: versionRow.prompt_version,
      });
    } catch (err) {
      if (err instanceof NarrationCompileError) {
        throw new NarrationPlanError(err.code, err.message);
      }
      throw err;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    ).run(
      id,
      projectId,
      NARRATION_PLAN_ARTIFACT_KIND,
      projectId,
      NARRATION_PLAN_ARTIFACT_KIND,
      JSON.stringify(plan),
      new Date().toISOString(),
    );
    const artifact = getArtifactById(id);
    if (!artifact) {
      throw new Error(`buildNarrationPlan: inserted artifact ${id} not found`);
    }
    return {plan, artifact, reused: false};
  });
  return tx.immediate();
}

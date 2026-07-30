import crypto from 'node:crypto';
import {getDb} from '../db';
import {isLegacyM1Project} from '../projects';
import {getStage} from '../workflow/stages';
import {getVersion} from '../workflow/versions';
import {
  compileNarrationPlanV2,
  NarrationV2CompileError,
  SCRIPT_V2_DSL_PROMPT_PREFIX,
  type NarrationV2InputMode,
} from './compiler-v2';
import {
  isPlanV2Eligible,
  NARRATION_PLAN_V2_ARTIFACT_KIND,
  NARRATION_V2_COMPILER_VERSION,
  narrationPlanV2Schema,
  type NarrationPlanV2,
} from './schema-v2';

/**
 * Narration Plan V2 artifact 层（M7.1）。
 *
 * - 独立 artifact kind（narration_plan_v2），append-only，绝不覆盖 v1 artifact
 * - source 只允许 script_v2.status==='locked' 的 locked_version（绝不读 active_version）
 * - 幂等：同 (projectId, scriptV2VersionId, compilerVersion) 复用已有 artifact
 * - candidate 语义：needsReview 非空的 plan 可保存为 candidate，
 *   但 getCurrentNarrationPlanV2 恒不返回（fail-closed，不得 current/lock）
 * - 构建 candidate 不改变 pipelineVersion、不触发 TTS/字幕/beats/render
 */

export {NARRATION_PLAN_V2_ARTIFACT_KIND} from './schema-v2';

export type NarrationPlanV2ErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'SCRIPT_V2_NOT_LOCKED'
  | 'SCRIPT_V2_VERSION_NOT_FOUND'
  | 'SCRIPT_V2_INVALID'
  | 'NARRATION_PLAN_INVALID';

export class NarrationPlanV2Error extends Error {
  constructor(
    public readonly code: NarrationPlanV2ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NarrationPlanV2Error';
  }
}

export interface NarrationPlanV2ArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

function listPlanV2Artifacts(projectId: string): NarrationPlanV2ArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, NARRATION_PLAN_V2_ARTIFACT_KIND) as NarrationPlanV2ArtifactRow[];
}

/** JSON.parse → narrationPlanV2Schema.safeParse；非法 artifact 一律 null。 */
function parsePlanV2(row: NarrationPlanV2ArtifactRow): NarrationPlanV2 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = narrationPlanV2Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 输入模式判定：script-v2@2.x → strict DSL；其余（1.x/无 promptVersion）→ legacy。 */
export function inputModeOf(promptVersion: string | null): NarrationV2InputMode {
  return promptVersion !== null && promptVersion.startsWith(SCRIPT_V2_DSL_PROMPT_PREFIX)
    ? 'strict'
    : 'legacy';
}

interface LockedScriptV2 {
  stage: {locked_version: number};
  versionRow: {id: string; version: number; content: string; prompt_version: string | null};
}

function requireLockedScriptV2(projectId: string): LockedScriptV2 {
  const stage = getStage(projectId, 'script_v2');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    throw new NarrationPlanV2Error(
      'SCRIPT_V2_NOT_LOCKED',
      `script_v2 未锁定（当前 ${stage?.status ?? 'missing'}）`,
    );
  }
  const versionRow = getVersion(projectId, 'script_v2', stage.locked_version) as
    | {id: string; version: number; content: string; prompt_version: string | null}
    | undefined;
  if (!versionRow) {
    throw new NarrationPlanV2Error(
      'SCRIPT_V2_VERSION_NOT_FOUND',
      `script_v2 locked_version=${stage.locked_version} 对应版本行不存在`,
    );
  }
  return {stage: {locked_version: stage.locked_version}, versionRow};
}

/**
 * 读取 eligible current plan v2：source 精确匹配 locked script_v2（versionId + version +
 * contentHash 隐含于编译输入）且 needsReview 为空。candidate（needsReview 非空）
 * 永不从这里返回。
 */
export function getCurrentNarrationPlanV2(projectId: string): {
  plan: NarrationPlanV2;
  artifact: NarrationPlanV2ArtifactRow;
} | null {
  const stage = getStage(projectId, 'script_v2');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    return null;
  }
  const versionRow = getVersion(projectId, 'script_v2', stage.locked_version) as
    | {id: string; version: number}
    | undefined;
  if (!versionRow) return null;
  for (const row of listPlanV2Artifacts(projectId)) {
    const plan = parsePlanV2(row);
    if (
      plan &&
      plan.compilerVersion === NARRATION_V2_COMPILER_VERSION &&
      plan.source.scriptV2VersionId === versionRow.id &&
      plan.source.scriptV2Version === stage.locked_version &&
      isPlanV2Eligible(plan)
    ) {
      return {plan, artifact: row};
    }
  }
  return null;
}

export type NarrationPlanV2Status =
  | 'ready'
  | 'needs_review'
  | 'stale'
  | 'missing'
  | 'not_locked';

export interface NarrationPlanV2Readiness {
  status: NarrationPlanV2Status;
  scriptV2Status: string | null;
  scriptV2LockedVersion: number | null;
  currentPlan: NarrationPlanV2 | null;
  artifactVersion: number | null;
  candidateCount: number;
  latestNeedsReviewCount: number | null;
}

/** Narration v2 readiness（纯读）。 */
export function checkNarrationPlanV2Readiness(projectId: string): NarrationPlanV2Readiness {
  const stage = getStage(projectId, 'script_v2');
  const locked = stage?.status === 'locked' && stage.locked_version !== null;
  const current = getCurrentNarrationPlanV2(projectId);
  let candidateCount = 0;
  let latestNeedsReviewCount: number | null = null;
  for (const row of listPlanV2Artifacts(projectId)) {
    const plan = parsePlanV2(row);
    if (!plan) continue;
    if (latestNeedsReviewCount === null) latestNeedsReviewCount = plan.needsReview.length;
    if (plan.needsReview.length > 0) candidateCount++;
  }
  let status: NarrationPlanV2Status;
  if (!locked) {
    status = 'not_locked';
  } else if (current) {
    status = 'ready';
  } else if (candidateCount > 0) {
    status = 'needs_review';
  } else if (latestNeedsReviewCount !== null) {
    status = 'stale';
  } else {
    status = 'missing';
  }
  return {
    status,
    scriptV2Status: stage?.status ?? null,
    scriptV2LockedVersion: stage?.locked_version ?? null,
    currentPlan: current?.plan ?? null,
    artifactVersion: current?.artifact.version ?? null,
    candidateCount,
    latestNeedsReviewCount,
  };
}

/**
 * 构建 / 复用 narration plan v2 candidate（单 BEGIN IMMEDIATE 原子，append-only）。
 * 不触发 TTS/字幕/beats/render，不改变 pipelineVersion。
 */
export function buildNarrationPlanV2(projectId: string): {
  plan: NarrationPlanV2;
  artifact: NarrationPlanV2ArtifactRow;
  reused: boolean;
} {
  const db = getDb();
  const tx = db.transaction((): {
    plan: NarrationPlanV2;
    artifact: NarrationPlanV2ArtifactRow;
    reused: boolean;
  } => {
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as {id: string} | undefined;
    if (!project) {
      throw new NarrationPlanV2Error('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (isLegacyM1Project(projectId)) {
      throw new NarrationPlanV2Error('LEGACY_PROJECT', 'Legacy M1 项目无工作流阶段，无法构建 Narration Plan V2');
    }
    const {stage, versionRow} = requireLockedScriptV2(projectId);
    const inputMode = inputModeOf(versionRow.prompt_version);

    // 幂等：同 source versionId + compilerVersion 直接复用
    for (const row of listPlanV2Artifacts(projectId)) {
      const plan = parsePlanV2(row);
      if (
        plan &&
        plan.compilerVersion === NARRATION_V2_COMPILER_VERSION &&
        plan.source.scriptV2VersionId === versionRow.id
      ) {
        return {plan, artifact: row, reused: true};
      }
    }

    let plan: NarrationPlanV2;
    try {
      plan = compileNarrationPlanV2({
        scriptV2Markdown: versionRow.content,
        scriptV2VersionId: versionRow.id,
        scriptV2Version: stage.locked_version,
        scriptV2PromptVersion: versionRow.prompt_version,
        inputMode,
      });
    } catch (err) {
      if (err instanceof NarrationV2CompileError) {
        throw new NarrationPlanV2Error(err.code, err.message);
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
      NARRATION_PLAN_V2_ARTIFACT_KIND,
      projectId,
      NARRATION_PLAN_V2_ARTIFACT_KIND,
      JSON.stringify(plan),
      new Date().toISOString(),
    );
    const artifact = db
      .prepare('SELECT * FROM artifacts WHERE id = ?')
      .get(id) as NarrationPlanV2ArtifactRow | undefined;
    if (!artifact) {
      throw new Error(`buildNarrationPlanV2: inserted artifact ${id} not found`);
    }
    return {plan, artifact, reused: false};
  });
  return tx.immediate();
}

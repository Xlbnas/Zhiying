import crypto from 'node:crypto';
import {getDb} from '../db';
import {getProjectInput} from '../project-inputs';
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

export interface ApprovedNarrationScriptSource {
  artifact: NarrationPlanArtifactRow;
  approval: NarrationPlanArtifactRow;
  revision: number;
  scriptText: string;
  plaintextSha256: string;
  markdownSha256: string;
}

/** Resolve an immutable narration_script only through its append-only approval record. */
export function getCurrentApprovedNarrationScript(
  projectId: string,
): ApprovedNarrationScriptSource | null {
  const db = getDb();
  const approvals = db.prepare(
    `SELECT * FROM artifacts
     WHERE project_id = ? AND kind = 'narration_script_approval'
     ORDER BY version DESC`,
  ).all(projectId) as NarrationPlanArtifactRow[];
  const current = approvals.filter((row) => {
    try {
      const value = JSON.parse(row.content_json) as Record<string, unknown>;
      return value.status === 'LOCKED' && value.userApproved === true &&
        value.ttsEligible === true && value.currentAuthority === true;
    } catch {
      return false;
    }
  });
  if (current.length !== 1) return null;

  const approval = current[0]!;
  const lock = JSON.parse(approval.content_json) as Record<string, unknown>;
  if (typeof lock.artifactId !== 'string' || !Number.isInteger(lock.revision) ||
      typeof lock.plaintextSha256 !== 'string' || typeof lock.markdownSha256 !== 'string') {
    return null;
  }
  const artifact = getArtifactById(lock.artifactId);
  if (!artifact || artifact.project_id !== projectId || artifact.kind !== 'narration_script' ||
      artifact.version !== lock.revision) return null;

  let script: Record<string, unknown>;
  try {
    script = JSON.parse(artifact.content_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (script.projectId !== projectId || script.revision !== lock.revision ||
      typeof script.scriptText !== 'string' || script.scriptTextSha256 !== lock.plaintextSha256 ||
      script.markdownSha256 !== lock.markdownSha256) return null;
  const actualSha = crypto.createHash('sha256').update(script.scriptText).digest('hex');
  if (actualSha !== lock.plaintextSha256) return null;
  const input = getProjectInput(projectId);
  if (!input || input.productionBaseline !== lock.productionBaseline ||
      input.workflowChannel !== lock.channel || input.experimentalOverride !== null) return null;

  return {
    artifact,
    approval,
    revision: lock.revision as number,
    scriptText: script.scriptText,
    plaintextSha256: lock.plaintextSha256,
    markdownSha256: lock.markdownSha256,
  };
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
  if (stage?.status === 'locked' && stage.locked_version !== null) {
    for (const row of listPlanArtifacts(projectId)) {
      const plan = parsePlan(row);
      if (
        plan &&
        plan.source.version === stage.locked_version &&
        plan.compilerVersion === NARRATION_COMPILER_VERSION &&
        plan.source.admission === undefined
      ) {
        return {plan, artifact: row};
      }
    }
  }
  const approved = getCurrentApprovedNarrationScript(projectId);
  if (!approved) return null;
  for (const row of listPlanArtifacts(projectId)) {
    const plan = parsePlan(row);
    if (plan && plan.compilerVersion === NARRATION_COMPILER_VERSION &&
        plan.source.admission === 'approved_external_artifact' &&
        plan.source.artifactId === approved.artifact.id &&
        plan.source.version === approved.revision &&
        plan.source.plaintextSha256 === approved.plaintextSha256 &&
        plan.source.approvalRecordId === approved.approval.id) {
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

/** Deterministically derive the standard TTS plan from an approved external V2. */
export function buildApprovedNarrationPlan(
  projectId: string,
  scriptMarkdown: string,
): {plan: NarrationPlan; artifact: NarrationPlanArtifactRow; reused: boolean} {
  const db = getDb();
  const tx = db.transaction(() => {
    const approved = getCurrentApprovedNarrationScript(projectId);
    if (!approved) {
      throw new NarrationPlanError('SCRIPT_V2_NOT_LOCKED', '没有可解析的 approved narration_script authority');
    }
    const markdownSha = crypto.createHash('sha256').update(scriptMarkdown).digest('hex');
    if (markdownSha !== approved.markdownSha256) {
      throw new NarrationPlanError('SCRIPT_V2_INVALID', 'approved narration Markdown SHA256 不匹配');
    }
    const existing = getCurrentNarrationPlan(projectId);
    if (existing) return {...existing, reused: true};

    // Approved canary reports use stable A｜… chapter labels. Adapt headings only;
    // speech text remains byte-authoritative and is rechecked below after compilation.
    const compilerMarkdown = scriptMarkdown.replace(
      /^##\s+([A-H])｜(.+)$/gm,
      (_line, label: string, title: string) =>
        `## 第 ${label.charCodeAt(0) - 'A'.charCodeAt(0) + 1} 章 ${title}`,
    );
    const compiled = compileNarrationPlan({
      scriptV2Markdown: compilerMarkdown,
      scriptV2Version: approved.revision,
      promptVersion: null,
    });
    const plan = narrationPlanSchema.parse({
      ...compiled,
      source: {
        ...compiled.source,
        artifactId: approved.artifact.id,
        plaintextSha256: approved.plaintextSha256,
        approvalRecordId: approved.approval.id,
        admission: 'approved_external_artifact',
      },
    });
    const reconstructed = plan.units
      .filter((unit) => unit.kind === 'speech')
      .map((unit) => unit.text ?? '')
      .join('')
      .replace(/\s+/g, '');
    if (reconstructed !== approved.scriptText.replace(/\s+/g, '')) {
      throw new NarrationPlanError('NARRATION_PLAN_INVALID', 'derived TTS plan 无法还原 approved plaintext');
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    ).run(id, projectId, NARRATION_PLAN_ARTIFACT_KIND, projectId,
      NARRATION_PLAN_ARTIFACT_KIND, JSON.stringify(plan), new Date().toISOString());
    const artifact = getArtifactById(id);
    if (!artifact) throw new Error(`buildApprovedNarrationPlan: inserted artifact ${id} not found`);
    return {plan, artifact, reused: false};
  });
  return tx.immediate();
}

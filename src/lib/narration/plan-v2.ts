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
import {getM7PipelineSnapshotArtifact, getSnapshotValidator} from '../m7-pipeline-snapshot';

/**
 * Narration Plan V2 artifact 层（M7.1 创建 / M7.1.1 candidate 语义冻结）。
 *
 * M7.1.1（REVIEW P0-1）：
 * - candidate artifact ≠ selected artifact ≠ active pipeline artifact。
 *   narration_plan_v2 创建后永远只是 candidate；不得因为 latest / needsReview=0 /
 *   source matches 被任何 getter 隐式升级为 current/selected/active。
 * - 唯一 active 载体是 projects.m7_pipeline_snapshot_id 指向的 immutable
 *   m7_pipeline_snapshot；deprecated getCurrentNarrationPlanV2 只从该
 *   snapshot 精确读取，m6/无 snapshot 恒返回 null，绝不扫描 latest。
 * - candidate 状态机：eligible_candidate | needs_review | stale | invalid。
 *
 * M7.2 输入契约（提前冻结，未实现）：
 *   buildNarrativeBeats({projectId, narrationPlanV2ArtifactId})
 *   —— 显式 artifact ID 输入并写入 provenance；禁止 current/latest 解析。
 *
 * artifact 纪律（不变）：append-only，绝不覆盖 v1 artifact；source 只读
 * script_v2 locked_version；构建 candidate 不改变 pipelineVersion、
 * 不触发 TTS/字幕/beats/render。
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

function listPlanV2ArtifactRows(projectId: string): NarrationPlanV2ArtifactRow[] {
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

function getLockedScriptV2(projectId: string): LockedScriptV2 | null {
  const stage = getStage(projectId, 'script_v2');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    return null;
  }
  const versionRow = getVersion(projectId, 'script_v2', stage.locked_version) as
    | {id: string; version: number; content: string; prompt_version: string | null}
    | undefined;
  if (!versionRow) return null;
  return {stage: {locked_version: stage.locked_version}, versionRow};
}

function requireLockedScriptV2(projectId: string): LockedScriptV2 {
  const locked = getLockedScriptV2(projectId);
  if (!locked) {
    const stage = getStage(projectId, 'script_v2');
    throw new NarrationPlanV2Error(
      'SCRIPT_V2_NOT_LOCKED',
      `script_v2 未锁定（当前 ${stage?.status ?? 'missing'}）`,
    );
  }
  if (!locked.versionRow) {
    throw new NarrationPlanV2Error(
      'SCRIPT_V2_VERSION_NOT_FOUND',
      `script_v2 locked_version=${locked.stage.locked_version} 对应版本行不存在`,
    );
  }
  return locked;
}

// ── M7.1.1：candidate 生命周期（唯一对外语义） ──

/** candidate 状态：与 project activation 严格分离（activation 见 pipeline-version.ts）。 */
export type NarrationPlanV2CandidateStatus =
  | 'eligible_candidate'
  | 'needs_review'
  | 'stale'
  | 'invalid';

export interface NarrationPlanV2Candidate {
  artifact: NarrationPlanV2ArtifactRow;
  /** invalid 时为 null（契约校验不过，绝不返回为 eligible）。 */
  plan: NarrationPlanV2 | null;
  status: NarrationPlanV2CandidateStatus;
  statusReason: string | null;
}

/** 单个 artifact 的 candidate 分类（deterministic，纯读）。 */
export function classifyNarrationPlanV2Candidate(
  projectId: string,
  row: NarrationPlanV2ArtifactRow,
): NarrationPlanV2Candidate {
  const plan = parsePlanV2(row);
  if (!plan) {
    return {artifact: row, plan: null, status: 'invalid', statusReason: '内容无法通过 narration-plan@2.0 契约校验'};
  }
  const locked = getLockedScriptV2(projectId);
  if (
    !locked ||
    plan.source.scriptV2VersionId !== locked.versionRow.id ||
    plan.source.scriptV2Version !== locked.stage.locked_version
  ) {
    return {
      artifact: row,
      plan,
      status: 'stale',
      statusReason: 'source 与当前 locked script_v2 不匹配',
    };
  }
  if (!isPlanV2Eligible(plan)) {
    return {
      artifact: row,
      plan,
      status: 'needs_review',
      statusReason: `needsReview=${plan.needsReview.length}，需人工处理`,
    };
  }
  return {artifact: row, plan, status: 'eligible_candidate', statusReason: null};
}

/**
 * 列出全部 narration_plan_v2 candidate（含 invalid/stale，完整可见性）。
 * 返回顺序：version 降序。任何一项都只是 candidate。
 */
export function listNarrationPlanV2Candidates(projectId: string): NarrationPlanV2Candidate[] {
  return listPlanV2ArtifactRows(projectId).map((row) => classifyNarrationPlanV2Candidate(projectId, row));
}

/**
 * 【仅供 UI/人工选择建议】返回最新 eligible candidate。
 * 名称即契约：返回值仍然是 candidate——不表示 current/selected/approved/active，
 * 调用方不得据此自动驱动下游；下游构建必须显式接收 artifact ID。
 */
export function getLatestEligibleNarrationPlanV2Candidate(
  projectId: string,
): NarrationPlanV2Candidate | null {
  for (const candidate of listNarrationPlanV2Candidates(projectId)) {
    if (candidate.status === 'eligible_candidate') return candidate;
  }
  return null;
}

/**
 * 按精确 artifact ID 读取 narration plan v2（唯一受信任的读取方式）。
 * 跨项目 / kind 不匹配 / 契约非法 → null（fail-closed，不猜）。
 */
export function getNarrationPlanV2Artifact(
  projectId: string,
  artifactId: string,
): {plan: NarrationPlanV2; artifact: NarrationPlanV2ArtifactRow} | null {
  const row = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?`)
    .get(artifactId, projectId, NARRATION_PLAN_V2_ARTIFACT_KIND) as
    | NarrationPlanV2ArtifactRow
    | undefined;
  if (!row) return null;
  const plan = parsePlanV2(row);
  if (!plan) return null;
  return {plan, artifact: row};
}

/**
 * @deprecated M7.1.1 起 candidate ≠ active。仅当项目 pipeline_version='m7'
 * 且 m7_pipeline_snapshot_id 指向合法 snapshot 时，返回该 snapshot 精确引用
 * 的 narration plan v2；其余情况（m6 / 无 snapshot / snapshot 非法）恒 null。
 * 绝不扫描 latest eligible artifact。新代码必须改用 getNarrationPlanV2Artifact
 * 显式传入 artifact ID。
 *
 * M7.2 补强（fail-closed）：读取前必须执行 snapshot 自身声明的 frozen
 * ruleset validator——schema 可解析但链损坏 / 未知 ruleset / 任何
 * consistency violation 一律返回 null，不 fallback candidate/latest。
 */
export function getCurrentNarrationPlanV2(projectId: string): {
  plan: NarrationPlanV2;
  artifact: NarrationPlanV2ArtifactRow;
} | null {
  const project = getDb()
    .prepare('SELECT pipeline_version, m7_pipeline_snapshot_id FROM projects WHERE id = ?')
    .get(projectId) as {pipeline_version: string; m7_pipeline_snapshot_id: string | null} | undefined;
  if (!project || project.pipeline_version !== 'm7' || project.m7_pipeline_snapshot_id === null) {
    return null;
  }
  const snapshotRef = getM7PipelineSnapshotArtifact(projectId, project.m7_pipeline_snapshot_id);
  if (!snapshotRef) return null;
  // 冻结 ruleset 完整验证：任何 violation（引用丢失/损坏/跨项目/approval
  // 不一致/gate 非 pass/final source 不一致/未知 ruleset）→ null。
  const validator = getSnapshotValidator(snapshotRef.snapshot.rulesetVersion);
  if (!validator) return null;
  if (validator(projectId, snapshotRef.snapshot).length > 0) return null;
  return getNarrationPlanV2Artifact(projectId, snapshotRef.snapshot.artifacts.narrationPlanV2ArtifactId);
}

// ── readiness（candidate 视角；activation 状态另见 pipeline-version.ts） ──

export type NarrationPlanV2ReadinessStatus =
  | 'eligible_candidate'
  | 'needs_review'
  | 'stale'
  | 'invalid'
  | 'missing'
  | 'script_not_locked';

export interface NarrationPlanV2Readiness {
  /** 最新 candidate 的状态（不是 current/active 语义）。 */
  status: NarrationPlanV2ReadinessStatus;
  scriptV2Status: string | null;
  scriptV2LockedVersion: number | null;
  candidateCount: number;
  latestCandidate: NarrationPlanV2Candidate | null;
}

/** Narration v2 candidate readiness（纯读；不暗示任何 active 语义）。 */
export function checkNarrationPlanV2Readiness(projectId: string): NarrationPlanV2Readiness {
  const stage = getStage(projectId, 'script_v2');
  const locked = stage?.status === 'locked' && stage.locked_version !== null;
  const candidates = listNarrationPlanV2Candidates(projectId);
  const latest = candidates[0] ?? null;
  let status: NarrationPlanV2ReadinessStatus;
  if (!locked) {
    status = 'script_not_locked';
  } else if (!latest) {
    status = 'missing';
  } else {
    status = latest.status;
  }
  return {
    status,
    scriptV2Status: stage?.status ?? null,
    scriptV2LockedVersion: stage?.locked_version ?? null,
    candidateCount: candidates.length,
    latestCandidate: latest,
  };
}

/**
 * 构建 / 复用 narration plan v2 candidate（单 BEGIN IMMEDIATE 原子，append-only）。
 * 产物永远只是 candidate：不 current、不 lock、不改变 pipelineVersion、
 * 不触发 TTS/字幕/beats/render。
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

    // 幂等：同 source versionId + compilerVersion 直接复用已有 candidate
    for (const row of listPlanV2ArtifactRows(projectId)) {
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

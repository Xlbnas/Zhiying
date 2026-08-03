/**
 * TTS-B Narration Performance Plan artifact 层（设计文档 §5/§7/§8）。
 *
 * 冻结语义：
 * - candidate artifact ≠ selected ≠ active：narration_performance_plan 永远只是
 *   candidate（current_candidate / stale_source / invalid_source）。
 * - build 必须显式接收 narrationPlanArtifactId + projectVoiceAssignmentArtifactId
 *   （exact source，禁止 current/latest 解析）。
 * - 幂等：同 requestId + 同 source 组合 → 同一 artifact（generation_runs
 *   UNIQUE(project_id, stage, request_id) + dispatch envelope 双持久状态 fail-closed）。
 * - commit-time source fence：final BEGIN IMMEDIATE 事务内、INSERT 前重新读取
 *   exact Narration Plan 并重新运行 classifyNarrationPlanV2Candidate（同步纯 DB 读，
 *   BEGIN IMMEDIATE 写锁关闭 outer-check 后的 drift 窗口；TTS-B.R3 P0）＋ Assignment
 *   行 hash fence；事务外重调用 TTS-A exact voice validator（异步文件 I/O，仅作
 *   early rejection）。漂移 → SOURCE_STALE / VOICE_SOURCE_INVALID，零 partial artifact。
 * - Web 不调用 LLM：POST 只 precheck + enqueue（202）；Worker claim 后执行。
 */

import crypto from 'node:crypto';
import {getDb, type Db} from '../db';
import {getProvider} from '../llm';
import {LLMError, type LLMProvider} from '../llm/types';
import {
  canonicalizeRequestId,
  claimGenerationRun,
  completeGenerationRunFailure,
  completeGenerationRunSuccess,
  RequestIdConflictError,
  type ClaimResult,
} from '../llm-generation/runs';
import {getNarrationPlanV2Artifact, classifyNarrationPlanV2Candidate} from '../narration/plan-v2';
import {validateVoiceProfileRevisionExact} from '../voice-library/revisions';
import {
  classifyProjectVoiceAssignment,
  getProjectVoiceAssignment,
  listProjectVoiceAssignmentRows,
  sha256Text,
  type AssignmentArtifactRow,
} from './assignment';
import {
  NARRATION_PERFORMANCE_PLAN_COMPILER_VERSION,
  NARRATION_PERFORMANCE_PLAN_KIND,
  NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION,
  PERFORMANCE_USAGE_STAGE,
} from './constants';
import {
  narrationPerformancePlanArtifactV1Schema,
  type NarrationPerformancePlanArtifactV1,
} from './performance-schema';
import {
  hasBlockingPerformanceIssues,
  validatePerformanceItems,
} from './performance-validate';
import {
  generateNarrationPerformancePlan,
  type PerformanceGenerationResult,
} from './performance-generate';

export type PerformanceErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'REQUEST_ID_REQUIRED'
  | 'REQUEST_ID_INVALID'
  | 'REQUEST_ID_CONFLICT'
  | 'NARRATION_PLAN_NOT_FOUND'
  | 'NARRATION_PLAN_NOT_ELIGIBLE'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'ASSIGNMENT_NOT_ELIGIBLE'
  | 'SOURCE_STALE'
  | 'VOICE_SOURCE_INVALID'
  | 'PERFORMANCE_INVALID';

export class PerformanceError extends Error {
  constructor(public readonly code: PerformanceErrorCode, message: string) {
    super(message);
    this.name = 'PerformanceError';
  }
}

export interface PerformanceArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

// ── provider 解析（worker/library 测试路径可注入；production 无后门） ──

let testProviderOverride: LLMProvider | null = null;

export function setPerformanceProviderForTest(provider: LLMProvider | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setPerformanceProviderForTest 禁止在 NODE_ENV=production 下使用');
  }
  testProviderOverride = provider;
}

/**
 * 测试注入 hook（TTS-B.R3 P0）：位于所有事务外异步校验完成之后、
 * final BEGIN IMMEDIATE 之前同步执行。用于复现真实竞态——
 * 「outer candidate check 已通过 → 此处 lock 新 Script V2 → 事务内
 * 重新 classify 必须拒绝」。production 下不可用；默认 null。
 */
let beforeCommitTransactionForTest: (() => void) | null = null;

export function setPerformanceBeforeCommitTransactionForTest(
  hook: (() => void) | null,
): void {
  if (process.env.NODE_ENV === 'production' && hook !== null) {
    throw new Error(
      'setPerformanceBeforeCommitTransactionForTest 禁止在 NODE_ENV=production 下使用',
    );
  }
  beforeCommitTransactionForTest = hook;
}

function resolveProvider(input?: LLMProvider): LLMProvider {
  return input ?? testProviderOverride ?? getProvider();
}

/** 双源复合键：确定性命名的 (narrationPlan, assignment) 对，写入 generation_runs/dispatch 的 source_artifact_id。 */
export function composePerformanceSourceKey(
  narrationPlanArtifactId: string,
  projectVoiceAssignmentArtifactId: string,
): string {
  return `${narrationPlanArtifactId}|${projectVoiceAssignmentArtifactId}`;
}

export function parsePerformanceSourceKey(
  key: string,
): {narrationPlanArtifactId: string; projectVoiceAssignmentArtifactId: string} {
  const [narrationPlanArtifactId, projectVoiceAssignmentArtifactId, ...rest] = key.split('|');
  if (!narrationPlanArtifactId || !projectVoiceAssignmentArtifactId || rest.length > 0) {
    throw new Error(`malformed performance source key: ${key}`);
  }
  return {narrationPlanArtifactId, projectVoiceAssignmentArtifactId};
}

// ── 行读取 / parse / get / list ──

export function listNarrationPerformancePlanRows(projectId: string): PerformanceArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, NARRATION_PERFORMANCE_PLAN_KIND) as PerformanceArtifactRow[];
}

export function parseNarrationPerformancePlan(
  row: PerformanceArtifactRow,
): NarrationPerformancePlanArtifactV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = narrationPerformancePlanArtifactV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function getNarrationPerformancePlan(
  projectId: string,
  artifactId: string,
): {performance: NarrationPerformancePlanArtifactV1; artifact: PerformanceArtifactRow} | null {
  const row = getDb()
    .prepare('SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?')
    .get(artifactId, projectId, NARRATION_PERFORMANCE_PLAN_KIND) as PerformanceArtifactRow | undefined;
  if (!row) return null;
  const performance = parseNarrationPerformancePlan(row);
  if (!performance) return null;
  return {performance, artifact: row};
}

// ── 分类（deterministic 纯读） ──

export type PerformanceCandidateStatus = 'current_candidate' | 'stale_source' | 'invalid_source';

export interface PerformanceCandidate {
  artifact: PerformanceArtifactRow;
  performance: NarrationPerformancePlanArtifactV1 | null;
  status: PerformanceCandidateStatus;
  statusReason: string | null;
}

export async function classifyNarrationPerformancePlan(
  projectId: string,
  row: PerformanceArtifactRow,
): Promise<PerformanceCandidate> {
  const performance = parseNarrationPerformancePlan(row);
  if (!performance) {
    return {
      artifact: row,
      performance: null,
      status: 'invalid_source',
      statusReason: '内容无法通过 narration-performance-plan@1.0 契约校验',
    };
  }
  if (
    performance.compilerVersion !== NARRATION_PERFORMANCE_PLAN_COMPILER_VERSION ||
    performance.promptVersion !== NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION
  ) {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: `compiler/prompt 版本不符（${performance.compilerVersion}/${performance.promptVersion}）`,
    };
  }

  // Narration Plan source 漂移 → stale
  const planRef = getNarrationPlanV2Artifact(projectId, performance.source.narrationPlanArtifactId);
  if (!planRef) {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: `narration plan artifact ${performance.source.narrationPlanArtifactId} 不可读`,
    };
  }
  if (sha256Text(planRef.artifact.content_json) !== performance.source.narrationPlanContentHash) {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: 'narration plan 内容 hash 漂移（source 变化，需重新生成 performance plan）',
    };
  }

  // Performance source 与 exact Narration Plan 逐项一致（TTS-B.R1：PERFORMANCE_SOURCE_MISMATCH）
  const planSrcMismatch = [
    performance.source.narrationPlanArtifactId === planRef.artifact.id ? null : 'narrationPlanArtifactId',
    performance.source.narrationPlanContentHash === sha256Text(planRef.artifact.content_json) ? null : 'narrationPlanContentHash',
    performance.source.narrationPlanSchemaVersion === planRef.plan.schemaVersion ? null : 'narrationPlanSchemaVersion',
    performance.source.narrationPlanCompilerVersion === planRef.plan.compilerVersion ? null : 'narrationPlanCompilerVersion',
    performance.source.scriptV2VersionId === planRef.plan.source.scriptV2VersionId ? null : 'scriptV2VersionId',
    performance.source.scriptV2Version === planRef.plan.source.scriptV2Version ? null : 'scriptV2Version',
    performance.source.scriptV2ContentHash === planRef.plan.source.scriptV2ContentHash ? null : 'scriptV2ContentHash',
  ].filter((x): x is string => x !== null);
  if (planSrcMismatch.length > 0) {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `PERFORMANCE_SOURCE_MISMATCH: ${planSrcMismatch.join(', ')}（与 exact Narration Plan 不一致，不得静默覆盖）`,
    };
  }

  // Narration candidate 状态传播（TTS-B.R1：必须经 classifyNarrationPlanV2Candidate——
  // locked Script V2 漂移不改 artifact content_json 也会使 candidate stale）
  const narrationCandidate = classifyNarrationPlanV2Candidate(projectId, planRef.artifact);
  if (narrationCandidate.status === 'needs_review') {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: 'NARRATION_PLAN_NOT_ELIGIBLE_NEEDS_REVIEW：narration plan 存在 needsReview，不可用于 performance',
    };
  }
  if (narrationCandidate.status === 'stale') {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: `NARRATION_PLAN_STALE：narration plan candidate 已 stale（${narrationCandidate.statusReason ?? ''}）`,
    };
  }
  if (narrationCandidate.status === 'invalid') {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `NARRATION_PLAN_INVALID：narration plan candidate 已 invalid（${narrationCandidate.statusReason ?? ''}）`,
    };
  }

  // Assignment source 漂移 → stale；assignment invalid（voice unusable）→ invalid
  const assignRef = getProjectVoiceAssignment(
    projectId,
    performance.source.projectVoiceAssignmentArtifactId,
  );
  if (!assignRef) {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: `voice assignment artifact ${performance.source.projectVoiceAssignmentArtifactId} 不可读`,
    };
  }
  if (
    sha256Text(assignRef.artifact.content_json) !==
    performance.source.projectVoiceAssignmentContentHash
  ) {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: 'voice assignment 内容 hash 漂移（source 变化，需重新生成 performance plan）',
    };
  }

  // Performance source 与 exact Assignment 逐项一致（PERFORMANCE_SOURCE_MISMATCH）
  const assignSrc = assignRef.assignment.source;
  const assignSrcMismatch = [
    performance.source.projectVoiceAssignmentArtifactId === assignRef.artifact.id ? null : 'projectVoiceAssignmentArtifactId',
    performance.source.projectVoiceAssignmentContentHash === sha256Text(assignRef.artifact.content_json) ? null : 'projectVoiceAssignmentContentHash',
    performance.source.voiceProfileId === assignSrc.voiceProfileId ? null : 'voiceProfileId',
    performance.source.voiceProfileRevisionId === assignSrc.voiceProfileRevisionId ? null : 'voiceProfileRevisionId',
    performance.source.provider === assignSrc.provider ? null : 'provider',
    performance.source.canonicalAudioSha256 === assignSrc.canonicalAudioSha256 ? null : 'canonicalAudioSha256',
    performance.source.adapterCompatibilityKey === assignSrc.adapterCompatibilityKey ? null : 'adapterCompatibilityKey',
  ].filter((x): x is string => x !== null);
  if (assignSrcMismatch.length > 0) {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `PERFORMANCE_SOURCE_MISMATCH: ${assignSrcMismatch.join(', ')}（与 exact Assignment 不一致）`,
    };
  }

  const assignCandidate = await classifyProjectVoiceAssignment(projectId, assignRef.artifact);
  if (assignCandidate.status === 'invalid_source') {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `voice assignment invalid：${assignCandidate.statusReason ?? ''}`,
    };
  }
  if (assignCandidate.status !== 'current_candidate') {
    return {
      artifact: row,
      performance,
      status: 'stale_source',
      statusReason: `voice assignment 非 current_candidate（${assignCandidate.status}）`,
    };
  }

  // exact voice 再次确认（fail-closed）+ descriptor 与 performance source 逐项一致
  const descriptor = await validateVoiceProfileRevisionExact(
    assignRef.assignment.source.voiceProfileId,
    assignRef.assignment.source.voiceProfileRevisionId,
  );
  if (!descriptor || !descriptor.usable) {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `exact voice revision 不可用（${descriptor?.unusableReason ?? '不可读'}）`,
    };
  }
  const voiceSrcMismatch = [
    descriptor.row.voice_profile_id === performance.source.voiceProfileId ? null : 'voiceProfileId',
    descriptor.row.id === performance.source.voiceProfileRevisionId ? null : 'voiceProfileRevisionId',
    descriptor.row.provider === performance.source.provider ? null : 'provider',
    descriptor.row.canonical_audio_sha256 === performance.source.canonicalAudioSha256 ? null : 'canonicalAudioSha256',
    descriptor.row.adapter_compatibility_key === performance.source.adapterCompatibilityKey ? null : 'adapterCompatibilityKey',
  ].filter((x): x is string => x !== null);
  if (voiceSrcMismatch.length > 0) {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `PERFORMANCE_SOURCE_MISMATCH: ${voiceSrcMismatch.join(', ')}（与 exact voice descriptor 不一致）`,
    };
  }

  // 语义终验（exact SpeechUnit coverage/顺序/forbidden）
  const issues = validatePerformanceItems(planRef.plan, performance.items);
  if (hasBlockingPerformanceIssues(issues)) {
    return {
      artifact: row,
      performance,
      status: 'invalid_source',
      statusReason: `语义终验不通过：${issues[0]!.code}（${issues[0]!.message}）`,
    };
  }
  return {artifact: row, performance, status: 'current_candidate', statusReason: null};
}

export async function listNarrationPerformancePlanCandidates(
  projectId: string,
): Promise<PerformanceCandidate[]> {
  const rows = listNarrationPerformancePlanRows(projectId);
  const out: PerformanceCandidate[] = [];
  for (const row of rows) {
    out.push(await classifyNarrationPerformancePlan(projectId, row));
  }
  return out;
}

// ── precheck（Web route enqueue 前与 worker build 共用；fail-closed） ──

export async function precheckPerformancePlanSource(input: {
  projectId: string;
  narrationPlanArtifactId: string;
  projectVoiceAssignmentArtifactId: string;
  requestId: string;
}): Promise<{
  requestId: string;
  planRef: NonNullable<ReturnType<typeof getNarrationPlanV2Artifact>>;
  assignmentRef: NonNullable<ReturnType<typeof getProjectVoiceAssignment>>;
}> {
  const db: Db = getDb();
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new PerformanceError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = canonicalizeRequestId(input.requestId);
  if (!requestId) {
    throw new PerformanceError(
      'REQUEST_ID_INVALID',
      'requestId 非法：trim 后须为 8–128 字符，仅允许 [A-Za-z0-9._:-]（拒绝空白/换行/控制字符/超长）',
    );
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new PerformanceError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }

  const planRef = getNarrationPlanV2Artifact(input.projectId, input.narrationPlanArtifactId);
  if (!planRef) {
    throw new PerformanceError(
      'NARRATION_PLAN_NOT_FOUND',
      `narration plan artifact ${input.narrationPlanArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const planStatus = classifyNarrationPlanV2Candidate(input.projectId, planRef.artifact);
  if (planStatus.status !== 'eligible_candidate') {
    throw new PerformanceError(
      'NARRATION_PLAN_NOT_ELIGIBLE',
      `narration plan 状态=${planStatus.status}（${planStatus.statusReason ?? ''}）——只有 eligible candidate 才能构建 performance plan`,
    );
  }

  const assignmentRef = getProjectVoiceAssignment(
    input.projectId,
    input.projectVoiceAssignmentArtifactId,
  );
  if (!assignmentRef) {
    throw new PerformanceError(
      'ASSIGNMENT_NOT_FOUND',
      `voice assignment artifact ${input.projectVoiceAssignmentArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const assignStatus = await classifyProjectVoiceAssignment(
    input.projectId,
    assignmentRef.artifact,
  );
  if (assignStatus.status !== 'current_candidate') {
    throw new PerformanceError(
      'ASSIGNMENT_NOT_ELIGIBLE',
      `voice assignment 状态=${assignStatus.status}（${assignStatus.statusReason ?? ''}）——只有 current_candidate 才能构建 performance plan`,
    );
  }
  return {requestId, planRef, assignmentRef};
}

// ── build（worker / library 路径；durable single-flight + commit-time fence） ──

export type BuildPerformancePlanResult =
  | {
      kind: 'succeeded';
      artifact: PerformanceArtifactRow;
      performance: NarrationPerformancePlanArtifactV1;
      reused: boolean;
      runId: string | null;
      generation: PerformanceGenerationResult | null;
    }
  | {kind: 'in_progress'; runId: string; retryAfterMs: number}
  | {
      kind: 'terminal';
      runId: string;
      status: 'failed' | 'indeterminate';
      errorCode: string;
      errorMessage: string;
    };

export async function buildNarrationPerformancePlan(input: {
  projectId: string;
  narrationPlanArtifactId: string;
  projectVoiceAssignmentArtifactId: string;
  requestId: string;
  provider?: LLMProvider;
  signal?: AbortSignal;
}): Promise<BuildPerformancePlanResult> {
  const db: Db = getDb();
  const {requestId, planRef, assignmentRef} = await precheckPerformancePlanSource(input);

  let claim: ClaimResult;
  try {
    claim = claimGenerationRun(db, {
      projectId: input.projectId,
      stage: PERFORMANCE_USAGE_STAGE,
      requestId,
      sourceArtifactId: composePerformanceSourceKey(
        input.narrationPlanArtifactId,
        input.projectVoiceAssignmentArtifactId,
      ),
    });
  } catch (err) {
    if (err instanceof RequestIdConflictError) {
      throw new PerformanceError('REQUEST_ID_CONFLICT', err.message);
    }
    throw err;
  }

  if (claim.kind === 'in_progress') {
    return {kind: 'in_progress', runId: claim.run.id, retryAfterMs: claim.retryAfterMs};
  }
  if (claim.kind === 'terminal') {
    return {
      kind: 'terminal',
      runId: claim.run.id,
      status: claim.run.status as 'failed' | 'indeterminate',
      errorCode: claim.run.error_code ?? 'UNKNOWN',
      errorMessage: claim.run.error_message ?? '',
    };
  }
  if (claim.kind === 'succeeded') {
    const artifactId = claim.run.result_artifact_id;
    const ref = artifactId ? getNarrationPerformancePlan(input.projectId, artifactId) : null;
    if (!ref) {
      return {
        kind: 'terminal',
        runId: claim.run.id,
        status: 'failed',
        errorCode: 'RESULT_ARTIFACT_MISSING',
        errorMessage: `run ${claim.run.id} 已 succeeded 但 result artifact ${artifactId ?? '(null)'} 不可读`,
      };
    }
    // TTS-B.R1：reused 前必须 classify——stale/invalid 不得返回 succeeded（fail-closed）
    const candidate = await classifyNarrationPerformancePlan(input.projectId, ref.artifact);
    if (candidate.status !== 'current_candidate') {
      const errorCode =
        candidate.status === 'invalid_source' ? 'RESULT_ARTIFACT_INVALID' : 'RESULT_ARTIFACT_STALE';
      return {
        kind: 'terminal',
        runId: claim.run.id,
        status: 'failed',
        errorCode,
        errorMessage: `run ${claim.run.id} 的 result artifact 已 ${candidate.status}（${candidate.statusReason ?? ''}）——不新建 artifact、不重新调用 LLM；请用新 requestId + 新 exact source`,
      };
    }
    return {
      kind: 'succeeded',
      artifact: ref.artifact,
      performance: ref.performance,
      reused: true,
      runId: claim.run.id,
      generation: null,
    };
  }

  const run = claim.run;
  const ownerToken = run.owner_token;
  if (!ownerToken) {
    throw new Error(`buildNarrationPerformancePlan: claimed run ${run.id} 缺少 owner_token（内部错误）`);
  }
  try {
    const provider = resolveProvider(input.provider);
    const generation: PerformanceGenerationResult = await generateNarrationPerformancePlan({
      db,
      provider,
      plan: planRef.plan,
      voice: {
        voiceProfileId: assignmentRef.assignment.source.voiceProfileId,
        voiceProfileRevisionId: assignmentRef.assignment.source.voiceProfileRevisionId,
        durationMs: null,
        canonicalAudioSha256: assignmentRef.assignment.source.canonicalAudioSha256,
      },
      projectId: input.projectId,
      requestId,
      runId: run.id,
      ownerToken,
      signal: input.signal,
    });

    const content: NarrationPerformancePlanArtifactV1 = {
      schemaVersion: 'narration-performance-plan@1.0',
      compilerVersion: NARRATION_PERFORMANCE_PLAN_COMPILER_VERSION,
      promptVersion: NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION,
      source: {
        narrationPlanArtifactId: planRef.artifact.id,
        narrationPlanContentHash: sha256Text(planRef.artifact.content_json),
        narrationPlanSchemaVersion: 'narration-plan@2.0',
        narrationPlanCompilerVersion: '2.0',
        scriptV2VersionId: planRef.plan.source.scriptV2VersionId,
        scriptV2Version: planRef.plan.source.scriptV2Version,
        scriptV2ContentHash: planRef.plan.source.scriptV2ContentHash,
        projectVoiceAssignmentArtifactId: assignmentRef.artifact.id,
        projectVoiceAssignmentContentHash: sha256Text(assignmentRef.artifact.content_json),
        voiceProfileId: assignmentRef.assignment.source.voiceProfileId,
        voiceProfileRevisionId: assignmentRef.assignment.source.voiceProfileRevisionId,
        provider: assignmentRef.assignment.source.provider,
        canonicalAudioSha256: assignmentRef.assignment.source.canonicalAudioSha256,
        adapterCompatibilityKey: assignmentRef.assignment.source.adapterCompatibilityKey,
      },
      generation: {
        requestId,
        provider: generation.provider,
        model: generation.model,
        attemptCount: generation.attemptCount,
      },
      items: generation.items,
    };

    // 防御性终验：artifact 契约 + 语义（LLM 路径已过，此处兜底）
    if (!narrationPerformancePlanArtifactV1Schema.safeParse(content).success) {
      throw new PerformanceError('PERFORMANCE_INVALID', '生成的 performance plan artifact 未通过契约终验（内部错误）');
    }
    const finalIssues = validatePerformanceItems(planRef.plan, content.items);
    if (hasBlockingPerformanceIssues(finalIssues)) {
      throw new PerformanceError(
        'PERFORMANCE_INVALID',
        `生成的 performance plan 未通过语义终验：${finalIssues[0]!.code}`,
      );
    }

    // ── 事务前检查 = early rejection / optimization（TTS-B.R3）─────────────
    // 注意：下面的 Narration candidate 快速检查、Assignment classifier、
    // exact voice SHA/file validator 都只是快速失败路径，不是最终权威
    // authoritative fence。最终权威判断在 final BEGIN IMMEDIATE 事务内：
    // 重新读取 exact Narration Plan + 重新运行 classifyNarrationPlanV2Candidate
    // （同步纯 DB 读），配合 BEGIN IMMEDIATE 写锁关闭「outer check 通过 →
    // lock 新 Script V2 → 提交 stale artifact」的竞态窗口。
    const commitPlanRef = getNarrationPlanV2Artifact(input.projectId, content.source.narrationPlanArtifactId);
    if (!commitPlanRef) {
      throw new PerformanceError('SOURCE_STALE', 'commit 前 narration plan artifact 不可读——放弃提交（零 artifact）');
    }
    if (sha256Text(commitPlanRef.artifact.content_json) !== content.source.narrationPlanContentHash) {
      throw new PerformanceError('SOURCE_STALE', 'commit 前 narration plan 内容 hash 漂移——放弃提交（零 artifact）');
    }
    const commitNarrationCandidate = classifyNarrationPlanV2Candidate(input.projectId, commitPlanRef.artifact);
    if (commitNarrationCandidate.status !== 'eligible_candidate') {
      throw new PerformanceError(
        'SOURCE_STALE',
        `commit 前 narration plan candidate 状态=${commitNarrationCandidate.status}（${commitNarrationCandidate.statusReason ?? ''}）——locked Script V2 漂移，放弃提交（零 artifact，run 转 failed）`,
      );
    }

    // 单 BEGIN IMMEDIATE：commit-time source fence —— 事务前重新调用 TTS-A exact
    // voice validator（异步 sha256）并重新确认 Assignment current_candidate，事务内
    // 重读 source 行核对 hash；任一漂移 → SOURCE_STALE / VOICE_SOURCE_INVALID，
    // 零 partial artifact。
    const commitAssignCandidate = await classifyProjectVoiceAssignment(
      input.projectId,
      assignmentRef.artifact,
    );
    if (commitAssignCandidate.status !== 'current_candidate') {
      throw new PerformanceError(
        'VOICE_SOURCE_INVALID',
        `commit 前 voice assignment 状态=${commitAssignCandidate.status}（${commitAssignCandidate.statusReason ?? ''}）——放弃提交`,
      );
    }
    const commitVoiceDescriptor = await validateVoiceProfileRevisionExact(
      assignmentRef.assignment.source.voiceProfileId,
      assignmentRef.assignment.source.voiceProfileRevisionId,
    );
    if (!commitVoiceDescriptor || !commitVoiceDescriptor.usable) {
      throw new PerformanceError(
        'VOICE_SOURCE_INVALID',
        `commit 前 exact voice revision 不可用（${commitVoiceDescriptor?.unusableReason ?? '不可读'}）——放弃提交`,
      );
    }

    const tx = db.transaction((): PerformanceArtifactRow => {
      // ── final authoritative fence（TTS-B.R3 P0）─────────────────────────
      // 事务内、INSERT 前同步重新读取 exact Narration Plan 并重新运行
      // classifyNarrationPlanV2Candidate。该函数是确定性纯 DB 读（narration
      // plan 行 + project_stages.script_v2.locked_version + exact Script V2
      // version），无网络/LLM/文件 SHA/异步 I/O，可在 BEGIN IMMEDIATE 内执行。
      // lockStage 同样使用 BEGIN IMMEDIATE：本事务取得写锁后，其他连接不能
      // 在 candidate check 与 INSERT 之间提交新的 locked version——locked
      // Script V2 漂移（不改 plan content_json）在此被权威拒绝，而不是依赖
      // 事务外 precheck（precheck 只是 early rejection / optimization）。
      const commitPlanRef = getNarrationPlanV2Artifact(
        input.projectId,
        content.source.narrationPlanArtifactId,
      );
      if (!commitPlanRef) {
        throw new PerformanceError(
          'SOURCE_STALE',
          '事务内 narration plan artifact 不可读——放弃提交（零 artifact）',
        );
      }
      if (sha256Text(commitPlanRef.artifact.content_json) !== content.source.narrationPlanContentHash) {
        throw new PerformanceError(
          'SOURCE_STALE',
          '事务内 narration plan 内容 hash 漂移——放弃提交（零 artifact）',
        );
      }
      const commitNarrationCandidate = classifyNarrationPlanV2Candidate(
        input.projectId,
        commitPlanRef.artifact,
      );
      if (commitNarrationCandidate.status !== 'eligible_candidate') {
        throw new PerformanceError(
          'SOURCE_STALE',
          `事务内 narration plan candidate 状态=${commitNarrationCandidate.status}（${commitNarrationCandidate.statusReason ?? ''}）——locked Script V2 漂移，放弃提交（零 artifact，run 转 failed）`,
        );
      }

      // 其余同步 source fence：Assignment exact 行 hash（事务内重读）。
      const fenceArtifact = (kind: string, artifactId: string, expectedHash: string): boolean => {
        const row = db
          .prepare('SELECT content_json FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?')
          .get(artifactId, input.projectId, kind) as {content_json: string} | undefined;
        return Boolean(row) && sha256Text(row!.content_json) === expectedHash;
      };
      if (
        !fenceArtifact(
          'project_voice_assignment',
          content.source.projectVoiceAssignmentArtifactId,
          content.source.projectVoiceAssignmentContentHash,
        )
      ) {
        throw new PerformanceError(
          'SOURCE_STALE',
          '事务内 assignment 行 hash 漂移——source 在 generation 期间发生变化，放弃提交（零 artifact）',
        );
      }

      // INSERT + completeGenerationRunSuccess 同事务原子；complete 以
      // owner_token + status='running' 守卫：run 已被并发转移/终态 → 抛错 →
      // 整个事务回滚（零 partial artifact）。
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
           ?, NULL, ?)`,
      ).run(
        id,
        input.projectId,
        NARRATION_PERFORMANCE_PLAN_KIND,
        input.projectId,
        NARRATION_PERFORMANCE_PLAN_KIND,
        JSON.stringify(content),
        new Date().toISOString(),
      );
      completeGenerationRunSuccess(db, {runId: run.id, ownerToken, resultArtifactId: id});
      const artifact = db
        .prepare('SELECT * FROM artifacts WHERE id = ?')
        .get(id) as PerformanceArtifactRow | undefined;
      if (!artifact) {
        throw new Error(`buildNarrationPerformancePlan: inserted artifact ${id} not found`);
      }
      return artifact;
    });
    // 测试注入 hook：位于所有事务外异步校验完成之后、BEGIN IMMEDIATE 之前
    //（TTS-B.R3 P0；production 下 setPerformanceBeforeCommitTransactionForTest 抛错）。
    beforeCommitTransactionForTest?.();
    const artifact = tx.immediate();
    return {
      kind: 'succeeded',
      artifact,
      performance: content,
      reused: false,
      runId: run.id,
      generation,
    };
  } catch (err) {
    const errorCode =
      err instanceof LLMError
        ? err.code
        : err instanceof PerformanceError
          ? err.code
          : 'INTERNAL_ERROR';
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      completeGenerationRunFailure(db, {runId: run.id, ownerToken, errorCode, errorMessage});
    } catch {
      // run 已被并发转移（理论上不可达：claim 独占）——不掩盖原始错误。
    }
    return {kind: 'terminal', runId: run.id, status: 'failed', errorCode, errorMessage};
  }
}

export type {AssignmentArtifactRow};
export {listProjectVoiceAssignmentRows};

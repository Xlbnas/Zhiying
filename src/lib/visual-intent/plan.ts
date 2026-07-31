/**
 * Visual Intent Plan artifact 层（M7.3A）：candidate 生命周期 + build。
 *
 * 冻结语义：
 * - candidate artifact ≠ selected ≠ active：任何 visual_intent_plan artifact
 *   永远只是 candidate（eligible_candidate / needs_review / stale / invalid）。
 *   不 current、不 lock、不改变 pipelineVersion、不触发下游。
 * - build 必须显式接收 narrativeBeatsArtifactId（exact source），
 *   禁止 current/latest 解析（M7.1.1 冻结契约的落实）。
 * - 幂等：同 requestId + 同 projectId + 同 source artifact → 同一 artifact，
 *   网络重试不重复收费、不重复写行；新 requestId = 显式 regenerate，
 *   产生新 candidate version（append-only，旧 candidate 保留）。
 */

import crypto from 'node:crypto';
import {getDb, type Db} from '../db';
import {getProvider} from '../llm';
import {LLMError, type LLMProvider} from '../llm/types';
import {
  classifyNarrativeBeatsCandidate,
  getNarrativeBeatsArtifact,
} from '../narrative-beats/plan';
import {getNarrationPlanV2Artifact} from '../narration/plan-v2';
import {generateVisualIntentPlan, VISUAL_INTENT_USAGE_STAGE, type VisualIntentGenerationResult} from './generate';
import {
  canonicalizeRequestId,
  claimGenerationRun,
  completeGenerationRunFailure,
  completeGenerationRunSuccess,
  findGenerationRun,
  RequestIdConflictError,
  type ClaimResult,
} from '../llm-generation/runs';
import {
  VISUAL_INTENT_COMPILER_VERSION,
  VISUAL_INTENT_KIND,
  VISUAL_INTENT_PROMPT_VERSION,
  visualIntentPlanArtifactV1Schema,
  type VisualIntentPlanArtifactV1,
} from './schema';
import {validateVisualIntentPlan} from './validate';

export class VisualIntentError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'REQUEST_ID_REQUIRED'
      | 'REQUEST_ID_INVALID'
      | 'REQUEST_ID_CONFLICT'
      | 'BEATS_NOT_FOUND'
      | 'BEATS_NOT_ELIGIBLE'
      | 'VISUAL_INTENT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'VisualIntentError';
  }
}

// ── provider 解析（worker executor/library 测试路径可注入；production 无后门） ──

let testProviderOverride: LLMProvider | null = null;

/**
 * 测试专用 provider override：仅当 NODE_ENV !== 'production' 时可用，
 * 否则抛错——不在 production 环境留下任何隐蔽后门。
 */
export function setVisualIntentProviderForTest(provider: LLMProvider | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setVisualIntentProviderForTest 禁止在 NODE_ENV=production 下使用');
  }
  testProviderOverride = provider;
}

function resolveProvider(input?: LLMProvider): LLMProvider {
  return input ?? testProviderOverride ?? getProvider();
}

export interface VisualIntentArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

function listVisualIntentRows(projectId: string): VisualIntentArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, VISUAL_INTENT_KIND) as VisualIntentArtifactRow[];
}

function parseVisualIntent(row: VisualIntentArtifactRow): VisualIntentPlanArtifactV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = visualIntentPlanArtifactV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ── candidate 生命周期 ──

export type VisualIntentCandidateStatus =
  | 'eligible_candidate'
  | 'needs_review'
  | 'stale'
  | 'invalid';

export interface VisualIntentCandidate {
  artifact: VisualIntentArtifactRow;
  /** invalid 时为 null。 */
  visualIntent: VisualIntentPlanArtifactV1 | null;
  status: VisualIntentCandidateStatus;
  statusReason: string | null;
}

/**
 * candidate 分类（deterministic，纯读）：
 * - invalid：契约非法，或 intents 对其精确 source beats 的覆盖/矩阵校验失败（结构损坏）；
 * - stale：source beats artifact 不存在 / 内容 hash 漂移 / 不再是
 *   eligible_candidate，或 compiler/prompt version 与当前构建要求不匹配；
 * - needs_review：合法但含 ≥1 个 VISUAL_UNRESOLVED；
 * - eligible_candidate：合法且 VISUAL_UNRESOLVED=0。
 */
export function classifyVisualIntentCandidate(
  projectId: string,
  row: VisualIntentArtifactRow,
): VisualIntentCandidate {
  const visualIntent = parseVisualIntent(row);
  if (!visualIntent) {
    return {artifact: row, visualIntent: null, status: 'invalid', statusReason: '内容无法通过 visual-intent-plan@1.0 契约校验'};
  }
  const sourceRef = getNarrativeBeatsArtifact(projectId, visualIntent.source.narrativeBeatsArtifactId);
  if (!sourceRef) {
    return {artifact: row, visualIntent, status: 'stale', statusReason: 'source narrative beats artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(sourceRef.artifact.content_json) !== visualIntent.source.narrativeBeatsContentHash) {
    return {artifact: row, visualIntent, status: 'stale', statusReason: 'source narrative beats 内容 hash 漂移'};
  }
  const sourceStatus = classifyNarrativeBeatsCandidate(projectId, sourceRef.artifact);
  if (sourceStatus.status !== 'eligible_candidate') {
    return {
      artifact: row,
      visualIntent,
      status: 'stale',
      statusReason: `source narrative beats 状态=${sourceStatus.status}，不再是 eligible candidate`,
    };
  }
  if (
    visualIntent.compilerVersion !== VISUAL_INTENT_COMPILER_VERSION ||
    visualIntent.promptVersion !== VISUAL_INTENT_PROMPT_VERSION
  ) {
    return {artifact: row, visualIntent, status: 'stale', statusReason: 'compiler/prompt version 与当前构建要求不匹配'};
  }
  // displayText 核对源：经 beats provenance 精确读取 narration plan + hash 核对。
  const narrationRef = getNarrationPlanV2Artifact(projectId, visualIntent.source.narrationPlanV2ArtifactId);
  if (!narrationRef) {
    return {artifact: row, visualIntent, status: 'stale', statusReason: 'source narration plan artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(narrationRef.artifact.content_json) !== visualIntent.source.narrationPlanV2ContentHash) {
    return {artifact: row, visualIntent, status: 'stale', statusReason: 'source narration plan 内容 hash 漂移'};
  }
  const semanticIssues = validateVisualIntentPlan(sourceRef.beats.beats, narrationRef.plan, visualIntent.intents);
  if (semanticIssues.length > 0) {
    return {
      artifact: row,
      visualIntent,
      status: 'invalid',
      statusReason: `语义校验失败：${semanticIssues[0]!.code}（共 ${semanticIssues.length} 项）`,
    };
  }
  const unresolvedCount = visualIntent.intents.filter((i) => i.intent === 'VISUAL_UNRESOLVED').length;
  if (unresolvedCount > 0) {
    return {
      artifact: row,
      visualIntent,
      status: 'needs_review',
      statusReason: `VISUAL_UNRESOLVED=${unresolvedCount}，需人工处理`,
    };
  }
  return {artifact: row, visualIntent, status: 'eligible_candidate', statusReason: null};
}

/** 列出全部 visual_intent_plan candidate（version 降序；任何一项都只是 candidate）。 */
export function listVisualIntentCandidates(projectId: string): VisualIntentCandidate[] {
  return listVisualIntentRows(projectId).map((row) => classifyVisualIntentCandidate(projectId, row));
}

/** 按精确 artifact ID 读取（跨项目/kind/非法 → null，fail-closed）。 */
export function getVisualIntentArtifact(
  projectId: string,
  artifactId: string,
): {visualIntent: VisualIntentPlanArtifactV1; artifact: VisualIntentArtifactRow} | null {
  const row = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?`)
    .get(artifactId, projectId, VISUAL_INTENT_KIND) as VisualIntentArtifactRow | undefined;
  if (!row) return null;
  const visualIntent = parseVisualIntent(row);
  if (!visualIntent) return null;
  return {visualIntent, artifact: row};
}

// ── build ──

export interface VisualIntentRowWithContent {
  row: VisualIntentArtifactRow;
  content: VisualIntentPlanArtifactV1;
}

/** 幂等查找：同 requestId 的已有 candidate（任何 version）。 */
export function findVisualIntentByRequestId(
  projectId: string,
  requestId: string,
): VisualIntentRowWithContent | null {
  for (const row of listVisualIntentRows(projectId)) {
    const content = parseVisualIntent(row);
    if (content && content.generation.requestId === requestId) {
      return {row, content};
    }
  }
  return null;
}

/**
 * exact source 前置检查（fail-closed，throw VisualIntentError）：
 * requestId 契约 → 项目存在 → exact source beats artifact 存在且属于本项目 →
 * kind/schema 合法 → candidate status=eligible_candidate → 经 beats provenance
 * 精确读取 narration plan 并核对 hash。
 * Web route（enqueue 前）与 worker build 共用——发生在 run claim / dispatch
 * 入队之前，不创建 run、不调用 provider。
 */
export function precheckVisualIntentSource(input: {
  projectId: string;
  narrativeBeatsArtifactId: string;
  requestId: string;
}): {
  requestId: string;
  sourceRef: NonNullable<ReturnType<typeof getNarrativeBeatsArtifact>>;
  narrationRef: NonNullable<ReturnType<typeof getNarrationPlanV2Artifact>>;
} {
  const db: Db = getDb();
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new VisualIntentError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = canonicalizeRequestId(input.requestId);
  if (!requestId) {
    throw new VisualIntentError(
      'REQUEST_ID_INVALID',
      'requestId 非法：trim 后须为 8–128 字符，仅允许 [A-Za-z0-9._:-]（拒绝空白/换行/控制字符/超长）',
    );
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new VisualIntentError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }

  const sourceRef = getNarrativeBeatsArtifact(input.projectId, input.narrativeBeatsArtifactId);
  if (!sourceRef) {
    throw new VisualIntentError(
      'BEATS_NOT_FOUND',
      `narrative beats artifact ${input.narrativeBeatsArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const sourceStatus = classifyNarrativeBeatsCandidate(input.projectId, sourceRef.artifact);
  if (sourceStatus.status !== 'eligible_candidate') {
    throw new VisualIntentError(
      'BEATS_NOT_ELIGIBLE',
      `narrative beats 状态=${sourceStatus.status}（${sourceStatus.statusReason ?? ''}）——只有 eligible_candidate 才能构建 visual intent`,
    );
  }

  // 经 beats provenance 精确读取 narration plan（displayText 核对源 + 投影输入）。
  const narrationRef = getNarrationPlanV2Artifact(
    input.projectId,
    sourceRef.beats.source.narrationPlanV2ArtifactId,
  );
  if (!narrationRef) {
    throw new VisualIntentError(
      'BEATS_NOT_FOUND',
      `beats provenance 指向的 narration plan artifact ${sourceRef.beats.source.narrationPlanV2ArtifactId} 不可读`,
    );
  }
  if (sha256Text(narrationRef.artifact.content_json) !== sourceRef.beats.source.narrationPlanV2ContentHash) {
    throw new VisualIntentError(
      'BEATS_NOT_ELIGIBLE',
      'beats provenance 的 narration plan 内容 hash 漂移——source 链损坏',
    );
  }
  return {requestId, sourceRef, narrationRef};
}

/**
 * build 结果 union（沿用 M7.2.1）：
 * - succeeded：拿到 artifact（reused=true 表示零 LLM 成本的幂等复用；
 *   legacy=true 表示无 generation run/journal 的 candidate，
 *   按 artifact 内 requestId 复用，绝不伪造 journal）。
 * - in_progress：同 requestId 的 run 正在运行（租约有效）——绝不二次调用 provider。
 * - terminal：failed / indeterminate 终态——同 requestId 永远返回同一终态，
 *   显式 regenerate 必须使用新 requestId。
 * precheck 失败（项目/source/requestId 非法或冲突）仍 throw VisualIntentError
 * ——发生在 run claim 之前，不创建 run、不调用 provider。
 */
export type BuildVisualIntentResult =
  | {
      kind: 'succeeded';
      artifact: VisualIntentArtifactRow;
      visualIntent: VisualIntentPlanArtifactV1;
      reused: boolean;
      legacy: boolean;
      runId: string | null;
      generation: VisualIntentGenerationResult | null;
    }
  | {kind: 'in_progress'; runId: string; retryAfterMs: number}
  | {
      kind: 'terminal';
      runId: string;
      status: 'failed' | 'indeterminate';
      errorCode: string;
      errorMessage: string;
    };

/**
 * 构建 / 复用 visual intent plan candidate。
 * 前置检查（全部 fail-closed）：项目存在 → exact source beats artifact 存在且
 * 属于本项目 → kind/schema 合法 → candidate status=eligible_candidate
 * （内含其 source narration eligible + 覆盖校验）→ 经 beats provenance
 * 精确读取 narration plan 并核对 hash。
 * 不写 current/lock，不改 pipelineVersion，不触发 Sequence/Shot/渲染下游。
 *
 * durable single-flight（沿用 M7.2.1，stage='m7_visual_intent'）：
 * 1. legacy 复用：artifact 内容中的 requestId 命中 → 直接复用，不建 run、
 *    零 provider 调用；
 * 2. 否则 BEGIN IMMEDIATE 原子 claim (project, stage, requestId) 唯一行：
 *    succeeded → 复用；running+租约有效 → in_progress；failed/indeterminate
 *    → 同一终态；不存在 → 当前调用方取得 claim；
 * 3. provider 调用发生在任何写事务之外；成功 → 单事务写 artifact +
 *    run succeeded；失败 → run failed 终态，同 requestId 不再调用 provider。
 */
export async function buildVisualIntentPlan(input: {
  projectId: string;
  narrativeBeatsArtifactId: string;
  requestId: string;
  /** 测试注入；默认经 resolveProvider（test override → 生产单例）。 */
  provider?: LLMProvider;
  signal?: AbortSignal;
}): Promise<BuildVisualIntentResult> {
  const db: Db = getDb();
  const {requestId, sourceRef, narrationRef} = precheckVisualIntentSource(input);

  // legacy/幂等复用：artifact 内容 requestId 命中 → 零 LLM 成本、零新行。
  const existing = findVisualIntentByRequestId(input.projectId, requestId);
  if (existing) {
    if (existing.content.source.narrativeBeatsArtifactId !== input.narrativeBeatsArtifactId) {
      throw new VisualIntentError(
        'REQUEST_ID_CONFLICT',
        `requestId ${requestId} 已用于 source ${existing.content.source.narrativeBeatsArtifactId}，不得复用于其他 source`,
      );
    }
    const run = findGenerationRun(db, input.projectId, VISUAL_INTENT_USAGE_STAGE, requestId);
    return {
      kind: 'succeeded',
      artifact: existing.row,
      visualIntent: existing.content,
      reused: true,
      legacy: !run,
      runId: run?.id ?? null,
      generation: null,
    };
  }

  // durable claim：provider 调用之前的唯一并发闸门。
  let claim: ClaimResult;
  try {
    claim = claimGenerationRun(db, {
      projectId: input.projectId,
      stage: VISUAL_INTENT_USAGE_STAGE,
      requestId,
      sourceArtifactId: input.narrativeBeatsArtifactId,
    });
  } catch (err) {
    if (err instanceof RequestIdConflictError) {
      throw new VisualIntentError('REQUEST_ID_CONFLICT', err.message);
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
    // run 已成功但 legacy 内容扫描未命中（异常状态）→ fail-closed，不重新生成。
    const artifactId = claim.run.result_artifact_id;
    const ref = artifactId ? getVisualIntentArtifact(input.projectId, artifactId) : null;
    if (!ref) {
      return {
        kind: 'terminal',
        runId: claim.run.id,
        status: 'failed',
        errorCode: 'RESULT_ARTIFACT_MISSING',
        errorMessage: `run ${claim.run.id} 已 succeeded 但 result artifact ${artifactId ?? '(null)'} 不可读`,
      };
    }
    return {
      kind: 'succeeded',
      artifact: ref.artifact,
      visualIntent: ref.visualIntent,
      reused: true,
      legacy: false,
      runId: claim.run.id,
      generation: null,
    };
  }

  // claimed：当前调用方独占本次 run。LLM 调用在任何写事务之外。
  const run = claim.run;
  const ownerToken = run.owner_token;
  if (!ownerToken) {
    throw new Error(`buildVisualIntentPlan: claimed run ${run.id} 缺少 owner_token（内部错误）`);
  }
  try {
    const provider = resolveProvider(input.provider);
    const generation: VisualIntentGenerationResult = await generateVisualIntentPlan({
      db,
      provider,
      beats: sourceRef.beats,
      plan: narrationRef.plan,
      projectId: input.projectId,
      requestId,
      runId: run.id,
      ownerToken,
      signal: input.signal,
    });

    const content: VisualIntentPlanArtifactV1 = {
      schemaVersion: 'visual-intent-plan@1.0',
      compilerVersion: VISUAL_INTENT_COMPILER_VERSION,
      promptVersion: VISUAL_INTENT_PROMPT_VERSION,
      source: {
        narrativeBeatsArtifactId: sourceRef.artifact.id,
        narrativeBeatsContentHash: sha256Text(sourceRef.artifact.content_json),
        narrativeBeatsSchemaVersion: 'narrative-beats@1.0',
        narrativeBeatsCompilerVersion: '1.0',
        narrationPlanV2ArtifactId: narrationRef.artifact.id,
        narrationPlanV2ContentHash: sha256Text(narrationRef.artifact.content_json),
        scriptV2VersionId: narrationRef.plan.source.scriptV2VersionId,
        scriptV2ContentHash: narrationRef.plan.source.scriptV2ContentHash,
      },
      generation: {
        requestId,
        provider: generation.provider,
        model: generation.model,
        attemptCount: generation.attemptCount,
      },
      intents: generation.intents,
    };

    // 防御性终验：artifact 契约 + 语义（LLM 路径已过，此处兜底）
    if (!visualIntentPlanArtifactV1Schema.safeParse(content).success) {
      throw new VisualIntentError('VISUAL_INTENT_INVALID', '生成的 visual intent artifact 未通过契约终验（内部错误）');
    }
    const finalIssues = validateVisualIntentPlan(sourceRef.beats.beats, narrationRef.plan, content.intents);
    if (finalIssues.length > 0) {
      throw new VisualIntentError(
        'VISUAL_INTENT_INVALID',
        `生成的 visual intent 未通过语义终验：${finalIssues[0]!.code}`,
      );
    }

    // 单 BEGIN IMMEDIATE：append-only 插入 artifact + run 原子转 succeeded。
    const tx = db.transaction((): VisualIntentArtifactRow => {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
           ?, NULL, ?)`,
      ).run(
        id,
        input.projectId,
        VISUAL_INTENT_KIND,
        input.projectId,
        VISUAL_INTENT_KIND,
        JSON.stringify(content),
        new Date().toISOString(),
      );
      completeGenerationRunSuccess(db, {runId: run.id, ownerToken, resultArtifactId: id});
      const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
        | VisualIntentArtifactRow
        | undefined;
      if (!artifact) {
        throw new Error(`buildVisualIntentPlan: inserted artifact ${id} not found`);
      }
      return artifact;
    });
    const artifact = tx.immediate();
    return {
      kind: 'succeeded',
      artifact,
      visualIntent: content,
      reused: false,
      legacy: false,
      runId: run.id,
      generation,
    };
  } catch (err) {
    // provider 请求开始后的任何失败 → run 终态 failed（同 requestId 不再调用 provider）。
    const errorCode =
      err instanceof LLMError
        ? err.code
        : err instanceof VisualIntentError
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

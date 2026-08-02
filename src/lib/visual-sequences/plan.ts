/**
 * Visual Sequences artifact 层（M7.3B）：candidate 生命周期 + build。
 *
 * 冻结语义：
 * - candidate artifact ≠ selected ≠ active：任何 visual_sequence_plan artifact
 *   永远只是 candidate（current_candidate / needs_review / stale_source /
 *   invalid_source）。不 current、不 lock、不改变 pipelineVersion、不触发下游。
 * - build 必须显式接收 narrativeBeatsArtifactId + visualIntentPlanArtifactId
 *   （exact source，禁止 current/latest 解析），双源 transitive chain 必须一致。
 * - 幂等：同 requestId + 同 projectId + 同 source 组合 → 同一 artifact，
 *   网络重试不重复收费、不重复写行；新 requestId = 显式 regenerate。
 * - commit-time source fence：落库事务内重读全部 source 行并核对内容 hash，
 *   漂移 → run 终态 failed，零 artifact 行（不产生 partial artifact）。
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
  findGenerationRun,
  RequestIdConflictError,
  type ClaimResult,
} from '../llm-generation/runs';
import {
  classifyNarrativeBeatsCandidate,
  getNarrativeBeatsArtifact,
} from '../narrative-beats/plan';
import {getNarrationPlanV2Artifact} from '../narration/plan-v2';
import {
  classifyVisualIntentCandidate,
  getVisualIntentArtifact,
} from '../visual-intent/plan';
import {
  classifyVisualSequencesCandidate,
  getVisualSequencesArtifact,
  listVisualSequencesCandidates,
  listVisualSequencesRows,
  parseVisualSequences,
  sha256Text,
  type VisualSequencesArtifactRow,
} from './classify';
import {generateVisualSequences, SEQUENCES_USAGE_STAGE, type VisualSequencesGenerationResult} from './generate';
import {
  VISUAL_SEQUENCES_COMPILER_VERSION,
  VISUAL_SEQUENCES_KIND,
  VISUAL_SEQUENCES_PROMPT_VERSION,
  visualSequencesArtifactV1Schema,
  type VisualSequencesArtifactV1,
} from './schema';
import {validateVisualSequences} from './validate';

export class VisualSequencesError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'REQUEST_ID_REQUIRED'
      | 'REQUEST_ID_INVALID'
      | 'REQUEST_ID_CONFLICT'
      | 'BEATS_NOT_FOUND'
      | 'BEATS_NOT_ELIGIBLE'
      | 'INTENT_NOT_FOUND'
      | 'INTENT_NOT_ELIGIBLE'
      | 'SOURCE_CHAIN_MISMATCH'
      | 'SOURCE_STALE'
      | 'SEQUENCES_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'VisualSequencesError';
  }
}

// ── provider 解析（worker executor/library 测试路径可注入；production 无后门） ──

let testProviderOverride: LLMProvider | null = null;

/**
 * 测试专用 provider override：仅当 NODE_ENV !== 'production' 时可用，
 * 否则抛错——不在 production 环境留下任何隐蔽后门。
 */
export function setVisualSequencesProviderForTest(provider: LLMProvider | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setVisualSequencesProviderForTest 禁止在 NODE_ENV=production 下使用');
  }
  testProviderOverride = provider;
}

function resolveProvider(input?: LLMProvider): LLMProvider {
  return input ?? testProviderOverride ?? getProvider();
}

/** 双源复合键：确定性命名的 (beats, intent) 对，写入 generation_runs/dispatch 的 source_artifact_id。 */
export function composeSequencesSourceKey(
  narrativeBeatsArtifactId: string,
  visualIntentPlanArtifactId: string,
): string {
  return `${narrativeBeatsArtifactId}|${visualIntentPlanArtifactId}`;
}

export function parseSequencesSourceKey(key: string): {narrativeBeatsArtifactId: string; visualIntentPlanArtifactId: string} {
  const [narrativeBeatsArtifactId, visualIntentPlanArtifactId, ...rest] = key.split('|');
  if (!narrativeBeatsArtifactId || !visualIntentPlanArtifactId || rest.length > 0) {
    throw new Error(`malformed sequences source key: ${key}`);
  }
  return {narrativeBeatsArtifactId, visualIntentPlanArtifactId};
}

// ── candidate 生命周期（classify/get/list 在 classify.ts） ──

export {
  classifyVisualSequencesCandidate,
  getVisualSequencesArtifact,
  listVisualSequencesCandidates,
  listVisualSequencesRows,
  parseVisualSequences,
  type VisualSequencesArtifactRow,
};

/** 幂等查找：同 requestId 的已有 candidate（任何 version）。 */
export function findVisualSequencesByRequestId(
  projectId: string,
  requestId: string,
): {row: VisualSequencesArtifactRow; content: VisualSequencesArtifactV1} | null {
  for (const row of listVisualSequencesRows(projectId)) {
    const content = parseVisualSequences(row);
    if (content && content.generation.requestId === requestId) {
      return {row, content};
    }
  }
  return null;
}

/**
 * exact source 前置检查（fail-closed，throw VisualSequencesError）：
 * requestId 契约 → 项目存在 → exact beats artifact 存在且属于本项目 →
 * beats 状态 eligible（含其 provenance 链校验）→ exact intent artifact 存在
 * 且属于本项目 → intent 状态 eligible 或 needs_review（VISUAL_UNRESOLVED
 * 传播路径，unresolved 不得自动改写为 MG）→ 双源 transitive narration/script
 * 链完全一致 → narration 行可读且 hash 全等。
 * Web route（enqueue 前）与 worker build 共用——发生在 run claim / dispatch
 * 入队之前，不创建 run、不调用 provider。
 */
export function precheckVisualSequencesSource(input: {
  projectId: string;
  narrativeBeatsArtifactId: string;
  visualIntentPlanArtifactId: string;
  requestId: string;
}): {
  requestId: string;
  beatsRef: NonNullable<ReturnType<typeof getNarrativeBeatsArtifact>>;
  intentRef: NonNullable<ReturnType<typeof getVisualIntentArtifact>>;
  narrationRef: NonNullable<ReturnType<typeof getNarrationPlanV2Artifact>>;
} {
  const db: Db = getDb();
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new VisualSequencesError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = canonicalizeRequestId(input.requestId);
  if (!requestId) {
    throw new VisualSequencesError(
      'REQUEST_ID_INVALID',
      'requestId 非法：trim 后须为 8–128 字符，仅允许 [A-Za-z0-9._:-]（拒绝空白/换行/控制字符/超长）',
    );
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new VisualSequencesError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }

  const beatsRef = getNarrativeBeatsArtifact(input.projectId, input.narrativeBeatsArtifactId);
  if (!beatsRef) {
    throw new VisualSequencesError(
      'BEATS_NOT_FOUND',
      `narrative beats artifact ${input.narrativeBeatsArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const beatsStatus = classifyNarrativeBeatsCandidate(input.projectId, beatsRef.artifact);
  if (beatsStatus.status !== 'eligible_candidate') {
    throw new VisualSequencesError(
      'BEATS_NOT_ELIGIBLE',
      `narrative beats 状态=${beatsStatus.status}（${beatsStatus.statusReason ?? ''}）——只有 eligible candidate 才能构建 visual sequences`,
    );
  }

  const intentRef = getVisualIntentArtifact(input.projectId, input.visualIntentPlanArtifactId);
  if (!intentRef) {
    throw new VisualSequencesError(
      'INTENT_NOT_FOUND',
      `visual intent artifact ${input.visualIntentPlanArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const intentStatus = classifyVisualIntentCandidate(input.projectId, intentRef.artifact);
  if (intentStatus.status !== 'eligible_candidate' && intentStatus.status !== 'needs_review') {
    throw new VisualSequencesError(
      'INTENT_NOT_ELIGIBLE',
      `visual intent 状态=${intentStatus.status}（${intentStatus.statusReason ?? ''}）——needs_review（VISUAL_UNRESOLVED）可构建但结果需人工处理`,
    );
  }

  // 双源 transitive chain 一致（fail-closed）：narration/script 必须全等。
  const beatsChain = beatsRef.beats.source;
  const intentChain = intentRef.visualIntent.source;
  const chainOk =
    beatsChain.narrationPlanV2ArtifactId === intentChain.narrationPlanV2ArtifactId &&
    beatsChain.narrationPlanV2ContentHash === intentChain.narrationPlanV2ContentHash &&
    beatsChain.scriptV2VersionId === intentChain.scriptV2VersionId &&
    beatsChain.scriptV2ContentHash === intentChain.scriptV2ContentHash;
  if (!chainOk) {
    throw new VisualSequencesError(
      'SOURCE_CHAIN_MISMATCH',
      'beats 与 visual intent 的 transitive narration/script 链不一致——source 链损坏',
    );
  }

  const narrationRef = getNarrationPlanV2Artifact(input.projectId, beatsChain.narrationPlanV2ArtifactId);
  if (!narrationRef) {
    throw new VisualSequencesError(
      'BEATS_NOT_FOUND',
      `双 provenance 指向的 narration plan artifact ${beatsChain.narrationPlanV2ArtifactId} 不可读`,
    );
  }
  if (sha256Text(narrationRef.artifact.content_json) !== beatsChain.narrationPlanV2ContentHash) {
    throw new VisualSequencesError(
      'SOURCE_CHAIN_MISMATCH',
      '双 provenance 的 narration plan 内容 hash 漂移——source 链损坏',
    );
  }
  return {requestId, beatsRef, intentRef, narrationRef};
}

/**
 * build 结果 union（沿用 M7.2.1）：
 * - succeeded：拿到 artifact（reused=true 表示零 LLM 成本的幂等复用；
 *   legacy=true 表示无 generation run/journal 的 candidate）；
 * - in_progress：同 requestId 的 run 正在运行（租约有效）——绝不二次调用 provider；
 * - terminal：failed / indeterminate 终态——同 requestId 永远返回同一终态。
 * precheck 失败（项目/source/requestId 非法或冲突）仍 throw VisualSequencesError
 * ——发生在 run claim 之前，不创建 run、不调用 provider。
 */
export type BuildVisualSequencesResult =
  | {
      kind: 'succeeded';
      artifact: VisualSequencesArtifactRow;
      visualSequences: VisualSequencesArtifactV1;
      reused: boolean;
      legacy: boolean;
      runId: string | null;
      generation: VisualSequencesGenerationResult | null;
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
 * 构建 / 复用 visual sequences candidate。
 * durable single-flight（沿用 M7.2.1，stage='m7_visual_sequences'）：
 * 1. legacy 复用：artifact 内容中的 requestId 命中 → 直接复用；
 * 2. 否则 BEGIN IMMEDIATE 原子 claim (project, stage, requestId) 唯一行
 *    （source 复合键冲突 → REQUEST_ID_CONFLICT）；
 * 3. provider 调用在任何写事务之外；成功 → 单事务内先重读 source 行核对
 *    hash（commit-time source fence，漂移 → SOURCE_STALE 终态、零 artifact），
 *    再写 artifact + run succeeded；失败 → run failed 终态。
 */
export async function buildVisualSequences(input: {
  projectId: string;
  narrativeBeatsArtifactId: string;
  visualIntentPlanArtifactId: string;
  requestId: string;
  /** 测试注入；默认经 resolveProvider（test override → 生产单例）。 */
  provider?: LLMProvider;
  signal?: AbortSignal;
}): Promise<BuildVisualSequencesResult> {
  const db: Db = getDb();
  const {requestId, beatsRef, intentRef, narrationRef} = precheckVisualSequencesSource(input);

  // legacy/幂等复用：artifact 内容 requestId 命中 → 零 LLM 成本、零新行。
  const existing = findVisualSequencesByRequestId(input.projectId, requestId);
  if (existing) {
    const key = composeSequencesSourceKey(input.narrativeBeatsArtifactId, input.visualIntentPlanArtifactId);
    const existingKey = composeSequencesSourceKey(
      existing.content.source.narrativeBeatsArtifactId,
      existing.content.source.visualIntentPlanArtifactId,
    );
    if (existingKey !== key) {
      throw new VisualSequencesError(
        'REQUEST_ID_CONFLICT',
        `requestId ${requestId} 已用于 source ${existingKey}，不得复用于其他 source 组合`,
      );
    }
    const run = findGenerationRun(db, input.projectId, SEQUENCES_USAGE_STAGE, requestId);
    return {
      kind: 'succeeded',
      artifact: existing.row,
      visualSequences: existing.content,
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
      stage: SEQUENCES_USAGE_STAGE,
      requestId,
      sourceArtifactId: composeSequencesSourceKey(
        input.narrativeBeatsArtifactId,
        input.visualIntentPlanArtifactId,
      ),
    });
  } catch (err) {
    if (err instanceof RequestIdConflictError) {
      throw new VisualSequencesError('REQUEST_ID_CONFLICT', err.message);
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
    const ref = artifactId ? getVisualSequencesArtifact(input.projectId, artifactId) : null;
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
      visualSequences: ref.visualSequences,
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
    throw new Error(`buildVisualSequences: claimed run ${run.id} 缺少 owner_token（内部错误）`);
  }
  try {
    const provider = resolveProvider(input.provider);
    const generation: VisualSequencesGenerationResult = await generateVisualSequences({
      db,
      provider,
      beats: beatsRef.beats,
      plan: narrationRef.plan,
      intentPlan: intentRef.visualIntent,
      projectId: input.projectId,
      requestId,
      runId: run.id,
      ownerToken,
      signal: input.signal,
    });

    const content: VisualSequencesArtifactV1 = {
      schemaVersion: 'visual-sequences@1.0',
      compilerVersion: VISUAL_SEQUENCES_COMPILER_VERSION,
      promptVersion: VISUAL_SEQUENCES_PROMPT_VERSION,
      source: {
        narrativeBeatsArtifactId: beatsRef.artifact.id,
        narrativeBeatsContentHash: sha256Text(beatsRef.artifact.content_json),
        narrativeBeatsSchemaVersion: 'narrative-beats@1.0',
        narrativeBeatsCompilerVersion: '1.0',
        visualIntentPlanArtifactId: intentRef.artifact.id,
        visualIntentPlanContentHash: sha256Text(intentRef.artifact.content_json),
        visualIntentSchemaVersion: 'visual-intent-plan@1.0',
        visualIntentCompilerVersion: '1.1',
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
      sequences: generation.sequences,
    };

    // 防御性终验：artifact 契约 + 语义（LLM 路径已过，此处兜底）
    if (!visualSequencesArtifactV1Schema.safeParse(content).success) {
      throw new VisualSequencesError('SEQUENCES_INVALID', '生成的 visual sequences artifact 未通过契约终验（内部错误）');
    }
    const finalIssues = validateVisualSequences(
      beatsRef.beats.beats,
      intentRef.visualIntent.intents,
      content.sequences,
    );
    if (finalIssues.some((issue) => !['SEQUENCE_NEEDS_REVIEW'].includes(issue.code))) {
      throw new VisualSequencesError(
        'SEQUENCES_INVALID',
        `生成的 visual sequences 未通过语义终验：${finalIssues[0]!.code}`,
      );
    }

    // 单 BEGIN IMMEDIATE：commit-time source fence（重读 source 行核对 hash）+
    // append-only 插入 artifact + run 原子转 succeeded。
    const tx = db.transaction((): VisualSequencesArtifactRow => {
      const fence = (
        kind: string,
        artifactId: string,
        expectedHash: string,
      ): boolean => {
        const row = db
          .prepare('SELECT content_json FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?')
          .get(artifactId, input.projectId, kind) as {content_json: string} | undefined;
        return Boolean(row) && sha256Text(row!.content_json) === expectedHash;
      };
      const fenceOk =
        fence('narrative_beats', content.source.narrativeBeatsArtifactId, content.source.narrativeBeatsContentHash) &&
        fence('visual_intent_plan', content.source.visualIntentPlanArtifactId, content.source.visualIntentPlanContentHash) &&
        fence('narration_plan_v2', content.source.narrationPlanV2ArtifactId, content.source.narrationPlanV2ContentHash);
      if (!fenceOk) {
        throw new VisualSequencesError(
          'SOURCE_STALE',
          'commit 前 source 行 hash 漂移——source 链在 generation 期间发生变化，放弃提交（零 artifact）',
        );
      }
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
           ?, NULL, ?)`,
      ).run(
        id,
        input.projectId,
        VISUAL_SEQUENCES_KIND,
        input.projectId,
        VISUAL_SEQUENCES_KIND,
        JSON.stringify(content),
        new Date().toISOString(),
      );
      completeGenerationRunSuccess(db, {runId: run.id, ownerToken, resultArtifactId: id});
      const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
        | VisualSequencesArtifactRow
        | undefined;
      if (!artifact) {
        throw new Error(`buildVisualSequences: inserted artifact ${id} not found`);
      }
      return artifact;
    });
    const artifact = tx.immediate();
    return {
      kind: 'succeeded',
      artifact,
      visualSequences: content,
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
        : err instanceof VisualSequencesError
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

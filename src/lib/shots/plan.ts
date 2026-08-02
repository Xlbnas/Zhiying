/**
 * Shots artifact 层（M7.3B）：candidate 生命周期 + build。
 *
 * 冻结语义：
 * - candidate artifact ≠ selected ≠ active：任何 shot_plan artifact
 *   永远只是 candidate（current_candidate / needs_review / stale_source /
 *   invalid_source）。不 current、不 lock、不改变 pipelineVersion、不触发下游。
 * - build 必须显式接收 visualSequencesArtifactId（exact source），
 *   从 exact Sequence provenance 取回并验证 Beats、Visual Intent、Narration Plan；
 *   必须验证 Visual Sequence artifact 自身记录的 source 与 Shots source 完全一致。
 * - 幂等：同 requestId + 同 projectId + 同 source → 同一 artifact。
 * - commit-time source fence：落库事务内重读全部 source 行并核对内容 hash，
 *   漂移 → run 终态 failed，零 artifact 行。
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
import {getVisualSequencesArtifact, classifyVisualSequencesCandidate, sha256Text as sha256TextSequences} from '../visual-sequences/classify';
import {
  classifyShotsCandidate,
  getShotsArtifact,
  listShotsCandidates,
  listShotsRows,
  parseShots,
  sha256Text,
  type ShotsArtifactRow,
} from './classify';
import {generateShots, SHOTS_USAGE_STAGE, type ShotsGenerationResult} from './generate';
import {
  SHOTS_COMPILER_VERSION,
  SHOTS_KIND,
  SHOTS_PROMPT_VERSION,
  shotsArtifactV1Schema,
  type ShotsArtifactV1,
} from './schema';
import {validateShots} from './validate';

export class ShotsError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'REQUEST_ID_REQUIRED'
      | 'REQUEST_ID_INVALID'
      | 'REQUEST_ID_CONFLICT'
      | 'SEQUENCES_NOT_FOUND'
      | 'SEQUENCES_NOT_ELIGIBLE'
      | 'SOURCE_CHAIN_MISMATCH'
      | 'SOURCE_STALE'
      | 'SHOTS_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ShotsError';
  }
}

// ── provider 解析（worker executor/library 测试路径可注入；production 无后门） ──

let testProviderOverride: LLMProvider | null = null;

/**
 * 测试专用 provider override：仅当 NODE_ENV !== 'production' 时可用，
 * 否则抛错——不在 production 环境留下任何隐蔽后门。
 */
export function setShotsProviderForTest(provider: LLMProvider | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('setShotsProviderForTest 禁止在 NODE_ENV=production 下使用');
  }
  testProviderOverride = provider;
}

function resolveProvider(input?: LLMProvider): LLMProvider {
  return input ?? testProviderOverride ?? getProvider();
}

// ── candidate 生命周期（classify/get/list 在 classify.ts） ──

export {
  classifyShotsCandidate,
  getShotsArtifact,
  listShotsCandidates,
  listShotsRows,
  parseShots,
  type ShotsArtifactRow,
};

/** 幂等查找：同 requestId 的已有 candidate（任何 version）。 */
export function findShotsByRequestId(
  projectId: string,
  requestId: string,
): {row: ShotsArtifactRow; content: ShotsArtifactV1} | null {
  for (const row of listShotsRows(projectId)) {
    const content = parseShots(row);
    if (content && content.generation.requestId === requestId) {
      return {row, content};
    }
  }
  return null;
}

/**
 * exact source 前置检查（fail-closed，throw ShotsError）：
 * requestId 契约 → 项目存在 → exact visual sequences artifact 存在且属于
 * 本项目 → 状态 current_candidate 或 needs_review（VISUAL_UNRESOLVED 传播，
 * 可被引用但结果需人工处理）→ 经 sequences provenance 精确读取 beats /
 * visual intent / narration plan 并全链核对 hash（sequences 自身记录的 source
 * 必须完整且一致）。
 * Web route（enqueue 前）与 worker build 共用——发生在 run claim / dispatch
 * 入队之前，不创建 run、不调用 provider。
 */
export function precheckShotsSource(input: {
  projectId: string;
  visualSequencesArtifactId: string;
  requestId: string;
}): {
  requestId: string;
  seqRef: NonNullable<ReturnType<typeof getVisualSequencesArtifact>>;
  beatsRef: NonNullable<ReturnType<typeof getNarrativeBeatsArtifact>>;
  intentRef: NonNullable<ReturnType<typeof getVisualIntentArtifact>>;
  narrationRef: NonNullable<ReturnType<typeof getNarrationPlanV2Artifact>>;
} {
  const db: Db = getDb();
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new ShotsError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = canonicalizeRequestId(input.requestId);
  if (!requestId) {
    throw new ShotsError(
      'REQUEST_ID_INVALID',
      'requestId 非法：trim 后须为 8–128 字符，仅允许 [A-Za-z0-9._:-]（拒绝空白/换行/控制字符/超长）',
    );
  }
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new ShotsError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }

  const seqRef = getVisualSequencesArtifact(input.projectId, input.visualSequencesArtifactId);
  if (!seqRef) {
    throw new ShotsError(
      'SEQUENCES_NOT_FOUND',
      `visual sequences artifact ${input.visualSequencesArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const seqStatus = classifyVisualSequencesCandidate(input.projectId, seqRef.artifact);
  if (seqStatus.status !== 'current_candidate' && seqStatus.status !== 'needs_review') {
    throw new ShotsError(
      'SEQUENCES_NOT_ELIGIBLE',
      `visual sequences 状态=${seqStatus.status}（${seqStatus.statusReason ?? ''}）——只有 current_candidate（或 needs_review，结果需人工处理）才能构建 shots`,
    );
  }

  const seqSource = seqRef.visualSequences.source;
  const beatsRef = getNarrativeBeatsArtifact(input.projectId, seqSource.narrativeBeatsArtifactId);
  if (!beatsRef) {
    throw new ShotsError(
      'SEQUENCES_NOT_FOUND',
      `sequences provenance 指向的 narrative beats artifact ${seqSource.narrativeBeatsArtifactId} 不可读`,
    );
  }
  if (sha256Text(beatsRef.artifact.content_json) !== seqSource.narrativeBeatsContentHash) {
    throw new ShotsError(
      'SOURCE_CHAIN_MISMATCH',
      'sequences provenance 的 narrative beats 内容 hash 漂移——source 链损坏',
    );
  }
  const beatsStatus = classifyNarrativeBeatsCandidate(input.projectId, beatsRef.artifact);
  if (beatsStatus.status !== 'eligible_candidate') {
    throw new ShotsError(
      'SEQUENCES_NOT_ELIGIBLE',
      `sequences provenance 的 narrative beats 状态=${beatsStatus.status}`,
    );
  }

  const intentRef = getVisualIntentArtifact(input.projectId, seqSource.visualIntentPlanArtifactId);
  if (!intentRef) {
    throw new ShotsError(
      'SEQUENCES_NOT_FOUND',
      `sequences provenance 指向的 visual intent artifact ${seqSource.visualIntentPlanArtifactId} 不可读`,
    );
  }
  if (sha256Text(intentRef.artifact.content_json) !== seqSource.visualIntentPlanContentHash) {
    throw new ShotsError(
      'SOURCE_CHAIN_MISMATCH',
      'sequences provenance 的 visual intent 内容 hash 漂移——source 链损坏',
    );
  }
  const intentStatus = classifyVisualIntentCandidate(input.projectId, intentRef.artifact);
  if (intentStatus.status !== 'eligible_candidate' && intentStatus.status !== 'needs_review') {
    throw new ShotsError(
      'SEQUENCES_NOT_ELIGIBLE',
      `sequences provenance 的 visual intent 状态=${intentStatus.status}`,
    );
  }

  const narrationRef = getNarrationPlanV2Artifact(input.projectId, seqSource.narrationPlanV2ArtifactId);
  if (!narrationRef) {
    throw new ShotsError(
      'SEQUENCES_NOT_FOUND',
      `sequences provenance 指向的 narration plan artifact ${seqSource.narrationPlanV2ArtifactId} 不可读`,
    );
  }
  if (sha256Text(narrationRef.artifact.content_json) !== seqSource.narrationPlanV2ContentHash) {
    throw new ShotsError(
      'SOURCE_CHAIN_MISMATCH',
      'sequences provenance 的 narration plan 内容 hash 漂移——source 链损坏',
    );
  }
  return {requestId, seqRef, beatsRef, intentRef, narrationRef};
}

/**
 * build 结果 union（沿用 M7.2.1）：
 * - succeeded：拿到 artifact（reused=true 表示零 LLM 成本的幂等复用）；
 * - in_progress：同 requestId 的 run 正在运行（租约有效）——绝不二次调用 provider；
 * - terminal：failed / indeterminate 终态——同 requestId 永远返回同一终态。
 */
export type BuildShotsResult =
  | {
      kind: 'succeeded';
      artifact: ShotsArtifactRow;
      shots: ShotsArtifactV1;
      reused: boolean;
      legacy: boolean;
      runId: string | null;
      generation: ShotsGenerationResult | null;
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
 * 构建 / 复用 shots candidate。
 * durable single-flight（沿用 M7.2.1，stage='m7_shots'）：
 * 1. legacy 复用：artifact 内容中的 requestId 命中 → 直接复用；
 * 2. 否则 BEGIN IMMEDIATE 原子 claim (project, stage, requestId) 唯一行；
 * 3. provider 调用在任何写事务之外；成功 → 单事务内先重读 source 行核对
 *    hash（commit-time source fence），再写 artifact + run succeeded。
 */
export async function buildShots(input: {
  projectId: string;
  visualSequencesArtifactId: string;
  requestId: string;
  /** 测试注入；默认经 resolveProvider（test override → 生产单例）。 */
  provider?: LLMProvider;
  signal?: AbortSignal;
}): Promise<BuildShotsResult> {
  const db: Db = getDb();
  const {requestId, seqRef, beatsRef, intentRef, narrationRef} = precheckShotsSource(input);

  // legacy/幂等复用：artifact 内容 requestId 命中 → 零 LLM 成本、零新行。
  const existing = findShotsByRequestId(input.projectId, requestId);
  if (existing) {
    if (existing.content.source.visualSequencesArtifactId !== input.visualSequencesArtifactId) {
      throw new ShotsError(
        'REQUEST_ID_CONFLICT',
        `requestId ${requestId} 已用于 source ${existing.content.source.visualSequencesArtifactId}，不得复用于其他 source`,
      );
    }
    const run = findGenerationRun(db, input.projectId, SHOTS_USAGE_STAGE, requestId);
    return {
      kind: 'succeeded',
      artifact: existing.row,
      shots: existing.content,
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
      stage: SHOTS_USAGE_STAGE,
      requestId,
      sourceArtifactId: input.visualSequencesArtifactId,
    });
  } catch (err) {
    if (err instanceof RequestIdConflictError) {
      throw new ShotsError('REQUEST_ID_CONFLICT', err.message);
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
    const ref = artifactId ? getShotsArtifact(input.projectId, artifactId) : null;
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
      shots: ref.shots,
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
    throw new Error(`buildShots: claimed run ${run.id} 缺少 owner_token（内部错误）`);
  }
  try {
    const provider = resolveProvider(input.provider);
    const generation: ShotsGenerationResult = await generateShots({
      db,
      provider,
      sequencesArtifact: seqRef.visualSequences,
      beats: beatsRef.beats,
      intentPlan: intentRef.visualIntent,
      plan: narrationRef.plan,
      projectId: input.projectId,
      requestId,
      runId: run.id,
      ownerToken,
      signal: input.signal,
    });

    const seqSource = seqRef.visualSequences.source;
    const content: ShotsArtifactV1 = {
      schemaVersion: 'shots@1.0',
      compilerVersion: SHOTS_COMPILER_VERSION,
      promptVersion: SHOTS_PROMPT_VERSION,
      source: {
        visualSequencesArtifactId: seqRef.artifact.id,
        visualSequencesContentHash: sha256TextSequences(seqRef.artifact.content_json),
        visualSequencesSchemaVersion: 'visual-sequences@1.0',
        visualSequencesCompilerVersion: '1.0',
        narrativeBeatsArtifactId: seqSource.narrativeBeatsArtifactId,
        narrativeBeatsContentHash: seqSource.narrativeBeatsContentHash,
        visualIntentPlanArtifactId: seqSource.visualIntentPlanArtifactId,
        visualIntentPlanContentHash: seqSource.visualIntentPlanContentHash,
        narrationPlanV2ArtifactId: seqSource.narrationPlanV2ArtifactId,
        narrationPlanV2ContentHash: seqSource.narrationPlanV2ContentHash,
        scriptV2VersionId: seqSource.scriptV2VersionId,
        scriptV2ContentHash: seqSource.scriptV2ContentHash,
      },
      generation: {
        requestId,
        provider: generation.provider,
        model: generation.model,
        attemptCount: generation.attemptCount,
      },
      shots: generation.shots,
    };

    // 防御性终验：artifact 契约 + 语义（LLM 路径已过，此处兜底）
    if (!shotsArtifactV1Schema.safeParse(content).success) {
      throw new ShotsError('SHOTS_INVALID', '生成的 shots artifact 未通过契约终验（内部错误）');
    }
    const finalIssues = validateShots(
      seqRef.visualSequences,
      beatsRef.beats,
      intentRef.visualIntent.intents,
      narrationRef.plan,
      content.shots,
    );
    if (finalIssues.some((issue) => !['SHOT_NEEDS_REVIEW'].includes(issue.code))) {
      throw new ShotsError(
        'SHOTS_INVALID',
        `生成的 shots 未通过语义终验：${finalIssues[0]!.code}`,
      );
    }

    // 单 BEGIN IMMEDIATE：commit-time source fence（重读 source 行核对 hash）+
    // append-only 插入 artifact + run 原子转 succeeded。
    const tx = db.transaction((): ShotsArtifactRow => {
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
        fence('visual_sequence_plan', content.source.visualSequencesArtifactId, content.source.visualSequencesContentHash) &&
        fence('narrative_beats', content.source.narrativeBeatsArtifactId, content.source.narrativeBeatsContentHash) &&
        fence('visual_intent_plan', content.source.visualIntentPlanArtifactId, content.source.visualIntentPlanContentHash) &&
        fence('narration_plan_v2', content.source.narrationPlanV2ArtifactId, content.source.narrationPlanV2ContentHash);
      if (!fenceOk) {
        throw new ShotsError(
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
        SHOTS_KIND,
        input.projectId,
        SHOTS_KIND,
        JSON.stringify(content),
        new Date().toISOString(),
      );
      completeGenerationRunSuccess(db, {runId: run.id, ownerToken, resultArtifactId: id});
      const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
        | ShotsArtifactRow
        | undefined;
      if (!artifact) {
        throw new Error(`buildShots: inserted artifact ${id} not found`);
      }
      return artifact;
    });
    const artifact = tx.immediate();
    return {
      kind: 'succeeded',
      artifact,
      shots: content,
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
        : err instanceof ShotsError
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

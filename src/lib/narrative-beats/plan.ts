/**
 * Narrative Beats artifact 层（M7.2）：candidate 生命周期 + build。
 *
 * 冻结语义：
 * - candidate artifact ≠ selected ≠ active：任何 narrative_beats artifact
 *   永远只是 candidate（eligible_candidate / stale / invalid）。
 *   不 current、不 lock、不改变 pipelineVersion、不触发下游。
 * - build 必须显式接收 narrationPlanV2ArtifactId（exact source），
 *   禁止 current/latest 解析（M7.1.1 冻结契约的落实）。
 * - 幂等：同 requestId + 同 projectId + 同 source artifact → 同一 artifact，
 *   网络重试不重复收费、不重复写行；新 requestId = 显式 regenerate，
 *   产生新 candidate version（append-only，旧 candidate 保留）。
 */

import crypto from 'node:crypto';
import {getDb, type Db} from '../db';
import {getProvider} from '../llm';
import type {LLMProvider} from '../llm/types';
import {
  classifyNarrationPlanV2Candidate,
  getNarrationPlanV2Artifact,
} from '../narration/plan-v2';
import {generateNarrativeBeats, type BeatGenerationResult} from './generate';
import {
  NARRATIVE_BEATS_COMPILER_VERSION,
  NARRATIVE_BEATS_KIND,
  NARRATIVE_BEATS_PROMPT_VERSION,
  narrativeBeatsArtifactV1Schema,
  type NarrativeBeatsArtifactV1,
} from './schema';
import {validateNarrativeBeatsCoverage} from './validate';

export class NarrativeBeatsError extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'REQUEST_ID_REQUIRED'
      | 'REQUEST_ID_CONFLICT'
      | 'NARRATION_PLAN_NOT_FOUND'
      | 'NARRATION_PLAN_NOT_ELIGIBLE'
      | 'BEATS_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'NarrativeBeatsError';
  }
}

export interface NarrativeBeatsArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

function listBeatsRows(projectId: string): NarrativeBeatsArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, NARRATIVE_BEATS_KIND) as NarrativeBeatsArtifactRow[];
}

function parseBeats(row: NarrativeBeatsArtifactRow): NarrativeBeatsArtifactV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = narrativeBeatsArtifactV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ── candidate 生命周期 ──

export type NarrativeBeatsCandidateStatus = 'eligible_candidate' | 'stale' | 'invalid';

export interface NarrativeBeatsCandidate {
  artifact: NarrativeBeatsArtifactRow;
  /** invalid 时为 null。 */
  beats: NarrativeBeatsArtifactV1 | null;
  status: NarrativeBeatsCandidateStatus;
  statusReason: string | null;
}

/**
 * candidate 分类（deterministic，纯读）：
 * - invalid：契约非法，或 beats 对其精确 source plan 的覆盖校验失败（结构损坏）；
 * - stale：source narration 不再是 eligible_candidate / source 内容 hash 漂移 /
 *   compiler/prompt version 与当前构建要求不匹配；
 * - eligible_candidate：其余。
 */
export function classifyNarrativeBeatsCandidate(
  projectId: string,
  row: NarrativeBeatsArtifactRow,
): NarrativeBeatsCandidate {
  const beats = parseBeats(row);
  if (!beats) {
    return {artifact: row, beats: null, status: 'invalid', statusReason: '内容无法通过 narrative-beats@1.0 契约校验'};
  }
  const sourceRef = getNarrationPlanV2Artifact(projectId, beats.source.narrationPlanV2ArtifactId);
  if (!sourceRef) {
    return {artifact: row, beats, status: 'stale', statusReason: 'source narration plan artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(sourceRef.artifact.content_json) !== beats.source.narrationPlanV2ContentHash) {
    return {artifact: row, beats, status: 'stale', statusReason: 'source narration plan 内容 hash 漂移'};
  }
  const sourceStatus = classifyNarrationPlanV2Candidate(projectId, sourceRef.artifact);
  if (sourceStatus.status !== 'eligible_candidate') {
    return {
      artifact: row,
      beats,
      status: 'stale',
      statusReason: `source narration plan 状态=${sourceStatus.status}，不再是 eligible candidate`,
    };
  }
  if (
    beats.compilerVersion !== NARRATIVE_BEATS_COMPILER_VERSION ||
    beats.promptVersion !== NARRATIVE_BEATS_PROMPT_VERSION
  ) {
    return {artifact: row, beats, status: 'stale', statusReason: 'compiler/prompt version 与当前构建要求不匹配'};
  }
  const coverageIssues = validateNarrativeBeatsCoverage(sourceRef.plan, beats.beats);
  if (coverageIssues.length > 0) {
    return {
      artifact: row,
      beats,
      status: 'invalid',
      statusReason: `覆盖校验失败：${coverageIssues[0]!.code}（共 ${coverageIssues.length} 项）`,
    };
  }
  return {artifact: row, beats, status: 'eligible_candidate', statusReason: null};
}

/** 列出全部 narrative_beats candidate（version 降序；任何一项都只是 candidate）。 */
export function listNarrativeBeatsCandidates(projectId: string): NarrativeBeatsCandidate[] {
  return listBeatsRows(projectId).map((row) => classifyNarrativeBeatsCandidate(projectId, row));
}

/** 按精确 artifact ID 读取（跨项目/kind/非法 → null，fail-closed）。 */
export function getNarrativeBeatsArtifact(
  projectId: string,
  artifactId: string,
): {beats: NarrativeBeatsArtifactV1; artifact: NarrativeBeatsArtifactRow} | null {
  const row = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?`)
    .get(artifactId, projectId, NARRATIVE_BEATS_KIND) as NarrativeBeatsArtifactRow | undefined;
  if (!row) return null;
  const beats = parseBeats(row);
  if (!beats) return null;
  return {beats, artifact: row};
}

// ── build ──

interface BeatsRowWithContent {
  row: NarrativeBeatsArtifactRow;
  content: NarrativeBeatsArtifactV1;
}

/** 幂等查找：同 requestId 的已有 candidate（任何 version）。 */
function findByRequestId(projectId: string, requestId: string): BeatsRowWithContent | null {
  for (const row of listBeatsRows(projectId)) {
    const content = parseBeats(row);
    if (content && content.generation.requestId === requestId) {
      return {row, content};
    }
  }
  return null;
}

export interface BuildNarrativeBeatsResult {
  artifact: NarrativeBeatsArtifactRow;
  beats: NarrativeBeatsArtifactV1;
  /** true = 同 requestId 幂等复用（零 LLM 成本、零新行）。 */
  reused: boolean;
  generation: BeatGenerationResult | null;
}

/**
 * 构建 / 复用 narrative beats candidate。
 * 前置检查（全部 fail-closed）：项目存在 → exact source artifact 存在且属于
 * 本项目 → kind/schema 合法 → candidate status=eligible_candidate
 * （内含 source 匹配 locked script_v2 + needsReview=0）。
 * 不写 current/lock，不改 pipelineVersion，不触发 TTS/字幕/下游。
 */
export async function buildNarrativeBeats(input: {
  projectId: string;
  narrationPlanV2ArtifactId: string;
  requestId: string;
  /** 测试注入；默认生产 provider 单例。 */
  provider?: LLMProvider;
  signal?: AbortSignal;
}): Promise<BuildNarrativeBeatsResult> {
  const db: Db = getDb();
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
    throw new NarrativeBeatsError('REQUEST_ID_REQUIRED', 'requestId 必须为非空字符串（幂等键）');
  }
  const requestId = input.requestId;
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new NarrativeBeatsError('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }

  const sourceRef = getNarrationPlanV2Artifact(input.projectId, input.narrationPlanV2ArtifactId);
  if (!sourceRef) {
    throw new NarrativeBeatsError(
      'NARRATION_PLAN_NOT_FOUND',
      `narration plan v2 artifact ${input.narrationPlanV2ArtifactId} 不存在/跨项目/契约非法`,
    );
  }
  const sourceStatus = classifyNarrationPlanV2Candidate(input.projectId, sourceRef.artifact);
  if (sourceStatus.status !== 'eligible_candidate') {
    throw new NarrativeBeatsError(
      'NARRATION_PLAN_NOT_ELIGIBLE',
      `narration plan v2 状态=${sourceStatus.status}（${sourceStatus.statusReason ?? ''}）——只有 eligible_candidate 才能构建 beats`,
    );
  }

  // 幂等：同 requestId → 同 artifact（零 LLM 成本）；requestId 冲突不同 source → 拒绝
  const existing = findByRequestId(input.projectId, requestId);
  if (existing) {
    if (existing.content.source.narrationPlanV2ArtifactId !== input.narrationPlanV2ArtifactId) {
      throw new NarrativeBeatsError(
        'REQUEST_ID_CONFLICT',
        `requestId ${requestId} 已用于 source ${existing.content.source.narrationPlanV2ArtifactId}，不得复用于其他 source`,
      );
    }
    return {artifact: existing.row, beats: existing.content, reused: true, generation: null};
  }

  const provider = input.provider ?? getProvider();
  const generation: BeatGenerationResult = await generateNarrativeBeats({
    db,
    provider,
    plan: sourceRef.plan,
    projectId: input.projectId,
    requestId,
    signal: input.signal,
  });

  const content: NarrativeBeatsArtifactV1 = {
    schemaVersion: 'narrative-beats@1.0',
    compilerVersion: NARRATIVE_BEATS_COMPILER_VERSION,
    promptVersion: NARRATIVE_BEATS_PROMPT_VERSION,
    source: {
      narrationPlanV2ArtifactId: sourceRef.artifact.id,
      narrationPlanV2ContentHash: sha256Text(sourceRef.artifact.content_json),
      narrationPlanSchemaVersion: 'narration-plan@2.0',
      narrationCompilerVersion: '2.0',
      scriptV2VersionId: sourceRef.plan.source.scriptV2VersionId,
      scriptV2ContentHash: sourceRef.plan.source.scriptV2ContentHash,
    },
    generation: {
      requestId,
      provider: generation.provider,
      model: generation.model,
      attemptCount: generation.attemptCount,
    },
    beats: generation.beats,
  };

  // 防御性终验：artifact 契约 + 覆盖（LLM 路径已过，此处兜底）
  if (!narrativeBeatsArtifactV1Schema.safeParse(content).success) {
    throw new NarrativeBeatsError('BEATS_INVALID', '生成的 beats artifact 未通过契约终验（内部错误）');
  }
  const finalIssues = validateNarrativeBeatsCoverage(sourceRef.plan, content.beats);
  if (finalIssues.length > 0) {
    throw new NarrativeBeatsError(
      'BEATS_INVALID',
      `生成的 beats 未通过覆盖终验：${finalIssues[0]!.code}`,
    );
  }

  // 单 BEGIN IMMEDIATE：并发同 requestId 二次检查 + append-only 插入
  const tx = db.transaction((): BuildNarrativeBeatsResult => {
    const raced = findByRequestId(input.projectId, requestId);
    if (raced) {
      return {artifact: raced.row, beats: raced.content, reused: true, generation: null};
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
      NARRATIVE_BEATS_KIND,
      input.projectId,
      NARRATIVE_BEATS_KIND,
      JSON.stringify(content),
      new Date().toISOString(),
    );
    const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | NarrativeBeatsArtifactRow
      | undefined;
    if (!artifact) {
      throw new Error(`buildNarrativeBeats: inserted artifact ${id} not found`);
    }
    return {artifact, beats: content, reused: false, generation};
  });
  return tx.immediate();
}

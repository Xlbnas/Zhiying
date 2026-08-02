/**
 * Visual Sequences candidate 分类（M7.3B §九，deterministic 纯读）。
 *
 * 状态（相对 exact source 未漂移，不代表 project current/active/locked）：
 * - invalid_source：内容无法通过 visual-sequences@1.0 契约，或语义校验有阻断 issue；
 * - stale_source：source beats/intent/narration artifact 缺失、内容 hash 漂移、
 *   不再是 eligible candidate、双链不一致，或 compiler/prompt version 不匹配；
 * - needs_review：合法但引用 ≥1 个 VISUAL_UNRESOLVED（含 source intent 自身
 *   needs_review 的传播）；
 * - current_candidate：其余（合法、源未漂移、无 unresolved）。
 */

import crypto from 'node:crypto';
import {getDb} from '../db';
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
  VISUAL_SEQUENCES_COMPILER_VERSION,
  VISUAL_SEQUENCES_KIND,
  VISUAL_SEQUENCES_PROMPT_VERSION,
  visualSequencesArtifactV1Schema,
  type VisualSequencesArtifactV1,
} from './schema';
import {SEQUENCE_NON_BLOCKING_CODES, validateVisualSequences} from './validate';

export interface VisualSequencesArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

export function listVisualSequencesRows(projectId: string): VisualSequencesArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, VISUAL_SEQUENCES_KIND) as VisualSequencesArtifactRow[];
}

export function parseVisualSequences(row: VisualSequencesArtifactRow): VisualSequencesArtifactV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = visualSequencesArtifactV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** 按精确 artifact ID 读取（跨项目/kind/非法 → null，fail-closed）。 */
export function getVisualSequencesArtifact(
  projectId: string,
  artifactId: string,
): {visualSequences: VisualSequencesArtifactV1; artifact: VisualSequencesArtifactRow} | null {
  const row = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?`)
    .get(artifactId, projectId, VISUAL_SEQUENCES_KIND) as VisualSequencesArtifactRow | undefined;
  if (!row) return null;
  const visualSequences = parseVisualSequences(row);
  if (!visualSequences) return null;
  return {visualSequences, artifact: row};
}

export type VisualSequencesCandidateStatus =
  | 'current_candidate'
  | 'stale_source'
  | 'invalid_source'
  | 'needs_review';

export interface VisualSequencesCandidate {
  artifact: VisualSequencesArtifactRow;
  /** invalid_source 时为 null。 */
  visualSequences: VisualSequencesArtifactV1 | null;
  status: VisualSequencesCandidateStatus;
  statusReason: string | null;
}

/**
 * candidate 分类（deterministic，纯读）。
 * 判定链：parse → beats 行/hash/状态 → intent 行/hash/状态 → narration 行/hash
 * → 双链（beats↔intent↔source）一致性 → version 匹配 → 语义校验 → unresolved。
 */
export function classifyVisualSequencesCandidate(
  projectId: string,
  row: VisualSequencesArtifactRow,
): VisualSequencesCandidate {
  const visualSequences = parseVisualSequences(row);
  if (!visualSequences) {
    return {
      artifact: row,
      visualSequences: null,
      status: 'invalid_source',
      statusReason: '内容无法通过 visual-sequences@1.0 契约校验',
    };
  }
  const source = visualSequences.source;

  // beats source
  const beatsRef = getNarrativeBeatsArtifact(projectId, source.narrativeBeatsArtifactId);
  if (!beatsRef) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'source narrative beats artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(beatsRef.artifact.content_json) !== source.narrativeBeatsContentHash) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'source narrative beats 内容 hash 漂移'};
  }
  const beatsStatus = classifyNarrativeBeatsCandidate(projectId, beatsRef.artifact);
  if (beatsStatus.status !== 'eligible_candidate') {
    return {
      artifact: row,
      visualSequences,
      status: 'stale_source',
      statusReason: `source narrative beats 状态=${beatsStatus.status}，不再是 eligible candidate`,
    };
  }

  // visual intent source
  const intentRef = getVisualIntentArtifact(projectId, source.visualIntentPlanArtifactId);
  if (!intentRef) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'source visual intent artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(intentRef.artifact.content_json) !== source.visualIntentPlanContentHash) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'source visual intent 内容 hash 漂移'};
  }
  const intentStatus = classifyVisualIntentCandidate(projectId, intentRef.artifact);
  if (intentStatus.status !== 'eligible_candidate' && intentStatus.status !== 'needs_review') {
    return {
      artifact: row,
      visualSequences,
      status: 'stale_source',
      statusReason: `source visual intent 状态=${intentStatus.status}，不可作为 sequence source`,
    };
  }

  // narration plan（经双 provenance）行 + hash
  const narrationRef = getNarrationPlanV2Artifact(projectId, source.narrationPlanV2ArtifactId);
  if (!narrationRef) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'source narration plan artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(narrationRef.artifact.content_json) !== source.narrationPlanV2ContentHash) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'source narration plan 内容 hash 漂移'};
  }

  // 双链一致性：beats 与 intent 的 transitive narration/script 必须与 source 完全一致
  const beatsChain = beatsRef.beats.source;
  const intentChain = intentRef.visualIntent.source;
  const chainOk =
    beatsChain.narrationPlanV2ArtifactId === intentChain.narrationPlanV2ArtifactId &&
    beatsChain.narrationPlanV2ArtifactId === source.narrationPlanV2ArtifactId &&
    beatsChain.narrationPlanV2ContentHash === intentChain.narrationPlanV2ContentHash &&
    beatsChain.narrationPlanV2ContentHash === source.narrationPlanV2ContentHash &&
    beatsChain.scriptV2VersionId === intentChain.scriptV2VersionId &&
    beatsChain.scriptV2VersionId === source.scriptV2VersionId &&
    beatsChain.scriptV2ContentHash === intentChain.scriptV2ContentHash &&
    beatsChain.scriptV2ContentHash === source.scriptV2ContentHash;
  if (!chainOk) {
    return {
      artifact: row,
      visualSequences,
      status: 'stale_source',
      statusReason: 'SEQUENCE_SOURCE_MISMATCH：beats 与 intent 的 transitive narration/script 链与 source 不一致',
    };
  }

  // version 匹配
  if (
    visualSequences.compilerVersion !== VISUAL_SEQUENCES_COMPILER_VERSION ||
    visualSequences.promptVersion !== VISUAL_SEQUENCES_PROMPT_VERSION
  ) {
    return {artifact: row, visualSequences, status: 'stale_source', statusReason: 'compiler/prompt version 与当前构建要求不匹配'};
  }

  // 语义校验（阻断 issue → invalid_source；仅 NEEDS_REVIEW → needs_review）
  const semanticIssues = validateVisualSequences(
    beatsRef.beats.beats,
    intentRef.visualIntent.intents,
    visualSequences.sequences,
  );
  const blocking = semanticIssues.filter((issue) => !SEQUENCE_NON_BLOCKING_CODES.has(issue.code));
  if (blocking.length > 0) {
    return {
      artifact: row,
      visualSequences,
      status: 'invalid_source',
      statusReason: `语义校验失败：${blocking[0]!.code}（共 ${blocking.length} 项）`,
    };
  }
  if (semanticIssues.length > 0 || intentStatus.status === 'needs_review') {
    const unresolvedCount = semanticIssues.filter((issue) => issue.code === 'SEQUENCE_NEEDS_REVIEW').length;
    return {
      artifact: row,
      visualSequences,
      status: 'needs_review',
      statusReason: `VISUAL_UNRESOLVED 引用=${unresolvedCount}（source intent 状态=${intentStatus.status}），需人工处理`,
    };
  }
  return {artifact: row, visualSequences, status: 'current_candidate', statusReason: null};
}

/** 列出全部 visual_sequence_plan candidate（version 降序；任何一项都只是 candidate）。 */
export function listVisualSequencesCandidates(projectId: string): VisualSequencesCandidate[] {
  return listVisualSequencesRows(projectId).map((row) => classifyVisualSequencesCandidate(projectId, row));
}

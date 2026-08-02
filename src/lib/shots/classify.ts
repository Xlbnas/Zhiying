/**
 * Shots candidate 分类（M7.3B §九，deterministic 纯读）。
 *
 * 状态（相对 exact source 未漂移，不代表 project current/active/locked）：
 * - invalid_source：内容无法通过 shots@1.0 契约，或语义校验有阻断 issue；
 * - stale_source：source visual sequences artifact 缺失/hash 漂移/不再是
 *   eligible candidate，或 transitive 链（beats/intent/narration）hash 漂移、
 *   与 sequences 自身记录的 source 不一致，或 compiler/prompt version 不匹配；
 * - needs_review：合法但引用 ≥1 个 VISUAL_UNRESOLVED（含 source sequence
 *   自身 needs_review 的传播）；
 * - current_candidate：其余。
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
import {classifyVisualSequencesCandidate, getVisualSequencesArtifact} from '../visual-sequences/classify';
import {
  SHOTS_COMPILER_VERSION,
  SHOTS_KIND,
  SHOTS_PROMPT_VERSION,
  shotsArtifactV1Schema,
  type ShotsArtifactV1,
} from './schema';
import {SHOT_NON_BLOCKING_CODES, validateShots} from './validate';

export interface ShotsArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
  created_at: string;
}

export function listShotsRows(projectId: string): ShotsArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, SHOTS_KIND) as ShotsArtifactRow[];
}

export function parseShots(row: ShotsArtifactRow): ShotsArtifactV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = shotsArtifactV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function sha256Text(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** 按精确 artifact ID 读取（跨项目/kind/非法 → null，fail-closed）。 */
export function getShotsArtifact(
  projectId: string,
  artifactId: string,
): {shots: ShotsArtifactV1; artifact: ShotsArtifactRow} | null {
  const row = getDb()
    .prepare(`SELECT * FROM artifacts WHERE id = ? AND project_id = ? AND kind = ?`)
    .get(artifactId, projectId, SHOTS_KIND) as ShotsArtifactRow | undefined;
  if (!row) return null;
  const shots = parseShots(row);
  if (!shots) return null;
  return {shots, artifact: row};
}

export type ShotsCandidateStatus =
  | 'current_candidate'
  | 'stale_source'
  | 'invalid_source'
  | 'needs_review';

export interface ShotsCandidate {
  artifact: ShotsArtifactRow;
  /** invalid_source 时为 null。 */
  shots: ShotsArtifactV1 | null;
  status: ShotsCandidateStatus;
  statusReason: string | null;
}

/**
 * candidate 分类（deterministic，纯读）。
 * 判定链：parse → sequences 行/hash/状态 → 自身 source 与 sequences 自身
 * 记录的 source 完全一致（SHOT_SOURCE_MISMATCH）→ transitive beats/intent/
 * narration 行 + hash → version 匹配 → 语义校验 → unresolved。
 */
export function classifyShotsCandidate(
  projectId: string,
  row: ShotsArtifactRow,
): ShotsCandidate {
  const shots = parseShots(row);
  if (!shots) {
    return {artifact: row, shots: null, status: 'invalid_source', statusReason: '内容无法通过 shots@1.0 契约校验'};
  }
  const source = shots.source;

  // source visual sequences artifact
  const seqRef = getVisualSequencesArtifact(projectId, source.visualSequencesArtifactId);
  if (!seqRef) {
    return {artifact: row, shots, status: 'stale_source', statusReason: 'source visual sequences artifact 不存在/跨项目/契约非法'};
  }
  if (sha256Text(seqRef.artifact.content_json) !== source.visualSequencesContentHash) {
    return {artifact: row, shots, status: 'stale_source', statusReason: 'source visual sequences 内容 hash 漂移'};
  }
  const seqStatus = classifyVisualSequencesCandidate(projectId, seqRef.artifact);
  if (seqStatus.status !== 'current_candidate' && seqStatus.status !== 'needs_review') {
    return {
      artifact: row,
      shots,
      status: 'stale_source',
      statusReason: `source visual sequences 状态=${seqStatus.status}，不可作为 shots source`,
    };
  }

  // 自身 source 必须与 sequences artifact 自身记录的 source 完全一致
  const seqSource = seqRef.visualSequences.source;
  const sourceOk =
    source.narrativeBeatsArtifactId === seqSource.narrativeBeatsArtifactId &&
    source.narrativeBeatsContentHash === seqSource.narrativeBeatsContentHash &&
    source.visualIntentPlanArtifactId === seqSource.visualIntentPlanArtifactId &&
    source.visualIntentPlanContentHash === seqSource.visualIntentPlanContentHash &&
    source.narrationPlanV2ArtifactId === seqSource.narrationPlanV2ArtifactId &&
    source.narrationPlanV2ContentHash === seqSource.narrationPlanV2ContentHash &&
    source.scriptV2VersionId === seqSource.scriptV2VersionId &&
    source.scriptV2ContentHash === seqSource.scriptV2ContentHash;
  if (!sourceOk) {
    return {
      artifact: row,
      shots,
      status: 'stale_source',
      statusReason: 'SHOT_SOURCE_MISMATCH：shots source 与 visual sequences artifact 自身记录的 source 不一致',
    };
  }

  // transitive beats / intent / narration 行 + hash
  const beatsRef = getNarrativeBeatsArtifact(projectId, source.narrativeBeatsArtifactId);
  if (!beatsRef || sha256Text(beatsRef.artifact.content_json) !== source.narrativeBeatsContentHash) {
    return {artifact: row, shots, status: 'stale_source', statusReason: 'transitive narrative beats 缺失或 hash 漂移'};
  }
  const beatsStatus = classifyNarrativeBeatsCandidate(projectId, beatsRef.artifact);
  if (beatsStatus.status !== 'eligible_candidate') {
    return {artifact: row, shots, status: 'stale_source', statusReason: `transitive narrative beats 状态=${beatsStatus.status}`};
  }
  const intentRef = getVisualIntentArtifact(projectId, source.visualIntentPlanArtifactId);
  if (!intentRef || sha256Text(intentRef.artifact.content_json) !== source.visualIntentPlanContentHash) {
    return {artifact: row, shots, status: 'stale_source', statusReason: 'transitive visual intent 缺失或 hash 漂移'};
  }
  const intentStatus = classifyVisualIntentCandidate(projectId, intentRef.artifact);
  if (intentStatus.status !== 'eligible_candidate' && intentStatus.status !== 'needs_review') {
    return {artifact: row, shots, status: 'stale_source', statusReason: `transitive visual intent 状态=${intentStatus.status}`};
  }
  const narrationRef = getNarrationPlanV2Artifact(projectId, source.narrationPlanV2ArtifactId);
  if (!narrationRef || sha256Text(narrationRef.artifact.content_json) !== source.narrationPlanV2ContentHash) {
    return {artifact: row, shots, status: 'stale_source', statusReason: 'transitive narration plan 缺失或 hash 漂移'};
  }

  // version 匹配
  if (
    shots.compilerVersion !== SHOTS_COMPILER_VERSION ||
    shots.promptVersion !== SHOTS_PROMPT_VERSION
  ) {
    return {artifact: row, shots, status: 'stale_source', statusReason: 'compiler/prompt version 与当前构建要求不匹配'};
  }

  // 语义校验（阻断 issue → invalid_source；仅 NEEDS_REVIEW → needs_review）
  const semanticIssues = validateShots(
    seqRef.visualSequences,
    beatsRef.beats,
    intentRef.visualIntent.intents,
    narrationRef.plan,
    shots.shots,
  );
  const blocking = semanticIssues.filter((issue) => !SHOT_NON_BLOCKING_CODES.has(issue.code));
  if (blocking.length > 0) {
    return {
      artifact: row,
      shots,
      status: 'invalid_source',
      statusReason: `语义校验失败：${blocking[0]!.code}（共 ${blocking.length} 项）`,
    };
  }
  if (semanticIssues.length > 0 || seqStatus.status === 'needs_review' || intentStatus.status === 'needs_review') {
    const unresolvedCount = semanticIssues.filter((issue) => issue.code === 'SHOT_NEEDS_REVIEW').length;
    return {
      artifact: row,
      shots,
      status: 'needs_review',
      statusReason: `VISUAL_UNRESOLVED 引用=${unresolvedCount}（source 状态：sequences=${seqStatus.status}, intent=${intentStatus.status}），需人工处理`,
    };
  }
  return {artifact: row, shots, status: 'current_candidate', statusReason: null};
}

/** 列出全部 shot_plan candidate（version 降序；任何一项都只是 candidate）。 */
export function listShotsCandidates(projectId: string): ShotsCandidate[] {
  return listShotsRows(projectId).map((row) => classifyShotsCandidate(projectId, row));
}

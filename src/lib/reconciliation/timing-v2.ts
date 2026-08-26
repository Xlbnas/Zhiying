import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {getDb} from '../db';
import type {NarrationAudioV2Artifact} from '../narration/audio-v2';
import type {SubtitleTimingV2Artifact} from '../subtitles/timing-v2';
import type {VisualSourceV2Artifact} from '../visual-source-v2';
import {compileTimingReconciliation} from './compiler';
import {
  RECONCILIATION_COMPILER_VERSION,
  TIMING_RECONCILIATION_ARTIFACT_KIND,
  timingReconciliationSchema,
  type TimingReconciliation,
} from './schema';

type ArtifactRow = {id: string; project_id: string; kind: string; version: number; content_json: string};

export interface ReconciliationV2Sources {
  visual: VisualSourceV2Artifact;
  audio: NarrationAudioV2Artifact;
  subtitle: SubtitleTimingV2Artifact;
}

export interface TimingReconciliationV2Artifact {
  artifact: {id: string; version: number};
  reconciliation: TimingReconciliation;
}

export class TimingReconciliationV2Error extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TimingReconciliationV2Error';
  }
}

function refsOf(src: ReconciliationV2Sources) {
  const visualSource = src.visual.visual.source;
  return {
    scenesVersionId: src.visual.artifact.id,
    scenesVersion: src.visual.artifact.version,
    narrationAudioArtifactId: src.audio.artifact.id,
    narrationAudioArtifactVersion: src.audio.artifact.version,
    subtitleTimingArtifactId: src.subtitle.artifact.id,
    subtitleTimingArtifactVersion: src.subtitle.artifact.version,
    narrationPlanArtifactId: visualSource.narrationPlanV2.id,
    narrationPlanArtifactVersion: visualSource.narrationPlanV2.version,
    scriptV2Version: visualSource.scriptV2.version,
    narrationCompilerVersion: src.audio.manifest.source.narrationCompilerVersion,
    subtitleCompilerVersion: src.subtitle.timing.compilerVersion,
    masterSha256: visualSource.masterSha256,
    masterDurationMs: visualSource.masterDurationMs,
  };
}

function validateSources(src: ReconciliationV2Sources): void {
  const source = src.visual.visual.source;
  if (
    source.narrationAudioV2.id !== src.audio.artifact.id ||
    source.narrationAudioV2.version !== src.audio.artifact.version ||
    source.subtitleTimingV2.id !== src.subtitle.artifact.id ||
    source.subtitleTimingV2.version !== src.subtitle.artifact.version ||
    src.subtitle.timing.source.narrationAudioV2ArtifactId !== src.audio.artifact.id ||
    src.subtitle.timing.source.narrationAudioV2ArtifactVersion !== src.audio.artifact.version ||
    source.masterSha256 !== src.audio.manifest.master.sha256 ||
    source.masterDurationMs !== src.audio.manifest.master.durationMs
  ) {
    throw new TimingReconciliationV2Error('SOURCE_MISMATCH', 'V2 visual/audio/subtitle exact source chain 不一致');
  }
}

function compile(src: ReconciliationV2Sources): TimingReconciliation {
  validateSources(src);
  return compileTimingReconciliation({
    scenes: src.visual.visual.data,
    refs: refsOf(src),
    unresolvedNarrationUnitIds: [],
  });
}

function parse(row: ArtifactRow): TimingReconciliation | null {
  try {
    const parsed = timingReconciliationSchema.safeParse(JSON.parse(row.content_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function matches(rec: TimingReconciliation, src: ReconciliationV2Sources): boolean {
  return rec.compilerVersion === RECONCILIATION_COMPILER_VERSION && isDeepStrictEqual(rec, compile(src));
}

export function buildTimingReconciliationV2(
  projectId: string,
  src: ReconciliationV2Sources,
): TimingReconciliationV2Artifact & {reused: boolean} {
  const expected = compile(src);
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, project_id, kind, version, content_json FROM artifacts
     WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
  ).all(projectId, TIMING_RECONCILIATION_ARTIFACT_KIND) as ArtifactRow[];
  for (const row of rows) {
    const rec = parse(row);
    if (rec && isDeepStrictEqual(rec, expected)) {
      return {artifact: {id: row.id, version: row.version}, reconciliation: rec, reused: true};
    }
  }
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id=? AND kind=?), ?, NULL, ?)`,
    ).run(id, projectId, TIMING_RECONCILIATION_ARTIFACT_KIND, projectId, TIMING_RECONCILIATION_ARTIFACT_KIND, JSON.stringify(expected), new Date().toISOString());
    return db.prepare('SELECT version FROM artifacts WHERE id = ?').get(id) as {version: number};
  });
  const row = tx.immediate();
  return {artifact: {id, version: row.version}, reconciliation: expected, reused: false};
}

export function getExactTimingReconciliationV2(
  projectId: string,
  expected: {artifactId: string; version: number},
  src: ReconciliationV2Sources,
): TimingReconciliationV2Artifact | null {
  const row = getDb().prepare(
    'SELECT id, project_id, kind, version, content_json FROM artifacts WHERE id = ?',
  ).get(expected.artifactId) as ArtifactRow | undefined;
  if (!row || row.project_id !== projectId || row.kind !== TIMING_RECONCILIATION_ARTIFACT_KIND || row.version !== expected.version) return null;
  const rec = parse(row);
  return rec && matches(rec, src)
    ? {artifact: {id: row.id, version: row.version}, reconciliation: rec}
    : null;
}

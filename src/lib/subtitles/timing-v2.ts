import crypto from 'node:crypto';
import {getDb} from '../db';
import {
  getExactNarrationAudioV2Artifact,
  type NarrationAudioV2Artifact,
} from '../narration/audio-v2';
import {getNarrationPlanV2Artifact} from '../narration/plan-v2';
import {compileSubtitleTimingV2, SubtitleV2CompileError} from './compiler-v2';
import {
  SUBTITLE_TIMING_V2_ARTIFACT_KIND,
  SUBTITLE_V2_COMPILER_VERSION,
  subtitleTimingV2Schema,
  type SubtitleTimingV2,
} from './schema-v2';

type SubtitleV2ArtifactRow = {
  id: string;
  project_id: string;
  kind: string;
  version: number;
  content_json: string;
};

export interface SubtitleTimingV2Artifact {
  artifact: {id: string; version: number};
  timing: SubtitleTimingV2;
}

export class SubtitleTimingV2Error extends Error {
  constructor(
    public readonly code:
      | 'PROJECT_NOT_FOUND'
      | 'NARRATION_AUDIO_V2_INVALID'
      | 'NARRATION_PLAN_V2_INVALID'
      | 'SUBTITLE_TIMING_V2_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleTimingV2Error';
  }
}

function parseTiming(row: SubtitleV2ArtifactRow): SubtitleTimingV2 | null {
  try {
    const parsed = subtitleTimingV2Schema.safeParse(JSON.parse(row.content_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function matchesExactSources(
  timing: SubtitleTimingV2,
  audio: NarrationAudioV2Artifact,
): boolean {
  const source = timing.source;
  const manifest = audio.manifest;
  return (
    timing.compilerVersion === SUBTITLE_V2_COMPILER_VERSION &&
    source.narrationAudioV2ArtifactId === audio.artifact.id &&
    source.narrationAudioV2ArtifactVersion === audio.artifact.version &&
    source.narrationPlanV2ArtifactId === manifest.source.narrationPlanV2ArtifactId &&
    source.narrationPlanV2ArtifactVersion === manifest.source.narrationPlanV2ArtifactVersion &&
    source.scriptV2VersionId === manifest.source.scriptV2VersionId &&
    source.scriptV2Version === manifest.source.scriptV2Version &&
    source.narrationCompilerVersion === manifest.source.narrationCompilerVersion &&
    source.masterSha256 === manifest.master.sha256 &&
    source.masterDurationMs === manifest.master.durationMs
  );
}

/** Exact identity read: no current/latest audio or plan resolver. */
export function getExactSubtitleTimingV2Artifact(
  projectId: string,
  expectedSubtitle: {artifactId: string; version: number},
  exactAudio: NarrationAudioV2Artifact,
): SubtitleTimingV2Artifact | null {
  const row = getDb().prepare(
    'SELECT id, project_id, kind, version, content_json FROM artifacts WHERE id = ?',
  ).get(expectedSubtitle.artifactId) as SubtitleV2ArtifactRow | undefined;
  if (
    !row ||
    row.project_id !== projectId ||
    row.kind !== SUBTITLE_TIMING_V2_ARTIFACT_KIND ||
    row.version !== expectedSubtitle.version
  ) return null;
  const timing = parseTiming(row);
  if (!timing || !matchesExactSources(timing, exactAudio)) return null;
  return {artifact: {id: row.id, version: row.version}, timing};
}

export async function buildSubtitleTimingV2(input: {
  projectId: string;
  narrationAudioV2ArtifactId: string;
  narrationAudioV2ArtifactVersion: number;
}): Promise<SubtitleTimingV2Artifact & {reused: boolean}> {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(input.projectId) as
    | {id: string}
    | undefined;
  if (!project) {
    throw new SubtitleTimingV2Error('PROJECT_NOT_FOUND', `项目不存在: ${input.projectId}`);
  }
  const audio = await getExactNarrationAudioV2Artifact(input.projectId, {
    artifactId: input.narrationAudioV2ArtifactId,
    version: input.narrationAudioV2ArtifactVersion,
  });
  if (!audio) {
    throw new SubtitleTimingV2Error(
      'NARRATION_AUDIO_V2_INVALID',
      `exact narration audio v2 无效/跨项目/version 或 media 不匹配: ${input.narrationAudioV2ArtifactId}@${input.narrationAudioV2ArtifactVersion}`,
    );
  }
  const planRef = getNarrationPlanV2Artifact(
    input.projectId,
    audio.manifest.source.narrationPlanV2ArtifactId,
  );
  if (
    !planRef ||
    planRef.artifact.version !== audio.manifest.source.narrationPlanV2ArtifactVersion
  ) {
    throw new SubtitleTimingV2Error(
      'NARRATION_PLAN_V2_INVALID',
      'audio manifest 指向的 exact narration plan v2 不存在/跨项目/version 不匹配',
    );
  }

  const rows = db.prepare(
    `SELECT id, project_id, kind, version, content_json FROM artifacts
     WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
  ).all(input.projectId, SUBTITLE_TIMING_V2_ARTIFACT_KIND) as SubtitleV2ArtifactRow[];
  for (const row of rows) {
    const timing = parseTiming(row);
    if (timing && matchesExactSources(timing, audio)) {
      return {artifact: {id: row.id, version: row.version}, timing, reused: true};
    }
  }

  let timing: SubtitleTimingV2;
  try {
    timing = compileSubtitleTimingV2({
      plan: planRef.plan,
      manifest: audio.manifest,
      narrationAudioV2ArtifactId: audio.artifact.id,
      narrationAudioV2ArtifactVersion: audio.artifact.version,
      narrationPlanV2ArtifactId: planRef.artifact.id,
      narrationPlanV2ArtifactVersion: planRef.artifact.version,
    });
  } catch (error) {
    if (error instanceof SubtitleV2CompileError) {
      throw new SubtitleTimingV2Error('SUBTITLE_TIMING_V2_INVALID', error.message);
    }
    throw error;
  }

  const tx = db.transaction((): SubtitleTimingV2Artifact & {reused: boolean} => {
    const exactAudioRow = db.prepare(
      'SELECT project_id, kind, version FROM artifacts WHERE id = ?',
    ).get(audio.artifact.id) as {project_id: string; kind: string; version: number} | undefined;
    if (
      !exactAudioRow ||
      exactAudioRow.project_id !== input.projectId ||
      exactAudioRow.kind !== 'narration_audio_manifest_v2' ||
      exactAudioRow.version !== audio.artifact.version
    ) {
      throw new SubtitleTimingV2Error('NARRATION_AUDIO_V2_INVALID', 'exact audio 在提交前消失或 identity 改变');
    }
    const latestRows = db.prepare(
      `SELECT id, project_id, kind, version, content_json FROM artifacts
       WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
    ).all(input.projectId, SUBTITLE_TIMING_V2_ARTIFACT_KIND) as SubtitleV2ArtifactRow[];
    for (const row of latestRows) {
      const existing = parseTiming(row);
      if (existing && matchesExactSources(existing, audio)) {
        return {artifact: {id: row.id, version: row.version}, timing: existing, reused: true};
      }
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
      SUBTITLE_TIMING_V2_ARTIFACT_KIND,
      input.projectId,
      SUBTITLE_TIMING_V2_ARTIFACT_KIND,
      JSON.stringify(timing),
      new Date().toISOString(),
    );
    const inserted = db.prepare('SELECT version FROM artifacts WHERE id = ?').get(id) as {version: number};
    return {artifact: {id, version: inserted.version}, timing, reused: false};
  });
  return tx.immediate();
}

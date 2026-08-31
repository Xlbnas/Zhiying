import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {getDb} from '../db';
import {enqueueRenderJob, type RenderJobRow} from '../jobs';
import type {NarrationAudioV2Artifact} from '../narration/audio-v2';
import {applyTimingReconciliation} from '../reconciliation/adapter';
import type {TimingReconciliationV2Artifact} from '../reconciliation/timing-v2';
import {summarizeRenderProgress} from '../render/progress-detail';
import {validateFinalVisualProps} from '../render/visual-gate';
import {
  COMPOSITION_ID,
  SCHEMA_VERSION,
  zhiyingFullCutPropsSchema,
  type ZhiyingFullCutProps,
} from '../scene-schema';
import type {SubtitleTimingV2Artifact} from '../subtitles/timing-v2';
import {toRendererSubtitleCuesV2} from '../subtitles/renderer';
import type {VisualSourceV2Artifact} from '../visual-source-v2';
import {
  buildRuntimeNarrationLogicalPath,
  computePropsSha256,
  computeSourceKey,
  FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
  FINAL_RENDER_ATTEMPT_SCHEMA_VERSION,
  FINAL_RENDER_SOURCE_ARTIFACT_KIND,
  FINAL_RENDER_SOURCE_COMPILER_VERSION,
  FINAL_RENDER_SOURCE_SCHEMA_VERSION,
  finalRenderSourceSchema,
  type FinalRenderSource,
} from './schema';

type ArtifactRow = {id: string; version: number; content_json: string};

export interface FinalRenderV2Sources {
  visual: VisualSourceV2Artifact;
  audio: NarrationAudioV2Artifact;
  subtitle: SubtitleTimingV2Artifact;
  reconciliation: TimingReconciliationV2Artifact;
}

export type SubtitleMode = 'none' | 'burned';

export class FinalRenderV2Error extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FinalRenderV2Error';
  }
}

function validateSources(src: FinalRenderV2Sources): void {
  const visual = src.visual.visual.source;
  const rec = src.reconciliation.reconciliation.source;
  if (
    visual.narrationAudioV2.id !== src.audio.artifact.id ||
    visual.narrationAudioV2.version !== src.audio.artifact.version ||
    visual.subtitleTimingV2.id !== src.subtitle.artifact.id ||
    visual.subtitleTimingV2.version !== src.subtitle.artifact.version ||
    rec.scenesVersionId !== src.visual.artifact.id ||
    rec.scenesVersion !== src.visual.artifact.version ||
    rec.narrationAudioArtifactId !== src.audio.artifact.id ||
    rec.narrationAudioArtifactVersion !== src.audio.artifact.version ||
    rec.subtitleTimingArtifactId !== src.subtitle.artifact.id ||
    rec.subtitleTimingArtifactVersion !== src.subtitle.artifact.version ||
    rec.masterSha256 !== visual.masterSha256 ||
    rec.masterDurationMs !== visual.masterDurationMs
  ) {
    throw new FinalRenderV2Error('SOURCE_MISMATCH', 'V2 final render exact source chain 不一致');
  }
}

export function buildFinalRenderPropsV2(input: {
  projectId: string;
  title: string;
  templateVersion: string;
  src: FinalRenderV2Sources;
  includeNarration?: boolean;
  subtitleMode?: SubtitleMode;
}): ZhiyingFullCutProps {
  validateSources(input.src);
  const rec = input.src.reconciliation.reconciliation;
  const reconciled = applyTimingReconciliation({
    scenes: input.src.visual.visual.data.scenes,
    chapterTiming: input.src.visual.visual.data.chapterTiming,
    reconciliation: rec,
  });
  return zhiyingFullCutPropsSchema.parse({
    data: {
      schemaVersion: SCHEMA_VERSION,
      templateVersion: input.templateVersion,
      project: {
        projectId: input.projectId,
        title: input.title,
        composition: COMPOSITION_ID,
        fps: rec.fps,
        width: 1920,
        height: 1080,
        durationSec: rec.target.totalFrames / rec.fps,
        durationInFrames: rec.target.totalFrames,
        timingBasis: 'narration_audio_v2_exact_reconciliation',
        sceneCount: reconciled.scenes.length,
      },
      chapterTiming: reconciled.chapterTiming,
      scenes: reconciled.scenes,
      assetMap: input.src.visual.visual.assetMap,
    },
    audio: {
      narration: input.includeNarration === false
        ? null
        : buildRuntimeNarrationLogicalPath(input.projectId, input.src.audio.artifact.id),
      bgm: null,
      sfx: null,
    },
    subtitles: toRendererSubtitleCuesV2(input.src.subtitle.timing),
    showSubtitles: input.subtitleMode !== 'none',
    renderMode: input.includeNarration === false ? 'preview' : 'final',
  });
}

function publicAssetFileExists(publicPath: string): boolean {
  try {
    const stat = fs.statSync(path.join(process.cwd(), 'public', publicPath));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function parseSource(row: ArtifactRow): FinalRenderSource | null {
  try {
    const parsed = finalRenderSourceSchema.safeParse(JSON.parse(row.content_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function enqueueFinalRenderV2(
  projectId: string,
  src: FinalRenderV2Sources,
  options?: {subtitleMode?: SubtitleMode},
): {job: RenderJobRow; sourceArtifact: {id: string; version: number}; sourceReused: boolean; props: ZhiyingFullCutProps} {
  validateSources(src);
  const db = getDb();
  const tx = db.transaction(() => {
    const project = db.prepare('SELECT id, title, template_version FROM projects WHERE id = ?').get(projectId) as
      | {id: string; title: string; template_version: string}
      | undefined;
    if (!project) throw new FinalRenderV2Error('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    const props = buildFinalRenderPropsV2({
      projectId,
      title: project.title,
      templateVersion: project.template_version,
      src,
      subtitleMode: options?.subtitleMode,
    });
    const visualGate = validateFinalVisualProps(props, {assetFileExists: publicAssetFileExists});
    if (!visualGate.ok) {
      const first = visualGate.issues[0]!;
      throw new FinalRenderV2Error('FINAL_VISUAL_INCOMPLETE', `${first.sceneId} ${first.reason}`);
    }
    const propsSha256 = computePropsSha256(props);
    const rec = src.reconciliation.reconciliation;
    // Existing frozen Worker schema is source-kind agnostic: these identities are the
    // real V2 artifact rows, never fabricated V1 aliases.
    const source: FinalRenderSource['source'] = {
      scenesVersionId: src.visual.artifact.id,
      scenesVersion: src.visual.artifact.version,
      narrationAudioArtifactId: src.audio.artifact.id,
      narrationAudioArtifactVersion: src.audio.artifact.version,
      subtitleTimingArtifactId: src.subtitle.artifact.id,
      subtitleTimingArtifactVersion: src.subtitle.artifact.version,
      timingReconciliationArtifactId: src.reconciliation.artifact.id,
      timingReconciliationArtifactVersion: src.reconciliation.artifact.version,
      masterSha256: src.audio.manifest.master.sha256,
      masterDurationMs: src.audio.manifest.master.durationMs,
      reconciliationCompilerVersion: rec.compilerVersion,
      subtitleCompilerVersion: src.subtitle.timing.compilerVersion,
    };
    const sourceKey = computeSourceKey({projectId, source, propsSha256});
    const content: FinalRenderSource = {
      schemaVersion: FINAL_RENDER_SOURCE_SCHEMA_VERSION,
      compilerVersion: FINAL_RENDER_SOURCE_COMPILER_VERSION,
      mode: 'final',
      sourceKey,
      source,
      narration: {
        logicalPath: buildRuntimeNarrationLogicalPath(projectId, src.audio.artifact.id),
        masterFilePath: src.audio.manifest.master.filePath,
      },
      propsSha256,
      props,
    };
    let sourceArtifact: {id: string; version: number} | null = null;
    const rows = db.prepare(
      'SELECT id, version, content_json FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC',
    ).all(projectId, FINAL_RENDER_SOURCE_ARTIFACT_KIND) as ArtifactRow[];
    for (const row of rows) {
      const existing = parseSource(row);
      if (existing && isDeepStrictEqual(existing, content)) {
        sourceArtifact = {id: row.id, version: row.version};
        break;
      }
    }
    const active = db.prepare(
      `SELECT id, progress, progress_detail FROM render_jobs WHERE project_id = ? AND status IN ('queued','running')
       ORDER BY queued_at LIMIT 1`,
    ).get(projectId) as {id: string; progress: number; progress_detail: string | null} | undefined;
    if (active) {
      throw new FinalRenderV2Error('RENDER_ALREADY_ACTIVE', `已有渲染任务：${summarizeRenderProgress(active.progress, active.progress_detail)}`);
    }
    const sourceReused = sourceArtifact !== null;
    if (!sourceArtifact) {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id=? AND kind=?), ?, NULL, ?)`,
      ).run(id, projectId, FINAL_RENDER_SOURCE_ARTIFACT_KIND, projectId, FINAL_RENDER_SOURCE_ARTIFACT_KIND, JSON.stringify(content), new Date().toISOString());
      const row = db.prepare('SELECT version FROM artifacts WHERE id = ?').get(id) as {version: number};
      sourceArtifact = {id, version: row.version};
    }
    const job = enqueueRenderJob(
      projectId,
      options?.subtitleMode === 'none' ? 'no-subtitles' : 'fullcut',
      props,
    );
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id=? AND kind=?), ?, NULL, ?)`,
    ).run(
      crypto.randomUUID(), projectId, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
      projectId, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
      JSON.stringify({
        schemaVersion: FINAL_RENDER_ATTEMPT_SCHEMA_VERSION,
        jobId: job.id,
        finalRenderSourceArtifactId: sourceArtifact.id,
        finalRenderSourceArtifactVersion: sourceArtifact.version,
        sourceKey,
        propsSha256,
      }),
      new Date().toISOString(),
    );
    return {job, sourceArtifact, sourceReused, props};
  });
  return tx.immediate();
}

import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {getDb} from '../db';
import {enqueueRenderJob, type RenderJobRow} from '../jobs';
import {getCurrentNarrationAudioArtifact, type NarrationAudioManifest} from '../narration/audio';
import {getCurrentNarrationPlan} from '../narration/plan';
import {scenesAiOutputSchema, type ScenesAiOutput} from '../prompts/scenes';
import {isLegacyM1Project} from '../projects';
import {applyTimingReconciliation} from '../reconciliation/adapter';
import type {TimingReconciliation} from '../reconciliation/schema';
import {getCurrentTimingReconciliation} from '../reconciliation/timing';
import {summarizeRenderProgress} from '../render/progress-detail';
import {
  COMPOSITION_ID,
  SCHEMA_VERSION,
  zhiyingFullCutPropsSchema,
  type ZhiyingFullCutProps,
} from '../scene-schema';
import {toRendererSubtitleCues} from '../subtitles/renderer';
import type {SubtitleTiming} from '../subtitles/schema';
import {getCurrentSubtitleTiming} from '../subtitles/timing';
import {validateScenesSemantics} from '../workflow/scenes-semantic-validation';
import {getStage} from '../workflow/stages';
import {getVersion} from '../workflow/versions';
import {
  buildRuntimeNarrationLogicalPath,
  computePropsSha256,
  computeSourceKey,
  FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
  FINAL_RENDER_ATTEMPT_SCHEMA_VERSION,
  FINAL_RENDER_SOURCE_ARTIFACT_KIND,
  FINAL_RENDER_SOURCE_COMPILER_VERSION,
  FINAL_RENDER_SOURCE_SCHEMA_VERSION,
  finalRenderAttemptSchema,
  finalRenderSourceSchema,
  type FinalRenderSource,
} from './schema';

/**
 * Final Render Bridge（M3-E）。
 *
 * 链：四 source 全 current（单 BEGIN IMMEDIATE authoritative fence）→
 * M3-D applyTimingReconciliation + M3-C toRendererSubtitleCues →
 * deterministic props → final_render_source（immutable，sourceKey 幂等 reuse，
 * 永不 UPDATE）→ render_job（复用 kind='fullcut'）+ final_render_attempt
 * （一 job 一 attempt，永不 UPDATE）。
 *
 * 与 M2 Preview Bridge 完全分离：不改 render_source / no-subtitles / preview props。
 */

export type FinalRenderErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'SCENES_NOT_CURRENT'
  | 'SCENES_INVALID'
  | 'NARRATION_PLAN_NOT_CURRENT'
  | 'NARRATION_AUDIO_NOT_READY'
  | 'SUBTITLE_TIMING_NOT_READY'
  | 'TIMING_RECONCILIATION_NOT_READY'
  | 'RENDER_ALREADY_ACTIVE'
  | 'FINAL_RENDER_SOURCE_INVALID';

export class FinalRenderError extends Error {
  constructor(
    public readonly code: FinalRenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FinalRenderError';
  }
}

// ---------- current Scenes 读取（与 frozen 边界一致的双校验）----------

type CurrentScenes =
  | {kind: 'ready'; versionId: string; version: number; data: ScenesAiOutput}
  | {kind: 'not_current'}
  | {kind: 'invalid'; message: string};

function readCurrentScenes(projectId: string): CurrentScenes {
  const stage = getStage(projectId, 'scenes');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    return {kind: 'not_current'};
  }
  const row = getVersion(projectId, 'scenes', stage.locked_version);
  if (!row) return {kind: 'not_current'};
  let raw: unknown;
  try {
    raw = JSON.parse(row.content);
  } catch {
    return {kind: 'invalid', message: 'scenes locked 内容不是合法 JSON'};
  }
  const structural = scenesAiOutputSchema.safeParse(raw);
  if (!structural.success) {
    return {
      kind: 'invalid',
      message: `scenes 未通过结构校验：${structural.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  const semantic = validateScenesSemantics(structural.data);
  if (!semantic.ok) {
    return {
      kind: 'invalid',
      message: `scenes 未通过语义校验：[${semantic.issues[0]!.code}] ${semantic.issues[0]!.message}`,
    };
  }
  return {kind: 'ready', versionId: row.id, version: row.version, data: structural.data};
}

// ---------- 四 source 汇总 ----------

interface FinalSources {
  scenes: Extract<CurrentScenes, {kind: 'ready'}>;
  audio: {artifact: {id: string; version: number}; manifest: NarrationAudioManifest};
  subtitle: {artifact: {id: string; version: number}; timing: SubtitleTiming};
  reconciliation: {artifact: {id: string; version: number}; reconciliation: TimingReconciliation};
}

function readFinalSources(projectId: string): FinalSources | FinalRenderError {
  const scenes = readCurrentScenes(projectId);
  if (scenes.kind === 'not_current') {
    return new FinalRenderError('SCENES_NOT_CURRENT', 'Scenes 未锁定或已 stale');
  }
  if (scenes.kind === 'invalid') {
    return new FinalRenderError('SCENES_INVALID', scenes.message);
  }
  const audio = getCurrentNarrationAudioArtifact(projectId);
  if (!audio) {
    return new FinalRenderError(
      getCurrentNarrationPlan(projectId)
        ? 'NARRATION_AUDIO_NOT_READY'
        : 'NARRATION_PLAN_NOT_CURRENT',
      'Narration Audio Manifest 不是 current',
    );
  }
  const subtitle = getCurrentSubtitleTiming(projectId);
  if (!subtitle) {
    return new FinalRenderError('SUBTITLE_TIMING_NOT_READY', 'Subtitle Timing 不是 current');
  }
  const reconciliation = getCurrentTimingReconciliation(projectId);
  if (!reconciliation) {
    return new FinalRenderError(
      'TIMING_RECONCILIATION_NOT_READY',
      'Timing Reconciliation 不是 current',
    );
  }
  const src: FinalSources = {scenes, audio, subtitle, reconciliation};

  // Whole-generation invariant（§12，defense-in-depth）：
  // reconciliation 声称的 source refs 必须逐项等于当前三者——禁止跨代组合。
  const rec = reconciliation.reconciliation.source;
  if (rec.scenesVersionId !== scenes.versionId || rec.scenesVersion !== scenes.version) {
    return new FinalRenderError(
      'FINAL_RENDER_SOURCE_INVALID',
      'reconciliation 与当前 locked Scenes 不同代，禁止组合',
    );
  }
  if (
    rec.narrationAudioArtifactId !== audio.artifact.id ||
    rec.narrationAudioArtifactVersion !== audio.artifact.version
  ) {
    return new FinalRenderError(
      'FINAL_RENDER_SOURCE_INVALID',
      'reconciliation 与当前 Narration Audio 不同代，禁止组合',
    );
  }
  if (
    rec.subtitleTimingArtifactId !== subtitle.artifact.id ||
    rec.subtitleTimingArtifactVersion !== subtitle.artifact.version
  ) {
    return new FinalRenderError(
      'FINAL_RENDER_SOURCE_INVALID',
      'reconciliation 与当前 Subtitle Timing 不同代，禁止组合',
    );
  }
  return src;
}

// ---------- deterministic props ----------

/**
 * 组 Final props（纯函数）：
 * durationInFrames = reconciliation.target.totalFrames（唯一时长真相，不再用 last scene.end）。
 */
export function buildFinalRenderProps(input: {
  projectId: string;
  title: string;
  templateVersion: string;
  src: FinalSources;
}): ZhiyingFullCutProps {
  const {src} = input;
  const rec = src.reconciliation.reconciliation;
  const fps = rec.fps;
  const reconciled = applyTimingReconciliation({
    scenes: src.scenes.data.scenes,
    chapterTiming: src.scenes.data.chapterTiming,
    reconciliation: rec,
  });
  return zhiyingFullCutPropsSchema.parse({
    data: {
      schemaVersion: SCHEMA_VERSION,
      templateVersion: input.templateVersion,
      project: {
        title: input.title,
        composition: COMPOSITION_ID,
        fps,
        durationSec: rec.target.totalFrames / fps,
        durationInFrames: rec.target.totalFrames,
        timingBasis: 'narration_scene_reconciliation',
      },
      chapterTiming: reconciled.chapterTiming,
      scenes: reconciled.scenes,
    },
    audio: {
      narration: buildRuntimeNarrationLogicalPath(input.projectId, src.audio.artifact.id),
      bgm: null,
      sfx: null,
    },
    subtitles: toRendererSubtitleCues(src.subtitle.timing),
    showSubtitles: true,
  });
}

// ---------- artifact 读取 ----------

interface ArtifactRow {
  id: string;
  version: number;
  content_json: string;
}

function listFinalSourceArtifacts(projectId: string): ArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
    )
    .all(projectId, FINAL_RENDER_SOURCE_ARTIFACT_KIND) as ArtifactRow[];
}

/** JSON.parse → finalRenderSourceSchema.safeParse；坏行 skip，不 crash 不 DELETE。 */
function parseFinalSource(row: ArtifactRow): FinalRenderSource | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = finalRenderSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------- readiness ----------

export interface FinalRenderReadiness {
  ready: boolean;
  blockers: Array<{code: string; message: string}>;
  compilerVersion: string;
  sources: {
    scenesVersion: number;
    audioArtifactVersion: number;
    subtitleArtifactVersion: number;
    reconciliationArtifactVersion: number;
  } | null;
  sceneCount: number;
  subtitleCueCount: number;
  masterDurationMs: number | null;
  targetTotalFrames: number | null;
  durationSec: number | null;
  frameResidualMs: number | null;
  playerPreviewProps: ZhiyingFullCutProps | null;
  latestJob: {
    id: string;
    status: string;
    progress: number;
    progressDetail: string | null;
    outputPath: string | null;
    sourceArtifactVersion: number | null;
  } | null;
}

function latestFinalJob(projectId: string): FinalRenderReadiness['latestJob'] {
  const attemptRows = getDb()
    .prepare(
      `SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC`,
    )
    .all(projectId, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND) as ArtifactRow[];
  for (const row of attemptRows) {
    try {
      const parsed = finalRenderAttemptSchema.safeParse(JSON.parse(row.content_json));
      if (!parsed.success) continue;
      const job = getDb()
        .prepare('SELECT * FROM render_jobs WHERE id = ?')
        .get(parsed.data.jobId) as RenderJobRow | undefined;
      if (!job) continue;
      return {
        id: job.id,
        status: job.status,
        progress: job.progress,
        progressDetail: (job as {progress_detail?: string | null}).progress_detail ?? null,
        outputPath: job.output_path,
        sourceArtifactVersion: parsed.data.finalRenderSourceArtifactVersion,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Final Render readiness（纯读，不抛错）。 */
export function checkFinalRenderReadiness(projectId: string): FinalRenderReadiness {
  const base: FinalRenderReadiness = {
    ready: false,
    blockers: [],
    compilerVersion: FINAL_RENDER_SOURCE_COMPILER_VERSION,
    sources: null,
    sceneCount: 0,
    subtitleCueCount: 0,
    masterDurationMs: null,
    targetTotalFrames: null,
    durationSec: null,
    frameResidualMs: null,
    playerPreviewProps: null,
    latestJob: latestFinalJob(projectId),
  };
  const project = getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(projectId) as {id: string; title: string; template_version: string} | undefined;
  if (!project) {
    base.blockers.push({code: 'PROJECT_NOT_FOUND', message: `项目不存在: ${projectId}`});
    return base;
  }
  if (isLegacyM1Project(projectId)) {
    base.blockers.push({code: 'LEGACY_PROJECT', message: 'Legacy M1 项目走原渲染链'});
    return base;
  }
  const src = readFinalSources(projectId);
  if (src instanceof FinalRenderError) {
    base.blockers.push({code: src.code, message: src.message});
    return base;
  }
  const active = getDb()
    .prepare(
      `SELECT id, progress, progress_detail FROM render_jobs WHERE project_id = ? AND status IN ('queued','running')
       ORDER BY queued_at ASC LIMIT 1`,
    )
    .get(projectId) as {id: string; progress: number; progress_detail: string | null} | undefined;
  if (active) {
    base.blockers.push({
      code: 'RENDER_ALREADY_ACTIVE',
      message: `已有渲染任务进行中：${summarizeRenderProgress(active.progress, active.progress_detail)}`,
    });
    return base;
  }
  const rec = src.reconciliation.reconciliation;
  base.ready = true;
  base.sources = {
    scenesVersion: src.scenes.version,
    audioArtifactVersion: src.audio.artifact.version,
    subtitleArtifactVersion: src.subtitle.artifact.version,
    reconciliationArtifactVersion: src.reconciliation.artifact.version,
  };
  base.sceneCount = src.scenes.data.scenes.length;
  base.subtitleCueCount = src.subtitle.timing.cues.length;
  base.masterDurationMs = src.audio.manifest.master.durationMs;
  base.targetTotalFrames = rec.target.totalFrames;
  base.durationSec = rec.target.renderedDurationMs / 1000;
  base.frameResidualMs = rec.target.frameResidualMs;
  // playerPreviewProps：audio.narration 强制 null（browser Player 无法访问 worker bundle 资产），
  // 仅供 UI 预览，不是 render source canonical props。
  const full = buildFinalRenderProps({
    projectId,
    title: project.title,
    templateVersion: project.template_version,
    src,
  });
  base.playerPreviewProps = {...full, audio: {...full.audio, narration: null}};
  return base;
}

// ---------- enqueue ----------

export interface EnqueueFinalRenderResult {
  job: RenderJobRow;
  sourceArtifact: {id: string; version: number};
  sourceReused: boolean;
}

/**
 * 原子 enqueue Final Render（单 BEGIN IMMEDIATE）：
 * 事务内重读四 source → whole-generation 断言 → deterministic props →
 * sourceKey 幂等（reuse/INSERT，永不 UPDATE）→ active guard →
 * render_job + final_render_attempt → COMMIT。
 */
export function enqueueFinalRender(projectId: string): EnqueueFinalRenderResult {
  const db = getDb();
  const tx = db.transaction((): EnqueueFinalRenderResult => {
    const project = db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(projectId) as {id: string; title: string; template_version: string} | undefined;
    if (!project) {
      throw new FinalRenderError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (isLegacyM1Project(projectId)) {
      throw new FinalRenderError('LEGACY_PROJECT', 'Legacy M1 项目走原渲染链');
    }
    const src = readFinalSources(projectId);
    if (src instanceof FinalRenderError) throw src;

    const props = buildFinalRenderProps({
      projectId,
      title: project.title,
      templateVersion: project.template_version,
      src,
    });
    const propsSha256 = computePropsSha256(props);
    const rec = src.reconciliation.reconciliation;
    const source: FinalRenderSource['source'] = {
      scenesVersionId: src.scenes.versionId,
      scenesVersion: src.scenes.version,
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
    const expectedContent: FinalRenderSource = {
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

    // 幂等：sourceKey + compiler 匹配且完整内容 deep equal → reuse（坏行 skip，历史不 DELETE）
    let sourceArtifact: {id: string; version: number} | null = null;
    for (const row of listFinalSourceArtifacts(projectId)) {
      const content = parseFinalSource(row);
      if (
        content &&
        content.compilerVersion === FINAL_RENDER_SOURCE_COMPILER_VERSION &&
        content.sourceKey === sourceKey &&
        isDeepStrictEqual(content, expectedContent)
      ) {
        sourceArtifact = {id: row.id, version: row.version};
        break;
      }
    }
    const sourceReused = sourceArtifact !== null;

    // active guard（在 source INSERT 之前：冲突时事务整体回滚，不留 orphan source）
    const active = db
      .prepare(
        `SELECT id, progress, progress_detail FROM render_jobs WHERE project_id = ? AND status IN ('queued','running')
         ORDER BY queued_at ASC LIMIT 1`,
      )
      .get(projectId) as {id: string; progress: number; progress_detail: string | null} | undefined;
    if (active) {
      throw new FinalRenderError(
        'RENDER_ALREADY_ACTIVE',
        `已有渲染任务进行中：${summarizeRenderProgress(active.progress, active.progress_detail)}`,
      );
    }

    if (!sourceArtifact) {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
           ?, NULL, ?)`,
      ).run(
        id,
        projectId,
        FINAL_RENDER_SOURCE_ARTIFACT_KIND,
        projectId,
        FINAL_RENDER_SOURCE_ARTIFACT_KIND,
        JSON.stringify(expectedContent),
        new Date().toISOString(),
      );
      const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
        | ArtifactRow
        | undefined;
      if (!row) throw new Error(`enqueueFinalRender: inserted source ${id} not found`);
      sourceArtifact = {id: row.id, version: row.version};
    }

    // 每次 Render 都是新 attempt（新 job + 新 attempt artifact，一一绑定）
    const job = enqueueRenderJob(projectId, 'fullcut', props);
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    ).run(
      crypto.randomUUID(),
      projectId,
      FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
      projectId,
      FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
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
    return {job, sourceArtifact, sourceReused};
  });
  return tx.immediate();
}

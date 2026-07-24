import crypto from 'node:crypto';
import {getDb} from '../db';
import {getCurrentNarrationAudioArtifact} from '../narration/audio';
import {getCurrentNarrationPlan} from '../narration/plan';
import {scenesAiOutputSchema, type ScenesAiOutput} from '../prompts/scenes';
import {isLegacyM1Project} from '../projects';
import {getCurrentSubtitleTiming} from '../subtitles/timing';
import {validateScenesSemantics} from '../workflow/scenes-semantic-validation';
import {getStage} from '../workflow/stages';
import {getVersion} from '../workflow/versions';
import {compileTimingReconciliation, ReconciliationCompileError} from './compiler';
import {
  RECONCILIATION_COMPILER_VERSION,
  TIMING_RECONCILIATION_ARTIFACT_KIND,
  timingReconciliationSchema,
  type TimingReconciliation,
} from './schema';

/**
 * Timing Reconciliation artifact 层（M3-D）。
 *
 * - source 三件套全部 current 才允许 build：locked Scenes（JSON.parse →
 *   scenesAiOutputSchema → validateScenesSemantics，不 blind trust frozen stage）、
 *   current Narration Audio、current Subtitle Timing
 * - 幂等：全 provenance + compilerVersion 匹配 → reuse
 * - stale：任一 source 前进 / compiler 升级 → 旧 artifact 保留历史，不再 current
 * - 单 BEGIN IMMEDIATE：事务内重读三 source + 幂等检查 + compile + INSERT
 * - corrupted artifact：JSON.parse → safeParse，坏数据 skip，不 crash 不 current
 * - 无 DB migration / 无第 11 stage / 无 job queue；绝不修改 source project_versions
 */

export type TimingReconciliationErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'SCENES_NOT_CURRENT'
  | 'SCENES_INVALID'
  | 'NARRATION_PLAN_NOT_CURRENT'
  | 'NARRATION_AUDIO_NOT_READY'
  | 'SUBTITLE_TIMING_NOT_READY'
  | 'RECONCILIATION_INVALID'
  | 'RECONCILIATION_IMPOSSIBLE';

export class TimingReconciliationError extends Error {
  constructor(
    public readonly code: TimingReconciliationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TimingReconciliationError';
  }
}

// ---------- current Scenes 读取（三态）----------

type CurrentScenes =
  | {kind: 'ready'; versionId: string; version: number; data: ScenesAiOutput}
  | {kind: 'not_current'}
  | {kind: 'invalid'; message: string};

/** locked Scenes + 双校验（与 Render Bridge 同一边界纪律，纯读不修复）。 */
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

interface CurrentSources {
  scenes: Extract<CurrentScenes, {kind: 'ready'}>;
  audio: NonNullable<ReturnType<typeof getCurrentNarrationAudioArtifact>>;
  subtitle: NonNullable<ReturnType<typeof getCurrentSubtitleTiming>>;
}

/** 三 source 全部 current 才返回（纯读；invalid scenes 视为不可用）。 */
function readCurrentSources(projectId: string): CurrentSources | null {
  const scenes = readCurrentScenes(projectId);
  if (scenes.kind !== 'ready') return null;
  const audio = getCurrentNarrationAudioArtifact(projectId);
  if (!audio) return null;
  const subtitle = getCurrentSubtitleTiming(projectId);
  if (!subtitle) return null;
  return {scenes, audio, subtitle};
}

// ---------- artifact 读取 / current 判定 ----------

interface ReconciliationArtifactRow {
  id: string;
  version: number;
  content_json: string;
}

function listReconciliationArtifacts(projectId: string): ReconciliationArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, TIMING_RECONCILIATION_ARTIFACT_KIND) as ReconciliationArtifactRow[];
}

/** JSON.parse → timingReconciliationSchema.safeParse；坏数据一律 null。 */
function parseReconciliation(row: ReconciliationArtifactRow): TimingReconciliation | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = timingReconciliationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** current 判定：全 provenance 与三 current source 逐项相等 + compilerVersion。 */
function matchesCurrentSource(rec: TimingReconciliation, src: CurrentSources): boolean {
  const manifestSrc = src.audio.manifest.source;
  return (
    rec.source.scenesVersionId === src.scenes.versionId &&
    rec.source.scenesVersion === src.scenes.version &&
    rec.source.narrationAudioArtifactId === src.audio.artifact.id &&
    rec.source.narrationAudioArtifactVersion === src.audio.artifact.version &&
    rec.source.subtitleTimingArtifactId === src.subtitle.artifact.id &&
    rec.source.subtitleTimingArtifactVersion === src.subtitle.artifact.version &&
    rec.source.narrationPlanArtifactId === manifestSrc.narrationPlanArtifactId &&
    rec.source.narrationPlanArtifactVersion === manifestSrc.narrationPlanArtifactVersion &&
    rec.source.scriptV2Version === manifestSrc.scriptV2Version &&
    rec.source.narrationCompilerVersion === manifestSrc.compilerVersion &&
    rec.source.subtitleCompilerVersion === src.subtitle.timing.compilerVersion &&
    rec.source.masterSha256 === src.audio.manifest.master.sha256 &&
    rec.source.masterDurationMs === src.audio.manifest.master.durationMs &&
    rec.compilerVersion === RECONCILIATION_COMPILER_VERSION
  );
}

/** 读取 current Timing Reconciliation（任一 source 不 current 时恒 null）。 */
export function getCurrentTimingReconciliation(projectId: string): {
  reconciliation: TimingReconciliation;
  artifact: {id: string; version: number};
} | null {
  const src = readCurrentSources(projectId);
  if (!src) return null;
  for (const row of listReconciliationArtifacts(projectId)) {
    const rec = parseReconciliation(row);
    if (rec && matchesCurrentSource(rec, src)) {
      return {reconciliation: rec, artifact: {id: row.id, version: row.version}};
    }
  }
  return null;
}

export type TimingReconciliationStatus = 'ready' | 'stale' | 'missing' | 'not_ready';

export interface TimingReconciliationReadiness {
  status: TimingReconciliationStatus;
  compilerVersion: string;
  sources: {
    scenesVersion: number;
    audioArtifactVersion: number;
    subtitleArtifactVersion: number;
  } | null;
  artifactVersion: number | null;
  sceneCount: number;
  masterDurationMs: number | null;
  sourceVisual: TimingReconciliation['sourceVisual'] | null;
  target: TimingReconciliation['target'] | null;
  unresolvedCount: number;
  reconciliation: TimingReconciliation | null;
}

/**
 * readiness（纯读）。状态区分（独立 review 要求）：
 * - not_ready：任一 source 本身不 current（scenes 未 locked/stale/invalid、
 *   audio/subtitle 链不 ready）
 * - stale：三 source 均 ready，但已有 reconciliation 无一匹配 current snapshot
 * - missing：三 source 均 ready，从未生成
 */
export function checkTimingReconciliationReadiness(
  projectId: string,
): TimingReconciliationReadiness {
  const src = readCurrentSources(projectId);
  const base: TimingReconciliationReadiness = {
    status: 'not_ready',
    compilerVersion: RECONCILIATION_COMPILER_VERSION,
    sources: null,
    artifactVersion: null,
    sceneCount: 0,
    masterDurationMs: null,
    sourceVisual: null,
    target: null,
    unresolvedCount: 0,
    reconciliation: null,
  };
  if (!src) return base;
  base.sources = {
    scenesVersion: src.scenes.version,
    audioArtifactVersion: src.audio.artifact.version,
    subtitleArtifactVersion: src.subtitle.artifact.version,
  };
  base.masterDurationMs = src.audio.manifest.master.durationMs;
  base.sceneCount = src.scenes.data.scenes.length;
  const current = getCurrentTimingReconciliation(projectId);
  if (current) {
    base.status = 'ready';
    base.artifactVersion = current.artifact.version;
    base.sourceVisual = current.reconciliation.sourceVisual;
    base.target = current.reconciliation.target;
    base.unresolvedCount = current.reconciliation.unresolvedNarrationUnitIds.length;
    base.reconciliation = current.reconciliation;
    return base;
  }
  const hasAny = listReconciliationArtifacts(projectId).some(
    (row) => parseReconciliation(row) !== null,
  );
  base.status = hasAny ? 'stale' : 'missing';
  return base;
}

/**
 * 构建 / 复用 current Timing Reconciliation（单 BEGIN IMMEDIATE 原子）：
 * 事务内重读三 source → 幂等复用 → deterministic compile → INSERT。
 */
export function buildTimingReconciliation(projectId: string): {
  reconciliation: TimingReconciliation;
  artifact: {id: string; version: number};
  reused: boolean;
} {
  const db = getDb();
  const tx = db.transaction((): {
    reconciliation: TimingReconciliation;
    artifact: {id: string; version: number};
    reused: boolean;
  } => {
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as {id: string} | undefined;
    if (!project) {
      throw new TimingReconciliationError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (isLegacyM1Project(projectId)) {
      throw new TimingReconciliationError('LEGACY_PROJECT', 'Legacy M1 项目无 workflow Scenes/Narration 链');
    }

    // 事务内重读三 source（authoritative fence）
    const scenes = readCurrentScenes(projectId);
    if (scenes.kind === 'not_current') {
      throw new TimingReconciliationError(
        'SCENES_NOT_CURRENT',
        'Scenes 未锁定或已 stale——请先完成并锁定 scenes 阶段',
      );
    }
    if (scenes.kind === 'invalid') {
      throw new TimingReconciliationError('SCENES_INVALID', scenes.message);
    }
    const audio = getCurrentNarrationAudioArtifact(projectId);
    if (!audio) {
      if (!getCurrentNarrationPlan(projectId)) {
        throw new TimingReconciliationError(
          'NARRATION_PLAN_NOT_CURRENT',
          'Narration Plan 不是当前版本（missing 或 stale）——请先 Build Narration Plan',
        );
      }
      throw new TimingReconciliationError(
        'NARRATION_AUDIO_NOT_READY',
        'Narration Audio Manifest 不是 current——请先生成音频',
      );
    }
    const subtitle = getCurrentSubtitleTiming(projectId);
    if (!subtitle) {
      throw new TimingReconciliationError(
        'SUBTITLE_TIMING_NOT_READY',
        'Subtitle Timing 不是 current——请先 Build Subtitle Timing',
      );
    }
    const src: CurrentSources = {scenes, audio, subtitle};

    // 幂等：全 source snapshot + compilerVersion 匹配 → reuse
    for (const row of listReconciliationArtifacts(projectId)) {
      const rec = parseReconciliation(row);
      if (rec && matchesCurrentSource(rec, src)) {
        return {reconciliation: rec, artifact: {id: row.id, version: row.version}, reused: true};
      }
    }

    let reconciliation: TimingReconciliation;
    try {
      reconciliation = compileTimingReconciliation({
        scenes: scenes.data,
        refs: {
          scenesVersionId: scenes.versionId,
          scenesVersion: scenes.version,
          narrationAudioArtifactId: audio.artifact.id,
          narrationAudioArtifactVersion: audio.artifact.version,
          subtitleTimingArtifactId: subtitle.artifact.id,
          subtitleTimingArtifactVersion: subtitle.artifact.version,
          narrationPlanArtifactId: audio.manifest.source.narrationPlanArtifactId,
          narrationPlanArtifactVersion: audio.manifest.source.narrationPlanArtifactVersion,
          scriptV2Version: audio.manifest.source.scriptV2Version,
          narrationCompilerVersion: audio.manifest.source.compilerVersion,
          subtitleCompilerVersion: subtitle.timing.compilerVersion,
          masterSha256: audio.manifest.master.sha256,
          masterDurationMs: audio.manifest.master.durationMs,
        },
        unresolvedNarrationUnitIds: subtitle.timing.unresolvedUnitIds,
      });
    } catch (err) {
      if (err instanceof ReconciliationCompileError) {
        throw new TimingReconciliationError(err.code, err.message);
      }
      throw err;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    ).run(
      id,
      projectId,
      TIMING_RECONCILIATION_ARTIFACT_KIND,
      projectId,
      TIMING_RECONCILIATION_ARTIFACT_KIND,
      JSON.stringify(reconciliation),
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ReconciliationArtifactRow
      | undefined;
    if (!row) {
      throw new Error(`buildTimingReconciliation: inserted artifact ${id} not found`);
    }
    return {
      reconciliation,
      artifact: {id: row.id, version: row.version},
      reused: false,
    };
  });
  return tx.immediate();
}

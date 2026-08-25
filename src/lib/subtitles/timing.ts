import crypto from 'node:crypto';
import {getDb} from '../db';
import {getCurrentNarrationAudioArtifact, type NarrationAudioArtifact} from '../narration/audio';
import {getCurrentNarrationPlan} from '../narration/plan';
import {isLegacyM1Project} from '../projects';
import {compileSubtitleTiming, SubtitleCompileError} from './compiler';
import {
  SUBTITLE_COMPILER_VERSION,
  SUBTITLE_TIMING_ARTIFACT_KIND,
  subtitleTimingSchema,
  type SubtitleTiming,
} from './schema';

/**
 * Subtitle Timing artifact 层（M3-C §二十五–三十）。
 *
 * - source 只允许 current Narration Audio Manifest（经 M3-B 全部防线），
 *   绝不从 tts_jobs 临时拼字幕
 * - 幂等：同 (audio artifact id/version, masterSha256, compilerVersion) 复用
 * - stale：audio source 前进 / compiler 升级后旧 artifact 保留为历史，不再 current
 * - 无 DB migration / 无 job queue：复用 artifacts 表（kind='subtitle_timing'），
 *   纯 CPU 小计算，单 BEGIN IMMEDIATE 内完成 recheck + compile + INSERT
 * - corrupted artifact：JSON.parse → safeParse，坏数据 skip，不 crash 不 current
 */

export type SubtitleTimingErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'NARRATION_PLAN_NOT_CURRENT'
  | 'NARRATION_PLAN_INVALID'
  | 'NARRATION_AUDIO_NOT_READY'
  | 'AUDIO_SOURCE_MISMATCH'
  | 'NARRATION_AUDIO_INVALID'
  | 'SUBTITLE_TIMING_INVALID'
  | 'AUDIO_TIMELINE_MISMATCH';

export class SubtitleTimingError extends Error {
  constructor(
    public readonly code: SubtitleTimingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleTimingError';
  }
}

interface SubtitleArtifactRow {
  id: string;
  version: number;
  content_json: string;
}

export type SubtitleTimingArtifact = {
  timing: SubtitleTiming;
  artifact: {id: string; version: number};
};

function listSubtitleArtifacts(projectId: string): SubtitleArtifactRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM artifacts
       WHERE project_id = ? AND kind = ?
       ORDER BY version DESC`,
    )
    .all(projectId, SUBTITLE_TIMING_ARTIFACT_KIND) as SubtitleArtifactRow[];
}

/** JSON.parse → subtitleTimingSchema.safeParse；坏 JSON/错 schema/非法 cues 一律 null。 */
function parseTiming(row: SubtitleArtifactRow): SubtitleTiming | null {
  let raw: unknown;
  try {
    raw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  const parsed = subtitleTimingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * current 判定（§二十六 + Hardening 3）：source snapshot 的全部 provenance
 * 必须与 current Narration Audio Manifest 自己记录的 provenance 一致——
 * JSON/Zod 合法但 provenance 被篡改/损坏的 artifact 绝不认 current、绝不复用。
 */
function matchesCurrentSource(
  timing: SubtitleTiming,
  audio: {
    artifact: {id: string; version: number};
    manifest: {
      source: {
        narrationPlanArtifactId: string;
        narrationPlanArtifactVersion: number;
        scriptV2Version: number;
        compilerVersion: string;
      };
      master: {sha256: string; durationMs: number};
    };
  },
): boolean {
  return (
    timing.source.narrationAudioArtifactId === audio.artifact.id &&
    timing.source.narrationAudioArtifactVersion === audio.artifact.version &&
    timing.source.narrationPlanArtifactId === audio.manifest.source.narrationPlanArtifactId &&
    timing.source.narrationPlanArtifactVersion ===
      audio.manifest.source.narrationPlanArtifactVersion &&
    timing.source.scriptV2Version === audio.manifest.source.scriptV2Version &&
    timing.source.narrationCompilerVersion === audio.manifest.source.compilerVersion &&
    timing.source.masterSha256 === audio.manifest.master.sha256 &&
    timing.source.masterDurationMs === audio.manifest.master.durationMs &&
    timing.compilerVersion === SUBTITLE_COMPILER_VERSION
  );
}

/** 读取 current Subtitle Timing（无 current audio source 时恒 null）。 */
export function getCurrentSubtitleTiming(projectId: string): {
  timing: SubtitleTiming;
  artifact: {id: string; version: number};
} | null {
  const audio = getCurrentNarrationAudioArtifact(projectId);
  if (!audio) return null;
  for (const row of listSubtitleArtifacts(projectId)) {
    const timing = parseTiming(row);
    if (timing && matchesCurrentSource(timing, audio)) {
      return {timing, artifact: {id: row.id, version: row.version}};
    }
  }
  return null;
}

/** Exact identity path: validates the supplied artifact against the supplied exact audio. */
export function getExactSubtitleTiming(
  projectId: string,
  expectedSubtitle: {artifactId: string; version: number},
  exactAudio: NarrationAudioArtifact,
): SubtitleTimingArtifact | null {
  const row = getDb().prepare(
    `SELECT id, project_id, kind, version, content_json FROM artifacts WHERE id = ?`,
  ).get(expectedSubtitle.artifactId) as
    | (SubtitleArtifactRow & {project_id: string; kind: string})
    | undefined;
  if (
    !row ||
    row.project_id !== projectId ||
    row.kind !== SUBTITLE_TIMING_ARTIFACT_KIND ||
    row.version !== expectedSubtitle.version
  ) return null;
  const timing = parseTiming(row);
  if (!timing || !matchesCurrentSource(timing, exactAudio)) return null;
  return {timing, artifact: {id: row.id, version: row.version}};
}

export type SubtitleTimingStatus = 'ready' | 'stale' | 'missing' | 'not_ready';

export interface SubtitleTimingReadiness {
  status: SubtitleTimingStatus;
  compilerVersion: string;
  sourceAudio: {
    artifactId: string;
    artifactVersion: number;
    masterDurationMs: number;
  } | null;
  artifactVersion: number | null;
  cueCount: number;
  timelineDurationMs: number | null;
  unresolvedCount: number;
  timing: SubtitleTiming | null;
}

/** Subtitle Timing 区 readiness（纯读，不触发构建）。 */
export function checkSubtitleTimingReadiness(projectId: string): SubtitleTimingReadiness {
  const audio = getCurrentNarrationAudioArtifact(projectId);
  const current = getCurrentSubtitleTiming(projectId);
  const hasAny = listSubtitleArtifacts(projectId).some((row) => parseTiming(row) !== null);
  let status: SubtitleTimingStatus;
  if (current) {
    status = 'ready';
  } else if (hasAny) {
    status = 'stale'; // 有历史 subtitle artifact 但无一匹配 current source
  } else if (audio) {
    status = 'missing'; // audio ready，尚未生成过字幕
  } else {
    status = 'not_ready'; // 无 current Narration Audio Manifest
  }
  return {
    status,
    compilerVersion: SUBTITLE_COMPILER_VERSION,
    sourceAudio: audio
      ? {
          artifactId: audio.artifact.id,
          artifactVersion: audio.artifact.version,
          masterDurationMs: audio.manifest.master.durationMs,
        }
      : null,
    artifactVersion: current?.artifact.version ?? null,
    cueCount: current?.timing.cues.length ?? 0,
    timelineDurationMs: current ? current.timing.source.masterDurationMs : null,
    unresolvedCount: current?.timing.unresolvedUnitIds.length ?? 0,
    timing: current?.timing ?? null,
  };
}

/**
 * 构建 / 复用 current Subtitle Timing（单 BEGIN IMMEDIATE 原子，§三十）：
 * project exists → 非 legacy → current audio manifest（含 plan current 防线）→
 * 幂等复用检查 → deterministic compile → INSERT artifact → commit。
 */
export function buildSubtitleTiming(
  projectId: string,
  options?: {
    expectedAudio?: {artifactId: string; version: number};
    exactAudio?: NarrationAudioArtifact;
  },
): {
  timing: SubtitleTiming;
  artifact: {id: string; version: number};
  reused: boolean;
} {
  const db = getDb();
  const tx = db.transaction((): {
    timing: SubtitleTiming;
    artifact: {id: string; version: number};
    reused: boolean;
  } => {
    const project = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get(projectId) as {id: string} | undefined;
    if (!project) {
      throw new SubtitleTimingError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
    }
    if (isLegacyM1Project(projectId)) {
      throw new SubtitleTimingError('LEGACY_PROJECT', 'Legacy M1 项目无 Narration 管线');
    }

    // Build Source Gate（§二十四）：只允许 current Narration Audio Manifest
    const audio = options?.exactAudio ?? getCurrentNarrationAudioArtifact(projectId);
    if (!audio) {
      if (!getCurrentNarrationPlan(projectId)) {
        throw new SubtitleTimingError(
          'NARRATION_PLAN_NOT_CURRENT',
          'Narration Plan 不是当前版本（missing 或 stale）——请先 Build Narration Plan',
        );
      }
      throw new SubtitleTimingError(
        'NARRATION_AUDIO_NOT_READY',
        'Narration Audio Manifest 不是 current（missing / stale / master 缺失）——请先生成音频',
      );
    }
    if (
      options?.expectedAudio &&
      (audio.artifact.id !== options.expectedAudio.artifactId ||
        audio.artifact.version !== options.expectedAudio.version)
    ) {
      throw new SubtitleTimingError(
        'AUDIO_SOURCE_MISMATCH',
        `Narration Audio source mismatch: expected ${options.expectedAudio.artifactId}@${options.expectedAudio.version}, ` +
          `current ${audio.artifact.id}@${audio.artifact.version}`,
      );
    }
    const currentPlan = getCurrentNarrationPlan(projectId);
    if (!currentPlan) {
      // audio gate 已通过时理论上不可达（readCurrentManifest 要求 plan current）
      throw new SubtitleTimingError('NARRATION_PLAN_INVALID', 'current Narration Plan 读取失败');
    }

    // 幂等（§二十五）：同 source snapshot + compilerVersion 直接复用
    for (const row of listSubtitleArtifacts(projectId)) {
      const timing = parseTiming(row);
      if (timing && matchesCurrentSource(timing, audio)) {
        return {timing, artifact: {id: row.id, version: row.version}, reused: true};
      }
    }

    let timing: SubtitleTiming;
    try {
      timing = compileSubtitleTiming({
        plan: currentPlan.plan,
        manifest: audio.manifest,
        narrationAudioArtifactId: audio.artifact.id,
        narrationAudioArtifactVersion: audio.artifact.version,
        narrationPlanArtifactId: currentPlan.artifact.id,
        narrationPlanArtifactVersion: currentPlan.artifact.version,
      });
    } catch (err) {
      if (err instanceof SubtitleCompileError) {
        throw new SubtitleTimingError(err.code, err.message);
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
      SUBTITLE_TIMING_ARTIFACT_KIND,
      projectId,
      SUBTITLE_TIMING_ARTIFACT_KIND,
      JSON.stringify(timing),
      new Date().toISOString(),
    );
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | SubtitleArtifactRow
      | undefined;
    if (!row) {
      throw new Error(`buildSubtitleTiming: inserted artifact ${id} not found`);
    }
    return {timing, artifact: {id: row.id, version: row.version}, reused: false};
  });
  return tx.immediate();
}

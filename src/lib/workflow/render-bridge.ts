import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '../db';
import {enqueueRenderJob, type RenderJobRow} from '../jobs';
import {summarizeRenderProgress} from '../render/progress-detail';
import {
  COMPOSITION_ID,
  SCHEMA_VERSION,
  TEMPLATE_VERSION,
  zhiyingFullCutPropsSchema,
  type ZhiyingFullCutProps,
} from '../scene-schema';
import {isLegacyM1Project} from '../projects';
import {scenesAiOutputSchema, type ScenesAiOutput} from '../prompts/scenes';
import {getStage} from './stages';
import {getVersion} from './versions';
import {
  SCENES_SYSTEM_FPS,
  validateScenesSemantics,
} from './scenes-semantic-validation';
import {buildAssetMap, evaluateVisualReadiness, type VisualReadinessSummary} from '../assets/readiness';
import {applyVisualOverrides, listVisualOverrides} from '../scenes/visual-overrides';

/**
 * Workflow → M1 Render Bridge（M2-E-C）。
 *
 * 单一职责：把「scenes locked 的 workflow 项目」安全适配进 M1 冻结渲染链。
 * 不重做 Renderer / Player，不改变 M1 渲染契约。
 *
 * 铁律：
 * - Render source 只允许 scenes.status === 'locked' 的 locked_version
 *   （stale 时 locked_version 虽保留也禁止新 render；绝不读 active_version）。
 * - Render boundary 独立防御：JSON.parse → structural Zod → semantic validator
 *   → system-owned metadata → final zhiyingFullCutPropsSchema.parse。
 * - Visual Preview Render：audio.narration = null、subtitles = []、
 *   showSubtitles = false（kind='no-subtitles'）。没有 TTS，绝不伪造旁白/字幕。
 * - Bridge 是 adapter：不补时间线、不重排、不改 ID/duration/template/category、
 *   不自动找素材、不改 licenseStatus。
 * - 不自动 render：仅人工显式触发。
 */

export type RenderBridgeErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'LEGACY_PROJECT'
  | 'SCENES_NOT_LOCKED'
  | 'SCENES_VERSION_NOT_FOUND'
  | 'RENDER_SOURCE_INVALID'
  | 'UNSUPPORTED_TEMPLATE'
  | 'ASSET_FILE_MISSING'
  | 'VISUAL_READINESS_FAILED'
  | 'RENDER_ALREADY_ACTIVE';

export class RenderBridgeError extends Error {
  constructor(
    public readonly code: RenderBridgeErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RenderBridgeError';
  }
}

export interface RenderBlocker {
  code: RenderBridgeErrorCode;
  message: string;
}

export interface RenderReadiness {
  ready: boolean;
  blockers: RenderBlocker[];
  scenesVersion: number | null;
  /** M6：视觉素材就绪情况（仅 workflow 项目） */
  visualReadiness: VisualReadinessSummary | null;
}

// ---------- 资产规则（M2-E-C §十一 / M2-E-D §四调查结论） ----------
// 仓库内没有素材 manifest 系统；当前 Renderer 真实消费的外部文件只有两类：
// 1. Freud 示例配乐（bgm/sfx）：ZhiyingFullCut 在 props.audio.bgm/sfx 非 null 时挂载
//    —— M2-E-D 起 Workflow Visual Preview 显式置 null，不再是硬依赖；
// 2. Freud 示例遗留：scene.assetIds 含 'freud_1909_loc' 时 ArchiveEditorial 引用的图片
const SCENE_ASSET_FILES: Readonly<Record<string, string>> = {
  freud_1909_loc: 'pilot/images/freud_1909_loc.jpg',
};

export type AssetFileExistsFn = (relativePublicPath: string) => boolean;

/** 默认实现：检查 public/ 下文件（防目录穿越）。 */
export const defaultAssetFileExists: AssetFileExistsFn = (rel) => {
  const publicRoot = path.resolve(process.cwd(), 'public');
  const abs = path.resolve(publicRoot, rel);
  if (!abs.startsWith(publicRoot + path.sep)) return false;
  return fs.existsSync(abs);
};

// ---------- 内部：读取并校验 locked scenes ----------

interface LockedScenesSource {
  scenesVersion: number;
  parsed: ScenesAiOutput;
}

function loadLockedScenesSource(projectId: string): LockedScenesSource {
  const stage = getStage(projectId, 'scenes');
  if (!stage || stage.status !== 'locked' || stage.locked_version === null) {
    throw new RenderBridgeError(
      'SCENES_NOT_LOCKED',
      `scenes 未锁定（当前 ${stage?.status ?? 'missing'}）；stale 的 locked_version 保留值不得用于渲染`,
      {currentStatus: stage?.status ?? 'missing'},
    );
  }
  const version = getVersion(projectId, 'scenes', stage.locked_version);
  if (!version) {
    throw new RenderBridgeError(
      'SCENES_VERSION_NOT_FOUND',
      `scenes locked_version=${stage.locked_version} 对应的版本行不存在`,
    );
  }
  // Render boundary 独立防御：parse → structural Zod → semantic validator
  let raw: unknown;
  try {
    raw = JSON.parse(version.content);
  } catch {
    throw new RenderBridgeError('RENDER_SOURCE_INVALID', 'scenes locked 内容不是合法 JSON');
  }
  const structural = scenesAiOutputSchema.safeParse(raw);
  if (!structural.success) {
    throw new RenderBridgeError(
      'RENDER_SOURCE_INVALID',
      `scenes locked 内容未通过结构校验：${structural.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const semantic = validateScenesSemantics(structural.data);
  if (!semantic.ok) {
    throw new RenderBridgeError(
      'RENDER_SOURCE_INVALID',
      `scenes locked 内容未通过语义校验：[${semantic.issues[0]!.code}] ${semantic.issues[0]!.message}`,
      {issueCount: semantic.issues.length},
    );
  }
  // M6.3.13：scene 级「改用 MG」override 在 scene 输入处生效（不改 scenes
  // artifact；以 locked 版本行 id 为失效判定基准，version 漂移自动跳过）
  const overriddenScenes = applyVisualOverrides(
    structural.data.scenes,
    listVisualOverrides(projectId),
    version.id,
  );
  return {
    scenesVersion: stage.locked_version,
    parsed: {...structural.data, scenes: overriddenScenes},
  };
}

// ---------- 内部：资产 preflight ----------

function collectAssetBlockers(
  parsed: ScenesAiOutput,
  audioPaths: Array<string | null>,
  fileExists: AssetFileExistsFn,
): RenderBlocker[] {
  const blockers: RenderBlocker[] = [];
  // 实际挂载的音频资产（bgm/sfx/narration 非 null 才检查；
  // Workflow Visual Preview 全 null → 无音频依赖）
  for (const rel of audioPaths) {
    if (rel !== null && !fileExists(rel)) {
      blockers.push({
        code: 'ASSET_FILE_MISSING',
        message: `音频资产缺失：public/${rel}`,
      });
    }
  }
  // scene.assetIds 中当前 Renderer 真正解析文件的条目
  const referenced = new Set(parsed.scenes.flatMap((scene) => scene.assetIds));
  for (const assetId of referenced) {
    const rel = SCENE_ASSET_FILES[assetId];
    if (rel !== undefined && !fileExists(rel)) {
      blockers.push({
        code: 'ASSET_FILE_MISSING',
        message: `场景素材文件缺失：${assetId} → public/${rel}`,
      });
    }
    // 其他 assetId 当前 Renderer 不做文件解析（M1 无 manifest 系统），不构成阻塞
  }
  return blockers;
}

// ---------- 公开 API ----------

/** Workflow Visual Preview 音频策略：无旁白（无 TTS）、不挂 Freud 示例 BGM/SFX。 */
const PREVIEW_AUDIO = {narration: null, bgm: null, sfx: null} as const;

export interface RenderReadinessOptions {
  fileExists?: AssetFileExistsFn;
}

/**
 * Render readiness 预检（纯读，不抛错）。
 * ready 需要：workflow 项目 + scenes locked(+locked_version) + 版本行存在 +
 * source 双校验通过 + 模板/合成器受支持 + 资产 preflight 通过 + 无 active render。
 */
export function checkWorkflowRenderReadiness(
  projectId: string,
  options: RenderReadinessOptions = {},
): RenderReadiness {
  const fileExists = options.fileExists ?? defaultAssetFileExists;
  const blockers: RenderBlocker[] = [];
  let scenesVersion: number | null = null;

  const project = getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(projectId) as {id: string; template_version: string; composition_id: string} | undefined;
  if (!project) {
    return {ready: false, blockers: [{code: 'PROJECT_NOT_FOUND', message: `项目不存在: ${projectId}`}], scenesVersion, visualReadiness: null};
  }
  if (isLegacyM1Project(projectId)) {
    return {
      ready: false,
      blockers: [{code: 'LEGACY_PROJECT', message: 'Legacy M1 项目走原渲染链，不经 Render Bridge'}],
      scenesVersion,
      visualReadiness: null,
    };
  }
  if (project.template_version !== TEMPLATE_VERSION || project.composition_id !== COMPOSITION_ID) {
    blockers.push({
      code: 'UNSUPPORTED_TEMPLATE',
      message: `不支持的 template/composition：${project.template_version}/${project.composition_id}`,
    });
  }

  let source: LockedScenesSource | null = null;
  try {
    source = loadLockedScenesSource(projectId);
    scenesVersion = source.scenesVersion;
  } catch (err) {
    if (err instanceof RenderBridgeError) {
      blockers.push({code: err.code, message: err.message});
    } else {
      throw err;
    }
  }

  if (source) {
    blockers.push(
      ...collectAssetBlockers(
        source.parsed,
        [PREVIEW_AUDIO.narration, PREVIEW_AUDIO.bgm, PREVIEW_AUDIO.sfx],
        fileExists,
      ),
    );
  }

  // M6：视觉素材就绪评估（Preview 不硬拦，仅报告状态；Final Render 硬拦）
  let visualReadiness: VisualReadinessSummary | null = null;
  if (source) {
    visualReadiness = evaluateVisualReadiness(projectId, source.parsed.scenes);
  }

  const activeRender = getDb()
    .prepare(
      `SELECT id, progress, progress_detail FROM render_jobs
       WHERE project_id = ? AND status IN ('queued', 'running')
       ORDER BY queued_at ASC LIMIT 1`,
    )
    .get(projectId) as {id: string; progress: number; progress_detail: string | null} | undefined;
  if (activeRender) {
    blockers.push({
      code: 'RENDER_ALREADY_ACTIVE',
      message: `已有渲染任务进行中：${summarizeRenderProgress(activeRender.progress, activeRender.progress_detail)}`,
    });
  }

  return {ready: blockers.length === 0, blockers, scenesVersion, visualReadiness};
}

export interface WorkflowRenderProps {
  props: ZhiyingFullCutProps;
  scenesVersion: number;
}

/**
 * Props Builder（Player 与 Renderer 共用，§二十三）：
 * locked scenes → 双校验 → system-owned metadata → FullCutData → final M1 schema parse。
 */
export function buildWorkflowRenderProps(
  projectId: string,
  options: RenderReadinessOptions = {},
): WorkflowRenderProps {
  const fileExists = options.fileExists ?? defaultAssetFileExists;
  const project = getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(projectId) as
    | {id: string; title: string; template_version: string; composition_id: string}
    | undefined;
  if (!project) {
    throw new RenderBridgeError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
  }
  if (isLegacyM1Project(projectId)) {
    throw new RenderBridgeError('LEGACY_PROJECT', 'Legacy M1 项目走原渲染链，不经 Render Bridge');
  }
  if (project.template_version !== TEMPLATE_VERSION || project.composition_id !== COMPOSITION_ID) {
    throw new RenderBridgeError(
      'UNSUPPORTED_TEMPLATE',
      `不支持的 template/composition：${project.template_version}/${project.composition_id}`,
    );
  }

  const source = loadLockedScenesSource(projectId);
  const assetBlockers = collectAssetBlockers(
    source.parsed,
    [PREVIEW_AUDIO.narration, PREVIEW_AUDIO.bgm, PREVIEW_AUDIO.sfx],
    fileExists,
  );
  if (assetBlockers.length > 0) {
    throw new RenderBridgeError('ASSET_FILE_MISSING', assetBlockers[0]!.message, {
      missing: assetBlockers.map((b) => b.message),
    });
  }

  // System-owned metadata（AI 只负责 chapterTiming + scenes；其余系统构造）
  // width/height 由 M1 projectMetaSchema 默认值统一提供（1920×1080，不再硬编码第二份）
  const durationSec = source.parsed.scenes[source.parsed.scenes.length - 1]!.end;
  // M6：注入 assetMap（已绑定的真实素材，含 provenance）
  const assetMap = buildAssetMap(projectId, source.parsed.scenes);
  const props: ZhiyingFullCutProps = zhiyingFullCutPropsSchema.parse({
    data: {
      schemaVersion: SCHEMA_VERSION,
      templateVersion: project.template_version,
      project: {
        title: project.title,
        composition: project.composition_id,
        fps: SCENES_SYSTEM_FPS,
        durationSec,
        durationInFrames: Math.round(durationSec * SCENES_SYSTEM_FPS),
      },
      chapterTiming: source.parsed.chapterTiming,
      scenes: source.parsed.scenes,
      assetMap,
    },
    subtitles: [],
    audio: {...PREVIEW_AUDIO},
    showSubtitles: false,
  });
  return {props, scenesVersion: source.scenesVersion};
}

/**
 * 原子入队（M2-E-C §十九/二十）：单个 BEGIN IMMEDIATE 内完成——
 * render readiness（scenes locked + source 双校验 + 资产）→ active render guard →
 * INSERT render_job（kind='no-subtitles'）→ INSERT artifact(kind='render_source')
 * 记录 {jobId, scenesVersion}（render job 是 locked Scenes version 的 immutable snapshot）。
 * 不自动 render；仅人工显式触发。
 */
export function enqueueWorkflowPreviewRender(
  projectId: string,
  options: RenderReadinessOptions = {},
): {job: RenderJobRow; scenesVersion: number} {
  const db = getDb();
  const tx = db.transaction((): {job: RenderJobRow; scenesVersion: number} => {
    // 事务内重做 readiness（authoritative fence；Route 的 check 只是 UX 预检）
    const {props, scenesVersion} = buildWorkflowRenderProps(projectId, options);
    const active = db
      .prepare(
        `SELECT id, progress, progress_detail FROM render_jobs
         WHERE project_id = ? AND status IN ('queued', 'running')
         ORDER BY queued_at ASC LIMIT 1`,
      )
      .get(projectId) as {id: string; progress: number; progress_detail: string | null} | undefined;
    if (active) {
      throw new RenderBridgeError(
        'RENDER_ALREADY_ACTIVE',
        `已有渲染任务进行中：${summarizeRenderProgress(active.progress, active.progress_detail)}`,
      );
    }
    const job = enqueueRenderJob(projectId, 'no-subtitles', props);
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, 'render_source',
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = 'render_source'),
         ?, NULL, ?)`,
    ).run(
      crypto.randomUUID(),
      projectId,
      projectId,
      JSON.stringify({jobId: job.id, scenesVersion}),
      new Date().toISOString(),
    );
    return {job, scenesVersion};
  });
  return tx.immediate();
}

/** 查询 render job 对应的 scenes source version（render_source artifact）。 */
export function getRenderSourceVersion(jobId: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT content_json FROM artifacts
       WHERE kind = 'render_source' AND content_json LIKE ?`,
    )
    .get(`%"jobId":"${jobId}"%`) as {content_json: string} | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content_json) as {scenesVersion?: number};
    return typeof parsed.scenesVersion === 'number' ? parsed.scenesVersion : null;
  } catch {
    return null;
  }
}

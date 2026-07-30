/**
 * M6.3.13：scene 级「改用 MG」视觉策略覆盖（scene_visual_overrides）。
 *
 * 设计约束：
 * - 不编辑 scenes artifact —— bridge whole-generation invariant 要求 reconciliation
 *   引用的 scenesVersionId 等于当前 locked 版本，切 MG 必须走独立 override 表 +
 *   props/readiness/resolver 构建时应用（与本模块 applyVisualOverrides 唯一入口）。
 * - override 携带创建时的 scenes_version_id（locked 版本行 id）；scenes 重新生成 /
 *   锁定新版本后 version 漂移 → override 自动失效（跳过，不报错），scene 的
 *   requirements 回到 readiness 分母，旧 bindings（active=0 历史）不自动恢复。
 * - 切换单事务：upsert override + 该 scene 全部 requirements deactivate binding
 *   （历史保留）+ clearResolutionState。
 */
import {getDb} from '../db';
import type {IdentifiedRequirement, Scene} from '../scene-schema';
import {validateTemplateProps} from './mg-templates';
import {deactivateBindingForRequirement, clearResolutionState} from '../assets/model';
import {authenticityOf, type SceneAssetPlan} from '../assets/requirements';

export interface SceneVisualOverrideRow {
  project_id: string;
  scene_id: string;
  scenes_version_id: string;
  strategy: string;
  template: string;
  template_props: string;
  created_at: string;
}

export interface SceneVisualOverride {
  sceneId: string;
  scenesVersionId: string;
  strategy: string;
  template: string;
  templateProps: Record<string, unknown>;
}

// ---------- DB CRUD ----------

function toOverride(row: SceneVisualOverrideRow): SceneVisualOverride | null {
  let templateProps: Record<string, unknown>;
  try {
    templateProps = JSON.parse(row.template_props) as Record<string, unknown>;
  } catch {
    return null; // 坏行视为不存在（不 crash 不 DELETE，同项目既有惯例）
  }
  return {
    sceneId: row.scene_id,
    scenesVersionId: row.scenes_version_id,
    strategy: row.strategy,
    template: row.template,
    templateProps,
  };
}

export function listVisualOverrides(projectId: string): SceneVisualOverride[] {
  const rows = getDb()
    .prepare('SELECT * FROM scene_visual_overrides WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as SceneVisualOverrideRow[];
  return rows.map(toOverride).filter((o): o is SceneVisualOverride => o !== null);
}

export function getVisualOverride(projectId: string, sceneId: string): SceneVisualOverride | null {
  const row = getDb()
    .prepare('SELECT * FROM scene_visual_overrides WHERE project_id = ? AND scene_id = ?')
    .get(projectId, sceneId) as SceneVisualOverrideRow | undefined;
  return row ? toOverride(row) : null;
}

export function upsertVisualOverride(input: {
  projectId: string;
  sceneId: string;
  scenesVersionId: string;
  template: string;
  templateProps: Record<string, unknown>;
}): void {
  getDb()
    .prepare(
      `INSERT INTO scene_visual_overrides
         (project_id, scene_id, scenes_version_id, strategy, template, template_props, created_at)
       VALUES (?, ?, ?, 'mg', ?, ?, ?)
       ON CONFLICT (project_id, scene_id)
       DO UPDATE SET scenes_version_id = excluded.scenes_version_id,
         strategy = excluded.strategy, template = excluded.template,
         template_props = excluded.template_props, created_at = excluded.created_at`,
    )
    .run(
      input.projectId,
      input.sceneId,
      input.scenesVersionId,
      input.template,
      JSON.stringify(input.templateProps),
      new Date().toISOString(),
    );
}

export function deleteVisualOverride(projectId: string, sceneId: string): void {
  getDb()
    .prepare('DELETE FROM scene_visual_overrides WHERE project_id = ? AND scene_id = ?')
    .run(projectId, sceneId);
}

// ---------- 当前 scenes 版本（locked 优先，fallback 最新） ----------

/**
 * override 失效判定的版本基准：stage locked 时取 locked_version 对应版本行 id；
 * 未锁定时取最新版本行 id（asset 工具路由读的就是最新版本，保持同一基准）。
 */
export function currentScenesVersionId(projectId: string): string | null {
  const db = getDb();
  const stage = db
    .prepare("SELECT locked_version FROM project_stages WHERE project_id = ? AND stage = 'scenes'")
    .get(projectId) as {locked_version: number | null} | undefined;
  if (stage?.locked_version != null) {
    const row = db
      .prepare("SELECT id FROM project_versions WHERE project_id = ? AND stage = 'scenes' AND version = ?")
      .get(projectId, stage.locked_version) as {id: string} | undefined;
    if (row) return row.id;
  }
  const latest = db
    .prepare("SELECT id FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1")
    .get(projectId) as {id: string} | undefined;
  return latest?.id ?? null;
}

/** 加载当前 scenes（locked 优先）→ 版本行 id + zod 解析后的 scenes。 */
export function loadCurrentScenes(projectId: string): {versionId: string; version: number; scenes: Scene[]} | null {
  const db = getDb();
  const stage = db
    .prepare("SELECT locked_version FROM project_stages WHERE project_id = ? AND stage = 'scenes'")
    .get(projectId) as {locked_version: number | null} | undefined;
  let row: {id: string; version: number; content: string} | undefined;
  if (stage?.locked_version != null) {
    row = db
      .prepare("SELECT id, version, content FROM project_versions WHERE project_id = ? AND stage = 'scenes' AND version = ?")
      .get(projectId, stage.locked_version) as typeof row;
  }
  row ??= db
    .prepare("SELECT id, version, content FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1")
    .get(projectId) as typeof row;
  if (!row?.content) return null;
  try {
    const parsed = JSON.parse(row.content) as {scenes?: Scene[]};
    if (!Array.isArray(parsed.scenes)) return null;
    return {versionId: row.id, version: row.version, scenes: parsed.scenes};
  } catch {
    return null;
  }
}

// ---------- 生效判定 ----------

/** version 匹配（未失效）的 override。 */
export function listActiveVisualOverrides(projectId: string, scenesVersionId: string | null): SceneVisualOverride[] {
  if (!scenesVersionId) return [];
  return listVisualOverrides(projectId).filter((o) => o.scenesVersionId === scenesVersionId);
}

/** 该 scene 当前是否有生效中的 MG override（acquire/generate/upload/bind 守卫用）。 */
export function isSceneVisuallyOverridden(projectId: string, sceneId: string): boolean {
  const override = getVisualOverride(projectId, sceneId);
  if (!override) return false;
  return override.scenesVersionId === currentScenesVersionId(projectId);
}

/** 当前生效 override 的 sceneId 集合（全量 acquire 跳过用）。 */
export function activeOverrideSceneIds(projectId: string): Set<string> {
  return new Set(
    listActiveVisualOverrides(projectId, currentScenesVersionId(projectId)).map((o) => o.sceneId),
  );
}

// ---------- 纯函数：scene 输入处应用 ----------

/**
 * 把生效 override 应用到 scenes（渲染/readiness/resolver 的统一入口）：
 * 命中且 scenes_version_id === currentScenesVersionId 的 scene → category/visualType
 * 切 MG + template/sourceTemplate/templateProps 注入；start/end/duration/
 * narrationSummary 等一切其他字段不动。version 不匹配 → 跳过（视为失效）。
 */
export function applyVisualOverrides(
  scenes: Scene[],
  overrides: SceneVisualOverride[],
  currentVersionId: string | null,
): Scene[] {
  if (!currentVersionId || overrides.length === 0) return scenes;
  const active = new Map(
    overrides.filter((o) => o.scenesVersionId === currentVersionId).map((o) => [o.sceneId, o]),
  );
  if (active.size === 0) return scenes;
  return scenes.map((scene) => {
    const o = active.get(scene.id);
    if (!o) return scene;
    return {
      ...scene,
      category: 'MG',
      visualType: 'MG',
      template: o.template,
      sourceTemplate: o.template,
      templateProps: o.templateProps,
    };
  });
}

// ---------- eligibility ----------

export type MgSwitchEligibility = {ok: true} | {ok: false; reason: string};

/**
 * 改用 MG 的语义闸门（与 AI fallback 的 authenticity 闸门同源）：
 * 任一 requirement 为 authentic_required → 禁止（MG 同样是对真实史料的替代）。
 */
export function canSwitchToMg(plan: SceneAssetPlan): MgSwitchEligibility {
  for (const req of plan.requirements) {
    if (authenticityOf(plan.category, req) === 'authentic_required') {
      return {ok: false, reason: '该镜头需要真实历史素材，不能改用 MG 模板画面'};
    }
  }
  return {ok: true};
}

// ---------- deterministic MG props 构建（v1 不接 LLM） ----------

const MESSAGE_MAX_LEN = 120;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * 从 scene 的 narrationSummary/description deterministic 构建 MG templateProps：
 * - 文案含 ≥2 个年份 → MG_Timeline（事件按出现顺序，去重）；
 * - 否则 → MG_MessageFocus（message = 摘要，截断到渲染安全长度）。
 * 两层都过 validateTemplateProps；构建不出合法 props → null（调用方 409）。
 */
export function buildMgPreviewProps(
  scene: Scene,
): {template: string; templateProps: Record<string, unknown>} | null {
  const text = `${scene.narrationSummary} ${scene.description}`;
  const years = [...new Set(text.match(/(?:18|19|20)\d{2}/g) ?? [])];

  if (years.length >= 2) {
    const props: Record<string, unknown> = {
      title: clip(scene.chapterTitle, 40) || '时间线',
      events: years.slice(0, 8).map((y) => ({label: y, time: y})),
      caption: clip(scene.narrationSummary, 60) || undefined,
    };
    if (validateTemplateProps('MG_Timeline', props).ok) {
      return {template: 'MG_Timeline', templateProps: props};
    }
  }

  // 兜底：单一关键信息聚焦（message = 摘要截断到 schema 上限/渲染安全长度）
  const message = clip(scene.narrationSummary, MESSAGE_MAX_LEN) || clip(scene.description, MESSAGE_MAX_LEN);
  if (!message) return null;
  const props: Record<string, unknown> = {
    message,
    context: clip(scene.chapterTitle, 40) || undefined,
  };
  if (!validateTemplateProps('MG_MessageFocus', props).ok) return null;
  return {template: 'MG_MessageFocus', templateProps: props};
}

// ---------- 切换 / 改回（API 层组合；切换为单事务） ----------

/**
 * 单事务切 MG：upsert override（含当前 scenes 版本行 id）+ 该 scene 全部
 * requirements deactivate binding（历史保留）+ clearResolutionState。
 * 调用方必须先完成 eligibility + validateTemplateProps 校验（本函数不重复校验）。
 */
export function switchSceneToMg(input: {
  projectId: string;
  sceneId: string;
  scenesVersionId: string;
  template: string;
  templateProps: Record<string, unknown>;
  requirements: IdentifiedRequirement[];
}): void {
  const db = getDb();
  const tx = db.transaction((): void => {
    upsertVisualOverride({
      projectId: input.projectId,
      sceneId: input.sceneId,
      scenesVersionId: input.scenesVersionId,
      template: input.template,
      templateProps: input.templateProps,
    });
    for (const req of input.requirements) {
      deactivateBindingForRequirement(input.projectId, input.sceneId, req.requirementId);
      clearResolutionState(input.projectId, input.sceneId, req.requirementId);
    }
  });
  tx.immediate();
}

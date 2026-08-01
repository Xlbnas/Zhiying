/**
 * M6 Visual Asset 数据模型（真实媒体素材，含 provenance）。
 * 素材文件存 public/assets/{projectId}/{assetId}.{ext}（staticFile 可直接消费）。
 */

import crypto from 'node:crypto';
import {getDb} from '../db';
import type {AssetRequirement} from '../scene-schema';

export interface AssetRow {
  id: string;
  project_id: string;
  scene_id: string | null;
  media_type: 'image' | 'video';
  source_type: 'archive' | 'stock' | 'generated' | 'upload' | 'local';
  source_provider: string;
  source_url: string | null;
  local_path: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  license_status: 'usable' | 'review_required' | 'blocked' | 'user_provided' | 'generated';
  license_note: string | null;
  attribution: string | null;
  description: string | null;
  requirement_json: string | null;
  provenance_json: string | null;
  created_at: string;
}

/**
 * M7.3A.3：generated asset 的严格 provenance（独立于 requirement_json 本体，
 * 兼容历史纯 requirement_json 资产）。
 * M7.3A.3.2：新 generated asset 的严格 provenance 全部字段必填
 * （assetGenerationJobId / requestId 不得为 null）。
 */
export interface StrictAssetProvenance {
  sourceScenesVersionId: string;
  sourceRequirementHash: string;
  assetGenerationJobId: string;
  requestId: string;
  /** 'current' = 来源与当前 scenes 匹配；'stale' = 来源已漂移/lease lost，仅历史。 */
  relevance: 'current' | 'stale';
  staleReason: string | null;
}

export interface AssetProvenance {
  sourceScenesVersionId: string | null;
  sourceRequirementHash: string | null;
  assetGenerationJobId: string | null;
  requestId: string | null;
  relevance: 'current' | 'stale';
  staleReason?: string | null;
}

/**
 * M7.3A.3.2：三态 provenance 解析。
 * - provenance_json === NULL → legacy（历史兼容路径）；
 * - provenance_json 非 NULL 且结构完整严格 → valid；
 * - provenance_json 非 NULL 但 JSON 无法解析 / 必填字段缺失 / relevance 非法
 *   → invalid（禁止绑定，绝不降级为 legacy）。
 */
export type ParsedAssetProvenance =
  | {kind: 'legacy'}
  | {kind: 'valid'; value: StrictAssetProvenance}
  | {kind: 'invalid'; issues: string[]};

const REQUIRED_STRICT_FIELDS: Array<[keyof StrictAssetProvenance, string]> = [
  ['sourceScenesVersionId', 'sourceScenesVersionId'],
  ['sourceRequirementHash', 'sourceRequirementHash'],
  ['assetGenerationJobId', 'assetGenerationJobId'],
  ['requestId', 'requestId'],
];

export function parseAssetProvenanceStrict(row: {provenance_json: string | null}): ParsedAssetProvenance {
  if (row.provenance_json === null || row.provenance_json === undefined) {
    return {kind: 'legacy'};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.provenance_json);
  } catch {
    return {kind: 'invalid', issues: ['provenance_json 不是合法 JSON']};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {kind: 'invalid', issues: ['provenance_json 不是对象']};
  }
  const issues: string[] = [];
  const p = parsed as Record<string, unknown>;
  if (p.relevance !== 'current' && p.relevance !== 'stale') {
    issues.push(`relevance 非法（${String(p.relevance)}）`);
  }
  for (const [key, label] of REQUIRED_STRICT_FIELDS) {
    const v = p[key];
    if (typeof v !== 'string' || v.length === 0) {
      issues.push(`${label} 缺失`);
    }
  }
  if (issues.length > 0) {
    return {kind: 'invalid', issues};
  }
  return {
    kind: 'valid',
    value: {
      sourceScenesVersionId: p.sourceScenesVersionId as string,
      sourceRequirementHash: p.sourceRequirementHash as string,
      assetGenerationJobId: p.assetGenerationJobId as string,
      requestId: p.requestId as string,
      relevance: p.relevance as 'current' | 'stale',
      staleReason: typeof p.staleReason === 'string' ? p.staleReason : null,
    },
  };
}

/** 兼容旧调用方：宽松解析（仅 relevance 校验）；M7.3A.3.2 起新代码应使用三态版本。 */
export function parseAssetProvenance(row: {provenance_json: string | null}): AssetProvenance | null {
  if (!row.provenance_json) return null;
  try {
    const parsed = JSON.parse(row.provenance_json) as AssetProvenance;
    return typeof parsed.relevance === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export interface NewAsset {
  /** M7.3A.3.1：可选显式 id（原子 commit 需要 job.result_asset_id 与 asset 行精确一致）。 */
  id?: string;
  projectId: string;
  sceneId: string | null;
  mediaType: 'image' | 'video';
  sourceType: AssetRow['source_type'];
  sourceProvider: string;
  sourceUrl?: string | null;
  localPath: string;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  licenseStatus: AssetRow['license_status'];  // usable | review_required | blocked | user_provided
  licenseNote?: string | null;
  attribution?: string | null;
  description?: string | null;
  requirement?: AssetRequirement | null;
  provenance?: AssetProvenance | null;
}

export function insertAsset(input: NewAsset): AssetRow {
  const id = input.id ?? crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO assets (
      id, project_id, scene_id, media_type, source_type, source_provider,
      source_url, local_path, mime_type, width, height, duration_ms,
      license_status, license_note, attribution, description,
      requirement_json, provenance_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.sceneId,
    input.mediaType,
    input.sourceType,
    input.sourceProvider,
    input.sourceUrl ?? null,
    input.localPath,
    input.mimeType ?? null,
    input.width ?? null,
    input.height ?? null,
    input.durationMs ?? null,
    input.licenseStatus,
    input.licenseNote ?? null,
    input.attribution ?? null,
    input.description ?? null,
    input.requirement ? JSON.stringify(input.requirement) : null,
    input.provenance ? JSON.stringify(input.provenance) : null,
    new Date().toISOString(),
  );
  return getAssetById(id)!;
}

export function getAssetById(id: string): AssetRow | undefined {
  return getDb().prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
}

export function listAssetsForProject(projectId: string): AssetRow[] {
  return getDb()
    .prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as AssetRow[];
}

export function deleteAssetsForProject(projectId: string): void {
  getDb().prepare('DELETE FROM assets WHERE project_id = ?').run(projectId);
}

// ---------- M6.3.8：显式 asset→requirement binding ----------

export interface AssetBindingRow {
  id: string;
  project_id: string;
  scene_id: string;
  requirement_id: string;
  asset_id: string;
  active: number;
  created_at: string;
}

export interface NewBinding {
  projectId: string;
  sceneId: string;
  requirementId: string;
  assetId: string;
}

/**
 * 绑定 asset 到 exact requirement（replace 语义）：
 * 同一事务内 deactivate 该 requirement 全部现有 binding + 插入新 active binding。
 * 旧 asset 行 / 文件 / provenance 一律保留（历史 binding active=0）。
 */
export function bindAssetToRequirement(input: NewBinding): AssetBindingRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const tx = db.transaction((): void => {
    db.prepare(
      `UPDATE asset_bindings SET active = 0
       WHERE project_id = ? AND scene_id = ? AND requirement_id = ? AND active = 1`,
    ).run(input.projectId, input.sceneId, input.requirementId);
    db.prepare(
      `INSERT INTO asset_bindings (id, project_id, scene_id, requirement_id, asset_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.projectId, input.sceneId, input.requirementId, input.assetId, new Date().toISOString());
  });
  tx();
  return getDb().prepare('SELECT * FROM asset_bindings WHERE id = ?').get(id) as AssetBindingRow;
}

/** 解除 exact requirement 的 active binding（保留历史行 active=0）。 */
export function deactivateBindingForRequirement(
  projectId: string,
  sceneId: string,
  requirementId: string,
): void {
  getDb()
    .prepare(
      `UPDATE asset_bindings SET active = 0
       WHERE project_id = ? AND scene_id = ? AND requirement_id = ? AND active = 1`,
    )
    .run(projectId, sceneId, requirementId);
}

export function getActiveBinding(
  projectId: string,
  sceneId: string,
  requirementId: string,
): AssetBindingRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM asset_bindings
       WHERE project_id = ? AND scene_id = ? AND requirement_id = ? AND active = 1`,
    )
    .get(projectId, sceneId, requirementId) as AssetBindingRow | undefined;
}

export function listActiveBindingsForProject(projectId: string): AssetBindingRow[] {
  return getDb()
    .prepare('SELECT * FROM asset_bindings WHERE project_id = ? AND active = 1 ORDER BY created_at ASC')
    .all(projectId) as AssetBindingRow[];
}

export function listBindingsForProject(projectId: string): AssetBindingRow[] {
  return getDb()
    .prepare('SELECT * FROM asset_bindings WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as AssetBindingRow[];
}

// ---------- M6.3.9：per-requirement 解析尝试状态（展示层元数据，非 readiness） ----------

export interface AssetResolutionStateRow {
  project_id: string;
  scene_id: string;
  requirement_id: string;
  status: 'no_result' | 'download_failed' | 'generation_failed' | 'policy_blocked';
  reason: string | null;
  queries_tried: string | null;
  provider: string | null;
  /** M7：JSON 元数据（attemptId, providerRequestId, failurePhase, model, prompt）。 */
  metadata: string | null;
  updated_at: string;
}

export interface ResolutionStateMetadata {
  attemptId?: string;
  requestId?: string;
  providerRequestId?: string;
  failurePhase?: string;
  model?: string;
  prompt?: string;
  elapsedMs?: number;
}

export interface NewResolutionState {
  projectId: string;
  sceneId: string;
  requirementId: string;
  status: AssetResolutionStateRow['status'];
  reason?: string | null;
  queriesTried?: string[];
  provider?: string | null;
  metadata?: ResolutionStateMetadata | null;
}

/** 记录某 requirement 最近一次解析尝试的失败结果（成功时由调用方 clear）。 */
export function upsertResolutionState(input: NewResolutionState): void {
  getDb()
    .prepare(
      `INSERT INTO asset_resolution_state
         (project_id, scene_id, requirement_id, status, reason, queries_tried, provider, metadata, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, scene_id, requirement_id)
       DO UPDATE SET status = excluded.status, reason = excluded.reason,
         queries_tried = excluded.queries_tried, provider = excluded.provider,
         metadata = excluded.metadata, updated_at = excluded.updated_at`,
    )
    .run(
      input.projectId,
      input.sceneId,
      input.requirementId,
      input.status,
      input.reason ?? null,
      JSON.stringify(input.queriesTried ?? []),
      input.provider ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      new Date().toISOString(),
    );
}

/** 解析成功（bind/upload/generate 成功）后清除失败状态。 */
export function clearResolutionState(projectId: string, sceneId: string, requirementId: string): void {
  getDb()
    .prepare(
      'DELETE FROM asset_resolution_state WHERE project_id = ? AND scene_id = ? AND requirement_id = ?',
    )
    .run(projectId, sceneId, requirementId);
}

export function listResolutionStatesForProject(projectId: string): AssetResolutionStateRow[] {
  return getDb()
    .prepare('SELECT * FROM asset_resolution_state WHERE project_id = ?')
    .all(projectId) as AssetResolutionStateRow[];
}

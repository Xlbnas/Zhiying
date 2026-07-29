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
  license_status: 'usable' | 'review_required' | 'blocked' | 'user_provided';
  license_note: string | null;
  attribution: string | null;
  description: string | null;
  requirement_json: string | null;
  created_at: string;
}

export interface NewAsset {
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
}

export function insertAsset(input: NewAsset): AssetRow {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO assets (
      id, project_id, scene_id, media_type, source_type, source_provider,
      source_url, local_path, mime_type, width, height, duration_ms,
      license_status, license_note, attribution, description,
      requirement_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function listUsableAssetsForScene(projectId: string, sceneId: string): AssetRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM assets
       WHERE project_id = ? AND scene_id = ? AND license_status = 'usable'
       ORDER BY created_at ASC`,
    )
    .all(projectId, sceneId) as AssetRow[];
}

export function deleteAssetsForProject(projectId: string): void {
  getDb().prepare('DELETE FROM assets WHERE project_id = ?').run(projectId);
}

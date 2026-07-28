/**
 * M6 Asset Acquisition Flow：Compile → Acquire → Validate → Bind。
 * 单项目、单 scene 归属由程序保证；provider 只负责搜索/下载。
 */

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {getDb} from '../db';
import type {AssetRequirement} from '../scene-schema';
import {insertAsset, listUsableAssetsForScene, type AssetRow} from './model';
import {compileAssetPlans, type SceneAssetPlan} from './requirements';
import {AssetProviderError, type AssetProvider, type AssetSearchHit} from './providers/types';
import {WikimediaCommonsProvider} from './providers/wikimedia';

export interface AcquireResult {
  sceneId: string;
  status: 'bound' | 'acquired' | 'no_result' | 'policy_blocked' | 'failed';
  assetId?: string;
  reason?: string;
}

export interface AcquireSummary {
  acquired: number;
  reused: number;
  failed: number;
  results: AcquireResult[];
}

const PROVIDERS: Record<string, () => AssetProvider> = {
  public_domain: () => new WikimediaCommonsProvider(),
};

function providerFor(policy: AssetRequirement['policy']): AssetProvider | null {
  // stock / generated：本轮无可用 provider（不静默降级到错误来源）
  return PROVIDERS[policy]?.() ?? null;
}

function publicRoot(): string {
  return path.join(process.cwd(), 'public');
}

function extForMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

function probeImage(absPath: string): {width: number | null; height: number | null} {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', absPath,
    ], {encoding: 'utf8', timeout: 15_000}).trim();
    const [w, h] = out.split(',').map((x) => Number.parseInt(x, 10));
    return {width: Number.isFinite(w) ? w : null, height: Number.isFinite(h) ? h : null};
  } catch {
    return {width: null, height: null};
  }
}

function pickHit(hits: AssetSearchHit[]): {hit?: AssetSearchHit; blockedReason?: string} {
  const usable = hits.find((h) => h.licenseStatus === 'usable');
  if (usable) return {hit: usable};
  if (hits.length > 0) return {blockedReason: `候选素材许可不可自动使用（${hits[0]!.licenseNote}）`};
  return {};
}

async function acquireOne(
  projectId: string,
  plan: SceneAssetPlan,
  requirement: AssetRequirement,
): Promise<AcquireResult> {
  const provider = providerFor(requirement.policy);
  if (!provider) {
    return {sceneId: plan.sceneId, status: 'policy_blocked', reason: `暂无可用的 ${requirement.policy} provider`};
  }
  let hits: AssetSearchHit[];
  try {
    hits = await provider.search(requirement, 3);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {sceneId: plan.sceneId, status: 'failed', reason};
  }
  const {hit, blockedReason} = pickHit(hits);
  if (!hit) {
    return blockedReason
      ? {sceneId: plan.sceneId, status: 'policy_blocked', reason: blockedReason}
      : {sceneId: plan.sceneId, status: 'no_result', reason: `未找到素材：${requirement.query}`};
  }
  const assetId = crypto.randomUUID();
  const ext = extForMime(hit.mimeType);
  const relPath = path.posix.join('assets', projectId, `${assetId}.${ext}`);
  const absPath = path.join(publicRoot(), relPath);
  try {
    await provider.download(hit, absPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {sceneId: plan.sceneId, status: 'failed', reason};
  }
  const stat = fs.statSync(absPath);
  if (stat.size < 1024) {
    fs.rmSync(absPath, {force: true});
    return {sceneId: plan.sceneId, status: 'failed', reason: '下载文件过小，校验失败'};
  }
  const dims = probeImage(absPath);
  const row = insertAsset({
    projectId,
    sceneId: plan.sceneId,
    mediaType: 'image',
    sourceType: requirement.policy === 'public_domain' ? 'archive' : 'generated',
    sourceProvider: provider.name,
    sourceUrl: hit.sourceUrl,
    localPath: relPath,
    mimeType: hit.mimeType,
    width: dims.width,
    height: dims.height,
    licenseStatus: hit.licenseStatus,
    licenseNote: hit.licenseNote,
    attribution: hit.attribution,
    description: hit.description || requirement.subject,
    requirement,
  });
  return {sceneId: plan.sceneId, status: 'acquired', assetId: row.id};
}

/**
 * 对项目 locked scenes 执行素材获取（已绑定 usable 素材的场景跳过）。
 * scenesJson = locked scenes artifact 内容。
 */
export async function acquireAssetsForProject(projectId: string): Promise<AcquireSummary> {
  const row = getDb().prepare(
    `SELECT content FROM project_versions
     WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as {content: string} | undefined;
  if (!row) throw new Error('项目缺少 scenes artifact');
  const plans = compileAssetPlans(row.content);
  const results: AcquireResult[] = [];
  for (const plan of plans) {
    if (!plan.needsAssets) continue;
    const existing = listUsableAssetsForScene(projectId, plan.sceneId);
    if (existing.length > 0) {
      results.push({sceneId: plan.sceneId, status: 'bound', assetId: existing[0]!.id});
      continue;
    }
    // 逐 requirement 尝试，任一成功即绑定
    let done: AcquireResult | null = null;
    for (const req of plan.requirements) {
      // eslint-disable-next-line no-await-in-loop
      const r = await acquireOne(projectId, plan, req);
      if (r.status === 'acquired') {
        done = r;
        break;
      }
      done = r;
    }
    results.push(done ?? {sceneId: plan.sceneId, status: 'failed', reason: '无可用 requirement'});
  }
  return {
    acquired: results.filter((r) => r.status === 'acquired').length,
    reused: results.filter((r) => r.status === 'bound').length,
    failed: results.filter((r) => r.status !== 'acquired' && r.status !== 'bound').length,
    results,
  };
}

/**
 * M6 Asset Acquisition Flow：Compile → Acquire → Validate → Bind。
 * 单项目、单 scene 归属由程序保证；provider 只负责搜索/下载。
 *
 * M6.3.8：per-requirement 获取 + exact binding。
 * - 已存在 active binding 的 requirement 跳过；其余逐个搜索/下载/绑定。
 * - 下载成功后 insertAsset + bindAssetToRequirement（exact requirementId）。
 * - 不再有 scene 级 skip，不再"任一成功即停"。
 */

import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {IdentifiedRequirement} from '../scene-schema';
import {
  bindAssetToRequirement,
  clearResolutionState,
  getActiveBinding,
  insertAsset,
  upsertResolutionState,
} from './model';
import {
  findRequirementInPlans,
  loadLatestScenesPlans,
  type SceneAssetPlan,
} from './requirements';
import {activeOverrideSceneIds, isSceneVisuallyOverridden} from '../scenes/visual-overrides';
import {type AssetProvider, type AssetSearchHit} from './providers/types';
import {WikimediaCommonsProvider} from './providers/wikimedia';

export interface AcquireResult {
  sceneId: string;
  requirementId: string;
  status: 'bound' | 'acquired' | 'no_result' | 'download_failed' | 'policy_blocked' | 'failed';
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

function providerFor(policy: IdentifiedRequirement['policy']): AssetProvider | null {
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

/** 从一个 requirement 生成最多 MAX_QUERIES 个搜索查询（优先英文 + 实体）。 */
function buildSearchQueries(req: IdentifiedRequirement): string[] {
  const queries: string[] = [req.query];
  const subject = req.subject.trim();
  // 如果原始 query 是中文，尝试提取英文实体/关键词
  // 简单策略：移除描述性词汇，生成短查询
  if (/[一-鿿]/.test(req.query)) {
    // 保留原始中文 query，同时尝试更短的变体
    const words = subject.replace(/[，,、；;。．\s]+/g, ' ').trim().split(/\s+/);
    if (words.length >= 3) queries.push(words.slice(0, 2).join(' '));
    if (words.length >= 4) queries.push(words.slice(0, 1).join(' '));
    // 移除括号内容和描述词
    const noParens = subject.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
    if (noParens !== subject) queries.push(noParens);
  }
  // 去重，限制数量
  return [...new Set(queries)].slice(0, 5);
}

/**
 * M6.3.9：把一次 requirement 获取的最终结果持久化为解析状态（展示层元数据，非 readiness）。
 * 成功 → 清除失败状态；可解释的失败 → 记录（no_result/download_failed/policy_blocked）；
 * 'failed'（搜索异常等瞬态错误）不持久化 —— 瞬态错误已在 POST 响应中告知用户。
 */
function persistOutcome(
  projectId: string,
  requirement: IdentifiedRequirement,
  queries: string[],
  result: AcquireResult,
): AcquireResult {
  if (result.status === 'acquired' || result.status === 'bound') {
    clearResolutionState(projectId, result.sceneId, result.requirementId);
    return result;
  }
  if (result.status === 'no_result' || result.status === 'download_failed' || result.status === 'policy_blocked') {
    upsertResolutionState({
      projectId,
      sceneId: result.sceneId,
      requirementId: result.requirementId,
      status: result.status,
      reason: result.reason ?? null,
      queriesTried: queries,
      provider: providerFor(requirement.policy)?.name ?? requirement.policy,
    });
  }
  return result;
}

async function acquireWithRetry(
  projectId: string,
  plan: SceneAssetPlan,
  requirement: IdentifiedRequirement,
  maxRetries = 3,
): Promise<AcquireResult> {
  const base = {sceneId: plan.sceneId, requirementId: requirement.requirementId};
  const provider = providerFor(requirement.policy);
  if (!provider) {
    return {...base, status: 'policy_blocked', reason: `暂无可用的 ${requirement.policy} provider`};
  }

  const queries = buildSearchQueries(requirement);
  let lastResult: AcquireResult | null = null;

  for (const query of queries) {
    if (query !== requirement.query) {
      // 修改 requirement 的 query 进行 fallback 搜索
      const altReq: IdentifiedRequirement = {...requirement, query};
      try {
        const hits = await provider.search(altReq, 3);
        const {hit, blockedReason} = pickHit(hits);
        if (!hit) {
          if (blockedReason) lastResult = {...base, status: 'policy_blocked', reason: blockedReason};
          else lastResult = {...base, status: 'no_result', reason: `未找到素材：${query}`};
          continue;
        }
        const result = await downloadAndInsert(projectId, plan.sceneId, requirement, hit, provider.name);
        if (result.status === 'acquired') return persistOutcome(projectId, requirement, queries, result);
        lastResult = result;
      } catch (err) {
        lastResult = {...base, status: 'failed', reason: err instanceof Error ? err.message : String(err)};
      }
    } else {
      // 原始 query，支持下载重试
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const hits = await provider.search(requirement, 3);
          const {hit, blockedReason} = pickHit(hits);
          if (!hit) {
            if (blockedReason) { lastResult = {...base, status: 'policy_blocked', reason: blockedReason}; break; }
            lastResult = {...base, status: 'no_result', reason: `未找到素材：${requirement.query}`};
            break;
          }
          const result = await downloadAndInsert(projectId, plan.sceneId, requirement, hit, provider.name);
          if (result.status === 'acquired') return persistOutcome(projectId, requirement, queries, result);
          if (result.status === 'download_failed' && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1))); // exponential backoff
            continue;
          }
          lastResult = result;
          break;
        } catch (err) {
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
            continue;
          }
          lastResult = {...base, status: 'failed', reason: err instanceof Error ? err.message : String(err)};
        }
      }
    }
  }

  return persistOutcome(
    projectId,
    requirement,
    queries,
    lastResult ?? {...base, status: 'no_result', reason: `所有查询均无结果：${requirement.subject}`},
  );
}

async function downloadAndInsert(
  projectId: string,
  sceneId: string,
  requirement: IdentifiedRequirement,
  hit: AssetSearchHit,
  providerName: string,
): Promise<AcquireResult> {
  const assetId = crypto.randomUUID();
  const ext = extForMime(hit.mimeType);
  const relPath = path.posix.join('assets', projectId, `${assetId}.${ext}`);
  const absPath = path.join(publicRoot(), relPath);
  try {
    // 先下载到临时文件
    const prov = providerFor(requirement.policy);
    if (!prov) return {sceneId, requirementId: requirement.requirementId, status: 'download_failed', reason: 'provider unavailable'};
    const tmpPath = absPath + '.tmp';
    await prov.download(hit, tmpPath);
    const tmpStat = fs.statSync(tmpPath);
    if (tmpStat.size < 1024) { fs.rmSync(tmpPath, {force: true}); return {sceneId, requirementId: requirement.requirementId, status: 'download_failed', reason: '下载文件过小，校验失败'}; }
    // 原子重命名
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {sceneId, requirementId: requirement.requirementId, status: 'download_failed', reason};
  }
  const dims = probeImage(absPath);
  const row = insertAsset({
    projectId,
    sceneId,
    mediaType: 'image',
    sourceType: requirement.policy === 'public_domain' ? 'archive' : 'generated',
    sourceProvider: providerName,
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
  // M6.3.8：exact binding —— 下载成功即绑定到该 requirement（replace 语义）
  bindAssetToRequirement({
    projectId,
    sceneId,
    requirementId: requirement.requirementId,
    assetId: row.id,
  });
  return {sceneId, requirementId: requirement.requirementId, status: 'acquired', assetId: row.id};
}

/**
 * 对项目 locked scenes 执行素材获取。
 * 逐 requirement：已有 active binding 的跳过（bound），其余搜索/下载/exact 绑定。
 */
export async function acquireAssetsForProject(projectId: string): Promise<AcquireSummary> {
  const plans = loadLatestScenesPlans(projectId);
  if (!plans) throw new Error('项目缺少 scenes artifact');
  // M6.3.13：已「改用 MG」的 scene 不再获取素材（override 失效后自动恢复获取）
  const overridden = activeOverrideSceneIds(projectId);
  const results: AcquireResult[] = [];
  for (const plan of plans) {
    if (!plan.needsAssets) continue;
    if (overridden.has(plan.sceneId)) continue;
    for (const req of plan.requirements) {
      if (getActiveBinding(projectId, plan.sceneId, req.requirementId)) {
        results.push({sceneId: plan.sceneId, requirementId: req.requirementId, status: 'bound'});
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await acquireWithRetry(projectId, plan, req);
      results.push(r);
    }
  }
  return {
    acquired: results.filter((r) => r.status === 'acquired').length,
    reused: results.filter((r) => r.status === 'bound').length,
    failed: results.filter((r) => r.status !== 'acquired' && r.status !== 'bound').length,
    results,
  };
}

/**
 * 单 requirement 定向获取（resolver UI「重新搜索」）。
 * requirement 不存在 = failed（调用方据此返回 4xx；禁止回退猜测）。
 */
export async function acquireAssetsForRequirement(
  projectId: string,
  sceneId: string,
  requirementId: string,
): Promise<AcquireResult> {
  const plans = loadLatestScenesPlans(projectId);
  if (!plans) throw new Error('项目缺少 scenes artifact');
  const found = findRequirementInPlans(plans, sceneId, requirementId);
  if (!found) {
    return {sceneId, requirementId, status: 'failed', reason: `需求 ${requirementId} 不存在于场景 ${sceneId}`};
  }
  // M6.3.13：已「改用 MG」的 scene 拒绝 acquire（防半截状态）
  if (isSceneVisuallyOverridden(projectId, sceneId)) {
    return {sceneId, requirementId, status: 'failed', reason: `场景 ${sceneId} 已改用 MG 模板，无需准备素材`};
  }
  if (getActiveBinding(projectId, sceneId, requirementId)) {
    return {sceneId, requirementId, status: 'bound'};
  }
  return acquireWithRetry(projectId, found.plan, found.requirement);
}

/**
 * M7.3A.3.1：generated asset result 的原子提交（Fence B 与 current commit 一体化）。
 *
 * 在单个 BEGIN IMMEDIATE 事务内完成：
 *   1. 读取 project_stages.active_version（exact）；
 *   2. 读取该 exact version 的 project_versions.content 并解析 exact scene/requirement；
 *   3. 计算当前 requirement snapshot hash；
 *   4. 检查 job 仍为 status='running' 且 owner_token 精确匹配；
 *   5. 判定 relevance：lease lost → stale(lease_lost)；source 不匹配/不可用 →
 *      stale(source_drift)；否则 current；
 *   6. INSERT asset 行（完整 provenance，relevance/staleReason 由判定写入）；
 *   7. UPDATE asset_generation_jobs（result_asset_id / result_relevance / succeeded /
 *      billing / provider_request_id / 清 owner）；
 *   8. 仅 current 时清除 asset_resolution_state（stale 保留 failure/readiness 状态）；
 *   9. commit。
 *
 * 禁止在 Fence B 读取与 commit 之间释放写锁（本模块天然满足：判定在事务内）。
 * 文件写入（tmp → rename append-only）由调用方在事务外完成；本事务抛错时
 * 调用方必须删除本轮新文件，且不得删除任何已落库历史 asset。
 */

import {getDb} from '../db';
import {insertAsset, type AssetProvenance} from './model';
import {
  buildRequirementSnapshot,
  computeRequirementSnapshotHash,
  findRequirementInPlans,
  loadActiveScenesSource,
} from './requirements';

export type CommitRelevance = 'current' | 'stale_source_drift' | 'stale_lease_lost';

export interface CommitGeneratedAssetInput {
  projectId: string;
  sceneId: string;
  requirementId: string;
  jobId: string;
  ownerToken: string;
  assetId: string;
  localPath: string;
  providerRequestId?: string;
  provider: string;
  model: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  licenseNote: string;
  attribution: string;
  description: string;
  requirementJson: string | null;
  /** enqueue 冻结的 source 快照（供 stale 判定与 provenance）。 */
  sourceScenesVersionId: string | null;
  sourceRequirementHash: string | null;
  requestId: string;
  /** 执行期检测到 production_gpu lease 丢失（executor 心跳）。 */
  leaseLost: boolean;
}

export interface CommitGeneratedAssetResult {
  relevance: 'current' | 'stale';
  staleReason: string | null;
  assetId: string;
}

export class CommitGeneratedAssetError extends Error {
  constructor(
    public readonly code: 'JOB_STATE_INVALID' | 'SOURCE_UNAVAILABLE' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'CommitGeneratedAssetError';
  }
}

export function commitGeneratedAssetResultTx(
  input: CommitGeneratedAssetInput,
): CommitGeneratedAssetResult {
  const db = getDb();
  const tx = db.transaction((): CommitGeneratedAssetResult => {
    // 1–3：读取 active scenes source（exact；缺失 → source 不可用，不得视为通过）
    let sourceAvailable = false;
    let currentHash: string | null = null;
    let activeVersion: string | null = null;
    const source = loadActiveScenesSource(input.projectId);
    if (source) {
      activeVersion = String(source.activeVersion);
      const found = findRequirementInPlans(source.plans, input.sceneId, input.requirementId);
      if (found) {
        sourceAvailable = true;
        currentHash = computeRequirementSnapshotHash(
          JSON.stringify(buildRequirementSnapshot(found.requirement)),
        );
      }
    }

    // 4：job 必须仍为 running 且 owner 精确匹配
    const job = db
      .prepare('SELECT status, owner_token FROM asset_generation_jobs WHERE id = ?')
      .get(input.jobId) as {status: string; owner_token: string | null} | undefined;
    if (!job || job.status !== 'running' || job.owner_token !== input.ownerToken) {
      throw new CommitGeneratedAssetError(
        'JOB_STATE_INVALID',
        `job ${input.jobId} 状态非法（status=${job?.status ?? 'missing'}）或 owner 不匹配`,
      );
    }

    // 5：判定 relevance
    let relevance: 'current' | 'stale';
    let staleReason: string | null;
    if (input.leaseLost) {
      relevance = 'stale';
      staleReason = 'lease_lost';
    } else if (
      sourceAvailable &&
      currentHash !== null &&
      input.sourceScenesVersionId !== null &&
      input.sourceRequirementHash !== null &&
      activeVersion === input.sourceScenesVersionId &&
      currentHash === input.sourceRequirementHash
    ) {
      relevance = 'current';
      staleReason = null;
    } else {
      relevance = 'stale';
      staleReason = 'source_drift';
    }

    const provenance: AssetProvenance = {
      sourceScenesVersionId: input.sourceScenesVersionId,
      sourceRequirementHash: input.sourceRequirementHash,
      assetGenerationJobId: input.jobId,
      requestId: input.requestId,
      relevance,
      staleReason,
    };

    // 6：INSERT asset（append-only，历史行永不删除；id 与 job.result_asset_id 一致）
    const requirement = input.requirementJson
      ? (JSON.parse(input.requirementJson) as Record<string, unknown>) as Parameters<typeof insertAsset>[0]['requirement']
      : undefined;
    insertAsset({
      id: input.assetId,
      projectId: input.projectId,
      sceneId: input.sceneId,
      mediaType: 'image',
      sourceType: 'generated',
      sourceProvider: input.provider,
      sourceUrl: null,
      localPath: input.localPath,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      licenseStatus: 'generated',
      licenseNote: input.licenseNote,
      attribution: input.attribution,
      description: input.description,
      requirement,
      provenance,
    });

    // 7：UPDATE job（owner 校验内联在 WHERE）
    const at = new Date().toISOString();
    const changed = db
      .prepare(
        `UPDATE asset_generation_jobs
         SET status = 'succeeded', owner_token = NULL, lease_expires_at = NULL,
             result_asset_id = ?, result_relevance = ?,
             provider_request_id = COALESCE(?, provider_request_id),
             billing_status = 'confirmed_charged', finished_at = ?, updated_at = ?
         WHERE id = ? AND owner_token = ? AND status = 'running'`,
      )
      .run(
        input.assetId,
        relevance,
        input.providerRequestId ?? null,
        at,
        at,
        input.jobId,
        input.ownerToken,
      ).changes;
    if (changed !== 1) {
      throw new CommitGeneratedAssetError('JOB_STATE_INVALID', `job ${input.jobId} 更新失败（owner 或状态已变）`);
    }

    // 8：仅 current 清除 resolution state（stale 保留 failure/readiness 状态）
    if (relevance === 'current') {
      db.prepare(
        'DELETE FROM asset_resolution_state WHERE project_id = ? AND scene_id = ? AND requirement_id = ?',
      ).run(input.projectId, input.sceneId, input.requirementId);
    }

    return {relevance, staleReason, assetId: input.assetId};
  });
  return tx.immediate();
}

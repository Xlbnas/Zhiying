/**
 * M6.3.8 / M7.3A.3.x：generated candidate → exact requirement 的显式绑定。
 *
 * 安全不变量：
 * - candidate 只能绑定到它生成时的 intended 目标（sceneId + requirementId 完全一致）。
 * - 目标 requirement 必须真实存在于 active scenes artifact（exact，禁止猜测）。
 * - 同一 requirement 重复绑定 = replace 语义（旧 binding 转历史，asset/文件/provenance 保留）。
 *
 * M7.3A.3.1：服务端权威 stale 门禁（带 provenance 的候选必须为 current）。
 * M7.3A.3.2：整个 bind 在单个 BEGIN IMMEDIATE 事务内完成
 * （bindGeneratedCandidateTx）：source 校验 → 三态 provenance 解析 → job 校验 →
 * binding 写入 → license 更新 → resolution state 清除，中间不释放 SQLite 写锁；
 * 从 source 校验开始到 binding 写入完成无 TOCTOU 窗口。
 * provenance 三态：NULL → legacy（兼容，legacyProvenance=true）；严格完整 → valid；
 * malformed（JSON/缺字段/relevance 非法）→ 409 CANDIDATE_PROVENANCE_INVALID，
 * 绝不降级为 legacy。
 */

import crypto from 'node:crypto';
import {getDb} from '../db';
import {
  parseAssetProvenanceStrict,
  type AssetBindingRow,
  type AssetRow,
} from './model';
import {
  buildRequirementSnapshot,
  computeRequirementSnapshotHash,
  findRequirementInPlans,
  loadActiveScenesSource,
} from './requirements';
import {isSceneVisuallyOverridden} from '../scenes/visual-overrides';
import {getAssetGenerationJobById} from './generation-jobs';

export class BindError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'BindError';
  }
}

/** candidate 的 intended 目标：sceneId 取 denormalized scene_id 列，requirementId 取快照。 */
function intendedTargetOf(asset: AssetRow): {sceneId: string | null; requirementId: string | null} {
  let requirementId: string | null = null;
  if (asset.requirement_json) {
    try {
      const parsed = JSON.parse(asset.requirement_json) as {requirementId?: unknown};
      if (typeof parsed.requirementId === 'string' && parsed.requirementId.length > 0) {
        requirementId = parsed.requirementId;
      }
    } catch {
      // 快照损坏 → 视为无 intended requirement（只能按 scene 级 provenance 校验）
    }
  }
  return {sceneId: asset.scene_id, requirementId};
}

/**
 * M7.3A.3.2：原子绑定。单 BEGIN IMMEDIATE 事务：
 * 读取 candidate → project/source_type → intended 目标 → provenance 三态 →
 * active source（exact）+ current hash → strict 候选 job 全量校验 →
 * MG override → 未绑他处 → deactivate 旧 binding → insert 新 binding →
 * license 更新 → clear resolution state → commit。
 */
export function bindGeneratedCandidateTx(input: {
  projectId: string;
  candidateId: string;
  sceneId: string;
  requirementId: string;
}): {binding: AssetBindingRow; asset: AssetRow; legacyProvenance: boolean} {
  const db = getDb();
  const tx = db.transaction((): {binding: AssetBindingRow; asset: AssetRow; legacyProvenance: boolean} => {
    // 1：读取 candidate asset
    const asset = db
      .prepare('SELECT * FROM assets WHERE id = ?')
      .get(input.candidateId) as AssetRow | undefined;
    if (!asset || asset.project_id !== input.projectId) {
      throw new BindError('candidate_not_found', '候选素材不存在', 404);
    }
    // 2：source_type
    if (asset.source_type !== 'generated') {
      throw new BindError('not_generated_candidate', '只能绑定 AI 生成的候选素材');
    }

    // 3：intended 目标（优先于 provenance 门禁，cross 绑定保持明确语义）
    const intended = intendedTargetOf(asset);
    if (intended.sceneId !== null && intended.sceneId !== input.sceneId) {
      throw new BindError(
        'scene_mismatch',
        `该候选素材的目标场景是 ${intended.sceneId}，不能绑定到 ${input.sceneId}`,
      );
    }
    if (intended.requirementId !== null && intended.requirementId !== input.requirementId) {
      throw new BindError(
        'requirement_mismatch',
        `该候选素材的目标需求是 ${intended.requirementId}，不能绑定到 ${input.requirementId}`,
      );
    }

    // 4：provenance 三态解析
    const parsed = parseAssetProvenanceStrict(asset);
    let legacyProvenance = false;
    if (parsed.kind === 'invalid') {
      throw new BindError(
        'CANDIDATE_PROVENANCE_INVALID',
        `候选素材 provenance 不完整：${parsed.issues.join('；')}`,
        409,
      );
    }
    if (parsed.kind === 'valid') {
      // 5：active scenes source（exact，fail-closed）
      const source = loadActiveScenesSource(input.projectId);
      if (!source) {
        throw new BindError('CANDIDATE_SOURCE_STALE', '项目缺少 active scenes artifact，无法验证候选素材来源', 409);
      }
      const found = findRequirementInPlans(source.plans, input.sceneId, input.requirementId);
      if (!found) {
        throw new BindError('CANDIDATE_SOURCE_STALE', `需求 ${input.requirementId} 不存在于当前 scenes 版本`, 409);
      }
      const curHash = computeRequirementSnapshotHash(
        JSON.stringify(buildRequirementSnapshot(found.requirement)),
      );
      const activeVersion = String(source.activeVersion);
      const prov = parsed.value;

      // 6：strict 候选全量校验
      if (prov.relevance !== 'current') {
        throw new BindError(
          'CANDIDATE_STALE',
          `该候选素材已被标记为历史（relevance=${prov.relevance}），来源已变化，不能绑定到当前版本`,
          409,
        );
      }
      if (prov.sourceScenesVersionId !== activeVersion) {
        throw new BindError(
          'CANDIDATE_SOURCE_STALE',
          `候选素材生成于 scenes v${prov.sourceScenesVersionId}，当前为 v${activeVersion}`,
          409,
        );
      }
      if (prov.sourceRequirementHash !== curHash) {
        throw new BindError('CANDIDATE_SOURCE_STALE', '候选素材的 requirement 快照与当前版本不一致', 409);
      }
      const job = getAssetGenerationJobById(prov.assetGenerationJobId);
      if (!job) {
        throw new BindError('CANDIDATE_SOURCE_STALE', '候选素材的生成 job 不存在', 409);
      }
      if (
        job.status !== 'succeeded' ||
        job.result_asset_id !== input.candidateId ||
        job.result_relevance !== 'current' ||
        job.project_id !== input.projectId ||
        job.scene_id !== input.sceneId ||
        job.requirement_id !== input.requirementId ||
        job.request_id !== prov.requestId
      ) {
        throw new BindError('CANDIDATE_SOURCE_STALE', '候选素材的生成 job 与绑定请求不一致', 409);
      }
    } else {
      legacyProvenance = true; // 历史 NULL provenance：保留 sceneId+requirementId 兼容，不伪造
    }

    // 7：MG override
    if (isSceneVisuallyOverridden(input.projectId, input.sceneId)) {
      throw new BindError('scene_overridden', `场景 ${input.sceneId} 已改用 MG 模板，如需绑定素材请先「改回素材」`, 409);
    }

    // 8：asset 未被其他目标 active 绑定
    const existing = db
      .prepare('SELECT scene_id, requirement_id FROM asset_bindings WHERE asset_id = ? AND active = 1')
      .get(input.candidateId) as {scene_id: string; requirement_id: string} | undefined;
    if (existing && (existing.scene_id !== input.sceneId || existing.requirement_id !== input.requirementId)) {
      throw new BindError('already_bound_elsewhere', `该候选素材已绑定到 ${existing.scene_id}/${existing.requirement_id}`, 409);
    }

    // 9：deactivate 当前 requirement 旧 binding（replace 语义，历史行保留）
    db.prepare(
      `UPDATE asset_bindings SET active = 0
       WHERE project_id = ? AND scene_id = ? AND requirement_id = ? AND active = 1`,
    ).run(input.projectId, input.sceneId, input.requirementId);

    // 10：插入新 active binding
    const bindingId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_bindings (id, project_id, scene_id, requirement_id, asset_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(bindingId, input.projectId, input.sceneId, input.requirementId, input.candidateId, at);

    // 11：license 更新（去除「待确认」）
    db.prepare('UPDATE assets SET license_status = ?, license_note = ? WHERE id = ?')
      .run('generated', asset.license_note?.replace('(待确认)', '').trim() || 'AI 生成', input.candidateId);

    // 12：清除 exact resolution state
    db.prepare(
      'DELETE FROM asset_resolution_state WHERE project_id = ? AND scene_id = ? AND requirement_id = ?',
    ).run(input.projectId, input.sceneId, input.requirementId);

    const binding = db
      .prepare('SELECT * FROM asset_bindings WHERE id = ?')
      .get(bindingId) as AssetBindingRow;
    return {binding, asset: db.prepare('SELECT * FROM assets WHERE id = ?').get(input.candidateId) as AssetRow, legacyProvenance};
  });
  return tx.immediate();
}

/** M7.3A.3.2：非事务包装（等价语义；路由与测试统一走原子版本）。 */
export function bindGeneratedCandidate(input: {
  projectId: string;
  candidateId: string;
  sceneId: string;
  requirementId: string;
}): {binding: AssetBindingRow; asset: AssetRow; legacyProvenance: boolean} {
  return bindGeneratedCandidateTx(input);
}

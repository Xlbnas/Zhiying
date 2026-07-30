import crypto from 'node:crypto';
import {z} from 'zod';
import {getDb} from './db';
import {getStage} from './workflow/stages';
import {getVersion} from './workflow/versions';
import {isPlanV2Eligible, narrationPlanV2Schema} from './narration/schema-v2';

/**
 * M7 Pipeline Snapshot（M7.1.1，REVIEW P0-2/P0-3 冻结）。
 *
 * 语义：
 * - candidate artifact ≠ selected artifact ≠ active pipeline artifact。
 *   任何 candidate（含 narration_plan_v2）绝不因「latest/eligible」自动成为
 *   current/active；唯一激活载体是不可变的 m7_pipeline_snapshot。
 * - snapshot 声明一个完整 M7 pipeline generation 的全部精确 artifact ID，
 *   不允许 null/空串/占位符构造「部分 snapshot」；缺任何字段即拒绝。
 * - ruleset 冻结：m7-pipeline-snapshot@1.0 永远使用 m7-activation@1.0
 *   validator。未来链变化必须新增 schemaVersion/rulesetVersion，
 *   不得修改 v1.0 validator 既有语义；新代码不得追溯破坏已激活项目。
 * - 本轮（M7.1.1）M7.2–M7.8 未实现：schema/parser/验证框架落地，
 *   但不创建真实 snapshot，activation 在 production 上必然 fail-closed。
 *
 * M7.2 输入契约（提前冻结，未实现）：
 *   buildNarrativeBeats({projectId, narrationPlanV2ArtifactId})
 *   —— 必须接收显式 artifact ID 并写入 provenance；
 *   禁止调用任何形式的 get current/latest narration plan。
 */

export const M7_PIPELINE_SNAPSHOT_KIND = 'm7_pipeline_snapshot';
export const M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION = 'm7-pipeline-snapshot@1.0';
export const M7_ACTIVATION_RULESET_V1 = 'm7-activation@1.0';

const requiredArtifactId = z.string().min(1);

export const m7PipelineSnapshotArtifactsSchema = z
  .object({
    narrationPlanV2ArtifactId: requiredArtifactId,
    narrativeBeatsArtifactId: requiredArtifactId,
    visualIntentArtifactId: requiredArtifactId,
    visualSequencesArtifactId: requiredArtifactId,
    shotsArtifactId: requiredArtifactId,
    reconciledShotTimelineArtifactId: requiredArtifactId,
    storyboardArtifactId: requiredArtifactId,
    storyboardApprovalId: requiredArtifactId,
    animaticSourceArtifactId: requiredArtifactId,
    animaticRenderArtifactId: requiredArtifactId,
    animaticApprovalId: requiredArtifactId,
    editorialGateResultArtifactId: requiredArtifactId,
    finalRenderSourceArtifactId: requiredArtifactId,
  })
  .strict();
export type M7PipelineSnapshotArtifacts = z.infer<typeof m7PipelineSnapshotArtifactsSchema>;

export const m7PipelineSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION),
    rulesetVersion: z.literal(M7_ACTIVATION_RULESET_V1),
    projectId: z.string().min(1),
    generation: z.number().int().positive(),
    artifacts: m7PipelineSnapshotArtifactsSchema,
    /** sha256(canonical(schemaVersion+rulesetVersion+projectId+generation+artifacts))，改任何字段即失效。 */
    provenanceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    createdAt: z.string().min(1),
  })
  .strict();
export type M7PipelineSnapshotV1 = z.infer<typeof m7PipelineSnapshotV1Schema>;

/** deterministic provenance hash：相同声明永远相同输出（字段序固定）。 */
export function computeSnapshotProvenanceHash(input: {
  schemaVersion: string;
  rulesetVersion: string;
  projectId: string;
  generation: number;
  artifacts: M7PipelineSnapshotArtifacts;
}): string {
  const keys = Object.keys(input.artifacts).sort() as Array<keyof M7PipelineSnapshotArtifacts>;
  const canonicalArtifacts = keys.map((k) => `${k}=${input.artifacts[k]}`).join('|');
  const canonical = [
    input.schemaVersion,
    input.rulesetVersion,
    input.projectId,
    String(input.generation),
    canonicalArtifacts,
  ].join('\n');
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

// ── m7-activation@1.0 冻结 ruleset：每个引用字段的期望 artifact kind ──
const RULESET_V1_EXPECTED_KIND: Record<keyof M7PipelineSnapshotArtifacts, string> = {
  narrationPlanV2ArtifactId: 'narration_plan_v2',
  narrativeBeatsArtifactId: 'narrative_beats',
  visualIntentArtifactId: 'visual_intent_plan',
  visualSequencesArtifactId: 'visual_sequence_plan',
  shotsArtifactId: 'shot_plan',
  reconciledShotTimelineArtifactId: 'timing_reconciliation_v2',
  storyboardArtifactId: 'storyboard',
  storyboardApprovalId: 'storyboard_approval',
  animaticSourceArtifactId: 'animatic_source',
  animaticRenderArtifactId: 'animatic_render',
  animaticApprovalId: 'animatic_approval',
  editorialGateResultArtifactId: 'editorial_gate_result',
  finalRenderSourceArtifactId: 'final_render_source',
};

interface ArtifactRow {
  id: string;
  project_id: string;
  kind: string;
  content_json: string | null;
}

function loadArtifactRow(artifactId: string): ArtifactRow | null {
  const row = getDb()
    .prepare('SELECT id, project_id, kind, content_json FROM artifacts WHERE id = ?')
    .get(artifactId) as ArtifactRow | undefined;
  return row ?? null;
}

function parseJson(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * m7-activation@1.0 validator（冻结语义，禁止就地修改）。
 * 返回 null = 通过；否则返回全部失败原因（fail-closed，列全不短路）。
 */
function validateWithRulesetV1(projectId: string, snapshot: M7PipelineSnapshotV1): string[] {
  const errors: string[] = [];
  if (snapshot.projectId !== projectId) {
    errors.push(`snapshot.projectId(${snapshot.projectId}) 与项目(${projectId})不一致`);
  }
  const recomputed = computeSnapshotProvenanceHash(snapshot);
  if (recomputed !== snapshot.provenanceHash) {
    errors.push('provenanceHash 与声明内容不一致（snapshot 被篡改或构造错误）');
  }

  const rows = new Map<string, ArtifactRow | null>();
  const fields = Object.keys(RULESET_V1_EXPECTED_KIND) as Array<keyof M7PipelineSnapshotArtifacts>;
  for (const field of fields) {
    const artifactId = snapshot.artifacts[field];
    const row = loadArtifactRow(artifactId);
    rows.set(field, row);
    if (!row) {
      errors.push(`${field} 引用的 artifact ${artifactId} 不存在`);
      continue;
    }
    if (row.project_id !== projectId) {
      errors.push(`${field} 引用的 artifact ${artifactId} 属于其他项目（${row.project_id}）`);
      continue;
    }
    const expectedKind = RULESET_V1_EXPECTED_KIND[field];
    if (row.kind !== expectedKind) {
      errors.push(`${field} 引用的 artifact kind=${row.kind}，期望 ${expectedKind}`);
    }
  }

  // narration_plan_v2：必须可解析、eligible（needsReview=0）、source 匹配当前 locked script_v2
  const narrationRow = rows.get('narrationPlanV2ArtifactId');
  if (narrationRow && narrationRow.project_id === projectId && narrationRow.kind === 'narration_plan_v2') {
    const raw = parseJson(narrationRow.content_json);
    const parsed = raw ? narrationPlanV2Schema.safeParse(raw) : null;
    if (!parsed || !parsed.success) {
      errors.push('narration_plan_v2 artifact 无法通过 narration-plan@2.0 契约校验（损坏）');
    } else {
      if (!isPlanV2Eligible(parsed.data)) {
        errors.push('narration_plan_v2 needsReview 非空，不得进入 active pipeline');
      }
      const stage = getStage(projectId, 'script_v2');
      const lockedRow =
        stage && stage.status === 'locked' && stage.locked_version !== null
          ? (getVersion(projectId, 'script_v2', stage.locked_version) as {id: string} | undefined)
          : undefined;
      if (!lockedRow || parsed.data.source.scriptV2VersionId !== lockedRow.id) {
        errors.push('narration_plan_v2 source 与当前 locked script_v2 不匹配（stale）');
      }
    }
  }

  // approvals：append-only record，必须精确引用对应 artifact 且 decision=approved
  const checkApproval = (
    approvalField: 'storyboardApprovalId' | 'animaticApprovalId',
    targetField: 'storyboardArtifactId' | 'animaticRenderArtifactId',
  ): void => {
    const row = rows.get(approvalField);
    if (!row || row.project_id !== projectId) return;
    const content = parseJson(row.content_json);
    if (!content) {
      errors.push(`${approvalField} approval artifact 内容损坏（不可解析）`);
      return;
    }
    if (content.artifactId !== snapshot.artifacts[targetField]) {
      errors.push(`${approvalField} 引用的 artifactId 与 snapshot.${targetField} 不一致`);
    }
    if (content.decision !== 'approved') {
      errors.push(`${approvalField} decision=${String(content.decision)}，期望 approved`);
    }
  };
  checkApproval('storyboardApprovalId', 'storyboardArtifactId');
  checkApproval('animaticApprovalId', 'animaticRenderArtifactId');

  // Editorial Gate：必须 pass，且评估对象精确引用本 snapshot 的 timeline + storyboard
  const gateRow = rows.get('editorialGateResultArtifactId');
  if (gateRow && gateRow.project_id === projectId) {
    const content = parseJson(gateRow.content_json);
    if (!content) {
      errors.push('editorial_gate_result artifact 内容损坏（不可解析）');
    } else {
      if (content.result !== 'pass') {
        errors.push(`Editorial Gate result=${String(content.result)}，非 pass 禁止激活`);
      }
      const evaluated = Array.isArray(content.evaluatedArtifactIds)
        ? (content.evaluatedArtifactIds as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      for (const required of [
        snapshot.artifacts.reconciledShotTimelineArtifactId,
        snapshot.artifacts.storyboardArtifactId,
      ]) {
        if (!evaluated.includes(required)) {
          errors.push(`Editorial Gate 未评估 snapshot 声明的 artifact ${required}`);
        }
      }
    }
  }

  // Final source：provenance 必须精确等于本 snapshot 声明的同一套 artifacts（不含自身）
  const finalRow = rows.get('finalRenderSourceArtifactId');
  if (finalRow && finalRow.project_id === projectId) {
    const content = parseJson(finalRow.content_json);
    if (!content) {
      errors.push('final_render_source artifact 内容损坏（不可解析）');
    } else {
      const declared =
        typeof content.artifactIds === 'object' && content.artifactIds !== null
          ? (content.artifactIds as Record<string, unknown>)
          : null;
      if (!declared) {
        errors.push('final_render_source 缺少 artifactIds provenance');
      } else {
        for (const field of fields) {
          if (field === 'finalRenderSourceArtifactId') continue;
          if (declared[field] !== snapshot.artifacts[field]) {
            errors.push(`final_render_source.artifactIds.${field} 与 snapshot 声明不一致`);
          }
        }
      }
    }
  }

  return errors;
}

export type SnapshotRulesetValidator = (projectId: string, snapshot: M7PipelineSnapshotV1) => string[];

/**
 * ruleset → validator 注册表（冻结分发）。
 * m7-activation@1.0 永远映射到 v1 validator；未来新增 v1.1 必须新增条目，
 * 不得改变 v1 行为——旧 snapshot 永远按其声明的 rulesetVersion 验证。
 */
const RULESET_VALIDATORS: Record<string, SnapshotRulesetValidator> = {
  [M7_ACTIVATION_RULESET_V1]: validateWithRulesetV1,
};

/** 按 snapshot 自身声明的 rulesetVersion 取冻结 validator；未知 ruleset → null（调用方 fail-closed）。 */
export function getSnapshotValidator(rulesetVersion: string): SnapshotRulesetValidator | null {
  return RULESET_VALIDATORS[rulesetVersion] ?? null;
}

/** 解析 snapshot artifact 内容：JSON + discriminated schema；非法返回 null。 */
export function parseM7PipelineSnapshot(contentJson: string): M7PipelineSnapshotV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(contentJson);
  } catch {
    return null;
  }
  // v1 schema  discriminated by schemaVersion literal；未来 v1.1 在此 union
  const parsed = m7PipelineSnapshotV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 读取并解析项目内指定 snapshot artifact（kind/project 校验；非法返回 null）。 */
export function getM7PipelineSnapshotArtifact(
  projectId: string,
  snapshotArtifactId: string,
): {snapshot: M7PipelineSnapshotV1; artifact: ArtifactRow} | null {
  const row = loadArtifactRow(snapshotArtifactId);
  if (!row || row.project_id !== projectId || row.kind !== M7_PIPELINE_SNAPSHOT_KIND) {
    return null;
  }
  if (row.content_json === null) return null;
  const snapshot = parseM7PipelineSnapshot(row.content_json);
  if (!snapshot) return null;
  return {snapshot, artifact: row};
}

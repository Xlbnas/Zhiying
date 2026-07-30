/**
 * M7.1.1 Explicit Pipeline Activation Gate 测试（临时 DB，零 production 接触）。
 *
 * 用法：npx tsx scripts/test-m711-activation.ts
 * 覆盖：
 * - candidate 生命周期与 getter fail-closed（精确 ID / 跨项目 / kind 拒绝 / 无 latest fallback）
 * - m7_pipeline_snapshot schema（缺字段 / null / 空串 / 版本不符 / provenanceHash）
 * - activation：narration-only / missing / partial / cross-project / artifact 缺失 /
 *   approval 不一致 / gate 非 pass / final source 不一致 / 完整链单事务成功 / 原子性
 * - frozen ruleset：v1.0 分发、未知 ruleset 拒绝、引用丢失/损坏仍 fail-closed、不追溯
 * - migration：默认 m6 + 指针 NULL、幂等重开
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m711-activation');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {
  buildNarrationPlanV2,
  classifyNarrationPlanV2Candidate,
  getCurrentNarrationPlanV2,
  getLatestEligibleNarrationPlanV2Candidate,
  getNarrationPlanV2Artifact,
  listNarrationPlanV2Candidates,
} from '../src/lib/narration/plan-v2';
import {NARRATION_PLAN_V2_ARTIFACT_KIND} from '../src/lib/narration/schema-v2';
import {
  computeSnapshotProvenanceHash,
  getM7PipelineSnapshotArtifact,
  getSnapshotValidator,
  M7_ACTIVATION_RULESET_V1,
  M7_PIPELINE_SNAPSHOT_KIND,
  M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
  parseM7PipelineSnapshot,
  type M7PipelineSnapshotArtifacts,
} from '../src/lib/m7-pipeline-snapshot';
import {
  activateM7Pipeline,
  assertPipelineConsistency,
  getM7PipelineActivationStatus,
  getM7PipelineSnapshotId,
  getPipelineVersion,
  PipelineVersionError,
  switchPipelineToM7,
} from '../src/lib/pipeline-version';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

function expectPipelineError(code: string, fn: () => unknown, label: string): void {
  try {
    fn();
    ok(false, label, '意外成功（应抛错）');
  } catch (err) {
    ok(
      err instanceof PipelineVersionError && err.code === code,
      label,
      err instanceof Error ? `${err.name}: ${(err as {code?: string}).code ?? err.message}` : err,
    );
  }
}

const UPSTREAM: WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
];

const CLEAN_MD = `# Script V2

## 第 1 章 T（00:00–01:00）

第一句。第二句。
第三句。
`;

const REVIEW_MD = `# Script V2

## 第 1 章 T（00:00–01:00）

（停顿）第一句。
`;

function newProjectWithLockedScript(content: string): string {
  const projectId = createProjectWithWorkflow({topic: 'm711', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({
      projectId,
      stage,
      content: `# ${stage}`,
      contentType: 'markdown',
      source: 'manual_edit',
    });
    lockStage(projectId, stage);
  }
  generateVersion({
    projectId,
    stage: 'script_v2',
    content,
    contentType: 'markdown',
    source: 'manual_edit',
    promptVersion: 'script-v2@1.0',
  });
  lockStage(projectId, 'script_v2');
  return projectId;
}

/** 直接写入 artifact 行（测试 fixture 专用；production 无此路径）。 */
function insertArtifact(projectId: string, kind: string, content: unknown): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?),
         ?, NULL, ?)`,
    )
    .run(id, projectId, kind, projectId, kind, JSON.stringify(content), new Date().toISOString());
  return id;
}

function makeSnapshotContent(
  projectId: string,
  artifacts: M7PipelineSnapshotArtifacts,
  generation = 1,
): Record<string, unknown> {
  const base = {
    schemaVersion: M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
    rulesetVersion: M7_ACTIVATION_RULESET_V1,
    projectId,
    generation,
    artifacts,
  };
  return {...base, provenanceHash: computeSnapshotProvenanceHash(base), createdAt: new Date().toISOString()};
}

/**
 * 构造一条满足 m7-activation@1.0 的完整 artifact 链 + snapshot artifact。
 * 返回 snapshot artifact ID 与全部引用 ID（供篡改场景使用）。
 */
function buildFullChain(projectId: string, narrationPlanArtifactId: string): {
  snapshotArtifactId: string;
  artifacts: M7PipelineSnapshotArtifacts;
} {
  const narrativeBeatsArtifactId = insertArtifact(projectId, 'narrative_beats', {});
  const visualIntentArtifactId = insertArtifact(projectId, 'visual_intent_plan', {});
  const visualSequencesArtifactId = insertArtifact(projectId, 'visual_sequence_plan', {});
  const shotsArtifactId = insertArtifact(projectId, 'shot_plan', {});
  const reconciledShotTimelineArtifactId = insertArtifact(projectId, 'timing_reconciliation_v2', {});
  const storyboardArtifactId = insertArtifact(projectId, 'storyboard', {});
  const storyboardApprovalId = insertArtifact(projectId, 'storyboard_approval', {
    artifactId: storyboardArtifactId,
    decision: 'approved',
  });
  const animaticSourceArtifactId = insertArtifact(projectId, 'animatic_source', {});
  const animaticRenderArtifactId = insertArtifact(projectId, 'animatic_render', {});
  const animaticApprovalId = insertArtifact(projectId, 'animatic_approval', {
    artifactId: animaticRenderArtifactId,
    decision: 'approved',
  });
  const editorialGateResultArtifactId = insertArtifact(projectId, 'editorial_gate_result', {
    result: 'pass',
    evaluatedArtifactIds: [reconciledShotTimelineArtifactId, storyboardArtifactId],
  });
  const artifacts: M7PipelineSnapshotArtifacts = {
    narrationPlanV2ArtifactId: narrationPlanArtifactId,
    narrativeBeatsArtifactId,
    visualIntentArtifactId,
    visualSequencesArtifactId,
    shotsArtifactId,
    reconciledShotTimelineArtifactId,
    storyboardArtifactId,
    storyboardApprovalId,
    animaticSourceArtifactId,
    animaticRenderArtifactId,
    animaticApprovalId,
    editorialGateResultArtifactId,
    finalRenderSourceArtifactId: '',
  };
  const finalRenderSourceArtifactId = insertArtifact(projectId, 'final_render_source', {
    artifactIds: {
      narrationPlanV2ArtifactId: narrationPlanArtifactId,
      narrativeBeatsArtifactId,
      visualIntentArtifactId,
      visualSequencesArtifactId,
      shotsArtifactId,
      reconciledShotTimelineArtifactId,
      storyboardArtifactId,
      storyboardApprovalId,
      animaticSourceArtifactId,
      animaticRenderArtifactId,
      animaticApprovalId,
      editorialGateResultArtifactId,
    },
  });
  artifacts.finalRenderSourceArtifactId = finalRenderSourceArtifactId;
  const snapshotArtifactId = insertArtifact(
    projectId,
    M7_PIPELINE_SNAPSHOT_KIND,
    makeSnapshotContent(projectId, artifacts),
  );
  return {snapshotArtifactId, artifacts};
}

function assertStillM6(projectId: string, label: string): void {
  ok(
    getPipelineVersion(projectId) === 'm6' && getM7PipelineSnapshotId(projectId) === null,
    `${label}（事务原子：pipelineVersion=m6 且指针 NULL）`,
  );
}

function main(): void {
  // ============ S：snapshot schema ============
  const projectS = newProjectWithLockedScript(CLEAN_MD);
  const planS = buildNarrationPlanV2(projectS);
  const {snapshotArtifactId: okSnapshotId, artifacts: okArtifacts} = buildFullChain(
    projectS,
    planS.artifact.id,
  );
  const okSnapshotRow = getDb()
    .prepare('SELECT content_json FROM artifacts WHERE id = ?')
    .get(okSnapshotId) as {content_json: string};

  ok(
    parseM7PipelineSnapshot(okSnapshotRow.content_json) !== null,
    '[S1] 完整 snapshot 内容可解析',
  );
  {
    const content = JSON.parse(okSnapshotRow.content_json) as Record<string, unknown>;
    const artifactsObj = content.artifacts as Record<string, unknown>;
    const missing = {...content, artifacts: {...artifactsObj}};
    delete (missing.artifacts as Record<string, unknown>).shotsArtifactId;
    ok(parseM7PipelineSnapshot(JSON.stringify(missing)) === null, '[S2] 缺 shotsArtifactId → 拒绝（禁止部分 snapshot）');
    const nulled = {...content, artifacts: {...artifactsObj, shotsArtifactId: null}};
    ok(parseM7PipelineSnapshot(JSON.stringify(nulled)) === null, '[S3] artifact 字段 null → 拒绝');
    const emptied = {...content, artifacts: {...artifactsObj, shotsArtifactId: ''}};
    ok(parseM7PipelineSnapshot(JSON.stringify(emptied)) === null, '[S4] artifact 字段空串 → 拒绝');
    const wrongSchema = {...content, schemaVersion: 'm7-pipeline-snapshot@9.9'};
    ok(parseM7PipelineSnapshot(JSON.stringify(wrongSchema)) === null, '[S5] 未知 schemaVersion → 拒绝');
    const wrongRuleset = {...content, rulesetVersion: 'm7-activation@9.9'};
    ok(parseM7PipelineSnapshot(JSON.stringify(wrongRuleset)) === null, '[S6] 未知 rulesetVersion → 拒绝（不猜测验证）');
    const extra = {...content, artifacts: {...artifactsObj, futureField: 'x'}};
    ok(parseM7PipelineSnapshot(JSON.stringify(extra)) === null, '[S7] artifacts 多余字段 → strict 拒绝');
    const badHash = {...content, provenanceHash: `sha256:${'0'.repeat(64)}`};
    const parsedBadHash = parseM7PipelineSnapshot(JSON.stringify(badHash));
    ok(
      parsedBadHash !== null &&
        getSnapshotValidator(parsedBadHash.rulesetVersion)!(projectS, parsedBadHash).length > 0,
      '[S8] provenanceHash 被篡改 → validator fail-closed',
    );
  }
  {
    const a = computeSnapshotProvenanceHash({
      schemaVersion: M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
      rulesetVersion: M7_ACTIVATION_RULESET_V1,
      projectId: projectS,
      generation: 1,
      artifacts: okArtifacts,
    });
    const b = computeSnapshotProvenanceHash({
      schemaVersion: M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
      rulesetVersion: M7_ACTIVATION_RULESET_V1,
      projectId: projectS,
      generation: 1,
      artifacts: {...okArtifacts},
    });
    ok(a === b, '[S9] provenanceHash deterministic');
    ok(
      getSnapshotValidator(M7_ACTIVATION_RULESET_V1) !== null &&
        getSnapshotValidator('m7-activation@1.1') === null &&
        getSnapshotValidator('nonsense') === null,
      '[S10] ruleset 注册表：v1.0 存在，未知 ruleset → null',
    );
  }

  // ============ G：getter fail-closed ============
  ok(
    getNarrationPlanV2Artifact(projectS, planS.artifact.id) !== null,
    '[G1] 精确 artifact ID 读取成功',
  );
  {
    const other = newProjectWithLockedScript(CLEAN_MD);
    ok(
      getNarrationPlanV2Artifact(other, planS.artifact.id) === null,
      '[G2] 跨项目 artifact ID → null',
    );
    ok(
      getM7PipelineSnapshotArtifact(other, okSnapshotId) === null,
      '[G3] 跨项目 snapshot artifact → null',
    );
    const beatsRow = getDb()
      .prepare(`SELECT id FROM artifacts WHERE project_id = ? AND kind = 'narrative_beats'`)
      .get(projectS) as {id: string};
    ok(
      getNarrationPlanV2Artifact(projectS, beatsRow.id) === null,
      '[G4] kind 不匹配 → null',
    );
    ok(
      getCurrentNarrationPlanV2(projectS) === null,
      '[G5] m6 项目 deprecated current getter 恒 null（虽有 eligible candidate + snapshot artifact 未激活）',
    );
    ok(
      getM7PipelineActivationStatus(other) === 'not_started',
      '[G6] 无任何 candidate → activation status=not_started',
    );
  }
  {
    // invalid JSON candidate 不得 eligible
    const badId = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
         VALUES (?, ?, ?, 99, 'not json', NULL, ?)`,
      )
      .run(badId, projectS, NARRATION_PLAN_V2_ARTIFACT_KIND, new Date().toISOString());
    const badRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(badId) as never;
    ok(
      classifyNarrationPlanV2Candidate(projectS, badRow).status === 'invalid',
      '[G7] 契约非法 artifact → invalid（绝不返回为 eligible）',
    );
    const eligible = getLatestEligibleNarrationPlanV2Candidate(projectS);
    ok(
      eligible !== null && eligible.artifact.id === planS.artifact.id,
      '[G8] latest-eligible 建议跳过 invalid，仍只返回 candidate（非 current）',
    );
    ok(
      listNarrationPlanV2Candidates(projectS).length === 2,
      '[G9] candidate 列表完整可见（含 invalid）',
    );
    getDb().prepare('DELETE FROM artifacts WHERE id = ?').run(badId);
  }

  // ============ A：activation 负向场景（逐一验证事务原子性） ============
  const projectA = newProjectWithLockedScript(CLEAN_MD);
  const planA = buildNarrationPlanV2(projectA);

  expectPipelineError(
    'M7_ACTIVATION_SNAPSHOT_REQUIRED',
    () => switchPipelineToM7(projectA),
    '[A1] 废弃 switchPipelineToM7 → 恒定 M7_ACTIVATION_SNAPSHOT_REQUIRED',
  );
  expectPipelineError(
    'M7_ACTIVATION_SNAPSHOT_REQUIRED',
    () => activateM7Pipeline(projectA, ''),
    '[A2] 空 snapshot ID → M7_ACTIVATION_SNAPSHOT_REQUIRED',
  );
  expectPipelineError(
    'SNAPSHOT_CHAIN_INCOMPLETE',
    () => activateM7Pipeline(projectA, planA.artifact.id),
    '[A3] narration-only 充当 snapshot → SNAPSHOT_CHAIN_INCOMPLETE',
  );
  assertStillM6(projectA, '[A3b] A3 拒绝后');
  expectPipelineError(
    'SNAPSHOT_CHAIN_INCOMPLETE',
    () => activateM7Pipeline(projectA, crypto.randomUUID()),
    '[A4] 不存在的 snapshot → SNAPSHOT_CHAIN_INCOMPLETE',
  );
  {
    // partial snapshot（缺字段，JSON 层面构造）
    const partialId = insertArtifact(projectA, M7_PIPELINE_SNAPSHOT_KIND, {
      schemaVersion: M7_PIPELINE_SNAPSHOT_SCHEMA_VERSION,
      rulesetVersion: M7_ACTIVATION_RULESET_V1,
      projectId: projectA,
      generation: 1,
      artifacts: {narrationPlanV2ArtifactId: planA.artifact.id},
      provenanceHash: `sha256:${'0'.repeat(64)}`,
      createdAt: new Date().toISOString(),
    });
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, partialId),
      '[A5] partial snapshot → 拒绝（schema 缺字段）',
    );
    assertStillM6(projectA, '[A5b] A5 拒绝后');
  }
  {
    // 引用不存在 artifact 的「完整形状」snapshot
    const ghost = Object.fromEntries(
      Object.keys(okArtifacts).map((k) => [k, crypto.randomUUID()]),
    ) as unknown as M7PipelineSnapshotArtifacts;
    const ghostId = insertArtifact(projectA, M7_PIPELINE_SNAPSHOT_KIND, makeSnapshotContent(projectA, ghost));
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, ghostId),
      '[A6] 全部引用 artifact 缺失 → 拒绝',
    );
    assertStillM6(projectA, '[A6b] A6 拒绝后');
  }
  {
    // 跨项目 snapshot：artifact 属于 projectS，拿来激活 projectA
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, okSnapshotId),
      '[A7] 跨项目 snapshot artifact → 拒绝',
    );
    // snapshot.projectId 指向其他项目
    const foreign = insertArtifact(
      projectA,
      M7_PIPELINE_SNAPSHOT_KIND,
      makeSnapshotContent(projectS, okArtifacts),
    );
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, foreign),
      '[A8] snapshot.projectId 与项目不一致 → 拒绝',
    );
    assertStillM6(projectA, '[A8b] A8 拒绝后');
  }
  {
    // approval 不一致：decision != approved
    const chain = buildFullChain(projectA, planA.artifact.id);
    getDb()
      .prepare(`UPDATE artifacts SET content_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({artifactId: chain.artifacts.storyboardArtifactId, decision: 'rejected'}),
        chain.artifacts.storyboardApprovalId,
      );
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, chain.snapshotArtifactId),
      '[A9] storyboard approval decision=rejected → 拒绝',
    );
    assertStillM6(projectA, '[A9b] A9 拒绝后');
    getDb()
      .prepare(`UPDATE artifacts SET content_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({artifactId: chain.artifacts.storyboardArtifactId, decision: 'approved'}),
        chain.artifacts.storyboardApprovalId,
      );
  }
  {
    // approval 引用错误 artifact
    const chain2 = buildFullChain(projectA, planA.artifact.id);
    getDb()
      .prepare(`UPDATE artifacts SET content_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({artifactId: crypto.randomUUID(), decision: 'approved'}),
        chain2.artifacts.animaticApprovalId,
      );
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, chain2.snapshotArtifactId),
      '[A10] animatic approval 引用错误 artifact → 拒绝',
    );
  }
  {
    // Editorial Gate 非 pass
    const chain3 = buildFullChain(projectA, planA.artifact.id);
    const gateRow = getDb()
      .prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(chain3.artifacts.editorialGateResultArtifactId) as {content_json: string};
    const gate = JSON.parse(gateRow.content_json) as Record<string, unknown>;
    gate.result = 'fail';
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(gate), chain3.artifacts.editorialGateResultArtifactId);
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, chain3.snapshotArtifactId),
      '[A11] Editorial Gate 非 pass → 拒绝',
    );
  }
  {
    // final source provenance 不一致
    const chain4 = buildFullChain(projectA, planA.artifact.id);
    const finalRow = getDb()
      .prepare('SELECT content_json FROM artifacts WHERE id = ?')
      .get(chain4.artifacts.finalRenderSourceArtifactId) as {content_json: string};
    const finalContent = JSON.parse(finalRow.content_json) as {artifactIds: Record<string, string>};
    finalContent.artifactIds.storyboardArtifactId = crypto.randomUUID();
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(JSON.stringify(finalContent), chain4.artifacts.finalRenderSourceArtifactId);
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectA, chain4.snapshotArtifactId),
      '[A12] final_render_source provenance 与 snapshot 不一致 → 拒绝',
    );
  }
  {
    // needsReview narration 不得进入 active pipeline
    const projectR = newProjectWithLockedScript(REVIEW_MD);
    const planR = buildNarrationPlanV2(projectR);
    const chainR = buildFullChain(projectR, planR.artifact.id);
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectR, chainR.snapshotArtifactId),
      '[A13] narration needsReview 非空 → 拒绝激活',
    );
    assertStillM6(projectR, '[A13b] A13 拒绝后');
  }
  assertStillM6(projectA, '[A14] 全部负向场景后 projectA 仍 m6 + 指针 NULL（零部分写入）');

  // ============ B：完整链单事务激活成功 ============
  const projectB = newProjectWithLockedScript(CLEAN_MD);
  const planB = buildNarrationPlanV2(projectB);
  const chainB = buildFullChain(projectB, planB.artifact.id);
  ok(
    getM7PipelineActivationStatus(projectB) === 'snapshot_ready',
    '[B1] snapshot artifact 存在但未激活 → status=snapshot_ready',
  );
  activateM7Pipeline(projectB, chainB.snapshotArtifactId);
  ok(getPipelineVersion(projectB) === 'm7', '[B2] 完整 snapshot → pipelineVersion=m7');
  ok(
    getM7PipelineSnapshotId(projectB) === chainB.snapshotArtifactId,
    '[B3] snapshot 指针精确指向激活 artifact（同事务写入）',
  );
  {
    let threw = false;
    try {
      assertPipelineConsistency(projectB);
    } catch {
      threw = true;
    }
    ok(!threw, '[B4] 激活后 consistency 复查通过');
  }
  ok(getM7PipelineActivationStatus(projectB) === 'active', '[B5] activation status=active');
  {
    const current = getCurrentNarrationPlanV2(projectB);
    ok(
      current !== null && current.artifact.id === planB.artifact.id,
      '[B6] m7 + snapshot → deprecated current getter 精确返回 snapshot 引用的 plan',
    );
  }
  expectPipelineError(
    'ALREADY_M7',
    () => activateM7Pipeline(projectB, chainB.snapshotArtifactId),
    '[B7] 重复 activation → ALREADY_M7',
  );
  expectPipelineError(
    'M7_ACTIVATION_SNAPSHOT_REQUIRED',
    () => switchPipelineToM7(projectB),
    '[B8] m7 项目旧函数仍恒定拒绝（无绕过路径）',
  );

  // ============ F：frozen ruleset（不追溯；引用丢失/损坏仍 fail-closed） ============
  {
    // 引用 artifact 丢失
    getDb()
      .prepare('DELETE FROM artifacts WHERE id = ?')
      .run(chainB.artifacts.animaticRenderArtifactId);
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => assertPipelineConsistency(projectB),
      '[F1] 已激活项目引用 artifact 丢失 → consistency fail-closed',
    );
    ok(getM7PipelineActivationStatus(projectB) === 'inconsistent', '[F2] status=inconsistent');
    const newRender = insertArtifact(projectB, 'animatic_render', {});
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run(
        JSON.stringify({artifactId: newRender, decision: 'approved'}),
        chainB.artifacts.animaticApprovalId,
      );
    // 直接恢复原 ID 不可能（已删除）；改 snapshot 不可能（immutable）。
    // 恢复方式：重建完整链证明「新代码不追溯旧 snapshot」——旧 snapshot 损坏后
    // 项目保持 m7 指针但 consistency 失败，正是 fail-closed 语义。
    void newRender;
  }
  {
    // 引用 artifact 内容损坏
    const projectC = newProjectWithLockedScript(CLEAN_MD);
    const planC = buildNarrationPlanV2(projectC);
    const chainC = buildFullChain(projectC, planC.artifact.id);
    activateM7Pipeline(projectC, chainC.snapshotArtifactId);
    getDb()
      .prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
      .run('corrupted', chainC.artifacts.editorialGateResultArtifactId);
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => assertPipelineConsistency(projectC),
      '[F3] 引用 artifact 内容损坏 → consistency fail-closed',
    );
    // v1.0 snapshot 永远按 v1.0 验证：未知/未来 ruleset 不会被用来追溯
    const snap = getM7PipelineSnapshotArtifact(projectC, chainC.snapshotArtifactId);
    ok(
      snap !== null &&
        snap.snapshot.rulesetVersion === M7_ACTIVATION_RULESET_V1 &&
        getSnapshotValidator(snap.snapshot.rulesetVersion) !== null,
      '[F4] v1.0 snapshot 固定分发到 v1.0 validator（ruleset 来自 snapshot 自身声明）',
    );
  }
  {
    // m6 指针污染（直接 UPDATE 模拟脏数据）→ fail-closed
    const projectD = newProjectWithLockedScript(CLEAN_MD);
    getDb()
      .prepare('UPDATE projects SET m7_pipeline_snapshot_id = ? WHERE id = ?')
      .run(crypto.randomUUID(), projectD);
    expectPipelineError(
      'INCONSISTENT_POINTER',
      () => assertPipelineConsistency(projectD),
      '[F5] m6 + 非 NULL snapshot 指针 → INCONSISTENT_POINTER',
    );
    ok(getM7PipelineActivationStatus(projectD) === 'inconsistent', '[F6] 指针污染 → status=inconsistent');
    // m7 + NULL 指针
    getDb()
      .prepare(`UPDATE projects SET pipeline_version = 'm7', m7_pipeline_snapshot_id = NULL WHERE id = ?`)
      .run(projectD);
    expectPipelineError(
      'INCONSISTENT_POINTER',
      () => assertPipelineConsistency(projectD),
      '[F7] m7 + NULL snapshot 指针 → INCONSISTENT_POINTER',
    );
  }

  // ============ M：migration / 幂等 ============
  {
    const cols = getDb()
      .prepare(`SELECT name FROM pragma_table_info('projects')`)
      .all() as Array<{name: string}>;
    ok(
      cols.some((c) => c.name === 'm7_pipeline_snapshot_id'),
      '[M1] m7_pipeline_snapshot_id 列存在',
    );
    closeDb();
    getDb(); // 重开 → migration 再跑一遍
    ok(true, '[M2] closeDb 后重开 migration 幂等（无异常）');
    const legacyId = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id, current_stage, created_at, updated_at)
         VALUES (?, 'legacy-m711', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
      )
      .run(legacyId, now, now);
    ok(
      getPipelineVersion(legacyId) === 'm6' && getM7PipelineSnapshotId(legacyId) === null,
      '[M3] 既有/新插入项目默认 m6 + 指针 NULL',
    );
    const m6Dirty = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM projects
         WHERE pipeline_version = 'm6' AND m7_pipeline_snapshot_id IS NOT NULL`,
      )
      .get() as {c: number};
    // projectD 被故意污染后改成了 m7+NULL，不在此集合；其余 m6 项目必须干净
    ok(m6Dirty.c === 0, '[M4] 全部 m6 项目 snapshot 指针为 NULL');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m711-activation'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.1.1 activation gate 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.1.1 activation gate 测试全部通过 ✅');
}

main();

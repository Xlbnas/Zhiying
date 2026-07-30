/**
 * M7.1 数据库 / 集成测试（Mock provider，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m71-db.ts
 * 使用临时数据目录（data/test-m71-db），结束后清理。
 * 覆盖：migration 默认 m6、append-only artifact、needsReview fail-closed、
 * pipelineVersion 原子分流 guard、stale/consistency、enqueue v2 端到端、
 * legacy M1 项目拒绝。任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m71-db');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion, editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {
  buildNarrationPlanV2,
  checkNarrationPlanV2Readiness,
  getCurrentNarrationPlanV2,
  NarrationPlanV2Error,
} from '../src/lib/narration/plan-v2';
import {NARRATION_PLAN_V2_ARTIFACT_KIND} from '../src/lib/narration/schema-v2';
import {
  assertPipelineConsistency,
  getPipelineVersion,
  PipelineVersionError,
  switchPipelineToM7,
} from '../src/lib/pipeline-version';
import {
  enqueueNarrationAudioJobsV2,
  fingerprintForUnit,
  NarrationAudioV2Error,
  type TtsProviderSnapshot,
} from '../src/lib/narration/audio-v2';
import {parseTtsJobPayload} from '../src/lib/tts-jobs';
import {DEFAULT_VOICE_PROFILE} from '../src/lib/tts';

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

function expectError<T extends Error>(
  cls: new (...args: never[]) => T,
  code: string,
  fn: () => unknown,
  label: string,
): void {
  try {
    fn();
    ok(false, label, '意外成功（应抛错）');
  } catch (err) {
    ok(
      err instanceof cls && (err as {code?: string}).code === code,
      label,
      err instanceof Error ? `${err.name}: ${(err as {code?: string}).code ?? err.message}` : err,
    );
  }
}

const SNAPSHOT: TtsProviderSnapshot = {
  name: 'mock',
  model: 'mock-tts',
  providerVersion: '1.0.0',
  providerCommit: null,
};

const UPSTREAM: WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
];

/** 锁全部上游 + script_v2（content 为 locked script_v2 markdown）。 */
function lockThroughScriptV2(projectId: string, scriptContent: string, promptVersion: string | null): void {
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
    content: scriptContent,
    contentType: 'markdown',
    source: 'manual_edit',
    promptVersion,
  });
  lockStage(projectId, 'script_v2');
}

const CLEAN_MD = `# Script V2

## 第 1 章 T（00:00–01:00）

第一句。第二句。
第三句。
`;

const REVIEW_MD = `# Script V2

## 第 1 章 T（00:00–01:00）

（停顿）第一句。
`;

function artifactRows(projectId: string): Array<{id: string; version: number; content_json: string}> {
  return getDb()
    .prepare(
      `SELECT id, version, content_json FROM artifacts
       WHERE project_id = ? AND kind = ? ORDER BY version ASC`,
    )
    .all(projectId, NARRATION_PLAN_V2_ARTIFACT_KIND) as Array<{
    id: string;
    version: number;
    content_json: string;
  }>;
}

function main(): void {
  // ============ Project A：干净 legacy markdown（eligible 全链路） ============
  const projectA = createProjectWithWorkflow({topic: 'db-test-a', coreQuestion: 'q'}).project.id;

  ok(getPipelineVersion(projectA) === 'm6', '[DB1] migration 后新项目默认 pipelineVersion=m6');
  {
    const col = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('projects') WHERE name = 'pipeline_version'`)
      .get() as {c: number};
    ok(col.c === 1, '[DB2] projects.pipeline_version 列存在（幂等 migration）');
  }

  expectError(
    NarrationPlanV2Error,
    'SCRIPT_V2_NOT_LOCKED',
    () => buildNarrationPlanV2(projectA),
    '[DB3] script_v2 未锁定 → 拒绝构建',
  );

  lockThroughScriptV2(projectA, CLEAN_MD, 'script-v2@1.0');

  const build1 = buildNarrationPlanV2(projectA);
  ok(!build1.reused && build1.artifact.version === 1, '[DB4] 首次构建 → 新 artifact v1');
  ok(build1.plan.needsReview.length === 0, '[DB5] 干净 markdown needsReview=0');
  ok(
    build1.plan.units.filter((u) => u.kind === 'speech').length === 2,
    '[DB6] speech unit 数=2（每 unit 两句）',
    build1.plan.units.map((u) => [u.id, u.kind]),
  );

  const build2 = buildNarrationPlanV2(projectA);
  ok(build2.reused && build2.artifact.id === build1.artifact.id, '[DB7] 重复构建幂等（reused，同 artifact）');
  ok(artifactRows(projectA).length === 1, '[DB8] 幂等构建不产生新 artifact 行');

  ok(getPipelineVersion(projectA) === 'm6', '[DB9] 构建 M7 candidate 不自动切 pipelineVersion');

  const current = getCurrentNarrationPlanV2(projectA);
  ok(current !== null && current.artifact.id === build1.artifact.id, '[DB10] eligible plan → current 可读');
  ok(checkNarrationPlanV2Readiness(projectA).status === 'ready', '[DB11] readiness=ready');

  // pipelineVersion 原子分流
  switchPipelineToM7(projectA);
  ok(getPipelineVersion(projectA) === 'm7', '[DB12] required chain 完整 → 原子切换 m7');
  expectError(
    PipelineVersionError,
    'ALREADY_M7',
    () => switchPipelineToM7(projectA),
    '[DB13] 重复切换 → ALREADY_M7',
  );
  let consistencyThrew = false;
  try {
    assertPipelineConsistency(projectA);
  } catch {
    consistencyThrew = true;
  }
  ok(!consistencyThrew, '[DB14] m7 + chain 完整 → consistency 复查通过');

  // enqueue v2 端到端（mock provider，不落音频文件，仅验证入队 payload）
  const enq1 = enqueueNarrationAudioJobsV2({projectId: projectA, provider: SNAPSHOT});
  ok(enq1.enqueued === 2 && enq1.reused === 0, '[DB15] 首次入队：2 个 speech unit → 2 jobs', enq1);
  const jobs = getDb()
    .prepare(`SELECT payload_json FROM tts_jobs WHERE project_id = ? ORDER BY queued_at ASC`)
    .all(projectA) as Array<{payload_json: string}>;
  const payloads = jobs.map((j) => parseTtsJobPayload(j.payload_json));
  ok(
    payloads.every((p) => p !== null && p.schemaVersion === 'tts-payload@1.1'),
    '[DB16] 全部 job payload 为 tts-payload@1.1',
  );
  const planUnits = current!.plan.units.filter((u) => u.kind === 'speech');
  const p0 = payloads[0];
  ok(
    p0 !== null &&
      p0.schemaVersion === 'tts-payload@1.1' &&
      p0.spokenText === planUnits[0]!.spokenText &&
      p0.delivery === planUnits[0]!.delivery &&
      p0.ttsInputFingerprint ===
        fingerprintForUnit(planUnits[0]!, SNAPSHOT, DEFAULT_VOICE_PROFILE, 'none'),
    '[DB17] payload spokenText/delivery/fingerprint 与 plan 精确一致',
  );
  const enq2 = enqueueNarrationAudioJobsV2({projectId: projectA, provider: SNAPSHOT});
  ok(enq2.enqueued === 0 && enq2.active === 2, '[DB18] 重复入队 → active 去重（零新 job）', enq2);

  // stale：script_v2 新版本 → 旧 plan artifact 不再 current（append-only 保留）
  const beforeRows = artifactRows(projectA);
  editVersion(
    {
      projectId: projectA,
      stage: 'script_v2',
      content: `${CLEAN_MD}\n第四句。`,
      contentType: 'markdown',
      source: 'manual_edit',
      promptVersion: 'script-v2@1.0',
    },
    {confirmStale: true},
  );
  lockStage(projectA, 'script_v2');
  ok(getCurrentNarrationPlanV2(projectA) === null, '[DB19] script_v2 新版本锁定后旧 plan stale（current=null）');
  expectError(
    PipelineVersionError,
    'CHAIN_INCOMPLETE',
    () => assertPipelineConsistency(projectA),
    '[DB20] m7 项目 chain 断裂 → consistency 复查 fail-closed',
  );
  const build3 = buildNarrationPlanV2(projectA);
  ok(!build3.reused && build3.artifact.version === 2, '[DB21] 新 locked 版本 → append-only 新 artifact v2');
  const afterRows = artifactRows(projectA);
  ok(
    afterRows.length === 2 && afterRows[0]!.content_json === beforeRows[0]!.content_json,
    '[DB22] 旧 artifact 原样保留（append-only，无 destructive overwrite）',
  );
  ok(getCurrentNarrationPlanV2(projectA) !== null, '[DB23] 重建后 current 恢复');
  let consistencyThrew2 = false;
  try {
    assertPipelineConsistency(projectA);
  } catch {
    consistencyThrew2 = true;
  }
  ok(!consistencyThrew2, '[DB24] 重建后 m7 consistency 恢复');

  // ============ Project B：needsReview candidate（fail-closed） ============
  const projectB = createProjectWithWorkflow({topic: 'db-test-b', coreQuestion: 'q'}).project.id;
  lockThroughScriptV2(projectB, REVIEW_MD, 'script-v2@1.0');
  const buildB = buildNarrationPlanV2(projectB);
  ok(buildB.plan.needsReview.length > 0, '[DB25] （停顿）无时长 → needsReview 非空', buildB.plan.needsReview);
  ok(artifactRows(projectB).length === 1, '[DB26] needsReview plan 可保存为 candidate artifact');
  ok(getCurrentNarrationPlanV2(projectB) === null, '[DB27] needsReview candidate 不得 current');
  ok(checkNarrationPlanV2Readiness(projectB).status === 'needs_review', '[DB28] readiness=needs_review');
  const buildB2 = buildNarrationPlanV2(projectB);
  ok(buildB2.reused && artifactRows(projectB).length === 1, '[DB29] needsReview 重复构建同样幂等');
  expectError(
    PipelineVersionError,
    'CHAIN_INCOMPLETE',
    () => switchPipelineToM7(projectB),
    '[DB30] needsReview 项目切换 m7 → CHAIN_INCOMPLETE',
  );
  ok(getPipelineVersion(projectB) === 'm6', '[DB31] 切换被拒后 pipelineVersion 保持 m6（事务原子）');
  expectError(
    NarrationAudioV2Error,
    'NARRATION_PLAN_V2_NOT_CURRENT',
    () => enqueueNarrationAudioJobsV2({projectId: projectB, provider: SNAPSHOT}),
    '[DB32] needsReview 项目入队 v2 → 拒绝',
  );

  // ============ Project C：legacy M1（无 project_stages 行） ============
  const legacyId = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id, current_stage, created_at, updated_at)
       VALUES (?, 'legacy', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    )
    .run(legacyId, now, now);
  ok(getPipelineVersion(legacyId) === 'm6', '[DB33] legacy M1 项目 migration 后默认 m6');
  expectError(
    NarrationPlanV2Error,
    'LEGACY_PROJECT',
    () => buildNarrationPlanV2(legacyId),
    '[DB34] legacy M1 项目 → LEGACY_PROJECT（不误构建）',
  );

  // ============ 未切换项目不得处于 m7（全表断言） ============
  {
    const m7Projects = getDb()
      .prepare(`SELECT id FROM projects WHERE pipeline_version = 'm7'`)
      .all() as Array<{id: string}>;
    ok(
      m7Projects.length === 1 && m7Projects[0]!.id === projectA,
      '[DB35] 仅显式切换的项目处于 m7',
      m7Projects,
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m71-db'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.1 DB 集成测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.1 DB 集成测试全部通过 ✅');
}

main();

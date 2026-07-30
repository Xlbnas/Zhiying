/**
 * M7.1.1 production 负向验证（live DB，fail-closed 语义验证）。
 *
 * 用法（production 容器内，挂载 data 目录）：
 *   npx tsx scripts/m711-activation-verify.ts
 *
 * 安全性：
 * - 只读取 artifact / projects / jobs。
 * - 对 activateM7Pipeline / switchPipelineToM7 的调用必然抛错，
 *   抛错发生在单事务内，整体回滚——绝不产生部分写入。
 * - 验证前后比对 pipeline_version / snapshot 指针 / job 计数 / Freud candidate hash。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';

import {closeDb, getDb} from '../src/lib/db';
import {
  classifyNarrationPlanV2Candidate,
  getCurrentNarrationPlanV2,
  listNarrationPlanV2Candidates,
} from '../src/lib/narration/plan-v2';
import {NARRATION_PLAN_V2_ARTIFACT_KIND} from '../src/lib/narration/schema-v2';
import {
  activateM7Pipeline,
  assertPipelineConsistency,
  getM7PipelineActivationStatus,
  getM7PipelineSnapshotId,
  getPipelineVersion,
  PipelineVersionError,
  switchPipelineToM7,
} from '../src/lib/pipeline-version';

const FREUD_PROJECT_ID = '8fbe9cb6-ed5f-41e9-b748-b52e156ba314';
const TUOYAN_PROJECT_ID = '2fda54fb-e5fa-4237-bda3-265fe1d7978d';
const FREUD_CANDIDATE_ARTIFACT_ID = '01ff6fbd-a1a8-4409-842b-dc586fed0f62';

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

function jobCounts(projectId: string): {tts: number; render: number} {
  const tts = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?`)
    .get(projectId) as {c: number};
  let render = 0;
  try {
    const r = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM render_jobs WHERE project_id = ?`)
      .get(projectId) as {c: number};
    render = r.c;
  } catch {
    render = -1; // 表不存在则标记，不当作新增
  }
  return {tts: tts.c, render};
}

function artifactHash(artifactId: string): string | null {
  const row = getDb()
    .prepare('SELECT content_json FROM artifacts WHERE id = ?')
    .get(artifactId) as {content_json: string} | undefined;
  if (!row) return null;
  return crypto.createHash('sha256').update(row.content_json, 'utf8').digest('hex');
}

function verifyProject(projectId: string, label: string): void {
  console.log(`\n===== ${label} (${projectId}) =====`);
  const beforeJobs = jobCounts(projectId);
  ok(getPipelineVersion(projectId) === 'm6', `${label} pipelineVersion=m6`);
  ok(getM7PipelineSnapshotId(projectId) === null, `${label} m7_pipeline_snapshot_id=NULL`);
  ok(getCurrentNarrationPlanV2(projectId) === null, `${label} deprecated current getter 返回 null（无 active snapshot）`);

  const candidates = listNarrationPlanV2Candidates(projectId);
  console.log(
    `  candidates: ${candidates.map((c) => `${c.artifact.id.slice(0, 8)}:${c.status}`).join(', ') || '(无)'}`,
  );

  // 负向：任何路径都不得激活
  for (const candidate of candidates) {
    expectPipelineError(
      'SNAPSHOT_CHAIN_INCOMPLETE',
      () => activateM7Pipeline(projectId, candidate.artifact.id),
      `${label} candidate ${candidate.artifact.id.slice(0, 8)} 充当 snapshot 激活 → 拒绝`,
    );
  }
  expectPipelineError(
    'SNAPSHOT_CHAIN_INCOMPLETE',
    () => activateM7Pipeline(projectId, crypto.randomUUID()),
    `${label} 不存在的 snapshot → 拒绝`,
  );
  expectPipelineError(
    'M7_ACTIVATION_SNAPSHOT_REQUIRED',
    () => switchPipelineToM7(projectId),
    `${label} 废弃 switchPipelineToM7 → M7_ACTIVATION_SNAPSHOT_REQUIRED`,
  );

  // 负向调用后状态必须零变化（事务原子）
  ok(getPipelineVersion(projectId) === 'm6', `${label} 负向调用后 pipelineVersion 仍 m6`);
  ok(getM7PipelineSnapshotId(projectId) === null, `${label} 负向调用后 snapshot 指针仍 NULL`);
  const afterJobs = jobCounts(projectId);
  ok(
    afterJobs.tts === beforeJobs.tts && afterJobs.render === beforeJobs.render,
    `${label} 负向调用零新增 TTS/render job`,
    {before: beforeJobs, after: afterJobs},
  );
  let threw = false;
  try {
    assertPipelineConsistency(projectId);
  } catch {
    threw = true;
  }
  ok(!threw, `${label} consistency 复查通过（m6 + 指针 NULL）`);
  ok(
    getM7PipelineActivationStatus(projectId) === (candidates.length > 0 ? 'building' : 'not_started'),
    `${label} activation status=${candidates.length > 0 ? 'building' : 'not_started'}`,
  );
}

function main(): void {
  const freudHashBefore = artifactHash(FREUD_CANDIDATE_ARTIFACT_ID);
  ok(freudHashBefore !== null, 'Freud candidate artifact 存在');
  console.log(`  Freud candidate sha256(content_json)=${freudHashBefore}`);

  {
    const row = getDb()
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(FREUD_CANDIDATE_ARTIFACT_ID) as never;
    const classified = classifyNarrationPlanV2Candidate(FREUD_PROJECT_ID, row);
    ok(
      classified.status === 'eligible_candidate',
      `Freud candidate 状态=eligible_candidate（实际 ${classified.status}）`,
      classified.statusReason ?? undefined,
    );
  }

  verifyProject(FREUD_PROJECT_ID, 'Freud');
  verifyProject(TUOYAN_PROJECT_ID, '拖延');

  const freudHashAfter = artifactHash(FREUD_CANDIDATE_ARTIFACT_ID);
  ok(
    freudHashAfter !== null && freudHashAfter === freudHashBefore,
    'Freud candidate 内容 hash 验证前后不变',
  );

  closeDb();
  console.log(`\n[verify] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[verify] M7.1.1 production 负向验证存在失败项 ❌');
    process.exit(1);
  }
  console.log('[verify] M7.1.1 production 负向验证全部通过 ✅');
}

main();

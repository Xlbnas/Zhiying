/**
 * M2-A 工作流状态机自动化测试（独立，不依赖 LLM / API / UI）。
 *
 * 用法：npx tsx scripts/test-workflow-stages.ts
 * 使用临时数据目录（data/test-workflow-stages），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-workflow-stages');

import {closeDb, getDb} from '../src/lib/db';
import {
  affectedDownstream,
  assertRerunAllowed,
  assertRunnable,
  getStage,
  initProjectStages,
  listStages,
  lockStage,
  markEdited,
  markGenerated,
  markRolledBack,
  WorkflowError,
} from '../src/lib/workflow/stages';
import {
  copyVersionAsNew,
  createVersion,
  getVersion,
  listVersions,
} from '../src/lib/workflow/versions';

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

function expectThrow(
  fn: () => void,
  code: WorkflowError['code'],
  label: string,
): void {
  try {
    fn();
    ok(false, `${label}（未抛错）`);
  } catch (err) {
    ok(
      err instanceof WorkflowError && err.code === code,
      `${label}（抛出 ${err instanceof WorkflowError ? err.code : String(err)}）`,
    );
  }
}

const PID = 'test-project-m2a';

function main(): void {
  // 干净起点
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-stages'), {
    recursive: true,
    force: true,
  });
  const db = getDb();
  db.prepare(
    `INSERT INTO projects (id, title, created_at, updated_at)
     VALUES (?, 'M2-A 测试项目', ?, ?)`,
  ).run(PID, new Date().toISOString(), new Date().toISOString());

  // ---- 1. 初始化 ----
  initProjectStages(PID);
  const stages = listStages(PID);
  ok(stages.length === 10, '初始化产生 10 个阶段行');
  ok(
    stages.every((s) => s.status === 'not_started'),
    '初始状态全部 not_started',
  );
  ok(
    stages[0].stage === 'project_definition' && stages[9].stage === 'scenes',
    '阶段顺序正确（project_definition … scenes）',
  );
  // 幂等
  initProjectStages(PID);
  ok(listStages(PID).length === 10, '重复初始化幂等（仍 10 行）');

  // ---- 2. run 门控 ----
  expectThrow(
    () => assertRunnable(PID, 'research'),
    'UPSTREAM_NOT_LOCKED',
    '上游未锁时 research 禁止 run',
  );
  ok(
    (() => {
      try {
        assertRunnable(PID, 'research');
        return false;
      } catch (err) {
        return (
          err instanceof WorkflowError &&
          err.detail?.firstUnlockedUpstream === 'project_definition'
        );
      }
    })(),
    '门控错误携带首个未锁上游名',
  );
  assertRunnable(PID, 'project_definition'); // 首阶段无上游
  ok(true, '首阶段 project_definition 可直接 run');

  // ---- 3. 生成 → 版本递增 ----
  const v1 = createVersion({
    projectId: PID,
    stage: 'project_definition',
    content: '# 项目定义 v1',
    contentType: 'markdown',
    source: 'ai_generate',
    promptVersion: 'pd@1.0',
    model: 'mock-flash',
  });
  markGenerated(PID, 'project_definition');
  let row = getStage(PID, 'project_definition');
  ok(row?.status === 'generated', '生成后状态 generated');
  ok(row?.active_version === 1, 'active_version=1');
  ok(v1.version === 1, '首版本 version=1');

  const v2 = createVersion({
    projectId: PID,
    stage: 'project_definition',
    content: '# 项目定义 v2（regenerate）',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  markGenerated(PID, 'project_definition');
  row = getStage(PID, 'project_definition');
  ok(v2.version === 2 && row?.active_version === 2, 'regenerate 产生 version=2');

  // ---- 4. 人工编辑 → edited ----
  const v3 = createVersion({
    projectId: PID,
    stage: 'project_definition',
    content: '# 项目定义 v3（人工）',
    contentType: 'markdown',
    source: 'manual_edit',
  });
  markEdited(PID, 'project_definition');
  row = getStage(PID, 'project_definition');
  ok(v3.version === 3 && row?.status === 'edited', '人工编辑 version=3 且状态 edited');

  // ---- 5. 锁定 ----
  lockStage(PID, 'project_definition');
  row = getStage(PID, 'project_definition');
  ok(row?.status === 'locked' && row.locked_version === 3, '锁定 locked_version=3');

  // 上游已锁 → research 可 run
  assertRunnable(PID, 'research');
  ok(true, 'project_definition 锁定后 research 通过门控');
  expectThrow(
    () => assertRunnable(PID, 'evidence'),
    'UPSTREAM_NOT_LOCKED',
    'research 未锁时 evidence 仍禁止 run',
  );

  // research 也走到 locked（供下游测试）
  createVersion({
    projectId: PID,
    stage: 'research',
    content: '# 研究 v1',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  markGenerated(PID, 'research');
  lockStage(PID, 'research');
  ok(getStage(PID, 'research')?.status === 'locked', 'research 已锁定');

  // ---- 6. 编辑 locked 阶段：confirmStale 门 ----
  expectThrow(
    () => markEdited(PID, 'project_definition'),
    'CONFIRM_STALE_REQUIRED',
    '编辑 locked 阶段无 confirm 被拒绝',
  );
  ok(
    affectedDownstream(PID, 'project_definition').includes('research'),
    'affectedDownstream 预告包含 research',
  );
  createVersion({
    projectId: PID,
    stage: 'project_definition',
    content: '# 项目定义 v4（锁后改）',
    contentType: 'markdown',
    source: 'manual_edit',
  });
  markEdited(PID, 'project_definition', {confirmStale: true});
  row = getStage(PID, 'project_definition');
  ok(row?.status === 'edited' && row.locked_version === 3, '编辑后 edited，locked_version 保留 3');
  ok(getStage(PID, 'research')?.status === 'stale', '下游 research 被传播 stale');
  ok(
    getStage(PID, 'research')?.locked_version === 1,
    'stale 后 research 的 locked_version 保留可查',
  );
  ok(
    getStage(PID, 'evidence')?.status === 'not_started',
    'not_started 下游（evidence）不受 stale 传播影响',
  );

  // ---- 7. stale 规则 ----
  expectThrow(
    () => lockStage(PID, 'research'),
    'STALE_MUST_RERUN',
    'stale 阶段不能直接 lock',
  );
  // project_definition 第 6 节编辑后尚未重新锁定，先锁定使 research 门控通过
  lockStage(PID, 'project_definition');
  ok(
    getStage(PID, 'project_definition')?.locked_version === 4,
    '锁后编辑重新锁定（locked_version=4）',
  );
  // stale re-run 无需 confirm
  assertRerunAllowed(PID, 'research');
  ok(true, 'stale 阶段 re-run 无需 confirm');
  createVersion({
    projectId: PID,
    stage: 'research',
    content: '# 研究 v2（重跑）',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  markGenerated(PID, 'research');
  ok(getStage(PID, 'research')?.status === 'generated', 'stale re-run 后 generated');
  lockStage(PID, 'research');
  ok(
    getStage(PID, 'research')?.locked_version === 2,
    're-run 后可重新 lock（locked_version=2）',
  );

  // ---- 8. locked 阶段 re-run 需要 confirm ----
  expectThrow(
    () => assertRerunAllowed(PID, 'research'),
    'CONFIRM_STALE_REQUIRED',
    'locked 阶段 re-run 无 confirm 被拒绝',
  );
  assertRerunAllowed(PID, 'research', {confirmStale: true});
  ok(true, 'locked 阶段 re-run 带 confirm 通过');

  // ---- 9. locked 阶段 rollback 需要 confirm（此时 research 仍 locked）----
  expectThrow(
    () => markRolledBack(PID, 'research'),
    'CONFIRM_STALE_REQUIRED',
    'locked 阶段 rollback 无 confirm 被拒绝',
  );

  // ---- 10. rollback：复制历史为新版本 ----
  const before = listVersions(PID, 'project_definition').length;
  const rb = copyVersionAsNew(PID, 'project_definition', 1);
  markRolledBack(PID, 'project_definition', {confirmStale: true});
  ok(rb.version === 5, `rollback 产生新版本 version=5（当前 ${rb.version}）`);
  ok(rb.content === '# 项目定义 v1', 'rollback 内容复制自 v1');
  ok(rb.source === 'rollback', 'rollback source 标记正确');
  ok(rb.prompt_version === 'pd@1.0', 'rollback 继承原 prompt_version');
  ok(
    getVersion(PID, 'project_definition', 1)?.content === '# 项目定义 v1',
    '历史版本 v1 未被移动/修改',
  );
  ok(
    listVersions(PID, 'project_definition').length === before + 1,
    '版本总数 +1（历史不删）',
  );
  ok(
    getStage(PID, 'project_definition')?.status === 'edited',
    'rollback 后状态 edited',
  );
  ok(
    getStage(PID, 'research')?.status === 'stale',
    'locked 阶段 rollback 确认后下游传播 stale',
  );

  // ---- 11. content_type 与查询 ----
  // 恢复链路：先锁 project_definition（edited → locked），research（stale）re-run → lock
  lockStage(PID, 'project_definition');
  assertRerunAllowed(PID, 'research');
  createVersion({
    projectId: PID,
    stage: 'research',
    content: '# 研究 v3（恢复）',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  markGenerated(PID, 'research');
  lockStage(PID, 'research');
  createVersion({
    projectId: PID,
    stage: 'evidence',
    content: '{"items":[]}',
    contentType: 'json',
    source: 'ai_generate',
  });
  markGenerated(PID, 'evidence');
  assertRunnable(PID, 'evidence');
  const ev = getVersion(PID, 'evidence', 1);
  ok(ev?.content_type === 'json', 'json content_type 存取正确');
  ok(
    getStage(PID, 'project_definition')?.locked_version === 5,
    'rollback 后重新锁定指向新版本（locked_version=5）',
  );

  // ---- 汇总 ----
  console.log('');
  console.log(`[test] 汇总: PASS=${pass} FAIL=${fail}`);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-stages'), {
    recursive: true,
    force: true,
  });
  if (fail > 0) {
    process.exit(1);
  }
  console.log('[test] M2-A 工作流状态机测试全部通过 ✅');
}

main();

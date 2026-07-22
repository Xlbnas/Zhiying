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

import Database from 'better-sqlite3';
import {closeDb, getDb, getDbPath} from '../src/lib/db';
import {
  editVersion,
  generateVersion,
  rollbackToVersion,
} from '../src/lib/workflow/operations';
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
import type {ProjectVersionRow} from '../src/lib/workflow/types';
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

  // ================================================================
  // 第二部分：Hardening（UNIQUE 约束 + 高层原子操作 + 并发安全）
  // ================================================================
  const PID2 = 'test-project-m2a-atomic';
  db.prepare(
    `INSERT INTO projects (id, title, created_at, updated_at)
     VALUES (?, 'M2-A Hardening 测试项目', ?, ?)`,
  ).run(PID2, new Date().toISOString(), new Date().toISOString());
  initProjectStages(PID2);

  // ---- A. 数据库级版本唯一约束 ----
  const g1 = generateVersion({
    projectId: PID2,
    stage: 'project_definition',
    content: '# 定义 v1',
    contentType: 'markdown',
    source: 'ai_generate',
    promptVersion: 'pd@1.0',
    model: 'mock-flash',
  });
  ok(g1.version === 1, '[A] generateVersion 创建 v1');
  let dupRejected = false;
  try {
    db.prepare(
      `INSERT INTO project_versions
         (id, project_id, stage, version, content, content_type, source, created_at)
       VALUES ('dup-id', ?, 'project_definition', 1, 'x', 'markdown', 'ai_generate', ?)`,
    ).run(PID2, new Date().toISOString());
  } catch (err) {
    dupRejected =
      err instanceof Error &&
      /UNIQUE|uq_project_versions_project_stage_version/.test(err.message);
  }
  ok(dupRejected, '[A] 同 project/stage/version 重复插入被 UNIQUE 约束拒绝');

  // ---- B. AI generate 原子操作：version + active + status 一次完成 ----
  let r2 = getStage(PID2, 'project_definition');
  ok(
    r2?.active_version === 1 && r2.status === 'generated',
    '[B] generateVersion 后 active_version=1 且 status=generated（单次调用）',
  );
  const g2 = generateVersion({
    projectId: PID2,
    stage: 'project_definition',
    content: '# 定义 v2',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  r2 = getStage(PID2, 'project_definition');
  ok(
    g2.version === 2 && r2?.active_version === 2 && r2.status === 'generated',
    '[B] 再次 generate：version=2 / active=2 / status=generated 原子完成',
  );

  // ---- C. manual edit 原子操作 + stale 传播 ----
  lockStage(PID2, 'project_definition');
  // research 推进到 locked，供 stale 传播验证
  generateVersion({
    projectId: PID2,
    stage: 'research',
    content: '# 研究 v1',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  lockStage(PID2, 'research');
  const beforeC = listVersions(PID2, 'project_definition').length;
  let e1: ProjectVersionRow | undefined;
  try {
    e1 = editVersion({
      projectId: PID2,
      stage: 'project_definition',
      content: '# 定义 v3（锁后改）',
      contentType: 'markdown',
      source: 'manual_edit',
    });
    ok(false, '[C] locked 阶段 editVersion 无 confirm 应被拒绝');
  } catch (err) {
    ok(
      err instanceof WorkflowError && err.code === 'CONFIRM_STALE_REQUIRED',
      '[C] locked 阶段 editVersion 无 confirm 被拒绝',
    );
  }
  // E（前置断言）：失败后无任何部分状态
  r2 = getStage(PID2, 'project_definition');
  ok(
    listVersions(PID2, 'project_definition').length === beforeC &&
      r2?.active_version === 2 &&
      r2.status === 'locked' &&
      getStage(PID2, 'research')?.status === 'locked',
    '[E] editVersion 校验失败：版本数/active/status/下游 全部无变化',
  );
  e1 = editVersion(
    {
      projectId: PID2,
      stage: 'project_definition',
      content: '# 定义 v3（锁后改）',
      contentType: 'markdown',
      source: 'manual_edit',
    },
    {confirmStale: true},
  );
  r2 = getStage(PID2, 'project_definition');
  const researchAfterC = getStage(PID2, 'research');
  ok(
    e1.version === 3 &&
      r2?.active_version === 3 &&
      r2.status === 'edited' &&
      r2.locked_version === 2,
    '[C] editVersion：version=3 / active=3 / status=edited / locked_version 保留 原子完成',
  );
  ok(
    researchAfterC?.status === 'stale' && researchAfterC.locked_version === 1,
    '[C] 同事务 stale 传播：research=stale 且 locked_version 保留',
  );

  // ---- D. rollback 原子操作 ----
  lockStage(PID2, 'project_definition');
  const d0 = rollbackToVersion(PID2, 'project_definition', 1, {
    confirmStale: true,
  });
  r2 = getStage(PID2, 'project_definition');
  ok(
    d0.version === 4 &&
      d0.source === 'rollback' &&
      d0.content === '# 定义 v1' &&
      r2?.active_version === 4 &&
      r2.status === 'edited',
    '[D] rollbackToVersion：复制 v1 为 v4 / active=4 / status=edited 原子完成',
  );
  const beforeD = listVersions(PID2, 'project_definition').length;
  try {
    rollbackToVersion(PID2, 'project_definition', 999, {confirmStale: true});
    ok(false, '[D] rollback 不存在版本应抛错');
  } catch {
    ok(true, '[D] rollback 不存在版本抛错');
  }
  r2 = getStage(PID2, 'project_definition');
  ok(
    listVersions(PID2, 'project_definition').length === beforeD &&
      r2?.active_version === 4 &&
      r2.status === 'edited',
    '[E] rollback 目标不存在：版本数/active/status 全部无变化',
  );

  // ---- E2. 不存在阶段的写操作整体拒绝 ----
  try {
    editVersion({
      projectId: PID2,
      stage: 'shot_list',
      content: 'x',
      contentType: 'markdown',
      source: 'manual_edit',
    });
    ok(false, '[E] not_started 阶段编辑应被拒绝');
  } catch (err) {
    ok(
      err instanceof WorkflowError && err.code === 'NO_ACTIVE_VERSION',
      '[E] not_started 阶段编辑被拒绝（NO_ACTIVE_VERSION）',
    );
  }
  ok(
    listVersions(PID2, 'shot_list').length === 0 &&
      getStage(PID2, 'shot_list')?.status === 'not_started',
    '[E] 拒绝后 shot_list 无版本、状态未变',
  );

  // ---- F. 双连接并发：写锁互斥，不产生重复版本 ----
  const dbPath = getDbPath();
  const locker = new Database(dbPath);
  locker.pragma('busy_timeout = 100');
  const appDb = getDb();
  const originalTimeout = 5000;
  appDb.pragma('busy_timeout = 100');
  // research 当前 stale（C 段传播）→ 恢复 locked 供后续操作；先记录当前版本数
  const researchVersionsBeforeF = listVersions(PID2, 'research').length;
  locker.exec('BEGIN IMMEDIATE');
  let busyError = false;
  try {
    generateVersion({
      projectId: PID2,
      stage: 'research',
      content: '# 研究 并发写入',
      contentType: 'markdown',
      source: 'ai_generate',
    });
  } catch (err) {
    busyError = err instanceof Error && /busy|locked/i.test(err.message);
  }
  locker.exec('ROLLBACK');
  ok(busyError, '[F] 他连接持写锁时 generateVersion 被 SQLITE_BUSY 拒绝（锁互斥）');
  // 锁释放后重试成功，版本号接续唯一序列
  const f1 = generateVersion({
    projectId: PID2,
    stage: 'research',
    content: '# 研究 并发后重试',
    contentType: 'markdown',
    source: 'ai_generate',
  });
  appDb.pragma(`busy_timeout = ${originalTimeout}`);
  locker.close();
  ok(
    f1.version === researchVersionsBeforeF + 1,
    '[F] 锁释放后重试成功，版本号接续唯一序列',
  );
  const dupCheck = db
    .prepare(
      `SELECT COUNT(*) AS c FROM project_versions
       WHERE project_id = ? AND stage = 'research' AND version = ?`,
    )
    .get(PID2, f1.version) as {c: number};
  ok(dupCheck.c === 1, '[F] 并发测试后无重复版本号');

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

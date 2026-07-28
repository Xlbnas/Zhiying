/**
 * M5 UI 逻辑测试（零 DOM、零真实 API）：
 * - 创建项目表单：时长收敛 / payload 契约 / 选项完整性
 * - Stage 锁定自动进阶：nextStageAfter + deriveCurrentStage 模拟
 * - Stage 切换竞态：createLatestOnlyGuard 慢响应丢弃
 * - 友好错误文案：默认中文、error code 不外泄
 *
 * 用法：npx tsx scripts/test-m5-ui-logic.ts
 */

import {
  clampDurationMinutes,
  DURATION_DEFAULT,
  DURATION_MAX,
  DURATION_MIN,
  formatDurationPayload,
  LANGUAGE_OPTIONS,
  PLATFORM_OPTIONS,
  VIDEO_STYLE_OPTIONS,
} from '../src/components/form-utils';
import {
  createLatestOnlyGuard,
  deriveCurrentStage,
  friendlyStageError,
  nextStageAfter,
  type WorkflowStageState,
} from '../src/components/workflow/shared';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';

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

// ---------- 1. 时长控件 ----------
ok(clampDurationMinutes(10) === 10, '[F01] 默认 10 分钟');
ok(clampDurationMinutes(NaN) === DURATION_DEFAULT, '[F02] NaN → 默认值');
ok(clampDurationMinutes(0) === DURATION_MIN, '[F03] 0 → 最小值');
ok(clampDurationMinutes(-5) === DURATION_MIN, '[F04] 负数 → 最小值');
ok(clampDurationMinutes(999) === DURATION_MAX, '[F05] 超上限 → 最大值');
ok(clampDurationMinutes(7.6) === 8, '[F06] 小数取整');
ok(formatDurationPayload(10) === '10 分钟', '[F07] payload 契约保持「N 分钟」字符串');
ok(formatDurationPayload(NaN) === `${DURATION_DEFAULT} 分钟`, '[F08] 非法输入 payload 仍合法');
ok(
  PLATFORM_OPTIONS.includes('B站') && PLATFORM_OPTIONS.includes('YouTube') && PLATFORM_OPTIONS.includes('小红书') && PLATFORM_OPTIONS.includes('抖音') && PLATFORM_OPTIONS.includes('TikTok'),
  '[F09] 平台选项覆盖 B站/YouTube/小红书/抖音/TikTok',
);
ok(LANGUAGE_OPTIONS[0] === '中文' && LANGUAGE_OPTIONS.includes('英文'), '[F10] 语言默认中文且可选英文');
ok(VIDEO_STYLE_OPTIONS.includes('视频论文'), '[F11] 视频风格保留既有默认「视频论文」');

// ---------- 2. 锁定自动进阶 ----------
ok(nextStageAfter('project_definition') === 'research', '[N01] Stage 1 锁定 → 进入 Stage 2');
ok(nextStageAfter('evidence') === 'argument_tree', '[N02] 证据 → 论证树');
ok(nextStageAfter('shot_list') === 'scenes', '[N03] Stage 9 → Stage 10');
ok(nextStageAfter('scenes') === null, '[N04] 最后阶段 → null（不跳到不存在的 Stage 11）');

// 模拟连续锁定：deriveCurrentStage 始终指向拓扑序第一个未锁定阶段
function stageRow(stage: WorkflowStage, status: WorkflowStageState['status']): WorkflowStageState {
  return {
    project_id: 'p',
    stage,
    status,
    active_version: null,
    locked_version: null,
    updated_at: '',
    latestJob: null,
    activeJob: null,
  };
}
{
  const rows = WORKFLOW_STAGES.map((s) => stageRow(s, 'not_started'));
  ok(deriveCurrentStage(rows) === 'project_definition', '[N05] 初始：当前 = 选题定义');
  for (let i = 0; i < WORKFLOW_STAGES.length - 1; i++) {
    const row = rows.find((r) => r.stage === WORKFLOW_STAGES[i])!;
    row.status = 'locked';
    const expected = WORKFLOW_STAGES[i + 1];
    ok(
      deriveCurrentStage(rows) === expected,
      `[N06-${i + 1}] 锁定「${WORKFLOW_STAGES[i]}」后当前 = ${expected}`,
    );
  }
  rows.find((r) => r.stage === 'scenes')!.status = 'locked';
  ok(deriveCurrentStage(rows) === 'scenes', '[N07] 全部锁定后停留最后阶段（不越界）');
}

// ---------- 3. 切换竞态：慢响应不得覆盖新数据 ----------
{
  // A 慢、B 快：B 已显示后 A 才返回 → A 必须被丢弃
  const guard = createLatestOnlyGuard();
  const tokenA = guard.next(); // 用户点 A，发起请求
  const tokenB = guard.next(); // 立刻点 B，发起新请求
  ok(guard.isLatest(tokenB), '[R01] B 是最新请求');
  ok(!guard.isLatest(tokenA), '[R02] A 的慢响应被丢弃（不得覆盖 B）');

  // 快速连击 A → B → C：最终只接受 C
  const g2 = createLatestOnlyGuard();
  const tA = g2.next();
  const tB = g2.next();
  const tC = g2.next();
  ok(g2.isLatest(tC) && !g2.isLatest(tA) && !g2.isLatest(tB), '[R03] A→B→C 连击后只接受 C');
}

// ---------- 4. 友好错误文案 ----------
ok(
  friendlyStageError('VALIDATION_FAILED', '[SCENE_CHAPTER_MISMATCH] S039 超出第 6 章范围') ===
    '部分场景的时间超出了所属章节，系统正在尝试自动修复。',
  '[E01] SCENE_CHAPTER_MISMATCH → 自然中文',
);
ok(
  friendlyStageError('VALIDATION_FAILED', '[SCENE_CATEGORY_INVALID] 多个 scene category 非法') ===
    '部分场景的画面类型不符合规范，系统正在尝试自动修复。',
  '[E02] SCENE_CATEGORY_INVALID → 自然中文',
);
ok(
  friendlyStageError('VALIDATION_FAILED', '[CHAPTER_TIMING_INVALID] 最后一章 end 必须与最后一个 Scene end 一致') ===
    '章节时间与场景时间不一致，系统正在尝试自动修复。',
  '[E03] CHAPTER_TIMING_INVALID → 自然中文',
);
{
  const msg = friendlyStageError('VALIDATION_FAILED', '[SCENE_CHAPTER_MISMATCH] S039');
  ok(!msg.includes('SCENE_'), '[E04] 默认文案不泄露 error code');
}
ok(
  friendlyStageError(null, null) === '操作失败，请稍后重试。',
  '[E05] 无信息时的兜底文案',
);
ok(
  friendlyStageError('SOME_UNKNOWN', '原始错误文本') === '原始错误文本',
  '[E06] 未知错误回退原始 message',
);

console.log(`\nM5 ui-logic: ${pass} PASS, ${fail} FAIL`);
if (fail > 0) process.exitCode = 1;

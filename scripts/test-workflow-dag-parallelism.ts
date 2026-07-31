/**
 * M7.3A.2 Workflow DAG Authoritative 测试。
 *
 * 用法：npx tsx scripts/test-workflow-dag-parallelism.ts
 * 使用临时数据目录（data/test-workflow-dag-parallelism），结束后清理。
 *
 * 覆盖：
 * - DAG direct dependencies（非数组前缀）；
 * - DAG reachability 下游失效（script_v2 双分支，并行兄弟互不 stale）；
 * - lockStage 后 computeNewlyReadyAfterLock 给出多个并行 ready 节点；
 * - assertRunnable 只检查 DAG 直接依赖。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-workflow-dag-parallelism');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion, editVersion} from '../src/lib/workflow/operations';
import {
  assertRunnable,
  affectedDownstream,
  applyDownstreamStaleTx,
  getStage,
  lockStage,
} from '../src/lib/workflow/stages';
import {
  computeNewlyReadyAfterLock,
  directStageDependencies,
  downstreamOf,
  downstreamStageNodes,
  getNodeDef,
} from '../src/lib/workflow/dag-shared';
import type {WorkflowStage} from '../src/lib/workflow/types';

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

function lockThrough(projectId: string, last: WorkflowStage): void {
  const all: WorkflowStage[] = [
    'project_definition',
    'research',
    'evidence',
    'argument_tree',
    'script_v1',
    'script_v2',
  ];
  for (const stage of all) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
    if (stage === last) break;
  }
}

function main(): void {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-dag-parallelism'), {recursive: true, force: true});

  // ============ D1：directStageDependencies 是 DAG 边，不是数组前缀 ============
  {
    ok(
      directStageDependencies('narration_beat_map').join(',') === 'script_v2',
      '[D1a] narration_beat_map 直接依赖只有 script_v2',
    );
    ok(
      directStageDependencies('visual_breakdown').join(',') === 'narration_beat_map',
      '[D1b] visual_breakdown 直接依赖只有 narration_beat_map',
    );
    ok(
      getNodeDef('narration_plan')?.dependencies.join(',') === 'script_v2',
      '[D1c] narration_plan DAG 依赖只有 script_v2',
    );
    ok(
      directStageDependencies('scenes').join(',') === 'shot_list',
      '[D1d] scenes 直接依赖只有 shot_list',
    );
  }

  // ============ D2：script_v2 锁定后解锁两个并行分支 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'dag-parallel', coreQuestion: 'q'}).project.id;
    lockThrough(projectId, 'script_v2');

    // 构造锁定前的 readiness 快照（script_v2 仍为 locked→done）
    const before = [
      {id: 'project_definition', status: 'done' as const, dependencies: []},
      {id: 'research', status: 'done' as const, dependencies: ['project_definition']},
      {id: 'evidence', status: 'done' as const, dependencies: ['research']},
      {id: 'argument_tree', status: 'done' as const, dependencies: ['evidence']},
      {id: 'script_v1', status: 'done' as const, dependencies: ['argument_tree']},
      {id: 'script_v2', status: 'done' as const, dependencies: ['script_v1']},
      {id: 'narration_beat_map', status: 'locked' as const, dependencies: ['script_v2']},
      {id: 'visual_breakdown', status: 'locked' as const, dependencies: ['narration_beat_map']},
      {id: 'narration_plan', status: 'locked' as const, dependencies: ['script_v2']},
      {id: 'shot_list', status: 'locked' as const, dependencies: ['visual_breakdown']},
      {id: 'narration_tts', status: 'locked' as const, dependencies: ['narration_plan']},
      {id: 'scenes', status: 'locked' as const, dependencies: ['shot_list']},
    ];
    const ready = computeNewlyReadyAfterLock(before, 'script_v2');
    ok(
      ready.length === 2 && ready.includes('narration_beat_map') && ready.includes('narration_plan'),
      '[D2a] script_v2 locked 后同时解锁 narration_beat_map 与 narration_plan',
      ready,
    );

    // assertRunnable 只要求 DAG 直接依赖 locked
    ok(
      (() => {
        try {
          assertRunnable(projectId, 'narration_beat_map');
          return true;
        } catch {
          return false;
        }
      })(),
      '[D2b] narration_beat_map 只检查 script_v2 已锁',
    );
    ok(
      !!(getNodeDef('narration_plan')?.dependencies.every((d) => d === 'script_v2')),
      '[D2c] narration_plan DAG 只依赖 script_v2',
    );
  }

  // ============ D3：视觉支改动只 stale 视觉支，不碰音频支 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'dag-stale', coreQuestion: 'q'}).project.id;
    lockThrough(projectId, 'script_v2');
    // 生成并锁定整条视觉链，使下游节点都是“已有进度”
    for (const stage of ['narration_beat_map', 'visual_breakdown', 'shot_list', 'scenes'] as WorkflowStage[]) {
      generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'ai_generate'});
      lockStage(projectId, stage);
    }

    const affected = affectedDownstream(projectId, 'narration_beat_map');
    const reachable = downstreamOf('narration_beat_map');
    ok(
      affected.includes('visual_breakdown') && affected.includes('shot_list') && affected.includes('scenes') &&
        !reachable.includes('narration_plan') && !reachable.includes('narration_tts'),
      '[D3a] narration_beat_map 下游只含视觉支 project stages，不含音频支',
      {affected, reachable},
    );

    // 模拟 visual_breakdown 重新生成并锁定，应用下游 stale
    generateVersion({projectId, stage: 'visual_breakdown', content: '# vb v2', contentType: 'markdown', source: 'ai_generate'});
    applyDownstreamStaleTx(projectId, 'visual_breakdown');
    ok(getStage(projectId, 'shot_list')?.status === 'stale', '[D3b] visual_breakdown 下游 shot_list stale');
    ok(getStage(projectId, 'scenes')?.status === 'stale', '[D3c] visual_breakdown 下游 scenes stale');
  }

  // ============ D4：script_v2 改动 stale 视觉支；音频支不是 project_stage，由 provenance 管理 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'dag-script-stale', coreQuestion: 'q'}).project.id;
    lockThrough(projectId, 'script_v2');
    for (const stage of ['narration_beat_map', 'visual_breakdown', 'shot_list', 'scenes'] as WorkflowStage[]) {
      generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'ai_generate'});
      lockStage(projectId, stage);
    }

    const affected = affectedDownstream(projectId, 'script_v2');
    const reachableFromScriptV2 = downstreamOf('script_v2');
    // affectedDownstream 只返回 project_stages（视觉支），不返回音频节点
    // 但 DAG reachability（downstreamOf）正确包含了音频支
    ok(
      affected.includes('narration_beat_map') && affected.includes('visual_breakdown') &&
        affected.includes('shot_list') && affected.includes('scenes') &&
        reachableFromScriptV2.includes('narration_plan') && reachableFromScriptV2.includes('narration_tts') &&
        !affected.includes('narration_plan' as WorkflowStage),
      '[D4a] script_v2 下游 project_stages 含视觉支；DAG 全量含音频支，但 affectedDownstream 不含',
      {affected, reachableFromScriptV2},
    );

    // 编辑 script_v2（带 confirmStale）
    editVersion(
      {projectId, stage: 'script_v2', content: '# Script V2\n\n新内容。', contentType: 'markdown', source: 'manual_edit'},
      {confirmStale: true},
    );
    applyDownstreamStaleTx(projectId, 'script_v2');
    ok(getStage(projectId, 'narration_beat_map')?.status === 'stale', '[D4b] script_v2 改动使 narration_beat_map stale');
    ok(getStage(projectId, 'visual_breakdown')?.status === 'stale', '[D4c] script_v2 改动使 visual_breakdown stale');
  }

  // ============ D5：reachability 不包含并行兄弟 ============
  {
    ok(
      downstreamStageNodes('narration_beat_map').includes('visual_breakdown') &&
        !downstreamOf('narration_beat_map').includes('narration_plan'),
      '[D5a] narration_beat_map project-stage 下游只含视觉支',
    );
    ok(
      downstreamOf('narration_plan').includes('narration_tts') &&
        !downstreamOf('narration_plan').includes('visual_breakdown'),
      '[D5b] narration_plan DAG 下游含音频支，不含视觉支并行兄弟',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-dag-parallelism'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] Workflow DAG Parallelism 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] Workflow DAG Parallelism 测试全部通过 ✅');
}

main();

/**
 * M2-E-B 十阶段完整工作流测试（Mock，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m2e-workflow.ts
 * 使用临时数据目录（data/test-m2e-workflow），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2e-workflow');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {
  enqueueWorkflowStageJob,
  getLlmJob,
  llmJobPayloadV2Schema,
  requestCancelLlmJob,
} from '../src/lib/llm-jobs';
import {MockLLMProvider} from '../src/lib/llm/mock';
import type {LLMProvider, LLMRequest, LLMResponse} from '../src/lib/llm/types';
import {getProjectInput} from '../src/lib/project-inputs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {getStagePrompt} from '../src/lib/prompts/registry';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runLlmJob, type LlmExecutorDeps} from '../src/worker/llm-executor';
import {
  ENABLED_WORKFLOW_STAGES,
  isStageEnabled,
} from '../src/lib/workflow/capabilities';
import {
  validateScenesSemantics,
  type ScenesSemanticInput,
} from '../src/lib/workflow/scenes-semantic-validation';
import {editVersion} from '../src/lib/workflow/operations';
import {getStage, listStages, lockStage} from '../src/lib/workflow/stages';
import {getVersion, listVersions} from '../src/lib/workflow/versions';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';
import {PATCH as stagePATCH} from '../src/app/api/projects/[id]/stage/[stage]/route';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CTX = {isShuttingDown: () => false, log: () => {}};

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

function countRows(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as {c: number}).c;
}

function claimLlm() {
  const claimed = claimNextAnyJob('w-m2e');
  return claimed && claimed.type === 'llm' ? claimed : null;
}

async function runStageOnce(
  pid: string,
  stage: WorkflowStage,
  deps?: LlmExecutorDeps,
  confirmStale = false,
) {
  const job = enqueueWorkflowStageJob(pid, stage, {confirmStale});
  const claimed = claimLlm();
  if (!claimed || claimed.job.id !== job.id) {
    throw new Error(`runStageOnce: claim 失败 ${stage}`);
  }
  await runLlmJob(claimed.job, CTX, deps);
  return getLlmJob(job.id)!;
}

async function genAndLock(pid: string, stage: WorkflowStage, deps?: LlmExecutorDeps): Promise<void> {
  const job = await runStageOnce(pid, stage, deps);
  if (job.status !== 'succeeded') {
    throw new Error(`genAndLock: ${stage} 未成功（${job.status}/${job.error_code}）`);
  }
  lockStage(pid, stage);
}

const EXPECTED_META: Record<WorkflowStage, {promptVersion: string; model: string; contentType: string}> = {
  project_definition: {promptVersion: 'project-definition@1.0', model: 'deepseek-v4-flash', contentType: 'markdown'},
  research: {promptVersion: 'research@1.0', model: 'deepseek-v4-flash', contentType: 'markdown'},
  evidence: {promptVersion: 'evidence@1.0', model: 'deepseek-v4-flash', contentType: 'json'},
  argument_tree: {promptVersion: 'argument-tree@1.0', model: 'deepseek-v4-pro', contentType: 'json'},
  script_v1: {promptVersion: 'script-v1@1.0', model: 'deepseek-v4-pro', contentType: 'markdown'},
  script_v2: {promptVersion: 'script-v2@1.0', model: 'deepseek-v4-pro', contentType: 'markdown'},
  narration_beat_map: {promptVersion: 'narration-beat-map@1.0', model: 'deepseek-v4-flash', contentType: 'markdown'},
  visual_breakdown: {promptVersion: 'visual-breakdown@1.0', model: 'deepseek-v4-flash', contentType: 'markdown'},
  shot_list: {promptVersion: 'shot-list@1.0', model: 'deepseek-v4-flash', contentType: 'json'},
  scenes: {promptVersion: 'scenes@1.2', model: 'deepseek-v4-flash', contentType: 'json'},
};

/** 完整链：十阶段依次 generate + lock（真实 enqueue → claim → runLlmJob → lockStage）。 */
async function lockAllTen(pid: string): Promise<void> {
  for (const stage of WORKFLOW_STAGES) {
    await genAndLock(pid, stage);
  }
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e-workflow'), {recursive: true, force: true});
  const db = getDb();

  // ============ A. Capability：10 阶段全部开放 ============
  ok(
    ENABLED_WORKFLOW_STAGES.length === 10 && ENABLED_WORKFLOW_STAGES.every((s) => isStageEnabled(s)),
    '[A] 10 阶段全部 isStageEnabled = true',
  );

  // ============ B. 完整 Mock 十阶段闭环 ============
  const pidB = newProject();
  for (const stage of WORKFLOW_STAGES) {
    const job = await runStageOnce(pidB, stage);
    const meta = EXPECTED_META[stage];
    const stageRow = getStage(pidB, stage)!;
    ok(job.status === 'succeeded', `[B] ${stage} job succeeded`);
    const version = getVersion(pidB, stage, stageRow.active_version!)!;
    ok(
      version.prompt_version === meta.promptVersion &&
        version.model === meta.model &&
        version.content_type === meta.contentType &&
        version.job_id === job.id,
      `[B] ${stage} 版本元信息（prompt_version/model/content_type/job_id）`,
    );
    if (meta.contentType === 'json') {
      const parsed = JSON.parse(version.content);
      ok(
        getStagePrompt(stage).zodSchema!.safeParse(parsed).success,
        `[B] ${stage} 内容过结构 zod`,
      );
      if (stage === 'scenes') {
        ok(
          validateScenesSemantics(parsed as ScenesSemanticInput).ok,
          '[B] scenes 内容过语义校验（validateScenesSemantics）',
        );
      }
    }
    lockStage(pidB, stage);
    const after = getStage(pidB, stage)!;
    ok(
      after.status === 'locked' && after.locked_version === after.active_version,
      `[B] ${stage} locked（active=locked=v${after.active_version}）`,
    );
  }
  ok(
    listStages(pidB).filter((s) => s.status === 'locked').length === 10,
    '[B] 最终 10/10 stages locked',
  );

  // ============ C. Deep Dependency Snapshot（Scenes 9 上游逐项核对） ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    // 解锁场景下重新入队 scenes：需要 confirmStale（scenes 已 locked）；
    // 先回滚到未锁状态——直接验证快照内容（新项目的 scenes job 已 succeeded，
    // 这里用 rerun 方式再入队一次验证快照）
    const job = enqueueWorkflowStageJob(pid, 'scenes', {confirmStale: true});
    const payload = llmJobPayloadV2Schema.parse(JSON.parse(job.payload_json));
    const expected: Record<string, number> = {
      project_definition: 1,
      research: 1,
      evidence: 1,
      argument_tree: 1,
      script_v1: 1,
      script_v2: 1,
      narration_beat_map: 1,
      visual_breakdown: 1,
      shot_list: 1,
    };
    ok(
      payload.schemaVersion === '2.0' &&
        payload.stage === 'scenes' &&
        JSON.stringify(payload.upstreamVersions) === JSON.stringify(expected),
      '[C] scenes 快照逐项 = 前 9 阶段 locked_version v1',
      payload.upstreamVersions,
    );
    // 取消这个验证用 job，不影响后续
    getDb().prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
  }

  // ============ D. Deep Preflight（Scenes 排队期间上游变化） ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    // scenes 已 locked → 先 rerun visual_breakdown 会 stale 下游；改用新项目变体：
    // 直接在 locked 链上 enqueue scenes（confirmStale），然后改变 visual_breakdown
    const job = enqueueWorkflowStageJob(pid, 'scenes', {confirmStale: true});
    editVersion({
      projectId: pid, stage: 'visual_breakdown',
      content: '# Visual v2（排队期改动）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'visual_breakdown');
    let providerCalls = 0;
    class CountProbe extends MockLLMProvider {
      override async generate(req: LLMRequest): Promise<LLMResponse> {
        providerCalls++;
        return super.generate(req);
      }
    }
    const claimed = claimLlm();
    await runLlmJob(claimed!.job, CTX, {provider: new CountProbe()});
    const after = getLlmJob(job.id)!;
    ok(providerCalls === 0, '[D] preflight：Provider 调用次数 = 0', providerCalls);
    ok(
      after.status === 'failed' && after.error_code === 'DEPENDENCY_STALE',
      '[D] Scenes 排队期上游变化 → failed DEPENDENCY_STALE',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ? AND stage = ?', pid, 'scenes') === 1,
      '[D] 不产生新 Scenes version（仍是首版 v1）',
    );
  }

  // ============ E. Deep Commit Fence（Scenes mid-flight）+ Cancel 优先 ============
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 9)) {
      await genAndLock(pid, stage);
    }
    const job = enqueueWorkflowStageJob(pid, 'scenes');
    const claimed = claimLlm();
    const running = runLlmJob(claimed!.job, CTX, {
      provider: new MockLLMProvider({delayMs: 150}),
      heartbeatMs: 30,
    });
    await sleep(50);
    editVersion({
      projectId: pid, stage: 'shot_list',
      content: JSON.stringify({shots: [{id: 'SH001', chapter: 1, purpose: '改动', visualType: 'Minimal', durationSec: 4, audioSpace: 'x', assetNeeds: [], transition: 'cut', notes: ''}]}),
      contentType: 'json', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'shot_list');
    await running;
    const after = getLlmJob(job.id)!;
    ok(
      after.status === 'failed' && after.error_code === 'DEPENDENCY_STALE',
      '[E] Scenes mid-flight 上游变化 → commit fence DEPENDENCY_STALE',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM llm_usage WHERE job_id = ?', job.id) === 1,
      '[E] usage 保留（请求已真实发生）',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ? AND stage = ?', pid, 'scenes') === 0,
      '[E] 不创建 Scenes version',
    );
  }
  {
    // E2：Cancel + dependency 同时 → Cancel 优先（deep-stage 代表回归）
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 9)) {
      await genAndLock(pid, stage);
    }
    const job = enqueueWorkflowStageJob(pid, 'scenes');
    const claimed = claimLlm();
    const running = runLlmJob(claimed!.job, CTX, {
      provider: new MockLLMProvider({delayMs: 150}),
      heartbeatMs: 30,
    });
    await sleep(50);
    requestCancelLlmJob(job.id);
    editVersion({
      projectId: pid, stage: 'shot_list',
      content: JSON.stringify({shots: [{id: 'SH001', chapter: 1, purpose: '改动', visualType: 'Minimal', durationSec: 4, audioSpace: 'x', assetNeeds: [], transition: 'cut', notes: ''}]}),
      contentType: 'json', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'shot_list');
    await running;
    const after = getLlmJob(job.id)!;
    ok(
      after.status === 'cancelled',
      '[E2] Cancel + dependency 同时 → cancelled（Cancel 优先，非 DEPENDENCY_STALE）',
      {status: after.status, error: after.error_code},
    );
  }

  // ============ F. Stale 深链传播 + 恢复 ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    // Case 1：修改 script_v2（locked，confirmStale）
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: '# Script V2 v2（引发传播）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    let stages = new Map(listStages(pid).map((s) => [s.stage, s.status]));
    ok(
      stages.get('narration_beat_map') === 'stale' &&
        stages.get('visual_breakdown') === 'stale' &&
        stages.get('shot_list') === 'stale' &&
        stages.get('scenes') === 'stale',
      '[F] 修改 script_v2 → 后四阶段全部 stale',
    );
    ok(
      stages.get('script_v1') === 'locked' && stages.get('project_definition') === 'locked',
      '[F] script_v1 及之前保持 locked',
    );
    // 恢复链：script_v2 lock → 后四 rerun + lock
    lockStage(pid, 'script_v2');
    for (const stage of ['narration_beat_map', 'visual_breakdown', 'shot_list', 'scenes'] as const) {
      const job = await runStageOnce(pid, stage);
      if (job.status !== 'succeeded') throw new Error(`恢复 ${stage} 失败: ${job.error_code}`);
      lockStage(pid, stage);
    }
    ok(
      listStages(pid).filter((s) => s.status === 'locked').length === 10,
      '[G] stale 后按拓扑恢复：重新 10/10 locked',
    );
    // Case 2：修改 narration_beat_map → 后三 stale，script_v2 不受影响
    editVersion({
      projectId: pid, stage: 'narration_beat_map',
      content: '# Beat v2（引发传播）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    stages = new Map(listStages(pid).map((s) => [s.stage, s.status]));
    ok(
      stages.get('visual_breakdown') === 'stale' &&
        stages.get('shot_list') === 'stale' &&
        stages.get('scenes') === 'stale' &&
        stages.get('script_v2') === 'locked',
      '[F] 修改 narration_beat_map → 后三 stale，script_v2 不受影响',
    );
  }

  // ============ H. JSON Manual Edit（Shot List + Scenes，实走 Route） ============
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 9)) {
      await genAndLock(pid, stage);
    }
    // H1 shot_list：合法 JSON → manual_edit + edited
    const beforeShots = listVersions(pid, 'shot_list').length;
    const validShots = JSON.stringify({
      shots: [
        {id: 'SH001', chapter: 1, purpose: '人工镜头', visualType: 'Reality B-roll', durationSec: 6.5, audioSpace: '旁白驱动', assetNeeds: ['示例素材'], transition: 'cut', notes: ''},
      ],
    });
    const r1 = await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: validShots, confirmStale: true})}),
      {params: Promise.resolve({id: pid, stage: 'shot_list'})},
    );
    const j1 = (await r1.json()) as {version?: {source: string; content_type: string}};
    ok(
      r1.status === 200 && j1.version?.source === 'manual_edit' && j1.version.content_type === 'json',
      '[H] shot_list 合法 JSON edit → manual_edit json version',
    );
    ok(
      listVersions(pid, 'shot_list').length === beforeShots + 1 &&
        getStage(pid, 'shot_list')!.status === 'edited',
      '[H] shot_list → edited（版本 +1）',
    );
    // H2 shot_list：schema 非法 → 422 无版本
    const r2 = await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: '{"wrong":1}'})}),
      {params: Promise.resolve({id: pid, stage: 'shot_list'})},
    );
    ok(
      r2.status === 422 && ((await r2.json()) as {error?: string}).error === 'INVALID_STAGE_CONTENT' &&
        listVersions(pid, 'shot_list').length === beforeShots + 1,
      '[H] shot_list schema 非法 → 422 INVALID_STAGE_CONTENT（无版本）',
    );
    // 人工编辑后重新锁定 shot_list，scenes 才能继续（run-gate 要求上游 locked）
    lockStage(pid, 'shot_list');
    // H3 scenes：合法 structural+semantic → manual_edit + edited
    await runStageOnce(pid, 'scenes');
    const scenesV1 = getVersion(pid, 'scenes', 1)!.content;
    const beforeScenes = listVersions(pid, 'scenes').length;
    const r3 = await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: scenesV1})}),
      {params: Promise.resolve({id: pid, stage: 'scenes'})},
    );
    const j3 = (await r3.json()) as {version?: {source: string}};
    ok(
      r3.status === 200 && j3.version?.source === 'manual_edit',
      '[H] scenes 合法 structural+semantic edit → manual_edit version',
    );
    // H4 scenes：结构合法但语义非法（S001,S003）→ 422 无版本
    const semanticBad = JSON.parse(scenesV1) as ScenesSemanticInput;
    semanticBad.scenes[1]!.id = 'S003';
    const r4 = await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: JSON.stringify(semanticBad)})}),
      {params: Promise.resolve({id: pid, stage: 'scenes'})},
    );
    ok(
      r4.status === 422 && ((await r4.json()) as {error?: string}).error === 'INVALID_STAGE_CONTENT' &&
        listVersions(pid, 'scenes').length === beforeScenes + 1,
      '[H] scenes 结构合法语义非法 → 422 INVALID_STAGE_CONTENT（无版本）',
    );
  }

  // ============ I. Version History / Rollback（后四代表：scenes） ============
  {
    const pid = newProject();
    for (const stage of WORKFLOW_STAGES.slice(0, 9)) {
      await genAndLock(pid, stage);
    }
    await genAndLock(pid, 'scenes'); // v1 ai_generate, locked
    const v1Content = getVersion(pid, 'scenes', 1)!.content;
    // v2 manual_edit（经 Route，语义合法）
    await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: v1Content, confirmStale: true})}),
      {params: Promise.resolve({id: pid, stage: 'scenes'})},
    );
    lockStage(pid, 'scenes'); // locked v2
    // 历史 metadata（经 versions API 语义：listVersions 验证 source 序列）
    const history = listVersions(pid, 'scenes');
    ok(
      history.length === 2 && history[0]!.version === 2 && history[0]!.source === 'manual_edit' &&
        history[1]!.source === 'ai_generate',
      '[I] scenes 版本历史倒序（ai_generate + manual_edit）',
    );
    // rollback v1（confirmStale）→ v3 source=rollback，active=3，edited，历史不动
    const {rollbackToVersion} = await import('../src/lib/workflow/operations');
    const rb = rollbackToVersion(pid, 'scenes', 1, {confirmStale: true});
    const stageAfter = getStage(pid, 'scenes')!;
    ok(
      rb.version === 3 && rb.source === 'rollback' && rb.content === v1Content &&
        stageAfter.status === 'edited' && stageAfter.active_version === 3 &&
        getVersion(pid, 'scenes', 1)!.content === v1Content,
      '[I] scenes rollback v1 → v3 复制（source=rollback/active=3/edited/历史不动）',
    );
    ok(
      listVersions(pid, 'scenes').length === 3 &&
        listVersions(pid, 'scenes').some((v) => v.source === 'rollback'),
      '[I] 历史含 ai_generate/manual_edit/rollback 三种 source',
    );
    // rollback 后 re-lock（semantic 内容由已校验路径而来，gate 正常通过）
    lockStage(pid, 'scenes');
    ok(
      getStage(pid, 'scenes')!.locked_version === 3,
      '[I] rollback 后 re-lock：locked_version=3',
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e-workflow'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M2-E-B 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M2-E-B 十阶段工作流测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

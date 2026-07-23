/**
 * M2-D Research → Script V2 自动化测试（Mock 为主，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m2d.ts
 * 使用临时数据目录（data/test-m2d），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2d');
process.env.LLM_PROVIDER = 'mock';

import Database from 'better-sqlite3';
import {closeDb, getDb, getDbPath} from '../src/lib/db';
import {
  commitLlmJobResult,
  enqueueWorkflowStageJob,
  getLlmJob,
  LlmJobError,
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
import {isStageEnabled, M2D_ENABLED_STAGES} from '../src/lib/workflow/capabilities';
import {
  captureLockedUpstreamVersionsTx,
  checkDependencySnapshotTx,
  resolveUpstreamVersionContents,
} from '../src/lib/workflow/dependencies';
import {editVersion, generateVersion} from '../src/lib/workflow/operations';
import {getStage, listStages, lockStage, WorkflowError} from '../src/lib/workflow/stages';
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
  const claimed = claimNextAnyJob('w-m2d');
  return claimed && claimed.type === 'llm' ? claimed : null;
}

/** 完整跑一个阶段：入队（原子快照）→ claim → runLlmJob → 返回 job 终态。 */
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

/** 生成并锁定一个阶段（Mock）。 */
async function genAndLock(pid: string, stage: WorkflowStage, deps?: LlmExecutorDeps): Promise<void> {
  const job = await runStageOnce(pid, stage, deps);
  if (job.status !== 'succeeded') {
    throw new Error(`genAndLock: ${stage} 未成功（${job.status}/${job.error_code}）`);
  }
  lockStage(pid, stage);
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2d'), {recursive: true, force: true});
  const db = getDb();

  // ============ S1. Stage Capability ============
  ok(
    M2D_ENABLED_STAGES.length === 6 &&
      M2D_ENABLED_STAGES.every((s) => isStageEnabled(s)) &&
      !isStageEnabled('narration_beat_map') &&
      !isStageEnabled('scenes'),
    '[S1] 能力表：前六阶段开放，后四阶段禁用',
  );

  // ============ D1. Snapshot 捕获正确 ============
  const pid1 = newProject();
  await genAndLock(pid1, 'project_definition');
  await genAndLock(pid1, 'research');
  // research 再编辑一次 → v2 locked
  editVersion({
    projectId: pid1, stage: 'research',
    content: '# 研究 v2（人工修订）', contentType: 'markdown', source: 'manual_edit',
  }, {confirmStale: true});
  lockStage(pid1, 'research');
  {
    const job = enqueueWorkflowStageJob(pid1, 'evidence');
    const payload = llmJobPayloadV2Schema.parse(JSON.parse(job.payload_json));
    ok(
      payload.schemaVersion === '2.0' &&
        payload.upstreamVersions.project_definition === 1 &&
        payload.upstreamVersions.research === 2 &&
        Object.keys(payload.upstreamVersions).length === 2,
      '[D1] evidence 入队快照精确包含 pd v1 + research v2',
      payload.upstreamVersions,
    );
    // 快照不复制大段内容
    ok(
      !job.payload_json.includes('人工修订'),
      '[D1] payload 只存版本号，不复制上游内容',
    );
    cancelQuiet(job.id);
  }

  // ============ D2. 未锁上游禁止入队 ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    let threw: string | null = null;
    try {
      enqueueWorkflowStageJob(pid, 'evidence');
    } catch (err) {
      threw = err instanceof WorkflowError ? err.code : String(err);
    }
    ok(threw === 'UPSTREAM_NOT_LOCKED', '[D2] research 未锁 → evidence 入队拒绝', threw);
  }

  // ============ D3. 原子入队（双连接写锁互斥） ============
  {
    const dbB = new Database(getDbPath());
    dbB.pragma('journal_mode = WAL');
    dbB.pragma('busy_timeout = 100');
    // B 在事务内持写锁（无害写入并提交），持锁期间 A 的任何写入必须失败——
    // 证明快照读取与 INSERT 处于同一写锁内，不存在可插入修改的中间窗口。
    dbB.transaction(() => {
      dbB.prepare('UPDATE project_stages SET updated_at = ? WHERE project_id = ? AND stage = ?')
        .run(new Date().toISOString(), pid1, 'research');
      let busyThrew: string | null = null;
      const dbA2 = new Database(getDbPath());
      dbA2.pragma('busy_timeout = 100');
      try {
        dbA2
          .prepare('UPDATE project_stages SET updated_at = ? WHERE project_id = ? AND stage = ?')
          .run(new Date().toISOString(), pid1, 'research');
      } catch (err) {
        busyThrew = String(err);
      } finally {
        dbA2.close();
      }
      ok(
        busyThrew !== null &&
          (busyThrew.includes('database is locked') || busyThrew.includes('SQLITE_BUSY')),
        '[D3] B 持锁期间 A 的写入被拒绝（写锁互斥）',
        busyThrew,
      );
    }).immediate();
    dbB.close();
    // 原子性正向验证：capture 与当前状态一致（同事务语义）
    const snapshot = captureLockedUpstreamVersionsTx(pid1, 'evidence');
    ok(
      snapshot.research === 2 &&
        checkDependencySnapshotTx(pid1, snapshot).length === 0,
      '[D3] 快照读取与当前状态一致（事务内语义）',
    );
  }

  // ============ D4. Worker 按快照注入上游内容（probe 实证） ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    await genAndLock(pid, 'research');
    // 捕获 evidence 阶段 user prompt 的探针 Provider
    let capturedUser = '';
    const probe: LLMProvider = {
      name: 'mock',
      generate(req: LLMRequest): Promise<LLMResponse> {
        capturedUser = req.user;
        return new MockLLMProvider().generate(req);
      },
    };
    const job = enqueueWorkflowStageJob(pid, 'evidence');
    const payload = llmJobPayloadV2Schema.parse(JSON.parse(job.payload_json));
    const c = claimLlm();
    await runLlmJob(c!.job, CTX, {provider: probe});
    ok(getLlmJob(job.id)!.status === 'succeeded', '[D4] evidence 生成成功');
    const v1Content = getVersion(pid, 'research', 1)!.content;
    const pdContent = getVersion(pid, 'project_definition', 1)!.content;
    ok(
      capturedUser.includes(v1Content) && capturedUser.includes(pdContent),
      '[D4] Prompt 注入 payload 快照指定的精确版本内容（pd v1 + research v1）',
    );
    ok(
      payload.upstreamVersions.research === 1 && payload.upstreamVersions.project_definition === 1,
      '[D4] 快照版本号 = locked_version（Worker 不读 active/UI state）',
    );
    // resolveUpstreamVersionContents 单元验证：精确读历史版本
    editVersion({
      projectId: pid, stage: 'research',
      content: '# 研究 v2（后续变化）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    const contents = resolveUpstreamVersionContents(pid, {research: 1});
    ok(
      contents.research === v1Content,
      '[D4] resolveUpstreamVersionContents：即使已有 v2，仍精确读 v1 历史版本',
    );
  }

  // ============ D5. queued stale preflight ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    await genAndLock(pid, 'research');
    const job = enqueueWorkflowStageJob(pid, 'evidence');
    // 排队期间上游改变：research → edit v3 → lock v3
    editVersion({
      projectId: pid, stage: 'research',
      content: '# 研究 v3', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'research');
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
    ok(providerCalls === 0, '[D5] preflight：Provider 调用次数 = 0', providerCalls);
    ok(
      after.status === 'failed' && after.error_code === 'DEPENDENCY_STALE',
      '[D5] 上游已变 → job failed DEPENDENCY_STALE（non-retryable）',
    );
    ok(
      after.error_message!.includes('stage=research') &&
        after.error_message!.includes('expectedVersion=1') &&
        after.error_message!.includes('currentLockedVersion=2'),
      '[D5] 错误 detail 含 stage/expectedVersion/currentLockedVersion',
    );
  }

  // ============ D6. mid-flight stale（commit fence） ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    await genAndLock(pid, 'research');
    const job = enqueueWorkflowStageJob(pid, 'evidence');
    const claimed = claimLlm();
    const running = runLlmJob(claimed!.job, CTX, {
      provider: new MockLLMProvider({delayMs: 150}),
      heartbeatMs: 30,
    });
    await sleep(50);
    // Provider 进行中：research → edit v3 → lock v3
    editVersion({
      projectId: pid, stage: 'research',
      content: '# 研究 v3（mid-flight）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'research');
    await running;
    const after = getLlmJob(job.id)!;
    ok(
      after.status === 'failed' && after.error_code === 'DEPENDENCY_STALE',
      '[D6] Provider 返回后 commit fence → DEPENDENCY_STALE',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM llm_usage WHERE job_id = ?', job.id) === 1,
      '[D6] usage 保留（请求已真实发生）',
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ? AND stage = ?', pid, 'evidence') === 0 &&
        getStage(pid, 'evidence')!.status !== 'generated',
      '[D6] 不创建 Evidence version，stage 不 generated',
    );
  }

  // ============ D7. normal dependency（全链正常提交） ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    await genAndLock(pid, 'research');
    const job = await runStageOnce(pid, 'evidence');
    ok(job.status === 'succeeded', '[D7] 依赖不变 → succeeded');
    ok(
      getStage(pid, 'evidence')!.status === 'generated',
      '[D7] evidence generated',
    );
  }

  // ============ D8. Cancel + dependency 同时发生（Cancel 优先） ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    await genAndLock(pid, 'research');
    const job = enqueueWorkflowStageJob(pid, 'evidence');
    const claimed = claimLlm();
    const running = runLlmJob(claimed!.job, CTX, {
      provider: new MockLLMProvider({delayMs: 150}),
      heartbeatMs: 30,
    });
    await sleep(50);
    requestCancelLlmJob(job.id);
    editVersion({
      projectId: pid, stage: 'research',
      content: '# 研究 v3（cancel race）', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    lockStage(pid, 'research');
    await running;
    const after = getLlmJob(job.id)!;
    ok(
      after.status === 'cancelled',
      '[D8] Cancel + dependency 同时 → cancelled（Cancel 优先，非 DEPENDENCY_STALE）',
      {status: after.status, error: after.error_code},
    );
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ? AND stage = ?', pid, 'evidence') === 0,
      '[D8] 不创建版本',
    );
  }

  // ============ S9. Stale 传播链（全链锁到 script_v2 后改 research） ============
  const pid9 = newProject();
  for (const stage of M2D_ENABLED_STAGES) {
    await genAndLock(pid9, stage);
  }
  ok(
    listStages(pid9).filter((s) => s.status === 'locked').length === 6,
    '[S9] 前置：六阶段全部 locked',
  );
  editVersion({
    projectId: pid9, stage: 'research',
    content: '# 研究 v2（引发传播）', contentType: 'markdown', source: 'manual_edit',
  }, {confirmStale: true});
  {
    const stages = listStages(pid9);
    const byStage = new Map(stages.map((s) => [s.stage, s]));
    ok(byStage.get('research')!.status === 'edited', '[S9] research → edited');
    ok(
      (['evidence', 'argument_tree', 'script_v1', 'script_v2'] as const).every(
        (s) => byStage.get(s)!.status === 'stale',
      ),
      '[S9] evidence→script_v2 全部 stale',
    );
    ok(byStage.get('project_definition')!.status === 'locked', '[S9] pd 仍 locked');
    ok(
      byStage.get('evidence')!.locked_version === 1,
      '[S9] stale 后 locked_version 历史值保留',
    );
  }

  // ============ S10. Manual Edit Gate（漏洞封闭验证） ============
  {
    // 当前 pid9：research=edited（未锁）、evidence=stale
    let threw: string | null = null;
    try {
      editVersion({
        projectId: pid9, stage: 'evidence',
        content: '{"evidence":[{"id":"E01","claim":"x","source":"s","sourceType":"primary","verification":"UNVERIFIED","supportLevel":"low","allowedWording":"x","forbiddenInference":"","notes":""}],"gaps":[]}',
        contentType: 'json', source: 'manual_edit',
      });
    } catch (err) {
      threw = err instanceof WorkflowError ? err.code : String(err);
    }
    ok(threw === 'UPSTREAM_NOT_LOCKED', '[S10] 上游未锁时人工编辑 downstream 被拒绝', threw);
    ok(
      countRows('SELECT COUNT(*) AS c FROM project_versions WHERE project_id = ? AND stage = ?', pid9, 'evidence') === 1,
      '[S10] 拒绝后 evidence 版本数不变（无绕过）',
    );
    // 直接 lock 也被 stale 规则 + gate 双保险（stale → STALE_MUST_RERUN）
    let lockThrew: string | null = null;
    try {
      lockStage(pid9, 'evidence');
    } catch (err) {
      lockThrew = err instanceof WorkflowError ? err.code : String(err);
    }
    ok(
      lockThrew === 'STALE_MUST_RERUN' || lockThrew === 'UPSTREAM_NOT_LOCKED',
      '[S10] stale 阶段直接 lock 被拒绝',
      lockThrew,
    );
  }

  // ============ S11. JSON 人工编辑校验（PATCH 路由） ============
  {
    const pid = newProject();
    await genAndLock(pid, 'project_definition');
    await genAndLock(pid, 'research');
    await runStageOnce(pid, 'evidence'); // generated（不 lock，可直接编辑）
    const beforeCount = listVersions(pid, 'evidence').length;
    const patch = (content: string) =>
      stagePATCH(
        new Request('http://test', {method: 'PATCH', body: JSON.stringify({content})}),
        {params: Promise.resolve({id: pid, stage: 'evidence'})},
      );
    // 非法 JSON → 422
    const r1 = await patch('{broken json');
    ok(
      r1.status === 422 && ((await r1.json()) as {error?: string}).error === 'INVALID_STAGE_CONTENT',
      '[S11] evidence 非法 JSON → 422 INVALID_STAGE_CONTENT',
    );
    ok(listVersions(pid, 'evidence').length === beforeCount, '[S11] 非法 JSON 不产生版本');
    // 合法 JSON 但 schema 不符 → 422
    const r2 = await patch('{"wrong":"shape"}');
    ok(
      r2.status === 422 && ((await r2.json()) as {error?: string}).error === 'INVALID_STAGE_CONTENT',
      '[S11] evidence schema 不符 → 422 INVALID_STAGE_CONTENT',
    );
    ok(listVersions(pid, 'evidence').length === beforeCount, '[S11] schema 不符不产生版本');
    // 合法 JSON → 新 version + edited
    const validEvidence = JSON.stringify({
      evidence: [{
        id: 'E01', claim: '人工证据', source: 'SOURCE_REQUIRED', sourceType: 'primary',
        verification: 'SOURCE_REQUIRED', supportLevel: 'medium',
        allowedWording: '允许措辞', forbiddenInference: '禁止外推', notes: '',
      }],
      gaps: [],
    });
    const r3 = await patch(validEvidence);
    ok(r3.status === 200, '[S11] evidence 合法 JSON → 200');
    const versionsAfter = listVersions(pid, 'evidence');
    ok(
      versionsAfter.length === beforeCount + 1 &&
        versionsAfter[0]!.source === 'manual_edit' &&
        versionsAfter[0]!.content_type === 'json' &&
        getStage(pid, 'evidence')!.status === 'edited',
      '[S11] 合法 JSON → 新版本（manual_edit/json）+ edited',
    );
    // argument_tree：非法一组（需要上游 evidence locked，先锁）
    lockStage(pid, 'evidence');
    await runStageOnce(pid, 'argument_tree');
    const r4 = await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: '[1,2'})}),
      {params: Promise.resolve({id: pid, stage: 'argument_tree'})},
    );
    ok(
      r4.status === 422 && ((await r4.json()) as {error?: string}).error === 'INVALID_STAGE_CONTENT',
      '[S11] argument_tree 非法 JSON → 422',
    );
    const validTree = JSON.stringify({
      coreQuestion: 'q', coreClaim: 'c', audiencePrior: 'p', audienceTarget: 't',
      nodes: [{id: 'N01', kind: 'opening', title: '开场', summary: 's', evidenceIds: [], children: []}],
    });
    const r5 = await stagePATCH(
      new Request('http://test', {method: 'PATCH', body: JSON.stringify({content: validTree})}),
      {params: Promise.resolve({id: pid, stage: 'argument_tree'})},
    );
    ok(r5.status === 200, '[S11] argument_tree 合法 JSON → 200 + edited');
  }

  // ============ F. Mock 五连跑（六阶段全链） ============
  {
    const pid = newProject();
    const expectedMeta: Record<string, {promptVersion: string; model: string}> = {
      project_definition: {promptVersion: 'project-definition@1.0', model: 'deepseek-v4-flash'},
      research: {promptVersion: 'research@1.0', model: 'deepseek-v4-flash'},
      evidence: {promptVersion: 'evidence@1.0', model: 'deepseek-v4-flash'},
      argument_tree: {promptVersion: 'argument-tree@1.0', model: 'deepseek-v4-pro'},
      script_v1: {promptVersion: 'script-v1@1.0', model: 'deepseek-v4-pro'},
      script_v2: {promptVersion: 'script-v2@1.0', model: 'deepseek-v4-pro'},
    };
    for (const stage of M2D_ENABLED_STAGES) {
      const job = await runStageOnce(pid, stage);
      const payload = llmJobPayloadV2Schema.parse(JSON.parse(job.payload_json));
      const snapshotOk = checkDependencySnapshotTx(pid, payload.upstreamVersions).length === 0;
      ok(
        job.status === 'succeeded' && snapshotOk,
        `[F] ${stage} succeeded 且快照一致`,
      );
      const v = listVersions(pid, stage)[0]!;
      ok(
        v.prompt_version === expectedMeta[stage]!.promptVersion &&
          v.model === expectedMeta[stage]!.model &&
          v.job_id === job.id,
        `[F] ${stage} 版本元信息（prompt_version/model/job_id）`,
      );
      lockStage(pid, stage);
    }
    ok(
      listStages(pid).filter((s) => s.status === 'locked').length === 6,
      '[F] 六阶段全部 locked',
    );
    // JSON 阶段内容过 zod
    for (const stage of ['evidence', 'argument_tree'] as const) {
      const v = listVersions(pid, stage)[0]!;
      ok(
        getStagePrompt(stage).zodSchema!.safeParse(JSON.parse(v.content)).success,
        `[F] ${stage} 内容通过 zod 复验`,
      );
    }
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2d'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M2-D 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M2-D Research→Script V2 测试全部通过 ✅');
}

function cancelQuiet(jobId: string): void {
  getDb()
    .prepare("UPDATE llm_jobs SET status = 'cancelled' WHERE id = ? AND status = 'queued'")
    .run(jobId);
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

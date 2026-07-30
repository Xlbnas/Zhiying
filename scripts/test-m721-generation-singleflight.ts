/**
 * M7.2.1 Durable LLM Single-Flight + Attempt Audit 测试（临时 DB + Mock Provider，
 * 零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m721-generation-singleflight.ts
 * 覆盖：
 * - 真实并发 single-flight（可阻塞 provider barrier：in_progress / 零二次调用 / 复用）；
 * - 不同 requestId 独立生成；同 requestId 不同 source → REQUEST_ID_CONFLICT；
 * - 进程重启（closeDb → getDb）后幂等复用持久；
 * - 租约过期 → indeterminate（孤儿 attempt 一并转移，不自动重调 provider）；
 * - attempt journal（repair 成功 / 三次仍失败）：状态机、response 原文/hash、
 *   validation issues、usage_record_id 精确关联、request 投影无 secret；
 * - API route 真实路径（setNarrativeBeatsProviderForTest 注入）：201/200/409/422；
 * - requestId canonicalize 契约；production 下 provider override 后门禁用。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m721-singleflight');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion, editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {LLMError, type LLMProvider, type LLMRequest, type LLMResponse} from '../src/lib/llm/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {
  buildNarrativeBeats,
  NarrativeBeatsError,
  setNarrativeBeatsProviderForTest,
  type BuildNarrativeBeatsResult,
} from '../src/lib/narrative-beats/plan';
import {
  GENERATION_IN_PROGRESS_RETRY_AFTER_MS,
  listRunAttempts,
  sha256Text,
  type GenerationRunRow,
} from '../src/lib/narrative-beats/runs';
import {NARRATIVE_BEATS_KIND, type NarrativeBeatV1} from '../src/lib/narrative-beats/schema';
import {GET as beatsGET, POST as beatsPOST} from '../src/app/api/projects/[id]/narrative-beats/route';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

async function expectBeatsError(code: string, fn: () => unknown, label: string): Promise<void> {
  try {
    await fn();
    ok(false, label, '意外成功（应抛错）');
  } catch (err) {
    ok(
      err instanceof NarrativeBeatsError && err.code === code,
      label,
      err instanceof Error ? `${err.name}: ${(err as {code?: string}).code ?? err.message}` : err,
    );
  }
}

type SucceededResult = Extract<BuildNarrativeBeatsResult, {kind: 'succeeded'}>;

function asSucceeded(result: BuildNarrativeBeatsResult, label: string): SucceededResult {
  ok(result.kind === 'succeeded', label, result.kind === 'succeeded' ? undefined : result);
  return result as SucceededResult;
}

// ── Scriptable Mock Provider（确定性故障注入；与 test-m72 同构） ──
class ScriptableProvider implements LLMProvider {
  readonly name = 'scriptable-mock';
  readonly requests: LLMRequest[] = [];
  private queue: Array<{text?: string; finishReason?: string; error?: LLMError}> = [];

  push(resp: {text?: string; finishReason?: string; error?: LLMError}): void {
    this.queue.push(resp);
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error('scriptable provider: 无预置响应'));
    if (next.error) return Promise.reject(next.error);
    return Promise.resolve({
      text: next.text ?? '',
      requestId: `scr-${this.requests.length}`,
      model: request.model,
      finishReason: next.finishReason ?? 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
  }
}

/** 可阻塞 Mock Provider：generate 停在 Promise barrier 上，release() 后放行。 */
class BlockableProvider implements LLMProvider {
  readonly name = 'blockable-mock';
  readonly requests: LLMRequest[] = [];
  private gate: Promise<void> | null = null;
  private releaseFn: (() => void) | null = null;

  constructor(private readonly text: string) {}

  arm(): void {
    this.gate = new Promise((resolve) => {
      this.releaseFn = resolve;
    });
  }

  release(): void {
    this.releaseFn?.();
    this.gate = null;
    this.releaseFn = null;
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const respond = (): LLMResponse => ({
      text: this.text,
      requestId: `blk-${this.requests.length}`,
      model: request.model,
      finishReason: 'stop',
      usage: {promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 50},
    });
    if (this.gate) return this.gate.then(respond);
    return Promise.resolve(respond());
  }
}

/** generate 永远挂起（模拟进程崩溃前的 in_flight 状态；测试结束随进程退出）。 */
class HangingProvider implements LLMProvider {
  readonly name = 'hanging-mock';
  readonly requests: LLMRequest[] = [];

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    return new Promise(() => {});
  }
}

const UPSTREAM: WorkflowStage[] = [
  'project_definition',
  'research',
  'evidence',
  'argument_tree',
  'script_v1',
];

/** strict DSL：2 章、6 units（4 speech + 2 silence，含 pause 与 visual_breath）。 */
const STRICT_MD = `# Script V2

## 第 1 章 开场（00:00–01:00）

第一句。第二句。

@silence 500ms reason=pause

第三句。

## 第 2 章 展开（01:00–02:00）

第四句。第五句。

@silence 800ms reason=visual_breath

第六句。
`;

function newProjectWithScript(content: string, promptVersion: string): string {
  const projectId = createProjectWithWorkflow({topic: 'm721', coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({
    projectId,
    stage: 'script_v2',
    content,
    contentType: 'markdown',
    source: 'manual_edit',
    promptVersion,
  });
  lockStage(projectId, 'script_v2');
  return projectId;
}

/** 每个 unit 独立成 beat 的合法基线：speech→explanation，silence→pause。 */
function makeValidBeats(plan: NarrationPlanV2): NarrativeBeatV1[] {
  return plan.units.map((unit, index) => ({
    beatId: `B${String(index + 1).padStart(3, '0')}`,
    chapter: unit.chapter,
    unitIds: [unit.id],
    role: unit.kind === 'silence' ? 'pause' : 'explanation',
    summary: `节拍 ${index + 1} 的编辑备注。`,
    payoff: null,
  }));
}

function proposalJson(beats: NarrativeBeatV1[]): string {
  return JSON.stringify({beats});
}

function usageCount(projectId: string, requestId?: string): number {
  const row = (
    requestId === undefined
      ? getDb()
          .prepare(`SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = 'm7_narrative_beats'`)
          .get(projectId)
      : getDb()
          .prepare(
            `SELECT COUNT(*) AS c FROM llm_usage WHERE project_id = ? AND stage = 'm7_narrative_beats' AND job_id = ?`,
          )
          .get(projectId, requestId)
  ) as {c: number};
  return row.c;
}

function beatsRows(projectId: string): Array<{id: string; version: number}> {
  return getDb()
    .prepare(`SELECT id, version FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version ASC`)
    .all(projectId, NARRATIVE_BEATS_KIND) as Array<{id: string; version: number}>;
}

function runRow(projectId: string, requestId: string): GenerationRunRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM generation_runs WHERE project_id = ? AND stage = 'm7_narrative_beats' AND request_id = ?`,
    )
    .get(projectId, requestId) as GenerationRunRow | undefined;
}

function runCount(projectId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM generation_runs WHERE project_id = ? AND stage = 'm7_narrative_beats'`)
    .get(projectId) as {c: number};
  return row.c;
}

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

function postBeats(projectId: string, body: unknown): Promise<Response> {
  return beatsPOST(new Request('http://test', {method: 'POST', body: JSON.stringify(body)}), {
    params: Promise.resolve({id: projectId}),
  });
}

async function main(): Promise<void> {
  // ============ SF1：真实并发 single-flight（可阻塞 barrier） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const beats = makeValidBeats(build.plan);
    const provider = new BlockableProvider(proposalJson(beats));
    provider.arm();

    // caller1：同步完成 claim + 第一次 provider 调用（停在 barrier 上）。
    const p1 = buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-sf1-001',
      provider,
    });
    await new Promise((resolve) => setImmediate(resolve));
    ok(provider.requests.length === 1, '[SF1a] caller1 已 claim 并发起第 1 次 provider 调用');

    // caller2：同 requestId，run 仍 running（租约有效）→ in_progress，绝不调用 provider。
    const r2 = await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-sf1-001',
      provider,
    });
    ok(
      r2.kind === 'in_progress' && r2.retryAfterMs === GENERATION_IN_PROGRESS_RETRY_AFTER_MS,
      '[SF1b] caller2 → in_progress + retryAfterMs',
      r2,
    );
    ok(provider.requests.length === 1, '[SF1c] caller2 零 provider 调用（仍 1 次）');
    ok(usageCount(projectId) === 0, '[SF1d] in_progress 期间零 usage（response 未到达）');

    provider.release();
    const r1 = asSucceeded(await p1, '[SF1e] release 后 caller1 build 返回 kind=succeeded');
    ok(!r1.reused && r1.beats.beats.length === 6, '[SF1f] caller1 全新生成 6 beats');

    // caller3：run 已 succeeded → 复用同一 artifact。
    const r3 = asSucceeded(
      await buildNarrativeBeats({
        projectId,
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-sf1-001',
        provider,
      }),
      '[SF1g] caller3 build 返回 kind=succeeded',
    );
    ok(
      r3.reused && !r3.legacy && r3.runId === r1.runId && r3.artifact.id === r1.artifact.id,
      '[SF1h] caller3 → reused 同 artifact 同 run（legacy=false）',
    );
    ok(provider.requests.length === 1, '[SF1i] 全程 provider.generate 恰好 1 次');
    ok(runCount(projectId) === 1, '[SF1j] generation_runs 恰好 1 行');
    ok(beatsRows(projectId).length === 1, '[SF1k] artifacts 恰好 1 行');
    ok(usageCount(projectId, 'req-sf1-001') === 1, '[SF1l] llm_usage 恰好 1 行（1 attempt 即成功）');
    const attempts = listRunAttempts(getDb(), r1.runId!);
    ok(
      attempts.length === 1 && attempts[0]!.status === 'succeeded' && attempts[0]!.provider_request_id === 'blk-1',
      '[SF1m] attempt journal：1 行 succeeded + provider_request_id 匹配',
      attempts.map((a) => [a.attempt_number, a.status, a.provider_request_id]),
    );
  }

  // ============ SF2：不同 requestId 各自生成 ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const beats = makeValidBeats(build.plan);
    const provider = new ScriptableProvider();
    provider.push({text: proposalJson(beats)});
    provider.push({text: proposalJson(beats)});
    const ra = asSucceeded(
      await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: build.artifact.id, requestId: 'req-sf2-000a', provider}),
      '[SF2a] 第一个 requestId build 返回 kind=succeeded',
    );
    const rb = asSucceeded(
      await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: build.artifact.id, requestId: 'req-sf2-000b', provider}),
      '[SF2b] 第二个 requestId build 返回 kind=succeeded',
    );
    ok(
      !ra.reused && !rb.reused && ra.artifact.id !== rb.artifact.id,
      '[SF2c] 不同 requestId → 各自新 candidate（append-only）',
    );
    ok(runCount(projectId) === 2, '[SF2d] 2 条 generation_runs');
    ok(beatsRows(projectId).length === 2, '[SF2e] 2 条 artifacts');
    ok(provider.requests.length === 2, '[SF2f] provider 恰好 2 次调用');
  }

  // ============ SF3：同 requestId 不同 source → REQUEST_ID_CONFLICT ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build1 = buildNarrationPlanV2(projectId);
    const provider = new ScriptableProvider();
    provider.push({text: proposalJson(makeValidBeats(build1.plan))});
    await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build1.artifact.id,
      requestId: 'req-sf3-001',
      provider,
    });
    editVersion(
      {
        projectId,
        stage: 'script_v2',
        content: `${STRICT_MD}\n第七句。`,
        contentType: 'markdown',
        source: 'manual_edit',
        promptVersion: 'script-v2@2.0',
      },
      {confirmStale: true},
    );
    lockStage(projectId, 'script_v2');
    const build2 = buildNarrationPlanV2(projectId);
    ok(build2.artifact.id !== build1.artifact.id, '[SF3a] 演进 script 产生第二个 plan candidate');
    await expectBeatsError(
      'REQUEST_ID_CONFLICT',
      () =>
        buildNarrativeBeats({
          projectId,
          narrationPlanV2ArtifactId: build2.artifact.id,
          requestId: 'req-sf3-001',
          provider,
        }),
      '[SF3b] 同 requestId 不同 source → REQUEST_ID_CONFLICT（throw）',
    );
  }

  // ============ SF4：进程重启持久性（closeDb → getDb 模拟重启） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const provider = new ScriptableProvider();
    provider.push({text: proposalJson(makeValidBeats(build.plan))});
    const first = asSucceeded(
      await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: build.artifact.id, requestId: 'req-sf4-001', provider}),
      '[SF4a] 重启前 build 返回 kind=succeeded',
    );
    ok(provider.requests.length === 1, '[SF4b] 重启前 provider 恰好 1 次调用');

    closeDb();
    getDb(); // 模拟进程重启后重开同一 DB 文件

    const afterRestart = new ScriptableProvider();
    const second = asSucceeded(
      await buildNarrativeBeats({
        projectId,
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-sf4-001',
        provider: afterRestart,
      }),
      '[SF4c] 重启后同 requestId build 返回 kind=succeeded',
    );
    ok(
      second.reused && !second.legacy && second.runId === first.runId && second.artifact.id === first.artifact.id,
      '[SF4d] 重启后幂等复用持久（同 run 同 artifact）',
    );
    ok(afterRestart.requests.length === 0, '[SF4e] 重启后复用零 provider 调用');
    ok(usageCount(projectId, 'req-sf4-001') === 1, '[SF4f] 重启后零新增 usage');
  }

  // ============ SF5：租约过期 → indeterminate（不自动重调 provider） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const hanging = new HangingProvider();
    // caller1 永远停在 provider 调用上（模拟进程崩溃前的 in_flight）。
    void buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-sf5-001',
      provider: hanging,
    });
    await new Promise((resolve) => setImmediate(resolve));
    ok(hanging.requests.length === 1, '[SF5a] caller1 已 claim 并挂起（in_flight attempt）');
    const running = runRow(projectId, 'req-sf5-001');
    ok(running !== undefined && running.status === 'running', '[SF5b] run 处于 running + 租约有效');

    // 直接把租约改为过去时间（模拟崩溃后租约过期）。
    getDb()
      .prepare(`UPDATE generation_runs SET lease_expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), running!.id);

    const r2 = await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-sf5-001',
      provider: new ScriptableProvider(),
    });
    ok(
      r2.kind === 'terminal' && r2.status === 'indeterminate',
      '[SF5c] 租约过期后同 requestId → terminal indeterminate',
      r2,
    );
    ok(hanging.requests.length === 1, '[SF5d] 过期 run 不自动重调 provider（仍 1 次）');
    const runAfter = runRow(projectId, 'req-sf5-001');
    ok(
      runAfter !== undefined && runAfter.status === 'indeterminate' && runAfter.error_code === 'LEASE_EXPIRED',
      '[SF5e] run 终态 indeterminate + LEASE_EXPIRED',
      runAfter && {status: runAfter.status, error_code: runAfter.error_code},
    );
    const orphanAttempts = listRunAttempts(getDb(), running!.id);
    ok(
      orphanAttempts.length === 1 && orphanAttempts[0]!.status === 'indeterminate',
      '[SF5f] 孤儿 in_flight attempt 一并转 indeterminate',
      orphanAttempts.map((a) => [a.attempt_number, a.status]),
    );
    ok(usageCount(projectId) === 0, '[SF5g] 全程零 usage（response 从未到达）');

    // 显式 regenerate：新 requestId 才能成功。
    const regen = new ScriptableProvider();
    regen.push({text: proposalJson(makeValidBeats(build.plan))});
    const r3 = asSucceeded(
      await buildNarrativeBeats({
        projectId,
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-sf5-002',
        provider: regen,
      }),
      '[SF5h] 新 requestId build 返回 kind=succeeded',
    );
    ok(!r3.reused && regen.requests.length === 1, '[SF5i] 新 requestId 才成功生成（1 次调用）');
  }

  // ============ J：attempt journal（proposal 语义失败 → repair 成功） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const validBeats = makeValidBeats(build.plan);
    const [n1, n2] = build.plan.units.map((u) => u.id) as [string, string];
    const dupBeats = validBeats.map((b) => ({...b}));
    dupBeats[0] = {...dupBeats[0]!, unitIds: [n1, n2]};
    const badText = proposalJson(dupBeats);
    const goodText = proposalJson(validBeats);

    const provider = new ScriptableProvider();
    provider.push({text: badText});
    provider.push({text: goodText});
    const result = asSucceeded(
      await buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: build.artifact.id, requestId: 'req-j-00001', provider}),
      '[J1] proposal 失败 + repair 成功 build 返回 kind=succeeded',
    );
    ok(result.beats.generation.attemptCount === 2, '[J2] attemptCount=2');
    ok(runCount(projectId) === 1, '[J3] generation_runs 恰好 1 行');
    ok(beatsRows(projectId).length === 1, '[J4] artifacts 恰好 1 行');
    ok(usageCount(projectId, 'req-j-00001') === 2, '[J5] llm_usage 恰好 2 行（proposal + repair）');

    const run = runRow(projectId, 'req-j-00001')!;
    const attempts = listRunAttempts(getDb(), run.id);
    ok(attempts.length === 2, '[J6] generation_attempts 恰好 2 行');
    const [a1, a2] = attempts as [(typeof attempts)[number], (typeof attempts)[number]];

    ok(
      a1.status === 'validation_failed' && a1.parse_result === 'pass',
      '[J7] attempt1 = validation_failed（JSON/schema 通过、语义失败）',
      {status: a1.status, parse_result: a1.parse_result},
    );
    ok(a1.response_text === badText, '[J8] attempt1 保存原始 response 原文');
    ok(
      a1.semantic_issues_json !== null && a1.semantic_issues_json.includes('DUPLICATE_UNIT'),
      '[J9] attempt1 semantic_issues 含精确 DUPLICATE_UNIT',
      a1.semantic_issues_json,
    );
    ok(a2.status === 'succeeded' && a2.parse_result === 'pass', '[J10] attempt2 = succeeded');
    ok(a2.response_text === goodText, '[J11] attempt2 保存原始 response 原文');
    ok(
      a1.provider_request_id === 'scr-1' && a2.provider_request_id === 'scr-2',
      '[J12] 两行 provider_request_id 与 Mock 返回值一致',
      [a1.provider_request_id, a2.provider_request_id],
    );
    ok(
      a1.response_hash === sha256Text(badText) && a2.response_hash === sha256Text(goodText),
      '[J13] response_hash = sha256Text(response.text)',
    );

    // usage_record_id 精确关联：指向真实 llm_usage 行，且该行 request_id = provider_request_id。
    const usageRows = getDb()
      .prepare(
        `SELECT id, request_id FROM llm_usage WHERE project_id = ? AND stage = 'm7_narrative_beats' AND job_id = ?`,
      )
      .all(projectId, 'req-j-00001') as Array<{id: string; request_id: string}>;
    const usageById = new Map(usageRows.map((u) => [u.id, u]));
    const u1 = a1.usage_record_id ? usageById.get(a1.usage_record_id) : undefined;
    const u2 = a2.usage_record_id ? usageById.get(a2.usage_record_id) : undefined;
    ok(
      u1 !== undefined && u1.request_id === 'scr-1' && u2 !== undefined && u2.request_id === 'scr-2' &&
        a1.usage_record_id !== a2.usage_record_id,
      '[J14] usage_record_id 精确关联 llm_usage.id（且与 provider_request_id 互证）',
      {a1: a1.usage_record_id, a2: a2.usage_record_id},
    );

    // request 投影安全：绝无 Authorization / api-key / secret 字样。
    const leak = attempts.filter((a) => /authorization|api[-_]?key|secret|bearer/i.test(a.request_json));
    ok(leak.length === 0, '[J15] request_json 不含 Authorization/api-key/secret 字样');
    ok(
      attempts.every((a) => a.request_json.includes('"model"') && a.request_json.includes('"user"')),
      '[J16] request_json 为安全字段投影（model/user 等）',
    );

    // artifact 可经 run.result_artifact_id 追溯。
    ok(
      run.result_artifact_id === result.artifact.id && run.status === 'succeeded',
      '[J17] run.result_artifact_id 精确指向生成 artifact',
    );
    const traced = getDb()
      .prepare(`SELECT id FROM artifacts WHERE id = ? AND kind = ?`)
      .get(run.result_artifact_id, NARRATIVE_BEATS_KIND) as {id: string} | undefined;
    ok(traced !== undefined, '[J18] result_artifact_id → artifacts 行可追溯');
  }

  // ============ F：两次 repair 仍失败 → run failed 终态 ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const validBeats = makeValidBeats(build.plan);
    const missing = validBeats.slice(0, 5); // 遗漏 unit → 语义非法
    const provider = new ScriptableProvider();
    provider.push({text: proposalJson(missing)});
    provider.push({text: proposalJson(missing)});
    provider.push({text: proposalJson(missing)});
    const result = await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-f-00001',
      provider,
    });
    ok(
      result.kind === 'terminal' && result.status === 'failed' && result.errorCode === 'VALIDATION_FAILED',
      '[F1] 三次非法输出 → terminal VALIDATION_FAILED（不 throw）',
      result,
    );
    const run = runRow(projectId, 'req-f-00001')!;
    ok(run.status === 'failed' && run.error_code === 'VALIDATION_FAILED', '[F2] run 终态 failed');
    const attempts = listRunAttempts(getDb(), run.id);
    ok(
      attempts.length === 3 && attempts.every((a) => a.status === 'validation_failed'),
      '[F3] attempts=3 且全部 validation_failed（journal 完整）',
      attempts.map((a) => [a.attempt_number, a.status]),
    );
    ok(usageCount(projectId, 'req-f-00001') === 3, '[F4] usage 恰好 3 行（含失败请求，成本可审计）');
    ok(beatsRows(projectId).length === 0, '[F5] 失败 generation 零 artifact');

    // 同 requestId 再调 → 同一 terminal，零 provider 调用、零新增 usage。
    const callsBefore = provider.requests.length;
    const usageBefore = usageCount(projectId);
    const again = await buildNarrativeBeats({
      projectId,
      narrationPlanV2ArtifactId: build.artifact.id,
      requestId: 'req-f-00001',
      provider,
    });
    ok(
      again.kind === 'terminal' && again.errorCode === 'VALIDATION_FAILED' && again.runId === run.id,
      '[F6] 失败 requestId 再调 → 同一 terminal 同一 run',
    );
    ok(provider.requests.length === callsBefore, '[F7] 终态复用零 provider 调用');
    ok(usageCount(projectId) === usageBefore, '[F8] 终态复用零新增 usage');
  }

  // ============ RT：API route 真实路径（provider override 注入） ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const validBeats = makeValidBeats(build.plan);
    const routeProvider = new ScriptableProvider();
    setNarrativeBeatsProviderForTest(routeProvider);
    try {
      // 新建 → 201 + 非空 runId
      routeProvider.push({text: proposalJson(validBeats)});
      const createRes = await postBeats(projectId, {
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-rt-0001',
      });
      ok(createRes.status === 201, '[RT1] 新 requestId POST → 201');
      const createJson = (await createRes.json()) as {runId: string | null; reused: boolean; legacy: boolean};
      ok(
        createJson.runId !== null && createJson.reused === false && createJson.legacy === false,
        '[RT2] 201 响应含非空 runId',
        createJson,
      );
      ok(routeProvider.requests.length === 1, '[RT3] route 真实调用注入的 provider（1 次）');

      // 同 requestId → 200 reused
      const reuseRes = await postBeats(projectId, {
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-rt-0001',
      });
      ok(reuseRes.status === 200, '[RT4] 同 requestId POST → 200 reused');
      const reuseJson = (await reuseRes.json()) as {reused: boolean; runId: string | null};
      ok(reuseJson.reused === true && reuseJson.runId === createJson.runId, '[RT5] 200 响应 reused + 同 runId');

      // terminal run → 409（三次非法输出）
      routeProvider.push({text: proposalJson(validBeats.slice(0, 5))});
      routeProvider.push({text: proposalJson(validBeats.slice(0, 5))});
      routeProvider.push({text: proposalJson(validBeats.slice(0, 5))});
      const failRes = await postBeats(projectId, {
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-rt-0002',
      });
      ok(failRes.status === 409, '[RT6] 三次非法输出 POST → 409');
      const failJson = (await failRes.json()) as {status: string; errorCode: string; runId: string};
      ok(
        failJson.status === 'failed' && failJson.errorCode === 'VALIDATION_FAILED',
        '[RT7] 409 响应含 status=failed + errorCode',
        failJson,
      );
      // 同 requestId 再 POST → 同一 409（稳定终态）
      const failAgain = await postBeats(projectId, {
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'req-rt-0002',
      });
      ok(failAgain.status === 409, '[RT8] terminal 同 requestId 再 POST → 409（稳定）');

      // invalid body（缺 artifact id）→ 422
      const invalidBody = await postBeats(projectId, {requestId: 'req-rt-0003'});
      ok(invalidBody.status === 422, '[RT9] 缺 artifact ID → 422');

      // 过短 requestId → 422 REQUEST_ID_INVALID
      const shortId = await postBeats(projectId, {
        narrationPlanV2ArtifactId: build.artifact.id,
        requestId: 'abc',
      });
      ok(shortId.status === 422, '[RT10] 过短 requestId → 422');
    } finally {
      setNarrativeBeatsProviderForTest(null);
    }

    // GET：runs 数组 + legacyRunMetadataUnavailable。
    // 手工插入一个无 run row 的 legacy candidate（复制既有 artifact 内容、改 requestId）。
    const srcRow = getDb()
      .prepare(`SELECT content_json FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version ASC LIMIT 1`)
      .get(projectId, NARRATIVE_BEATS_KIND) as {content_json: string};
    const legacyContent = JSON.parse(srcRow.content_json) as {
      generation: {requestId: string};
      source: {narrationPlanV2ArtifactId: string};
    };
    legacyContent.generation.requestId = 'req-legacy-1';
    insertArtifact(projectId, NARRATIVE_BEATS_KIND, legacyContent);

    const listRes = await beatsGET(new Request('http://test'), {params: Promise.resolve({id: projectId})});
    ok(listRes.status === 200, '[RT12] GET list → 200');
    const listJson = (await listRes.json()) as {
      runs: Array<{requestId: string; status: string}>;
      candidates: Array<{requestId: string | null; legacyRunMetadataUnavailable: boolean}>;
    };
    ok(
      Array.isArray(listJson.runs) &&
        listJson.runs.some((r) => r.requestId === 'req-rt-0001' && r.status === 'succeeded') &&
        listJson.runs.some((r) => r.requestId === 'req-rt-0002' && r.status === 'failed'),
      '[RT13] GET 响应含 runs（succeeded + failed 均可见）',
    );
    const legacyCandidate = listJson.candidates.find((c) => c.requestId === 'req-legacy-1');
    const durableCandidate = listJson.candidates.find((c) => c.requestId === 'req-rt-0001');
    ok(
      legacyCandidate !== undefined && legacyCandidate.legacyRunMetadataUnavailable === true,
      '[RT14] 无 run 的 legacy candidate legacyRunMetadataUnavailable=true',
    );
    ok(
      durableCandidate !== undefined && durableCandidate.legacyRunMetadataUnavailable === false,
      '[RT15] 有 run 的 candidate legacyRunMetadataUnavailable=false',
    );

    // legacy requestId 复用：按 artifact 内 requestId 命中 → 200 reused + legacy=true + runId=null。
    const legacyRes = await postBeats(projectId, {
      narrationPlanV2ArtifactId: legacyContent.source.narrationPlanV2ArtifactId,
      requestId: 'req-legacy-1',
    });
    ok(legacyRes.status === 200, '[RT16] legacy requestId POST → 200 reused（不触达 LLM）');
    const legacyJson = (await legacyRes.json()) as {reused: boolean; legacy: boolean; runId: string | null};
    ok(
      legacyJson.reused === true && legacyJson.legacy === true && legacyJson.runId === null,
      '[RT17] legacy 复用响应 legacy=true + runId=null（不伪造 journal）',
      legacyJson,
    );

    // REQUEST_ID_CONFLICT：演进 script 产生第二个 plan candidate + 同 requestId → 409
    // （放在最后：此后原 plan 变 stale，不再适合其他用例）。
    editVersion(
      {
        projectId,
        stage: 'script_v2',
        content: `${STRICT_MD}\n第七句。`,
        contentType: 'markdown',
        source: 'manual_edit',
        promptVersion: 'script-v2@2.0',
      },
      {confirmStale: true},
    );
    lockStage(projectId, 'script_v2');
    const build2 = buildNarrationPlanV2(projectId);
    const conflictRes = await postBeats(projectId, {
      narrationPlanV2ArtifactId: build2.artifact.id,
      requestId: 'req-rt-0001',
    });
    ok(conflictRes.status === 409, '[RT18] 同 requestId 不同 source POST → 409 REQUEST_ID_CONFLICT');
  }

  // ============ RQ：requestId canonicalize 契约 ============
  {
    const projectId = newProjectWithScript(STRICT_MD, 'script-v2@2.0');
    const build = buildNarrationPlanV2(projectId);
    const provider = new ScriptableProvider();
    const call = (requestId: string): Promise<BuildNarrativeBeatsResult> =>
      buildNarrativeBeats({projectId, narrationPlanV2ArtifactId: build.artifact.id, requestId, provider});

    await expectBeatsError('REQUEST_ID_INVALID', () => call('abc'), '[RQ1] 过短（3 字符）→ REQUEST_ID_INVALID');
    await expectBeatsError('REQUEST_ID_REQUIRED', () => call('   '), '[RQ2] 全空格 → REQUEST_ID_REQUIRED');
    await expectBeatsError('REQUEST_ID_REQUIRED', () => call(''), '[RQ3] 空字符串 → REQUEST_ID_REQUIRED');
    await expectBeatsError('REQUEST_ID_INVALID', () => call('req\nabc-12'), '[RQ4] 含换行 → REQUEST_ID_INVALID');
    await expectBeatsError('REQUEST_ID_INVALID', () => call('req abc-12'), '[RQ5] 含空格 → REQUEST_ID_INVALID');
    await expectBeatsError('REQUEST_ID_INVALID', () => call('r'.repeat(129)), '[RQ6] 超长 129 字符 → REQUEST_ID_INVALID');
    await expectBeatsError('REQUEST_ID_INVALID', () => call('req-\u0001abc'), '[RQ7] 含控制字符 → REQUEST_ID_INVALID');
    ok(runCount(projectId) === 0, '[RQ8] 非法 requestId 在 claim 前拒绝（零 run 行）');

    // trim 等价：' req-abc-123 ' 与 'req-abc-123' 是同一键。
    provider.push({text: proposalJson(makeValidBeats(build.plan))});
    const padded = asSucceeded(await call(' req-abc-123 '), '[RQ9] 带空白 requestId build 返回 kind=succeeded');
    const unpadded = asSucceeded(await call('req-abc-123'), '[RQ10] trim 后同键 build 返回 kind=succeeded');
    ok(
      padded.runId !== null && padded.runId === unpadded.runId && unpadded.reused,
      '[RQ11] trim 前后视为同一键（同 run 复用）',
    );
    ok(provider.requests.length === 1, '[RQ12] 同键复用零新增 provider 调用');
    ok(runCount(projectId) === 1, '[RQ13] 同键仅一条 generation_runs 行');
  }

  // ============ SEC：production 下 provider override 后门禁用 ============
  {
    // Next.js 类型把 NODE_ENV 标为 readonly——经可写视图临时改值（测完恢复）。
    const env = process.env as Record<string, string | undefined>;
    const savedEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    let threw = false;
    try {
      setNarrativeBeatsProviderForTest(null);
    } catch {
      threw = true;
    } finally {
      if (savedEnv === undefined) {
        delete env.NODE_ENV;
      } else {
        env.NODE_ENV = savedEnv;
      }
    }
    ok(threw, '[SEC1] NODE_ENV=production 时 setNarrativeBeatsProviderForTest 必须 throw');
    // 恢复后非 production 环境可用（不影响其他用例）。
    let okAgain = true;
    try {
      setNarrativeBeatsProviderForTest(null);
    } catch {
      okAgain = false;
    }
    ok(okAgain, '[SEC2] 恢复 NODE_ENV 后 override 可用');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m721-singleflight'), {recursive: true, force: true});

  // async 断言是微任务——等待全部落定再汇总
  await new Promise((resolve) => setImmediate(resolve));

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.2.1 Generation Single-Flight 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.2.1 Generation Single-Flight 测试全部通过 ✅');
}

void main();

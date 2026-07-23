/**
 * M2-B LLM 层自动化测试（Mock 为主，零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m2b.ts
 * 使用临时数据目录（data/test-m2b），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2b');

import {z} from 'zod';
import {closeDb, getDb} from '../src/lib/db';
import {DeepSeekProvider} from '../src/lib/llm/deepseek';
import {executeStageGeneration, extractJsonText} from '../src/lib/llm/executor';
import {createProviderFromEnv} from '../src/lib/llm/index';
import {MockLLMProvider} from '../src/lib/llm/mock';
import {computeCostCny, PRICE_TABLE, PRICE_TABLE_VERSION} from '../src/lib/llm/pricing';
import {getStageModelConfig, STAGE_MODELS} from '../src/lib/llm/stage-models';
import {LLMError, type LLMRequest, type LLMUsage} from '../src/lib/llm/types';
import {recordLlmUsage} from '../src/lib/llm/usage';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {PROMPT_REGISTRY, assertRegistryComplete} from '../src/lib/prompts/registry';
import type {StagePromptInput} from '../src/lib/prompts/shared';
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

async function expectLLMError(
  fn: () => Promise<unknown> | unknown,
  code: LLMError['code'],
  label: string,
): Promise<void> {
  try {
    await fn();
    ok(false, `${label}（未抛错）`);
  } catch (err) {
    ok(
      err instanceof LLMError && err.code === code,
      `${label}（抛出 ${err instanceof LLMError ? err.code : String(err)}）`,
    );
  }
}

// ---------- DeepSeek 假 fetch 工具 ----------

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
  authorization?: string;
}

function makeOkResponse(overrides?: {
  content?: string;
  finishReason?: string;
  usage?: Record<string, unknown>;
}): Response {
  return new Response(
    JSON.stringify({
      id: 'req-test-001',
      model: 'deepseek-v4-flash',
      choices: [
        {
          message: {role: 'assistant', content: overrides?.content ?? '测试输出'},
          finish_reason: overrides?.finishReason ?? 'stop',
        },
      ],
      usage: overrides?.usage ?? {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 30,
        prompt_cache_miss_tokens: 70,
        completion_tokens_details: {reasoning_tokens: 20},
      },
    }),
    {status: 200, headers: {'content-type': 'application/json'}},
  );
}

const INPUT: StagePromptInput = {
  topic: '测试主题：我们为什么会拖延',
  coreQuestion: '拖延只是时间管理问题吗？',
  targetDuration: '10 分钟',
};

const EXPECTED_OUTPUT_KIND: Record<WorkflowStage, 'markdown' | 'json'> = {
  project_definition: 'markdown',
  research: 'markdown',
  evidence: 'json',
  argument_tree: 'json',
  script_v1: 'markdown',
  script_v2: 'markdown',
  narration_beat_map: 'markdown',
  visual_breakdown: 'markdown',
  shot_list: 'json',
  scenes: 'json',
};

function usageRows(stage?: string): Array<Record<string, unknown>> {
  const db = getDb();
  if (stage) {
    return db
      .prepare('SELECT * FROM llm_usage WHERE stage = ? ORDER BY created_at, rowid')
      .all(stage) as Array<Record<string, unknown>>;
  }
  return db.prepare('SELECT * FROM llm_usage ORDER BY created_at, rowid').all() as Array<
    Record<string, unknown>
  >;
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2b'), {recursive: true, force: true});
  const db = getDb();

  // ============ A. Provider 选择器安全规则 ============
  ok(createProviderFromEnv({LLM_PROVIDER: 'mock'}).name === 'mock', '[A] 显式 mock → Mock Provider');
  ok(
    createProviderFromEnv({LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-test-dummy'}).name ===
      'deepseek',
    '[A] deepseek + key → DeepSeek Provider',
  );
  await expectLLMError(
    () => createProviderFromEnv({LLM_PROVIDER: 'mock', NODE_ENV: 'production'}),
    'CONFIG_ERROR',
    '[A] production + mock → CONFIG_ERROR',
  );
  await expectLLMError(
    () => createProviderFromEnv({NODE_ENV: 'production'}),
    'CONFIG_ERROR',
    '[A] production 未配置 provider → CONFIG_ERROR',
  );
  await expectLLMError(
    () => createProviderFromEnv({LLM_PROVIDER: 'deepseek'}),
    'CONFIG_ERROR',
    '[A] deepseek 无 API Key → CONFIG_ERROR',
  );
  await expectLLMError(
    () => createProviderFromEnv({LLM_PROVIDER: 'deepseek', NODE_ENV: 'production'}),
    'CONFIG_ERROR',
    '[A] production deepseek 无 Key → CONFIG_ERROR',
  );
  await expectLLMError(
    () => createProviderFromEnv({LLM_PROVIDER: 'bogus'}),
    'CONFIG_ERROR',
    '[A] 未知 provider → CONFIG_ERROR',
  );
  {
    const warnings: string[] = [];
    const provider = createProviderFromEnv({}, {warn: (m) => warnings.push(m)});
    ok(
      provider.name === 'mock' && warnings.length === 1,
      '[A] dev 未配置 → fallback mock 且输出 warning',
      warnings,
    );
  }

  // ============ B. DeepSeek 请求体 / thinking / JSON mode / usage 解析 ============
  {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        authorization: (init.headers as Record<string, string>).Authorization,
      });
      return makeOkResponse();
    }) as unknown as typeof fetch;

    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
    const res = await provider.generate({
      model: 'deepseek-v4-flash',
      system: 'sys',
      user: 'usr',
      outputMode: 'json',
      thinking: 'enabled',
      reasoningEffort: 'high',
      maxTokens: 512,
    });
    const body = calls[0]?.body ?? {};
    ok(calls.length === 1 && url0(calls) === 'https://api.deepseek.com/chat/completions', '[B] 请求端点正确');
    ok(body.model === 'deepseek-v4-flash', '[B] body.model 正确');
    ok(
      Array.isArray(body.messages) &&
        (body.messages as Array<{role: string}>)[0]?.role === 'system' &&
        (body.messages as Array<{role: string}>)[1]?.role === 'user',
      '[B] messages = system + user',
    );
    ok(body.stream === false, '[B] 显式 stream=false');
    ok(
      (body.thinking as {type: string})?.type === 'enabled' &&
        body.reasoning_effort === 'high',
      '[B] thinking=enabled 显式发送 + reasoning_effort=high',
    );
    ok(
      (body.response_format as {type: string})?.type === 'json_object',
      '[B] JSON 阶段 response_format=json_object',
    );
    ok(body.max_tokens === 512, '[B] max_tokens 透传');
    ok(!('temperature' in body) && !('top_p' in body), '[B] 不发送 temperature/top_p');
    ok(calls[0]?.authorization === 'Bearer sk-test-dummy', '[B] Key 仅存在于 Authorization 头');
    ok(
      res.usage.promptTokens === 100 &&
        res.usage.cacheHitTokens === 30 &&
        res.usage.cacheMissTokens === 70 &&
        res.usage.completionTokens === 50 &&
        res.usage.reasoningTokens === 20,
      '[B] usage 完整解析（含 cache hit/miss 与 reasoning）',
      res.usage,
    );
    ok(res.requestId === 'req-test-001' && res.model === 'deepseek-v4-flash' && res.finishReason === 'stop', '[B] requestId/model/finishReason 解析');
  }
  {
    const calls: CapturedCall[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push({url: _url, body: JSON.parse(String(init.body))});
      return makeOkResponse();
    }) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
    await provider.generate({
      model: 'deepseek-v4-flash',
      system: 'sys',
      user: 'usr',
      outputMode: 'text',
      thinking: 'disabled',
    });
    const body = calls[0]?.body ?? {};
    ok(
      (body.thinking as {type: string})?.type === 'disabled' &&
        !('reasoning_effort' in body) &&
        !('response_format' in body),
      '[B] thinking=disabled 显式发送且不携带 reasoning_effort/response_format',
      body,
    );
  }

  // ============ C. 超时 / 错误映射 / retry 上限 ============
  {
    let calls = 0;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        calls++;
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', timeoutMs: 50, fetchImpl});
    await expectLLMError(
      () =>
        provider.generate({
          model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
        }),
      'PROVIDER_TIMEOUT',
      '[C] 超时 → PROVIDER_TIMEOUT',
    );
    ok(calls === 2, '[C] 超时可 retry 且最多 1 次（共 2 次尝试）', calls);
  }
  {
    for (const [status, expectCalls] of [[500, 2], [429, 2], [400, 1]] as const) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response('server says no', {status});
      }) as unknown as typeof fetch;
      const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
      await expectLLMError(
        () =>
          provider.generate({
            model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
          }),
        'PROVIDER_HTTP_ERROR',
        `[C] HTTP ${status} → PROVIDER_HTTP_ERROR`,
      );
      ok(
        calls === expectCalls,
        `[C] HTTP ${status} 尝试次数 = ${expectCalls}（${status === 400 ? '不 retry' : 'retry 1 次'}）`,
        calls,
      );
    }
  }
  {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? new Response('boom', {status: 500}) : makeOkResponse();
    }) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
    const res = await provider.generate({
      model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
    });
    ok(calls === 2 && res.text === '测试输出', '[C] 500 后 retry 成功', calls);
  }
  {
    const fetchImpl = (async () => new Response('not-json{{', {status: 200})) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
    await expectLLMError(
      () =>
        provider.generate({
          model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
        }),
      'PROVIDER_INVALID_RESPONSE',
      '[C] 200 但非法 JSON → PROVIDER_INVALID_RESPONSE',
    );
  }
  {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({id: 'x', model: 'm', choices: [{message: {content: 'hi'}, finish_reason: 'stop'}]}),
        {status: 200},
      )) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
    await expectLLMError(
      () =>
        provider.generate({
          model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
        }),
      'PROVIDER_INVALID_RESPONSE',
      '[C] 缺 usage → PROVIDER_INVALID_RESPONSE（不伪造成本）',
    );
  }

  // ============ D. Prompt Registry 完整性 ============
  let registryThrew = false;
  try {
    assertRegistryComplete();
  } catch {
    registryThrew = true;
  }
  ok(!registryThrew, '[D] assertRegistryComplete 通过');
  ok(
    WORKFLOW_STAGES.every((s) => PROMPT_REGISTRY[s] !== undefined),
    '[D] 10 个阶段模板注册完整',
  );
  ok(
    WORKFLOW_STAGES.every((s) => PROMPT_REGISTRY[s].promptVersion.trim().length > 0),
    '[D] 全部 promptVersion 非空',
  );
  ok(
    WORKFLOW_STAGES.every((s) => PROMPT_REGISTRY[s].outputKind === EXPECTED_OUTPUT_KIND[s]),
    '[D] outputKind 划分正确（markdown×6 / json×4）',
  );
  ok(
    WORKFLOW_STAGES.filter((s) => EXPECTED_OUTPUT_KIND[s] === 'json').every(
      (s) => PROMPT_REGISTRY[s].zodSchema !== undefined,
    ),
    '[D] JSON 阶段全部带 zod schema',
  );
  {
    // scenes：AI 不控制系统数据（schemaVersion/templateVersion/composition/fps/width/height 被剥离）
    const validScene = {
      id: 'S001', chapter: 1, chapterTitle: 't', start: 0, end: 1, duration: 1,
      startFrame: 0, durationInFrames: 30, category: 'Minimal', visualType: 'Minimal',
      template: null, sourceTemplate: null, narrationSummary: 'n', description: 'd',
    };
    const parsed = scenesAiOutputSchema.safeParse({
      chapterTiming: [{chapter: 1, title: 't', start: 0, end: 1}],
      scenes: [validScene],
      schemaVersion: '9.9',
      templateVersion: 'evil',
      composition: 'evil',
      fps: 999,
      width: 1,
      height: 1,
    });
    ok(
      parsed.success &&
        !('schemaVersion' in parsed.data) &&
        !('templateVersion' in parsed.data) &&
        !('fps' in parsed.data),
      '[D] scenes schema 只接受 chapterTiming+scenes，系统字段被剥离',
    );
  }

  // ============ E. 来源/科学边界 ============
  {
    const research = PROMPT_REGISTRY.research;
    const evidence = PROMPT_REGISTRY.evidence;
    ok(
      research.system.includes('UNVERIFIED') &&
        research.system.includes('SOURCE_REQUIRED') &&
        research.system.includes('INSUFFICIENT_SOURCES') &&
        research.system.includes('禁止伪造'),
      '[E] research 含来源边界三态与禁止伪造',
    );
    ok(
      evidence.system.includes('UNVERIFIED') &&
        evidence.system.includes('SOURCE_REQUIRED') &&
        evidence.system.includes('INSUFFICIENT_SOURCES') &&
        evidence.system.includes('禁止伪造'),
      '[E] evidence 含来源边界三态与禁止伪造',
    );
    ok(
      research.system.includes('没有联网检索能力'),
      '[E] research 显式声明无联网检索能力',
    );
    ok(
      research.buildUser(INPUT).includes('未提供'),
      '[E] 无 sourceContext 时 research user 显式标注',
    );
    ok(
      !research.system.includes('弗洛伊德') && !PROMPT_REGISTRY.visual_breakdown.system.includes('弗洛伊德'),
      '[E] 提示词不硬编码 Freud 示例项目风格',
    );
  }

  // ============ F. Stage Model Config ============
  ok(
    STAGE_MODELS.argument_tree.model === 'deepseek-v4-pro' &&
      STAGE_MODELS.argument_tree.thinking === 'enabled' &&
      STAGE_MODELS.argument_tree.reasoningEffort === 'high',
    '[F] argument_tree → Pro + thinking enabled + high',
  );
  ok(
    STAGE_MODELS.project_definition.thinking === 'disabled' &&
      STAGE_MODELS.narration_beat_map.thinking === 'disabled' &&
      STAGE_MODELS.shot_list.thinking === 'disabled' &&
      STAGE_MODELS.scenes.thinking === 'disabled',
    '[F] 四个阶段 thinking 显式 disabled',
  );
  ok(
    STAGE_MODELS.script_v1.model === 'deepseek-v4-pro' &&
      STAGE_MODELS.script_v2.model === 'deepseek-v4-pro' &&
      STAGE_MODELS.visual_breakdown.model === 'deepseek-v4-flash',
    '[F] script_v1/v2 → Pro，visual_breakdown → Flash',
  );
  {
    const overridden = getStageModelConfig('research', {
      LLM_STAGE_MODEL_RESEARCH: 'deepseek-v4-pro',
    });
    ok(
      overridden.model === 'deepseek-v4-pro' &&
        overridden.thinking === 'enabled' &&
        overridden.reasoningEffort === 'high',
      '[F] LLM_STAGE_MODEL_<STAGE> 覆盖模型名且不动 thinking',
    );
  }

  // ============ G. Pricing 成本公式 ============
  {
    const {costCny, price} = computeCostCny('deepseek-v4-flash', {
      cacheHitTokens: 1_000_000,
      cacheMissTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    ok(
      Math.abs(costCny - (0.02 + 1 + 2)) < 1e-9 &&
        price.cacheHitPerM === 0.02 &&
        price.cacheMissPerM === 1 &&
        price.outputPerM === 2,
      '[G] flash 成本公式：hit×0.02 + miss×1 + out×2（每百万）',
      costCny,
    );
    const withReasoning = computeCostCny('deepseek-v4-flash', {
      cacheHitTokens: 0,
      cacheMissTokens: 1000,
      completionTokens: 1000,
      reasoningTokens: 900,
    } as LLMUsage);
    const withoutReasoning = computeCostCny('deepseek-v4-flash', {
      cacheHitTokens: 0,
      cacheMissTokens: 1000,
      completionTokens: 1000,
    });
    ok(
      withReasoning.costCny === withoutReasoning.costCny,
      '[G] reasoningTokens 不重复计费',
    );
    ok(
      PRICE_TABLE['deepseek-v4-pro'].cacheHitPerM === 0.025 &&
        PRICE_TABLE['deepseek-v4-pro'].cacheMissPerM === 3 &&
        PRICE_TABLE['deepseek-v4-pro'].outputPerM === 6,
      '[G] pro 价格快照（0.025/3/6 元每百万）',
    );
    ok(PRICE_TABLE_VERSION.trim().length > 0, '[G] priceTableVersion 非空');
    await expectLLMError(
      () =>
        computeCostCny('unknown-model', {
          cacheHitTokens: 0,
          cacheMissTokens: 1,
          completionTokens: 1,
        }),
      'CONFIG_ERROR',
      '[G] 未知模型拒绝估算 → CONFIG_ERROR',
    );
  }

  // ============ H. Executor：Mock 十阶段全通过 ============
  const jsonStages = WORKFLOW_STAGES.filter((s) => EXPECTED_OUTPUT_KIND[s] === 'json');
  for (const stage of WORKFLOW_STAGES) {
    const provider = new MockLLMProvider();
    const result = await executeStageGeneration({
      db,
      provider,
      stage,
      input: INPUT,
      projectId: 'test-m2b',
      env: {},
    });
    ok(
      result.stage === stage &&
        result.contentType === EXPECTED_OUTPUT_KIND[stage] &&
        result.content.length > 0 &&
        result.repairCount === 0 &&
        result.requestIds.length === 1 &&
        result.versionSource === 'ai_generate' &&
        (EXPECTED_OUTPUT_KIND[stage] === 'json' ? result.parsed !== undefined : result.parsed === undefined),
      `[H] executor ${stage} 首次通过（contentType=${EXPECTED_OUTPUT_KIND[stage]}）`,
    );
    if (EXPECTED_OUTPUT_KIND[stage] === 'json') {
      const schema = PROMPT_REGISTRY[stage].zodSchema!;
      ok(schema.safeParse(JSON.parse(result.content)).success, `[H] ${stage} content 可经 zod 复验`);
    }
  }

  // ============ I. Repair 语义 ============
  {
    const provider = new MockLLMProvider({badJson: 1});
    const result = await executeStageGeneration({
      db, provider, stage: 'evidence', input: INPUT, projectId: 'test-m2b-repair', env: {},
    });
    ok(
      result.repairCount === 1 && result.requestIds.length === 2 && result.versionSource === 'repair',
      '[I] bad JSON → repair 1 次后通过',
    );
    const rows = usageRows('evidence').filter((r) => r.project_id === 'test-m2b-repair');
    ok(rows.length === 2, '[I] repair 每次独立 usage 行（2 行）', rows.length);
    ok(
      rows.every((r, i) => r.request_id === result.requestIds[i]),
      '[I] usage 行 request_id 与请求一一对应',
    );
    ok(
      rows.every((r) => typeof r.cost_cny === 'number' && (r.cost_cny as number) > 0),
      '[I] 失败请求也产生真实成本（invalid output 仍记 usage）',
    );
  }
  {
    const provider = new MockLLMProvider({badSchema: 1});
    const result = await executeStageGeneration({
      db, provider, stage: 'shot_list', input: INPUT, projectId: 'test-m2b-repair2', env: {},
    });
    ok(result.repairCount === 1 && result.parsed !== undefined, '[I] bad schema → repair 1 次后通过');
  }
  {
    const provider = new MockLLMProvider({badJson: 3});
    await expectLLMError(
      () =>
        executeStageGeneration({
          db, provider, stage: 'argument_tree', input: INPUT, projectId: 'test-m2b-fail', env: {},
        }),
      'VALIDATION_FAILED',
      '[I] 首次 + 2 次 repair 全坏 → VALIDATION_FAILED',
    );
    const rows = usageRows('argument_tree').filter((r) => r.project_id === 'test-m2b-fail');
    ok(rows.length === 3, '[I] 失败 3 次请求全部记录 usage（含最终失败）', rows.length);
  }
  {
    const provider = new MockLLMProvider({empty: 1});
    const result = await executeStageGeneration({
      db, provider, stage: 'research', input: INPUT, projectId: 'test-m2b-empty', env: {},
    });
    ok(
      result.repairCount === 1 && result.content.length > 0,
      '[I] EMPTY_RESPONSE → recovery 后通过',
    );
  }
  {
    const provider = new MockLLMProvider({empty: 5});
    await expectLLMError(
      () =>
        executeStageGeneration({
          db, provider, stage: 'research', input: INPUT, projectId: 'test-m2b-empty2', env: {},
        }),
      'EMPTY_RESPONSE',
      '[I] 持续空响应 → EMPTY_RESPONSE',
    );
  }
  {
    const provider = new MockLLMProvider({truncated: 1});
    await expectLLMError(
      () =>
        executeStageGeneration({
          db, provider, stage: 'scenes', input: INPUT, projectId: 'test-m2b-trunc', env: {},
        }),
      'OUTPUT_TRUNCATED',
      '[I] finishReason=length → OUTPUT_TRUNCATED',
    );
    const rows = usageRows('scenes').filter((r) => r.project_id === 'test-m2b-trunc');
    ok(rows.length === 1, '[I] 截断不做普通 repair（仅 1 次请求）且 usage 已记录', rows.length);
  }
  {
    const provider = new MockLLMProvider({
      providerError: new LLMError('PROVIDER_HTTP_ERROR', '模拟 500', {status: 500}),
    });
    const before = usageRows().length;
    await expectLLMError(
      () =>
        executeStageGeneration({
          db, provider, stage: 'research', input: INPUT, projectId: 'test-m2b-transport', env: {},
        }),
      'PROVIDER_HTTP_ERROR',
      '[I] transport 层失败错误原样上抛',
    );
    ok(usageRows().length === before, '[I] transport 层无 usage → 不伪造成本（0 行新增）');
  }

  // ============ J. usage 快照内容 ============
  {
    const provider = new MockLLMProvider();
    const result = await executeStageGeneration({
      db, provider, stage: 'project_definition', input: INPUT, projectId: 'test-m2b-snap', env: {},
    });
    const rows = usageRows('project_definition').filter((r) => r.project_id === 'test-m2b-snap');
    const row = rows[0];
    // mock cacheHit=0：cached_tokens=0，miss = input_tokens - hit；
    // cost = hit×0.02 + miss×1 + out×2（元/百万）
    const expectedFormula =
      ((row!.cached_tokens as number) * 0.02 +
        ((row!.input_tokens as number) - (row!.cached_tokens as number)) * 1 +
        (row!.output_tokens as number) * 2) /
      1_000_000;
    ok(rows.length === 1, '[J] 单次生成 1 行 usage');
    ok(
      row!.request_id === result.requestIds[0] &&
        row!.provider === 'mock' &&
        row!.model === 'deepseek-v4-flash' &&
        row!.prompt_version === 'project-definition@1.0',
      '[J] usage 行 request_id/provider/model/prompt_version 正确',
    );
    ok(
      row!.price_cache_hit_per_m === 0.02 &&
        row!.price_cache_miss_per_m === 1 &&
        row!.price_output_per_m === 2,
      '[J] 单价快照来自 priceTable（flash 0.02/1/2）',
    );
    ok(
      Math.abs((row!.cost_cny as number) - expectedFormula) < 1e-12,
      '[J] cost_cny = hit×0.02 + miss×1 + out×2（手算核对）',
      {row: row!.cost_cny, expectedFormula},
    );
  }

  // ============ K. Mock 确定性 ============
  {
    const req: LLMRequest = {
      model: 'deepseek-v4-flash', system: 's', user: 'u',
      outputMode: 'text', thinking: 'disabled', meta: {stage: 'research'},
    };
    const r1 = await new MockLLMProvider().generate(req);
    const r2 = await new MockLLMProvider().generate(req);
    ok(
      r1.text === r2.text &&
        r1.requestId === r2.requestId &&
        JSON.stringify(r1.usage) === JSON.stringify(r2.usage),
      '[K] 相同输入 → 相同输出/usage/requestId（deterministic）',
    );
  }

  // ============ L. M2-B 边界：不触碰 workflow 层 ============
  {
    const versionCount = db
      .prepare('SELECT COUNT(*) AS c FROM project_versions')
      .get() as {c: number};
    const stageCount = db.prepare('SELECT COUNT(*) AS c FROM project_stages').get() as {c: number};
    const llmJobCount = db.prepare('SELECT COUNT(*) AS c FROM llm_jobs').get() as {c: number};
    ok(versionCount.c === 0, '[L] executor 不写 project_versions', versionCount.c);
    ok(stageCount.c === 0, '[L] executor 不写 project_stages', stageCount.c);
    ok(llmJobCount.c === 0, '[L] executor 不创建/消费 llm_jobs', llmJobCount.c);
    const executorSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/llm/executor.ts'),
      'utf8',
    );
    ok(
      !/from\s+['"][^'"]*workflow\/operations['"]/.test(executorSrc) &&
        !/require\(\s*['"][^'"]*workflow\/operations['"]/.test(executorSrc),
      '[L] executor 源码不 import workflow transaction 层',
    );
  }

  // ============ M. Secret 静态检查 + extractJsonText ============
  {
    for (const file of ['src/lib/llm/deepseek.ts', 'src/lib/llm/usage.ts', 'src/lib/llm/executor.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      ok(!/console\.log\s*\(/.test(src), `[M] ${file} 无 console.log 调用（防 secret 泄漏）`);
    }
    ok(
      (JSON.parse(extractJsonText('{"a":2}')) as {a: number}).a === 2 &&
        (JSON.parse(extractJsonText('```json\n{"a":1}\n```')) as {a: number}).a === 1,
      '[M] extractJsonText：裸 JSON 与围栏均可解析',
    );
    const zodCheck = z.object({a: z.number()}).safeParse({a: 'x'});
    ok(!zodCheck.success, '[M] zod 可用（sanity）');
  }

  // ============ N. Cancellation（AbortSignal，M2-C 集成补强） ============
  {
    // Mock：长请求进行中 abort → Provider 真正停止
    const controller = new AbortController();
    const provider = new MockLLMProvider({delayMs: 200});
    const pending = provider.generate({
      model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
      signal: controller.signal, meta: {stage: 'research'},
    });
    setTimeout(() => controller.abort(), 30);
    await expectLLMError(() => pending, 'CANCELLED', '[N] Mock 长请求进行中 abort → CANCELLED');
  }
  {
    // Mock：signal 预 abort → 立即 CANCELLED
    const controller = new AbortController();
    controller.abort();
    const provider = new MockLLMProvider({delayMs: 50});
    await expectLLMError(
      () =>
        provider.generate({
          model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
          signal: controller.signal, meta: {stage: 'research'},
        }),
      'CANCELLED',
      '[N] Mock 预 abort → 立即 CANCELLED',
    );
  }
  {
    // DeepSeek：外部 abort → CANCELLED（不得误判 PROVIDER_TIMEOUT），且不 retry
    let calls = 0;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        calls++;
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', timeoutMs: 5000, fetchImpl});
    const controller = new AbortController();
    const pending = provider.generate({
      model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expectLLMError(() => pending, 'CANCELLED', '[N] DeepSeek 外部 abort → CANCELLED（非 TIMEOUT）');
    ok(calls === 1, '[N] CANCELLED 不触发 provider retry（仅 1 次尝试）', calls);
  }
  {
    // DeepSeek：预 abort → fetch 根本未发出
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return makeOkResponse();
    }) as unknown as typeof fetch;
    const provider = new DeepSeekProvider({apiKey: 'sk-test-dummy', fetchImpl});
    const controller = new AbortController();
    controller.abort();
    await expectLLMError(
      () =>
        provider.generate({
          model: 'm', system: 's', user: 'u', outputMode: 'text', thinking: 'disabled',
          signal: controller.signal,
        }),
      'CANCELLED',
      '[N] DeepSeek 预 abort → CANCELLED',
    );
    ok(calls === 0, '[N] 预 abort 时 fetch 未发出（0 次网络调用）', calls);
  }
  {
    // executor：首个请求进行中 abort → executor 停止，不产生 usage
    const controller = new AbortController();
    const before = usageRows().length;
    const pending = executeStageGeneration({
      db, provider: new MockLLMProvider({delayMs: 200}), stage: 'evidence',
      input: INPUT, projectId: 'test-m2b-cancel', env: {}, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expectLLMError(() => pending, 'CANCELLED', '[N] executor 请求中 abort → CANCELLED');
    ok(usageRows().length === before, '[N] 取消的请求无 Response → 不记 usage（0 行新增）');
  }
  {
    // executor：repair 途中 abort → 不继续 repair（CANCELLED 而非 VALIDATION_FAILED）
    const controller = new AbortController();
    // 首次 badJson 立即返回并记 usage；repair 请求人为拉长，期间 abort
    const slowRepair = new MockLLMProvider({badJson: 1});
    let calls2 = 0;
    const wrappedGenerate = slowRepair.generate.bind(slowRepair);
    slowRepair.generate = async (req) => {
      calls2++;
      if (calls2 >= 2) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new LLMError('CANCELLED', '请求已被用户取消'));
          }, {once: true});
        });
      }
      return wrappedGenerate(req);
    };
    const before = usageRows().length;
    const pending2 = executeStageGeneration({
      db, provider: slowRepair, stage: 'evidence',
      input: INPUT, projectId: 'test-m2b-cancel2', env: {}, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expectLLMError(() => pending2, 'CANCELLED', '[N] repair 途中 abort → CANCELLED（非 VALIDATION_FAILED）');
    ok(usageRows().length === before + 1, '[N] repair 取消：仅首次响应记 usage（repair 无响应不记）');
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2b'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M2-B 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M2-B LLM 层测试全部通过 ✅');
}

function url0(calls: CapturedCall[]): string {
  return calls[0]?.url ?? '';
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

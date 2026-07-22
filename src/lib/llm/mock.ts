/**
 * Mock LLM Provider（M2-B，M2 实施计划 §1.4）。
 *
 * - deterministic：输出 = f(阶段, 请求内容)，相同输入永远相同输出；无随机数/时间戳。
 * - 10 个阶段都有合法 fixture（Markdown/JSON 均过对应 zod schema）。
 * - 故障注入（仅测试显式构造）：badJson / badSchema / empty / truncated /
 *   providerError，按阶段独立计数，前 N 次注入后恢复合法输出。
 * - token usage 由请求/响应文本长度确定性推导，不产生真实 API 成本。
 * - 安全规则（production 禁用、未配置 fallback 告警）在 llm/index.ts 选择器实现。
 */

import {
  MOCK_BAD_JSON_TEXT,
  MOCK_BAD_SCHEMA_JSON,
  MOCK_FIXTURES,
} from '../prompts/fixtures';
import type {WorkflowStage} from '../workflow/types';
import {
  LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
} from './types';

export interface MockFailurePlan {
  /** 前 N 次调用返回不可解析文本。 */
  badJson?: number;
  /** 前 N 次调用返回合法 JSON 但不满足 schema。 */
  badSchema?: number;
  /** 前 N 次调用返回空文本。 */
  empty?: number;
  /** 前 N 次调用 finishReason='length'（截断）。 */
  truncated?: number;
  /** 所有调用直接抛出该错误。 */
  providerError?: LLMError;
}

/** FNV-1a 32bit → 8 位十六进制（确定性 requestId 用）。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function deterministicUsage(system: string, user: string, text: string, thinking: string): LLMUsage {
  const promptTokens = Math.ceil((system.length + user.length) / 4);
  const completionTokens = Math.max(Math.ceil(text.length / 4), 1);
  return {
    promptTokens,
    cacheHitTokens: 0,
    cacheMissTokens: promptTokens,
    completionTokens,
    reasoningTokens: thinking === 'enabled' ? Math.ceil(completionTokens / 2) : undefined,
  };
}

export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  private readonly plan: MockFailurePlan;
  /** 每阶段已调用次数（故障注入按阶段独立计数）。 */
  private readonly calls = new Map<string, number>();

  constructor(plan: MockFailurePlan = {}) {
    this.plan = plan;
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    if (this.plan.providerError) {
      return Promise.reject(this.plan.providerError);
    }

    const stage = (request.meta?.stage ?? 'unknown') as WorkflowStage | 'unknown';
    const callIndex = (this.calls.get(stage) ?? 0) + 1;
    this.calls.set(stage, callIndex);

    const fixture =
      stage === 'unknown'
        ? 'mock fixture（未知阶段）'
        : MOCK_FIXTURES[stage as WorkflowStage];

    // 故障注入：前 N 次按注入类型返回坏输出（一种计划一次只应配一类；
    // 若配置多类，按优先级 empty > truncated > badJson > badSchema 生效）。
    let text = fixture;
    let finishReason = 'stop';
    if ((this.plan.empty ?? 0) >= callIndex) {
      text = '';
    } else if ((this.plan.truncated ?? 0) >= callIndex) {
      text = fixture.slice(0, Math.max(Math.floor(fixture.length / 2), 1));
      finishReason = 'length';
    } else if ((this.plan.badJson ?? 0) >= callIndex) {
      text = MOCK_BAD_JSON_TEXT;
    } else if ((this.plan.badSchema ?? 0) >= callIndex) {
      text = MOCK_BAD_SCHEMA_JSON;
    }

    const response: LLMResponse = {
      text,
      requestId: `mock-${fnv1a(`${stage}|${request.system}|${request.user}|${callIndex}`)}`,
      model: request.model,
      finishReason,
      usage: deterministicUsage(request.system, request.user, text, request.thinking),
    };
    return Promise.resolve(response);
  }
}

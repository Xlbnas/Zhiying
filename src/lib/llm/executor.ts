/**
 * 阶段生成执行器（M2-B）。
 *
 * 管线：Prompt Registry → Stage Model Config → Provider.generate
 *       → record usage → parse → Zod validate → ≤2 次 repair → ValidatedStageResult。
 *
 * 铁律：
 * - 每个拿到 Provider Response 的请求立即记 llm_usage（含失败/截断），
 *   顺序必须是 Response → Record Usage → Parse/Validate；
 *   Transport 层没拿到 usage（HTTP 错误/无效响应/超时）则没有成本可记，不伪造。
 * - JSON 阶段：首次生成 + 最多 2 次 repair；repair 携带原始输出（截断）+
 *   精确 Zod issues（截断）+ schema 要求 + JSON ONLY；repair 每次独立记 usage。
 * - EMPTY_RESPONSE 可 recovery（同 prompt 重问，占 repair 次数）；
 *   finishReason='length' → OUTPUT_TRUNCATED，不做普通 repair。
 * - M2-B 边界：不写 project_versions / project_stages，不创建/消费 llm_jobs，
 *   不调用 workflow/operations（transaction 层冻结，M2-C 才接线）。
 */

import type {Db} from '../db';
import {getStagePrompt} from '../prompts/registry';
import type {StagePrompt, StagePromptInput} from '../prompts/shared';
import type {VersionSource, WorkflowStage} from '../workflow/types';
import {getStageModelConfig} from './stage-models';
import {clipText, LLMError, type LlmEnv, type LLMProvider, type LLMRequest, type LLMResponse} from './types';
import {recordLlmUsage} from './usage';

export interface ValidatedStageResult {
  stage: WorkflowStage;
  /** Markdown 原文，或 zod 校验后规范化的 JSON 字符串。 */
  content: string;
  contentType: 'markdown' | 'json';
  /** JSON 阶段：zod 解析后的对象（含 schema 默认值）。 */
  parsed?: unknown;
  provider: string;
  model: string;
  promptVersion: string;
  /** 实际发生的 repair 次数（0 = 首次即通过）。 */
  repairCount: number;
  /** 全部真实请求的 requestId（首次 + 每次 repair）。 */
  requestIds: string[];
  /** ai_generate = 首次通过；repair = 经 repair 通过（对齐 project_versions.source 枚举）。 */
  versionSource: VersionSource;
}

export interface ExecuteStageOptions {
  db: Db;
  provider: LLMProvider;
  stage: WorkflowStage;
  input: StagePromptInput;
  projectId?: string;
  jobId?: string;
  env?: LlmEnv;
  /** Worker graceful cancel：中断中/后续请求；取消不进入 repair。 */
  signal?: AbortSignal;
  /** 默认 2（含首次共最多 3 次真实请求）。 */
  maxRepairs?: number;
}

const MAX_OUTPUT_IN_REPAIR = 4000;
const MAX_ISSUES_IN_REPAIR = 2000;
const MAX_ISSUES_IN_ERROR = 10;

/** 宽松提取 JSON 文本：整段围栏则剥掉，其余原样（parse 失败走 repair，不硬猜）。 */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/m.exec(trimmed);
  if (fence && fence[1] !== undefined) {
    return fence[1].trim();
  }
  return trimmed;
}

function formatZodIssues(error: import('zod').ZodError): string {
  const issues = error.issues
    .slice(0, MAX_ISSUES_IN_ERROR)
    .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  const more =
    error.issues.length > MAX_ISSUES_IN_ERROR
      ? [`- …另有 ${error.issues.length - MAX_ISSUES_IN_ERROR} 个问题`]
      : [];
  return [...issues, ...more].join('\n');
}

function buildRepairUser(
  originalUser: string,
  badOutput: string,
  issues: string,
): string {
  return [
    originalUser,
    '【Repair】你上一次的输出未通过校验。请修正后重新输出完整结果。',
    '【校验问题（精确）】',
    clipText(issues, MAX_ISSUES_IN_REPAIR),
    '【你上一次的输出】',
    clipText(badOutput, MAX_OUTPUT_IN_REPAIR),
    '【要求】严格按 schema 输出 JSON ONLY：不要 Markdown 围栏，不要任何解释文字。',
  ].join('\n\n');
}

export async function executeStageGeneration(
  options: ExecuteStageOptions,
): Promise<ValidatedStageResult> {
  const {db, provider, stage, input} = options;
  const maxRepairs = options.maxRepairs ?? 2;
  if (maxRepairs < 0) {
    throw new LLMError('CONFIG_ERROR', `maxRepairs 非法: ${maxRepairs}`);
  }

  const prompt: StagePrompt = getStagePrompt(stage);
  const modelConfig = getStageModelConfig(stage, options.env);
  const isJson = prompt.outputKind === 'json';
  const schema = prompt.zodSchema;
  if (isJson && !schema) {
    throw new LLMError('CONFIG_ERROR', `JSON 阶段 ${stage} 缺少 zodSchema`);
  }

  const originalUser = prompt.buildUser(input);
  const requestIds: string[] = [];
  const maxAttempts = 1 + maxRepairs;
  let user = originalUser;
  let lastFailure = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      // 取消不进入 repair：即使上一次输出校验失败，也立即以 CANCELLED 结束。
      throw new LLMError('CANCELLED', `阶段 ${stage} 已被取消（第 ${attempt} 次尝试前）`);
    }
    const request: LLMRequest = {
      model: modelConfig.model,
      system: prompt.system,
      user,
      outputMode: isJson ? 'json' : 'text',
      thinking: modelConfig.thinking,
      reasoningEffort: modelConfig.reasoningEffort,
      maxTokens: modelConfig.maxTokens,
      signal: options.signal,
      meta: {stage},
    };

    // Transport 失败（HTTP/超时/无效响应）：无 usage 可记，错误原样上抛。
    const response: LLMResponse = await provider.generate(request);

    // 拿到真实 Response：先记 usage，再做任何解析/校验。
    requestIds.push(response.requestId);
    recordLlmUsage(db, {
      projectId: options.projectId ?? null,
      stage,
      jobId: options.jobId ?? null,
      requestId: response.requestId,
      provider: provider.name,
      model: response.model,
      usage: response.usage,
      promptVersion: prompt.promptVersion,
    });

    if (response.text.trim().length === 0) {
      // EMPTY_RESPONSE：可 recovery（占 repair 次数，同 prompt 重问）。
      lastFailure = 'EMPTY_RESPONSE';
      if (attempt < maxAttempts) continue;
      throw new LLMError(
        'EMPTY_RESPONSE',
        `阶段 ${stage} 第 ${attempt} 次请求仍返回空内容`,
      );
    }

    if (response.finishReason === 'length') {
      // 截断：不做普通 repair（需调大 maxTokens 或人工介入），usage 已记录。
      throw new LLMError(
        'OUTPUT_TRUNCATED',
        `阶段 ${stage} 输出被 maxTokens=${modelConfig.maxTokens} 截断（finishReason=length）`,
      );
    }

    if (!isJson) {
      return {
        stage,
        content: response.text,
        contentType: 'markdown',
        provider: provider.name,
        model: response.model,
        promptVersion: prompt.promptVersion,
        repairCount: attempt - 1,
        requestIds,
        versionSource: attempt === 1 ? 'ai_generate' : 'repair',
      };
    }

    // JSON 阶段：parse → zod。
    const candidate = extractJsonText(response.text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      lastFailure = `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`;
      if (attempt === maxAttempts) {
        throw new LLMError(
          'VALIDATION_FAILED',
          `阶段 ${stage} 经 ${maxRepairs} 次 repair 仍失败。${lastFailure}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    const safe = schema!.safeParse(parsed);
    if (safe.success) {
      return {
        stage,
        content: JSON.stringify(safe.data),
        contentType: 'json',
        parsed: safe.data,
        provider: provider.name,
        model: response.model,
        promptVersion: prompt.promptVersion,
        repairCount: attempt - 1,
        requestIds,
        versionSource: attempt === 1 ? 'ai_generate' : 'repair',
      };
    }

    lastFailure = `Zod 校验失败：\n${formatZodIssues(safe.error)}`;
    if (attempt === maxAttempts) {
      throw new LLMError(
        'VALIDATION_FAILED',
        `阶段 ${stage} 经 ${maxRepairs} 次 repair 仍失败。\n${clipText(lastFailure, MAX_ISSUES_IN_REPAIR)}`,
      );
    }
    user = buildRepairUser(originalUser, response.text, lastFailure);
  }

  // 不可达（循环必然 return/throw），仅为类型收敛。
  throw new LLMError('VALIDATION_FAILED', `阶段 ${stage} 未知失败：${lastFailure}`);
}

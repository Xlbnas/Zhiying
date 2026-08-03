/**
 * TTS-B Narration Performance Plan LLM generation（设计文档 §7；沿用 M7.2.1 attempt
 * journal 与 visual-sequences 生成模式）。
 *
 * 流程：proposal → JSON/schema parse → deterministic semantic validation
 *       → 最多 2 次 repair → final validation。
 * 铁律：repair 只传机器可读 validator issues + 上一次输出（截断），不拿 raw script
 * 重新自由生成；LLM 输出只允许 {items}（禁止 source/hash/artifact ID/路径/文本副本/
 * provider payload/timing/job ID）；服务端负责 source wrapper/hash/版本/commit。
 */

import type {Db} from '../db';
import {
  insertAttemptInFlight,
  refreshRunLease,
  sha256Text,
  updateAttempt,
} from '../llm-generation/runs';
import {extractJsonText} from '../llm/executor';
import {DEEPSEEK_FLASH} from '../llm/stage-models';
import {clipText, LLMError, type LLMProvider, type LLMRequest} from '../llm/types';
import {recordLlmUsage} from '../llm/usage';
import type {NarrationPlanV2} from '../narration/schema-v2';
import {
  NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION,
  PERFORMANCE_USAGE_STAGE,
} from './constants';
import {
  performanceItemsProposalSchema,
  type PerformanceItemV1,
} from './performance-schema';
import {
  hasBlockingPerformanceIssues,
  validatePerformanceItems,
  type PerformanceValidationIssue,
} from './performance-validate';

const MAX_REPAIRS = 2;
const MAX_OUTPUT_IN_REPAIR = 4000;
const MAX_ISSUES_IN_REPAIR = 2000;

export const PERFORMANCE_SYSTEM_PROMPT = [
  '你是旁白表演导演，为脚本的每个旁白句生成表演建议（performance items）。',
  '输入：Narration Plan 每个 SpeechUnit 的 id / spokenText / 原 delivery / chapter。',
  '输出：JSON ONLY，格式：{"items":[{"unitId":"N001","deliveryOverride":"normal|slow|fast|soft|firm|emphasis|null","pace":"slow|normal|fast","energy":"low|normal|high","emotion":{"mode":"none"}}]}',
  '规则：每个 SpeechUnit 恰好一个 item，顺序与输入一致；SilenceUnit 不输出；',
  '禁止输出任何 source/hash/artifact id/路径/文本副本/provider 参数/timing/job id。',
  '不要 Markdown 围栏，不要任何解释文字。',
].join('\n');

export interface PerformanceGenerationResult {
  items: PerformanceItemV1[];
  provider: string;
  model: string;
  attemptCount: number;
  providerRequestIds: string[];
}

export interface PerformancePlannerInput {
  plan: NarrationPlanV2;
  /** exact voice descriptor 的非路径元数据（profileId/revisionId/duration/sha 摘要）。 */
  voice: {
    voiceProfileId: string;
    voiceProfileRevisionId: string;
    durationMs: number | null;
    canonicalAudioSha256: string;
  };
}

export function buildPerformanceUserPrompt(input: PerformancePlannerInput): string {
  const speech = input.plan.units
    .filter((u) => u.kind === 'speech')
    .map((u) => `- N${u.id.slice(1)}: [chapter ${u.chapter}] [delivery=${u.delivery}] ${u.spokenText}`);
  return [
    `Voice: ${input.voice.voiceProfileId}@${input.voice.voiceProfileRevisionId} ` +
      `(durationMs=${input.voice.durationMs ?? 'unknown'}, sha=${input.voice.canonicalAudioSha256.slice(0, 12)})`,
    'SpeechUnits:',
    speech.join('\n'),
  ].join('\n\n');
}

function formatIssues(issues: PerformanceValidationIssue[]): string {
  return issues
    .slice(0, 10)
    .map((issue) => `- [${issue.code}] ${issue.message}`)
    .join('\n');
}

function buildRepairUser(originalUser: string, badOutput: string, issues: string): string {
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

export async function generateNarrationPerformancePlan(options: {
  db: Db;
  provider: LLMProvider;
  plan: NarrationPlanV2;
  voice: PerformancePlannerInput['voice'];
  projectId: string;
  /** 调用方幂等键：写入 llm_usage.job_id。 */
  requestId: string;
  runId: string;
  ownerToken: string;
  signal?: AbortSignal;
}): Promise<PerformanceGenerationResult> {
  const {db, provider, plan, voice} = options;
  const originalUser = buildPerformanceUserPrompt({plan, voice});
  const maxAttempts = 1 + MAX_REPAIRS;
  const providerRequestIds: string[] = [];
  let user = originalUser;
  let lastFailure = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new LLMError('CANCELLED', `narration performance 已被取消（第 ${attempt} 次尝试前）`);
    }
    refreshRunLease(db, options.runId, options.ownerToken);

    const request: LLMRequest = {
      model: DEEPSEEK_FLASH,
      system: PERFORMANCE_SYSTEM_PROMPT,
      user,
      outputMode: 'json',
      thinking: 'disabled',
      maxTokens: 8192,
      signal: options.signal,
      meta: {stage: PERFORMANCE_USAGE_STAGE},
    };

    const requestJson = JSON.stringify({
      model: request.model,
      system: request.system,
      user: request.user,
      outputMode: request.outputMode,
      thinking: request.thinking,
      maxTokens: request.maxTokens,
    });
    const attemptId = insertAttemptInFlight(db, {
      runId: options.runId,
      attemptNumber: attempt,
      provider: provider.name,
      model: request.model,
      requestHash: sha256Text(`${request.system}\n${request.user}`),
      requestJson,
    });

    let response;
    try {
      response = await provider.generate(request);
    } catch (err) {
      updateAttempt(db, attemptId, {status: 'transport_failed'});
      throw err;
    }

    providerRequestIds.push(response.requestId);
    const responseHash = sha256Text(response.text);
    const usageTx = db.transaction(() => {
      const usageRecord = recordLlmUsage(db, {
        projectId: options.projectId,
        stage: PERFORMANCE_USAGE_STAGE,
        jobId: options.requestId,
        requestId: response.requestId,
        provider: provider.name,
        model: response.model,
        usage: response.usage,
        promptVersion: NARRATION_PERFORMANCE_PLAN_PROMPT_VERSION,
      });
      updateAttempt(db, attemptId, {
        status: 'response_received',
        providerRequestId: response.requestId,
        responseHash,
        responseText: response.text,
        finishReason: response.finishReason,
        usageRecordId: usageRecord.id,
      });
    });
    usageTx.immediate();

    if (response.text.trim().length === 0) {
      lastFailure = 'EMPTY_RESPONSE';
      updateAttempt(db, attemptId, {
        status: 'validation_failed',
        semanticIssuesJson: JSON.stringify([{code: 'EMPTY_RESPONSE', message: 'provider 返回空内容'}]),
      });
      if (attempt < maxAttempts) continue;
      throw new LLMError('EMPTY_RESPONSE', `narration performance 第 ${attempt} 次请求仍返回空内容`);
    }
    if (response.finishReason === 'length') {
      updateAttempt(db, attemptId, {
        status: 'validation_failed',
        semanticIssuesJson: JSON.stringify([
          {code: 'OUTPUT_TRUNCATED', message: 'finishReason=length（maxTokens=8192 截断）'},
        ]),
      });
      throw new LLMError(
        'OUTPUT_TRUNCATED',
        'narration performance 输出被 maxTokens=8192 截断（finishReason=length）',
      );
    }

    const candidateText = extractJsonText(response.text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateText);
    } catch (err) {
      lastFailure = `JSON 解析失败：${err instanceof Error ? err.message : String(err)}`;
      updateAttempt(db, attemptId, {
        status: 'validation_failed',
        parseResult: 'fail',
        schemaIssuesJson: JSON.stringify([{code: 'JSON_PARSE', message: lastFailure}]),
      });
      if (attempt === maxAttempts) {
        throw new LLMError(
          'VALIDATION_FAILED',
          `narration performance 经 ${MAX_REPAIRS} 次 repair 仍失败。${lastFailure}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    const safe = performanceItemsProposalSchema.safeParse(parsed);
    if (!safe.success) {
      const zodIssues = safe.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      }));
      lastFailure = `Zod 校验失败：${zodIssues.map((i) => `- ${i.path}: ${i.message}`).join('\n')}`;
      updateAttempt(db, attemptId, {
        status: 'validation_failed',
        parseResult: 'fail',
        schemaIssuesJson: JSON.stringify(zodIssues),
      });
      if (attempt === maxAttempts) {
        throw new LLMError(
          'VALIDATION_FAILED',
          `narration performance 经 ${MAX_REPAIRS} 次 repair 仍失败。\n${clipText(lastFailure, MAX_ISSUES_IN_REPAIR)}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    // deterministic semantic validation（exact coverage/顺序/重复/非 speech/forbidden）
    const semanticIssues = validatePerformanceItems(plan, safe.data.items);
    if (hasBlockingPerformanceIssues(semanticIssues)) {
      lastFailure = `语义校验失败：\n${formatIssues(semanticIssues)}`;
      updateAttempt(db, attemptId, {
        status: 'validation_failed',
        parseResult: 'pass',
        semanticIssuesJson: JSON.stringify(
          semanticIssues.map((i) => ({code: i.code, message: i.message, unitId: i.unitId})),
        ),
      });
      if (attempt === maxAttempts) {
        throw new LLMError(
          'VALIDATION_FAILED',
          `narration performance 经 ${MAX_REPAIRS} 次 repair 仍失败。\n${clipText(lastFailure, MAX_ISSUES_IN_REPAIR)}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    updateAttempt(db, attemptId, {status: 'succeeded', parseResult: 'pass'});
    return {
      items: safe.data.items,
      provider: provider.name,
      model: response.model,
      attemptCount: attempt,
      providerRequestIds,
    };
  }

  throw new LLMError('VALIDATION_FAILED', `narration performance 未知失败：${lastFailure}`);
}

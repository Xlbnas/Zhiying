/**
 * Narrative Beats LLM generation（M7.2 §九 / M7.2.1 attempt journal）。
 *
 * 流程：proposal → JSON/schema parse → deterministic semantic validation
 *       → 最多 2 次 repair → final validation。
 *
 * 铁律（沿用 llm/executor 已验证语义）：
 * - 每个拿到 Provider Response 的请求立即记 llm_usage（含失败）；
 *   Transport 层没拿到 usage 则不记（不伪造成本）。
 * - repair prompt 携带精确 validation errors + 上一次输出（截断）；
 *   repair 不得拿 raw script 重新自由生成（user 始终是同一 projection prompt
 *   加上 repair 段）。
 * - 最多 2 次 repair（共最多 3 次真实请求）；仍失败 → VALIDATION_FAILED，
 *   本次 generation 失败，不保存 artifact。
 * - deterministic normalization 仅限 JSON 围栏剥离与首尾空白
 *   （extractJsonText）；禁止自动重编号/补 unit/去重/改 role/合并 beat。
 *
 * M7.2.1：每次 provider 请求写入 generation_attempts journal（append-only）：
 * - 调用前：in_flight 行（安全 request 投影 + hash，绝无 header/secret）；
 * - response 到达：usage 写入与 attempt 更新在同一 DB 事务内完成，
 *   attempt.usage_record_id 精确关联 llm_usage.id；
 * - validation 失败：parse/schema/semantic issues 完整落行；
 * - transport 失败：transport_failed；进程崩溃遗留 in_flight 随 run 租约
 *   过期转 indeterminate（runs.ts claim 路径处理）。
 */

import type {Db} from '../db';
import {extractJsonText} from '../llm/executor';
import {DEEPSEEK_FLASH} from '../llm/stage-models';
import {clipText, LLMError, type LLMProvider, type LLMRequest} from '../llm/types';
import {recordLlmUsage} from '../llm/usage';
import type {NarrationPlanV2} from '../narration/schema-v2';
import {BEATS_SYSTEM_PROMPT, buildBeatsUserPrompt} from './prompt';
import {buildBeatPlannerInput} from './projection';
import {
  insertAttemptInFlight,
  refreshRunLease,
  sha256Text,
  updateAttempt,
} from './runs';
import {
  NARRATIVE_BEATS_PROMPT_VERSION,
  narrativeBeatsProposalSchema,
  type NarrativeBeatV1,
} from './schema';
import {validateNarrativeBeatsCoverage, type BeatValidationIssue} from './validate';

/** usage 记录的 stage 标签（自由文本列；与 M2 workflow 阶段区分）。 */
export const BEATS_USAGE_STAGE = 'm7_narrative_beats';

const MAX_REPAIRS = 2;
const MAX_OUTPUT_IN_REPAIR = 4000;
const MAX_ISSUES_IN_REPAIR = 2000;

export interface BeatGenerationResult {
  beats: NarrativeBeatV1[];
  provider: string;
  model: string;
  /** 真实 LLM 请求次数（1 = 首次即通过）。 */
  attemptCount: number;
  /** 全部真实请求的 provider requestId（首次 + 每次 repair）。 */
  providerRequestIds: string[];
}

function formatIssues(issues: BeatValidationIssue[]): string {
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

export async function generateNarrativeBeats(options: {
  db: Db;
  provider: LLMProvider;
  plan: NarrationPlanV2;
  projectId: string;
  /** 调用方幂等键：写入 llm_usage.job_id 以便审计/对账。 */
  requestId: string;
  /** M7.2.1：durable run 标识（attempt journal 归属 + 租约刷新）。 */
  runId: string;
  ownerToken: string;
  signal?: AbortSignal;
}): Promise<BeatGenerationResult> {
  const {db, provider, plan} = options;
  const plannerInput = buildBeatPlannerInput(plan);
  const originalUser = buildBeatsUserPrompt(plannerInput);
  const maxAttempts = 1 + MAX_REPAIRS;
  const providerRequestIds: string[] = [];
  let user = originalUser;
  let lastFailure = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new LLMError('CANCELLED', `narrative beats 已被取消（第 ${attempt} 次尝试前）`);
    }
    // 每个 attempt 开始前刷新 run 租约（校验 owner）。
    refreshRunLease(db, options.runId, options.ownerToken);

    const request: LLMRequest = {
      model: DEEPSEEK_FLASH,
      system: BEATS_SYSTEM_PROMPT,
      user,
      outputMode: 'json',
      thinking: 'disabled',
      maxTokens: 8192,
      signal: options.signal,
      meta: {stage: BEATS_USAGE_STAGE},
    };

    // journal：调用前 in_flight 行（安全投影——只含实际发送的
    // model/system/user/outputMode/thinking/maxTokens，绝无 header/secret）。
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

    // Transport 失败：无 usage 可记，attempt 转 transport_failed，错误原样上抛。
    let response;
    try {
      response = await provider.generate(request);
    } catch (err) {
      updateAttempt(db, attemptId, {status: 'transport_failed'});
      throw err;
    }

    // 拿到真实 Response：usage 写入与 attempt 更新在同一 DB 事务内完成。
    providerRequestIds.push(response.requestId);
    const responseHash = sha256Text(response.text);
    const usageTx = db.transaction(() => {
      const usageRecord = recordLlmUsage(db, {
        projectId: options.projectId,
        stage: BEATS_USAGE_STAGE,
        jobId: options.requestId,
        requestId: response.requestId,
        provider: provider.name,
        model: response.model,
        usage: response.usage,
        promptVersion: NARRATIVE_BEATS_PROMPT_VERSION,
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
      throw new LLMError('EMPTY_RESPONSE', `narrative beats 第 ${attempt} 次请求仍返回空内容`);
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
        'narrative beats 输出被 maxTokens=8192 截断（finishReason=length）',
      );
    }

    // parse → zod（LLM 输出契约）
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
        throw new LLMError('VALIDATION_FAILED', `narrative beats 经 ${MAX_REPAIRS} 次 repair 仍失败。${lastFailure}`);
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    const safe = narrativeBeatsProposalSchema.safeParse(parsed);
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
          `narrative beats 经 ${MAX_REPAIRS} 次 repair 仍失败。\n${clipText(lastFailure, MAX_ISSUES_IN_REPAIR)}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    // deterministic semantic validation（覆盖/顺序/chapter/role/泄漏）
    const semanticIssues = validateNarrativeBeatsCoverage(plan, safe.data.beats);
    if (semanticIssues.length > 0) {
      lastFailure = `语义校验失败：\n${formatIssues(semanticIssues)}`;
      updateAttempt(db, attemptId, {
        status: 'validation_failed',
        parseResult: 'pass',
        semanticIssuesJson: JSON.stringify(
          semanticIssues.map((i) => ({code: i.code, message: i.message})),
        ),
      });
      if (attempt === maxAttempts) {
        throw new LLMError(
          'VALIDATION_FAILED',
          `narrative beats 经 ${MAX_REPAIRS} 次 repair 仍失败。\n${clipText(lastFailure, MAX_ISSUES_IN_REPAIR)}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    updateAttempt(db, attemptId, {status: 'succeeded', parseResult: 'pass'});
    return {
      beats: safe.data.beats,
      provider: provider.name,
      model: response.model,
      attemptCount: attempt,
      providerRequestIds,
    };
  }

  throw new LLMError('VALIDATION_FAILED', `narrative beats 未知失败：${lastFailure}`);
}

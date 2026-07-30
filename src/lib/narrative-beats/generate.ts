/**
 * Narrative Beats LLM generation（M7.2 §九）。
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

    // Transport 失败：无 usage 可记，错误原样上抛。
    const response = await provider.generate(request);

    // 拿到真实 Response：先记 usage，再做任何解析/校验。
    providerRequestIds.push(response.requestId);
    recordLlmUsage(db, {
      projectId: options.projectId,
      stage: BEATS_USAGE_STAGE,
      jobId: options.requestId,
      requestId: response.requestId,
      provider: provider.name,
      model: response.model,
      usage: response.usage,
      promptVersion: NARRATIVE_BEATS_PROMPT_VERSION,
    });

    if (response.text.trim().length === 0) {
      lastFailure = 'EMPTY_RESPONSE';
      if (attempt < maxAttempts) continue;
      throw new LLMError('EMPTY_RESPONSE', `narrative beats 第 ${attempt} 次请求仍返回空内容`);
    }
    if (response.finishReason === 'length') {
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
      if (attempt === maxAttempts) {
        throw new LLMError('VALIDATION_FAILED', `narrative beats 经 ${MAX_REPAIRS} 次 repair 仍失败。${lastFailure}`);
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

    const safe = narrativeBeatsProposalSchema.safeParse(parsed);
    if (!safe.success) {
      lastFailure = `Zod 校验失败：${safe.error.issues
        .slice(0, 10)
        .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`;
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
      if (attempt === maxAttempts) {
        throw new LLMError(
          'VALIDATION_FAILED',
          `narrative beats 经 ${MAX_REPAIRS} 次 repair 仍失败。\n${clipText(lastFailure, MAX_ISSUES_IN_REPAIR)}`,
        );
      }
      user = buildRepairUser(originalUser, response.text, lastFailure);
      continue;
    }

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

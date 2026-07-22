/**
 * llm_usage 记录器（M2-B，架构 §6.2）。
 *
 * 规则：
 * - 每个真正拿到 Provider Response 的请求立即记录（含校验失败/截断的请求）。
 * - Repair 请求是新的真实请求，每次独立成行。
 * - 单价与成本在写入当时快照（pricing.ts），历史行禁止按未来价格重算。
 * - Transport 层没拿到 usage 时不调用本模块——不伪造成本。
 * - 禁止 DB migration：只 INSERT 现有 llm_usage 表。
 */

import {randomUUID} from 'node:crypto';
import type {Db} from '../db';
import {computeCostCny, PRICE_CHECKED_AT, PRICE_TABLE_VERSION} from './pricing';
import type {LLMUsage} from './types';

export interface UsageRecordInput {
  projectId?: string | null;
  stage?: string | null;
  jobId?: string | null;
  requestId: string;
  provider: string;
  model: string;
  usage: LLMUsage;
  promptVersion: string;
}

export interface UsageRecordResult {
  id: string;
  costCny: number;
  priceTableVersion: string;
  priceCheckedAt: string;
}

export function recordLlmUsage(db: Db, input: UsageRecordInput): UsageRecordResult {
  const {costCny, price} = computeCostCny(input.model, input.usage);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO llm_usage (
       id, project_id, stage, job_id, request_id,
       provider, model,
       input_tokens, cached_tokens, output_tokens,
       price_cache_hit_per_m, price_cache_miss_per_m, price_output_per_m,
       cost_cny, prompt_version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId ?? null,
    input.stage ?? null,
    input.jobId ?? null,
    input.requestId,
    input.provider,
    input.model,
    input.usage.promptTokens,
    input.usage.cacheHitTokens,
    input.usage.completionTokens,
    price.cacheHitPerM,
    price.cacheMissPerM,
    price.outputPerM,
    costCny,
    input.promptVersion,
    new Date().toISOString(),
  );
  return {
    id,
    costCny,
    priceTableVersion: PRICE_TABLE_VERSION,
    priceCheckedAt: PRICE_CHECKED_AT,
  };
}

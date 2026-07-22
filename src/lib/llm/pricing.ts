/**
 * DeepSeek 官方人民币定价快照（M2-B）。
 *
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 核对日期：2026-07-22（执行当天官方文档，单位：元 / 百万 tokens）
 *   deepseek-v4-flash：缓存命中 0.02 / 缓存未命中 1 / 输出 2
 *   deepseek-v4-pro：  缓存命中 0.025 / 缓存未命中 3 / 输出 6
 * 注：deepseek-chat / deepseek-reasoner 将于 2026-07-24 弃用，不纳入价目表。
 *
 * 历史 usage 永远按调用当时的单价快照结算，禁止用未来价格重算。
 */

import {LLMError, type LLMUsage} from './types';

export const PRICE_TABLE_VERSION = 'deepseek-cny-2026-07-22';
export const PRICE_CHECKED_AT = '2026-07-22';

export interface ModelPrice {
  /** 元 / 百万 tokens（缓存命中输入）。 */
  cacheHitPerM: number;
  /** 元 / 百万 tokens（缓存未命中输入）。 */
  cacheMissPerM: number;
  /** 元 / 百万 tokens（输出，含 reasoning）。 */
  outputPerM: number;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'deepseek-v4-flash': {cacheHitPerM: 0.02, cacheMissPerM: 1, outputPerM: 2},
  'deepseek-v4-pro': {cacheHitPerM: 0.025, cacheMissPerM: 3, outputPerM: 6},
};

const MILLION = 1_000_000;

/**
 * 成本公式：
 *   cacheHitTokens × hit 单价 + cacheMissTokens × miss 单价 + completionTokens × output 单价
 * reasoningTokens 已包含在 completionTokens 中，不得重复计费（此处显式忽略）。
 */
export function computeCostCny(
  model: string,
  usage: Pick<LLMUsage, 'cacheHitTokens' | 'cacheMissTokens' | 'completionTokens'>,
): {costCny: number; price: ModelPrice} {
  const price = PRICE_TABLE[model];
  if (!price) {
    throw new LLMError(
      'CONFIG_ERROR',
      `价目表 ${PRICE_TABLE_VERSION} 中不存在模型 "${model}" 的人民币定价，拒绝估算成本`,
    );
  }
  const costCny =
    (usage.cacheHitTokens * price.cacheHitPerM +
      usage.cacheMissTokens * price.cacheMissPerM +
      usage.completionTokens * price.outputPerM) /
    MILLION;
  return {costCny, price};
}

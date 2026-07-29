/**
 * APIYi 图像生成人民币定价快照（M6.3.10）。
 *
 * 来源：API易文档中心 Nano Banana 2（= gemini-3.1-flash-image）上线公告
 *   https://docs.apiyi.com/news/nano-banana-2-launch
 *   https://docs.apiyi.com/news/gemini-3-1-flash-lite-image-launch
 * 核对日期：2026-07-29
 *   按次计费（per-call）：$0.025 / 次（1K）
 *   按量计费（token-based）：输入 $0.10 / 1M tokens，输出 $12.00 / 1M tokens
 * 计费模式由 APIYi 令牌的「Billing model」设置决定；provider response 不返回
 * 账单金额，因此本表属于 configured_estimate。每个 usage event 同时记录
 * usageMetadata token 数与写入当时的 unitPrice，供事后对账，禁止用未来价格重算。
 *
 * 汇率快照：1 USD = 7.2 CNY（2026-07-29；项目无实时汇率，与 LLM 价目表同口径）。
 *   $0.025 × 7.2 = ¥0.18 / 张（1K）
 *
 * 若 APIYi 令牌实际为按量计费：更新本表数值并 bump IMAGE_PRICE_TABLE_VERSION，
 * 历史 event 不受影响（cost/unitPrice 已随 event 落库）。
 */

export const IMAGE_PRICE_TABLE_VERSION = 'apiyi-image-cny-2026-07-29';
export const IMAGE_PRICE_CHECKED_AT = '2026-07-29';

export interface ImageModelPrice {
  /** 元 / 张（按次计费口径）。 */
  perImageCny: number;
}

/** key：`${provider}:${model}:${size}`。未知 key 一律 fail-closed，拒绝估算。 */
export const IMAGE_PRICE_TABLE: Readonly<Record<string, ImageModelPrice>> = {
  'apiyi:gemini-3.1-flash-image:1K': {perImageCny: 0.18},
};

export class ImagePricingError extends Error {
  readonly code = 'CONFIG_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ImagePricingError';
  }
}

export function imagePriceKey(provider: string, model: string, size: string): string {
  return `${provider}:${model}:${size}`;
}

/**
 * 成本公式：imageCount × perImageCny。
 * 一次 provider 调用产出 N 张图即产生 N 张计费（含未被采用/未绑定的 candidate）。
 */
export function computeImageCostCny(input: {
  provider: string;
  model: string;
  size: string;
  imageCount: number;
}): {costCny: number; unitPriceCny: number; priceKey: string} {
  const priceKey = imagePriceKey(input.provider, input.model, input.size);
  const price = IMAGE_PRICE_TABLE[priceKey];
  if (!price) {
    throw new ImagePricingError(
      `图像价目表 ${IMAGE_PRICE_TABLE_VERSION} 中不存在 "${priceKey}" 的人民币定价，拒绝估算成本`,
    );
  }
  return {costCny: price.perImageCny * input.imageCount, unitPriceCny: price.perImageCny, priceKey};
}

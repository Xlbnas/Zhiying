/**
 * TTS-B Narration Performance Plan deterministic semantic validation（设计文档 §6）。
 *
 * 输入：exact Narration Plan V2（SpeechUnit 序列）+ items。
 * 铁律：validator 不自动排序、不自动改写枚举；SilenceUnit 不得进入 items；
 * forbidden 字段 hard-fail（zod strict unknown-key + 显式语义检查）。
 */
import type {NarrationPlanV2} from '../narration/schema-v2';
import type {PerformanceItemV1} from './performance-schema';

export type PerformanceIssueCode =
  | 'PERFORMANCE_UNIT_COVERAGE_GAP'
  | 'PERFORMANCE_UNIT_DUPLICATE'
  | 'PERFORMANCE_UNIT_ORDER_MISMATCH'
  | 'PERFORMANCE_NON_SPEECH_UNIT'
  | 'PERFORMANCE_UNIT_NOT_FOUND'
  | 'PERFORMANCE_DELIVERY_INVALID'
  | 'PERFORMANCE_PACE_INVALID'
  | 'PERFORMANCE_ENERGY_INVALID'
  | 'PERFORMANCE_EMOTION_INVALID'
  | 'PERFORMANCE_FORBIDDEN_FIELD'
  | 'PERFORMANCE_SOURCE_MISMATCH'
  | 'PERFORMANCE_VOICE_UNUSABLE'
  // 预留（TTS-C provider capability compile；本轮不自动 emit）
  | 'PERFORMANCE_PROVIDER_CAPABILITY_UNRESOLVED'
  | 'PERFORMANCE_NEEDS_REVIEW';

export interface PerformanceValidationIssue {
  code: PerformanceIssueCode;
  unitId?: string;
  message: string;
}

/** forbidden 字段（TTS-B 语义层显式检查，zod strict 兜底 unknown-key）。 */
const FORBIDDEN_ITEM_KEYS = [
  'spokenText',
  'subtitleText',
  'sourceText',
  'evidenceIds',
  'pauseDurationMs',
  'startMs',
  'endMs',
  'durationMs',
  'frames',
  'audioPath',
  'outputPath',
  'ttsJobId',
  'providerPayload',
  'synthesisParameters',
] as const;

/**
 * 校验 items 是否精确覆盖 exact Narration Plan 的全部 SpeechUnit：
 * - 只允许 SpeechUnit（SilenceUnit 不得出现，缺失覆盖按 coverage gap 处理）；
 * - 每个 exact SpeechUnit 恰好一个 item（缺失 → coverage gap；重复 → duplicate；
 *   items 引用不存在的 unit → unit_not_found）；
 * - 顺序必须与 SpeechUnit 顺序逐项一致（order mismatch）；
 * - forbidden 字段显式 hard-fail。
 */
export function validatePerformanceItems(
  plan: NarrationPlanV2,
  items: PerformanceItemV1[],
): PerformanceValidationIssue[] {
  const issues: PerformanceValidationIssue[] = [];

  const speechUnits = plan.units.filter((u) => u.kind === 'speech');
  const expectedOrder = speechUnits.map((u) => u.id);

  // forbidden 字段（显式语义检查；LLM 若输出这些键，zod strict 已在 parse 层拒绝，
  // 此处是防御性二次检查——可对「手工构造的 item 对象」独立生效）
  for (const item of items) {
    const keys = Object.keys(item as unknown as Record<string, unknown>);
    for (const key of keys) {
      if ((FORBIDDEN_ITEM_KEYS as readonly string[]).includes(key)) {
        issues.push({
          code: 'PERFORMANCE_FORBIDDEN_FIELD',
          unitId: item.unitId,
          message: `item ${item.unitId} 含 forbidden 字段 ${key}`,
        });
      }
    }
  }

  const seen = new Set<string>();
  const expectedSet = new Set(expectedOrder);
  let expectedIndex = 0;
  for (const item of items) {
    if (seen.has(item.unitId)) {
      issues.push({
        code: 'PERFORMANCE_UNIT_DUPLICATE',
        unitId: item.unitId,
        message: `unitId ${item.unitId} 出现多次`,
      });
      continue;
    }
    seen.add(item.unitId);
    if (!expectedSet.has(item.unitId)) {
      issues.push({
        code: 'PERFORMANCE_UNIT_NOT_FOUND',
        unitId: item.unitId,
        message: `item 引用不存在的 unit ${item.unitId}`,
      });
      continue;
    }
    // 顺序：与 SpeechUnit 顺序逐项一致（SilenceUnit 不出现在 items——它不在 expectedOrder）
    const expected = expectedOrder[expectedIndex];
    if (item.unitId !== expected) {
      issues.push({
        code: 'PERFORMANCE_UNIT_ORDER_MISMATCH',
        unitId: item.unitId,
        message: `item 顺序错误：第 ${expectedIndex + 1} 个应为 ${expected}（实际 ${item.unitId}）`,
      });
    }
    expectedIndex++;
  }

  // 覆盖缺口：expected 中未出现 或 顺序错位导致未消耗（SilenceUnit 不允许出现在 items）
  for (let i = 0; i < expectedOrder.length; i++) {
    const id = expectedOrder[i]!;
    if (!seen.has(id)) {
      issues.push({
        code: 'PERFORMANCE_UNIT_COVERAGE_GAP',
        unitId: id,
        message: `SpeechUnit ${id} 缺少 performance item`,
      });
    }
  }
  // SilenceUnit 不得进入 items（若被显式传入——正常 items 无 silence id）
  const silenceIds = new Set(
    plan.units.filter((u) => u.kind === 'silence').map((u) => u.id),
  );
  for (const item of items) {
    if (silenceIds.has(item.unitId)) {
      issues.push({
        code: 'PERFORMANCE_NON_SPEECH_UNIT',
        unitId: item.unitId,
        message: `SilenceUnit ${item.unitId} 不得出现在 performance items`,
      });
    }
  }

  return issues;
}

/** 是否存在 blocking issue（本轮所有 semantic issue 均 blocking；无非阻断 code）。 */
export function hasBlockingPerformanceIssues(issues: PerformanceValidationIssue[]): boolean {
  return issues.length > 0;
}

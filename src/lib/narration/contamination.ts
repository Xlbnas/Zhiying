/**
 * Narration Plan 污染状态（M7.2.1 P0 hotfix 后续 UX 闭环）。
 *
 * 定位：audio overview / UI 共用的「blocked_contaminated」判定与恢复指引。
 * 判定复用统一 leakage validator（findDirectiveLeakage），不复制任何新 regex。
 * 本模块为纯函数（无 db 依赖），可同时被服务端（audio.ts）与
 * 客户端组件（NarrationPanel.tsx）安全引用。
 */
import {describeLeakage, findDirectiveLeakage} from './leakage';
import type {NarrationPlan} from './schema';

/** 污染 unit 的对外摘要：只给 unit ID + token 摘要，不返回完整正文。 */
export interface PlanContaminationUnit {
  unitId: string;
  /** describeLeakage 摘要（kind + 截断 token，≤ 数十字符）。 */
  summary: string;
}

export interface PlanContamination {
  unitCount: number;
  units: PlanContaminationUnit[];
  recoveryRequired: true;
  recoverySteps: string[];
}

/** 恢复步骤（UI 展示 + API 返回共用，避免双真相）。 */
export const CONTAMINATION_RECOVERY_STEPS: readonly string[] = [
  '重新生成 Script V2（使用 M6 prompt，不含控制指令）',
  '审核并锁定新的 Script V2 版本',
  '重建 Narration Plan（生成 append-only 新版本）',
  '确认旁白文本干净（无 @delivery/@pause/@silence 等控制指令）',
  '重新生成配音',
];

/**
 * 检测 Narration Plan 的 speech unit 是否含导演指令/DSL 语法位。
 * 全部 speech unit 扫描，返回全部污染 unit（不只前 N 个）；
 * 干净 plan 返回 null。正常语义（如「他停顿了一下」）不误杀——
 * 由 findDirectiveLeakage 的语法位识别保证（leakage.ts 测试锁定）。
 */
export function detectPlanContamination(plan: NarrationPlan): PlanContamination | null {
  const units: PlanContaminationUnit[] = [];
  for (const unit of plan.units) {
    if (unit.kind !== 'speech' || !unit.text) continue;
    const leaks = findDirectiveLeakage(unit.text);
    if (leaks.length > 0) {
      units.push({unitId: unit.id, summary: describeLeakage(leaks)});
    }
  }
  if (units.length === 0) return null;
  return {
    unitCount: units.length,
    units,
    recoveryRequired: true,
    recoverySteps: [...CONTAMINATION_RECOVERY_STEPS],
  };
}

/**
 * 是否允许请求生成配音（UI 按钮 disabled 与测试共用同一判定）。
 * ready（无需重复生成）与 blocked_contaminated（硬阻断）之外的状态允许请求；
 * POST 仍有 Gate B fail-closed 兜底（NARRATION_PLAN_CONTAMINATED 409）。
 */
export function canRequestAudioGeneration(status: string): boolean {
  return status !== 'ready' && status !== 'blocked_contaminated';
}

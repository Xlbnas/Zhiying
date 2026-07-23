'use client';

import type {WorkflowStage} from '@/lib/workflow/types';
import {WORKFLOW_STAGES} from '@/lib/workflow/types';
import {
  deriveCurrentStage,
  isStageFailed,
  STAGE_NAMES,
  STAGE_STATE_LABELS,
  type WorkflowStageState,
} from './shared';

/**
 * Workflow Stepper（M2-C §二十二）：10 阶段视觉主轴。
 * 顶部轨道即阶段连接线；五态（not_started/generated/edited/locked/stale）
 * + 派生 current（流程位置推导）+ 派生 failed（最近 llm_job 推导）。
 */
export function WorkflowStepper({
  stages,
  selected,
  onSelect,
}: {
  stages: WorkflowStageState[];
  selected: WorkflowStage;
  onSelect: (stage: WorkflowStage) => void;
}) {
  const current = deriveCurrentStage(stages);

  return (
    <nav className="stepper" aria-label="工作流阶段">
      {WORKFLOW_STAGES.map((name, index) => {
        const row = stages.find((s) => s.stage === name);
        const state = row?.status ?? 'not_started';
        const failed = row ? isStageFailed(row) : false;
        const isCurrent = name === current;
        const isSelected = name === selected;
        return (
          <button
            key={name}
            type="button"
            className="step"
            data-state={state}
            data-current={isCurrent}
            data-failed={failed}
            aria-current={isCurrent ? 'step' : undefined}
            aria-pressed={isSelected}
            style={
              isSelected
                ? {background: 'color-mix(in srgb, var(--accent) 12%, transparent)'}
                : undefined
            }
            onClick={() => onSelect(name)}
          >
            <span className="step-index mono">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="step-name">{STAGE_NAMES[name]}</span>
            <span className="step-state">
              {failed
                ? '失败'
                : isCurrent
                  ? `当前 · ${STAGE_STATE_LABELS[state]}`
                  : STAGE_STATE_LABELS[state]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

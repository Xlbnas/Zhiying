/**
 * Workspace activity 控制器的纯逻辑（M7.3A.2）。
 *
 * 与 UI 框架无关，供 useActivityController 包装。
 * 负责统一轮询策略：mutation 触发、运行中保持、终态停止、hidden 降频、错误退避。
 */

import type {ActivityResponse, ActivityRunningJob} from './shared';

const DEFAULT_BASE_INTERVAL_MS = 2000;
const DEFAULT_HIDDEN_INTERVAL_MS = 15000;
const DEFAULT_MAX_ERROR_INTERVAL_MS = 15000;

export interface ActivityControllerState {
  activity: ActivityResponse | null;
  error: string | null;
  watchActive: boolean;
}

export interface ActivityControllerOptions {
  baseIntervalMs?: number;
  hiddenIntervalMs?: number;
  maxErrorIntervalMs?: number;
}

export type IntervalId = number;

export interface ActivityControllerDependencies extends ActivityControllerOptions {
  fetchActivity: () => Promise<ActivityResponse>;
  onChange: (state: ActivityControllerState) => void;
  getVisibilityState: () => 'visible' | 'hidden';
  setInterval: (callback: () => void, ms: number) => IntervalId;
  clearInterval: (id: IntervalId | null) => void;
}

export interface ActivityController {
  refresh: () => Promise<void>;
  notifyMutation: () => void;
  dispose: () => void;
  getState: () => ActivityControllerState;
}

function isTerminalAudioStatus(status: string): boolean {
  return status === 'ready' || status === 'failed' || status === 'blocked_contaminated' || status === 'missing';
}

function isTerminalSubtitleStatus(status: string): boolean {
  return status === 'ready' || status === 'missing';
}

function hasRunningJob(runningJobs: ActivityRunningJob[]): boolean {
  return runningJobs.length > 0;
}

export function createActivityController(deps: ActivityControllerDependencies): ActivityController {
  const baseIntervalMs = deps.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
  const hiddenIntervalMs = deps.hiddenIntervalMs ?? DEFAULT_HIDDEN_INTERVAL_MS;
  const maxErrorIntervalMs = deps.maxErrorIntervalMs ?? DEFAULT_MAX_ERROR_INTERVAL_MS;

  let state: ActivityControllerState = {activity: null, error: null, watchActive: false};
  let intervalId: IntervalId | null = null;
  let errorIntervalMs = baseIntervalMs;
  let emptyStreak = 0;
  let hasSuccess = false;
  let pending = false;
  let disposed = false;

  const {fetchActivity, onChange, getVisibilityState, setInterval: scheduleInterval, clearInterval: cancelInterval} = deps;

  function emit() {
    onChange({...state});
  }

  function clearTimer() {
    if (intervalId !== null) {
      cancelInterval(intervalId);
      intervalId = null;
    }
  }

  function scheduleTick() {
    clearTimer();
    const isHidden = getVisibilityState() === 'hidden';
    const interval = isHidden ? hiddenIntervalMs : errorIntervalMs;
    intervalId = scheduleInterval(() => {
      void refresh();
    }, interval);
  }

  function recomputeWatch() {
    const shouldWatch = state.watchActive || (state.activity !== null && hasRunningJob(state.activity.runningJobs));
    if (shouldWatch) {
      scheduleTick();
    } else {
      clearTimer();
    }
  }

  async function refresh(): Promise<void> {
    if (pending || disposed) return;
    pending = true;
    try {
      const next = await fetchActivity();
      if (disposed) return;
      state = {...state, activity: next, error: null};
      hasSuccess = true;
      errorIntervalMs = baseIntervalMs;

      const running = hasRunningJob(next.runningJobs);
      if (!running && isTerminalAudioStatus(next.audioOverview.status) && isTerminalSubtitleStatus(next.subtitleReadiness.status)) {
        emptyStreak += 1;
      } else {
        emptyStreak = 0;
      }

      // 自动停止 watch：至少成功刷新过一次，且连续两次空且 terminal
      if (state.watchActive && hasSuccess && emptyStreak >= 2) {
        state = {...state, watchActive: false};
      }
    } catch (err) {
      if (disposed) return;
      state = {...state, error: err instanceof Error ? err.message : '活动状态加载失败'};
      errorIntervalMs = Math.min(errorIntervalMs * 2, maxErrorIntervalMs);
    } finally {
      pending = false;
      emit();
      recomputeWatch();
    }
  }

  function notifyMutation() {
    emptyStreak = 0;
    state = {...state, watchActive: true};
    emit();
    recomputeWatch();
    void refresh();
  }

  function dispose() {
    disposed = true;
    clearTimer();
  }

  function getState(): ActivityControllerState {
    return {...state};
  }

  // 初始一次刷新
  void refresh();

  return {refresh, notifyMutation, dispose, getState};
}

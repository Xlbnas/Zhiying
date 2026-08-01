/**
 * M7.3A.3.3R1：render bundle 阶段执行与退出路由（轻量、可依赖注入测试）。
 *
 * runRenderJob 的 bundle 阶段使用本 helper：
 * - bundle promise 抛错 → 按 classifyBundleExit 优先级路由（lease lost >
 *   shutdown > cancel > bundle_error）到对应回调；
 * - bundle 成功但执行期间 lease lost → 仍路由 onLeaseLost，不进入 renderMedia；
 * - 返回 true = 继续 renderMedia；false = 已退出。
 *
 * heartbeat dispose 由 runRenderJob 的 finally 单一 owner 管理（本 helper
 * 不 dispose，避免双重释放）。
 */

import {classifyBundleExit, type BundleExitKind} from '@/lib/render/bundle-classify';

export interface BundlePhaseState {
  leaseLost: boolean;
  shuttingDown: boolean;
  cancelRequested: boolean;
}

export interface BundlePhaseCallbacks {
  onLeaseLost: () => void;
  onShutdown: () => void;
  onCancelled: () => void;
  onBundleError: (err: unknown) => void;
}

export function routeBundleExit(kind: BundleExitKind, callbacks: BundlePhaseCallbacks, err: unknown): void {
  switch (kind) {
    case 'lease_lost':
      callbacks.onLeaseLost();
      break;
    case 'shutdown':
      callbacks.onShutdown();
      break;
    case 'cancelled':
      callbacks.onCancelled();
      break;
    default:
      callbacks.onBundleError(err);
      break;
  }
}

export async function runBundlePhase(deps: {
  bundle: () => Promise<void>;
  state: BundlePhaseState;
  callbacks: BundlePhaseCallbacks;
}): Promise<boolean> {
  try {
    await deps.bundle();
  } catch (err) {
    routeBundleExit(classifyBundleExit(deps.state), deps.callbacks, err);
    return false;
  }
  // bundle 成功但执行期间 lease lost → 不进入 renderMedia
  if (classifyBundleExit(deps.state) === 'lease_lost') {
    deps.callbacks.onLeaseLost();
    return false;
  }
  return true;
}

/**
 * M7.3A.3.3R1/R2：render bundle 阶段执行与退出路由（轻量、可依赖注入测试）。
 *
 * runRenderJob 的 bundle 阶段使用本 helper：
 * - bundle promise 抛错 → 实时读取 getState() 并按 classifyBundleExit 优先级
 *   路由（lease lost > shutdown > cancel > bundle_error）到对应回调；
 * - bundle 成功 → post-bundle fence：实时读取 getState() 并经 controlExitKind
 *   判定（lease lost > shutdown > cancel > proceed）；任何控制退出都不进入
 *   renderMedia；
 * - 返回 true = 继续 renderMedia；false = 已退出。
 *
 * M7.3A.3.3R2：状态必须实时读取（getState），禁止传入预计算的 boolean 快照——
 * bundle 执行期间发生的 lease lost / shutdown / cancel 必须被 catch 与
 * post-bundle fence 看到。
 *
 * heartbeat dispose 由 runRenderJob 的 finally 单一 owner 管理（本 helper
 * 不 dispose，避免双重释放）。
 */

import {classifyBundleExit, controlExitKind, type BundleExitKind, type BundleExitState} from '@/lib/render/bundle-classify';

export type {BundleExitState};

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
  /** M7.3A.3.3R2：live state reader——每个判定边界重新调用，禁止 boolean 快照。 */
  getState: () => BundleExitState;
  callbacks: BundlePhaseCallbacks;
}): Promise<boolean> {
  try {
    await deps.bundle();
  } catch (err) {
    // catch 边界：实时读取状态再分类（bundle 执行期间的状态变化必须生效）
    routeBundleExit(classifyBundleExit(deps.getState()), deps.callbacks, err);
    return false;
  }
  // post-bundle fence 边界：bundle 成功不代表可以进入 render——
  // 实时读取状态；lease lost / shutdown / cancel 任一成立都不得进入 renderMedia。
  const kind = controlExitKind(deps.getState());
  if (kind !== null) {
    routeBundleExit(kind, deps.callbacks, null);
    return false;
  }
  return true;
}

/**
 * M7.3A.3.3R2：通用异步 lifecycle helper——cleanup 位于真正的 finally。
 * production runRenderJob 用它包裹 bundle+render，cleanup = heartbeat dispose；
 * 任何路径（reject/resolve/异常）都恰好执行一次 cleanup，无双重 dispose。
 */
export async function runWithCleanup<T>(work: () => Promise<T>, cleanup: () => void): Promise<T> {
  try {
    return await work();
  } finally {
    cleanup();
  }
}

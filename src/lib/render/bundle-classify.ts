/**
 * M7.3A.3.3：render bundle 退出分类（纯函数，无重依赖，可单测）。
 *
 * 优先级：lease lost > shutdown > cancel > 其他异常（bundle_error）。
 * runRenderJob 的 bundle catch 使用本函数；不得把 lease lost / shutdown /
 * cancel 误报为 BUNDLE_ERROR。
 *
 * M7.3A.3.3R2：controlExitKind 用于 bundle 成功后的 post-bundle fence——
 * 三项均 false 返回 null（= proceed），不把"无控制退出"误报为 bundle_error。
 */

export type BundleExitKind = 'lease_lost' | 'shutdown' | 'cancelled' | 'bundle_error';

export interface BundleExitState {
  leaseLost: boolean;
  shuttingDown: boolean;
  cancelRequested: boolean;
}

export function classifyBundleExit(input: BundleExitState): BundleExitKind {
  if (input.leaseLost) return 'lease_lost';
  if (input.shuttingDown) return 'shutdown';
  if (input.cancelRequested) return 'cancelled';
  return 'bundle_error';
}

/**
 * M7.3A.3.3R2：控制状态 classifier（成功路径 fence 用）。
 * 优先级 lease lost > shutdown > cancel；三项均 false → null（proceed）。
 */
export function controlExitKind(input: BundleExitState): BundleExitKind | null {
  if (input.leaseLost) return 'lease_lost';
  if (input.shuttingDown) return 'shutdown';
  if (input.cancelRequested) return 'cancelled';
  return null;
}

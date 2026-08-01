/**
 * M7.3A.3.3：render bundle 退出分类（纯函数，无重依赖，可单测）。
 *
 * 优先级：lease lost > shutdown > cancel > 其他异常（bundle_error）。
 * runRenderJob 的 bundle catch 使用本函数；不得把 lease lost / shutdown /
 * cancel 误报为 BUNDLE_ERROR。
 */

export type BundleExitKind = 'lease_lost' | 'shutdown' | 'cancelled' | 'bundle_error';

export function classifyBundleExit(input: {
  leaseLost: boolean;
  shuttingDown: boolean;
  cancelRequested: boolean;
}): BundleExitKind {
  if (input.leaseLost) return 'lease_lost';
  if (input.shuttingDown) return 'shutdown';
  if (input.cancelRequested) return 'cancelled';
  return 'bundle_error';
}

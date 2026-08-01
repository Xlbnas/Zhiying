/**
 * M7.3A.3：统一 resource lease heartbeat（TTS / Render / local image 共用）。
 *
 * 职责：
 * - 按 intervalMs 周期调用 heartbeatResourceLease(group, ownerToken, leaseMs)；
 * - heartbeat 返回 false（lease 被回收/被抢占）→ 标记 lost 并触发 onLost；
 * - 提供 isLost() 供执行器在提交成功前 fail-closed 检查；
 * - dispose() 停止周期心跳。
 *
 * 生命周期归属：scheduler 唯一 claim；job-runner finally 唯一 normal release；
 * executor 只接收 lost 信号并完成业务 fail-closed，不执行 normal lease release。
 */

import {getResourceLeaseMs, heartbeatResourceLease, type ResourceGroup} from './leases';

export interface ResourceLeaseHeartbeatOptions {
  group: ResourceGroup;
  ownerToken: string;
  /** 心跳周期；默认 2s。 */
  intervalMs?: number;
  /** 每次心跳续约时长；默认取 getResourceLeaseMs()（env 可覆盖）。 */
  leaseMs?: number;
  /** 首次 heartbeat 返回 false（lease 已丢失）时的回调。 */
  onLost?: () => void;
}

export interface ResourceLeaseHeartbeatHandle {
  /** 是否已确认 lease 丢失。 */
  isLost: () => boolean;
  /** 停止周期心跳（幂等）。 */
  dispose: () => void;
}

export function createResourceLeaseHeartbeat(
  opts: ResourceLeaseHeartbeatOptions,
): ResourceLeaseHeartbeatHandle {
  let lost = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const beat = (): void => {
    if (lost) return;
    const ok = heartbeatResourceLease(opts.group, opts.ownerToken, opts.leaseMs ?? getResourceLeaseMs());
    if (!ok) {
      lost = true;
      opts.onLost?.();
    }
  };

  timer = setInterval(beat, opts.intervalMs ?? 2000);
  // 立即执行一次，避免长 interval 首跳前的空窗
  beat();

  return {
    isLost: () => lost,
    dispose: () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

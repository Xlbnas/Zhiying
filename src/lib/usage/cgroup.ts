/**
 * 容器 CPU 用量读取（M6.3.10）。
 *
 * worker 单调度器串行执行（任何时刻只有一个 job），因此容器级 cgroup
 * usage_usec 的 delta 可以无歧义归属到当前执行的 job attempt。
 *
 * cgroup v2：/sys/fs/cgroup/cpu.stat → usage_usec（微秒）
 * cgroup v1：/sys/fs/cgroup/cpuacct/cpuacct.usage（纳秒，×1000 转微秒）
 * 不可读时返回 null —— 不伪造数据，调用方跳过记录。
 */
import fs from 'node:fs';

const V2_PATH = '/sys/fs/cgroup/cpu.stat';
const V1_PATH = '/sys/fs/cgroup/cpuacct/cpuacct.usage';

/** 测试注入：覆盖 cgroup 路径。 */
export interface CgroupPaths {
  v2Path?: string;
  v1Path?: string;
}

export function readContainerCpuUsageUsec(paths: CgroupPaths = {}): number | null {
  const v2 = paths.v2Path ?? V2_PATH;
  try {
    const stat = fs.readFileSync(v2, 'utf8');
    for (const line of stat.split('\n')) {
      const [key, value] = line.split(' ');
      if (key === 'usage_usec') {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
      }
    }
  } catch { /* fall through to v1 */ }

  const v1 = paths.v1Path ?? V1_PATH;
  try {
    const ns = Number(fs.readFileSync(v1, 'utf8').trim());
    if (Number.isFinite(ns) && ns >= 0) return Math.round(ns / 1000);
  } catch { /* unreadable */ }
  return null;
}

/** 计算 delta；任一端不可读 → null（调用方跳过 cpu 字段，不影响其他字段）。 */
export function cpuUsageDeltaUsec(start: number | null, end: number | null): number | null {
  if (start === null || end === null || end < start) return null;
  return end - start;
}

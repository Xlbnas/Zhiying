/**
 * Job 级 compute usage 采集（M6.3.10）。
 *
 * 归属模型：worker 单调度器串行（任何时刻只跑一个 job），容器 cgroup
 * usage_usec delta 可归属到当前 job attempt。
 *
 * 与 wall time 两流分离：wallMs 只由 usage-events 的 jobs 表幂等回填
 * （render-wall-${jobId} / tts-wall-${jobId}，含历史）；本模块写的 compute
 * event 只携带 cpuUsec / gpuSec（wallMs = null），杜绝双写重复计数。
 *
 * event id = `${kind}-cpu-${jobId}-a${attempt}` + INSERT OR IGNORE：
 * 同一 attempt 的重复处理永不重复记账；retry 是新 attempt 独立成行。
 */
import {recordUsageEvent} from '../usage-events';
import {cpuUsageDeltaUsec, readContainerCpuUsageUsec} from './cgroup';

export interface ComputeSnapshot {
  cpuStartUsec: number | null;
  wallStartMs: number;
}

export function snapshotComputeStart(): ComputeSnapshot {
  return {cpuStartUsec: readContainerCpuUsageUsec(), wallStartMs: Date.now()};
}

export function recordJobComputeUsage(input: {
  kind: 'render' | 'tts';
  jobId: string;
  projectId: string;
  attempt: number;
  snapshot: ComputeSnapshot;
  status: 'succeeded' | 'failed' | 'cancelled';
  /** 仅真实走 GPU 路径时传入（attempt wall 秒；不是利用率加权） */
  gpuAccelerated?: boolean;
  metadata?: Record<string, unknown>;
  /** 测试注入：覆盖 cgroup 读取 */
  readCpu?: () => number | null;
}): void {
  const readCpu = input.readCpu ?? readContainerCpuUsageUsec;
  const cpuUsec = cpuUsageDeltaUsec(input.snapshot.cpuStartUsec, readCpu());
  const wallSec = Math.max(0, (Date.now() - input.snapshot.wallStartMs) / 1000);
  // cpu/gpu 全不可读且非 GPU 路径时，event 只剩 status 元数据——仍然记录，
  // 让技术详情能看到 attempt 轨迹；cpu_usec/gpu_sec 为 null 不影响合计口径。
  recordUsageEvent({
    id: `${input.kind}-cpu-${input.jobId}-a${input.attempt}`,
    projectId: input.projectId,
    kind: input.kind,
    stage: input.kind,
    jobId: input.jobId,
    cpuUsec,
    gpuSec: input.gpuAccelerated === true ? wallSec : null,
    metadata: {
      attempt: input.attempt,
      status: input.status,
      attemptWallSec: Math.round(wallSec * 100) / 100,
      ...input.metadata,
    },
  });
}

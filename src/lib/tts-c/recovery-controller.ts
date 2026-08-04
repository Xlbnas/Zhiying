/**
 * TTS-C.1A.R2 MaterializationRecoveryController（P0-A：真正周期运行的 autonomous recovery）。
 *
 * 语义：
 * - Worker 启动时立即 sweep 一次；运行期间按固定 cadence 持续 sweep（默认 10s，可配置）；
 * - 不需要新 HTTP POST、不需要 Worker 重启；
 * - inFlight single-flight guard：两个 interval 重叠时只有一个 sweep 在飞；
 * - 单 job recovery 异常由 recoverExpiredMaterializationJobs 内部 try/catch 隔离（不阻断其余）；
 * - recovery 异常只记录（lastError），不得使主 Worker fatal；
 * - shutdown：stop() 停止 timer，等待 in-flight sweep settle；
 * - 每次 limit 有界（默认 10），避免饿死正常调度。
 */
import {recoverExpiredMaterializationJobs} from './materialization';

export interface MaterializationRecoveryControllerOptions {
  intervalMs?: number;
  limit?: number;
  log?: (...args: unknown[]) => void;
}

export class MaterializationRecoveryController {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private settlePromise: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly log: (...args: unknown[]) => void;
  lastRun: number | null = null;
  lastError: string | null = null;
  lastHandled = 0;

  constructor(opts: MaterializationRecoveryControllerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.limit = opts.limit ?? 10;
    this.log = opts.log ?? (() => undefined);
  }

  /** 启动：立即 sweep 一次 + 按 cadence 持续 sweep。 */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // 启动时立即 sweep 一次（不等待首个 interval）
    void this.runNow().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.runNow().catch(() => undefined);
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  /** 停止 timer 并等待 in-flight sweep settle（shutdown 语义）。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight && this.settlePromise) {
      await this.settlePromise;
    }
  }

  /** 立即执行一次 sweep（inFlight guard：重叠调用直接返回，不重入）。 */
  async runNow(): Promise<number> {
    if (this.inFlight) return 0; // 不重入
    if (this.stopped) return 0;
    this.inFlight = true;
    let settleResolve: () => void = () => undefined;
    this.settlePromise = new Promise<void>((resolve) => {
      settleResolve = resolve;
    });
    try {
      const handled = await recoverExpiredMaterializationJobs(this.limit);
      this.lastRun = Date.now();
      this.lastHandled = handled;
      this.lastError = null;
      if (handled > 0) this.log(`tts-c1a recovery: 处理 ${handled} 个 expired materialization job(s)`);
      return handled;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`tts-c1a recovery error（不 fatal）: ${this.lastError}`);
      return 0;
    } finally {
      this.inFlight = false;
      settleResolve();
    }
  }

  get isRunning(): boolean {
    return this.inFlight;
  }
}

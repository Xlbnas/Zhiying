/**
 * TTS-C.1B.3 RegistryRecoveryController——周期 crash reconciliation（复用 1A
 * MaterializationRecoveryController 最小骨架：周期 sweep / 同进程不重入 / shutdown settle /
 * 单条异常隔离 / 可注入周期与依赖）。
 *
 * 不新建通用 workflow engine；单 Worker writer 边界与 1A recovery 相同。
 */
import {recoverRegistryPublications, type RegistryRecoveryDeps, type RegistryRecoveryRunResult} from './registry-activation';

export interface RegistryRecoveryControllerOptions {
  intervalMs?: number;
  limit?: number;
  log?: (...args: unknown[]) => void;
}

export class RegistryRecoveryController {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private settlePromise: Promise<void> | null = null;
  private readonly intervalMs: number;
  private readonly limit: number;
  private readonly log: (...args: unknown[]) => void;
  lastRun: number | null = null;
  lastError: string | null = null;
  lastResult: RegistryRecoveryRunResult | null = null;

  constructor(
    private readonly deps: RegistryRecoveryDeps,
    opts: RegistryRecoveryControllerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.limit = opts.limit ?? 10;
    this.log = opts.log ?? (() => undefined);
  }

  /** 启动：立即 sweep 一次 + 按 cadence 持续 sweep。 */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
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
    if (this.inFlight) return 0;
    if (this.stopped) return 0;
    this.inFlight = true;
    let settleResolve: () => void = () => undefined;
    this.settlePromise = new Promise<void>((resolve) => {
      settleResolve = resolve;
    });
    try {
      const result = await recoverRegistryPublications(this.deps.db, this.deps, this.limit);
      this.lastRun = Date.now();
      this.lastResult = result;
      this.lastError = null;
      if (result.handled > 0) this.log(`tts-c1b3 recovery: sweep ${result.handled} publication(s)`);
      for (const err of result.errors) {
        this.log(`tts-c1b3 recovery 单条错误（不 fatal）: ${err}`);
      }
      return result.handled;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`tts-c1b3 recovery error（不 fatal）: ${this.lastError}`);
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

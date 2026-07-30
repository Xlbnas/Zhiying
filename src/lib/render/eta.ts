/**
 * 渲染 ETA 估算（M6.3.13）：纯函数模块，前端轮询与脚本测试共用。
 *
 * 输入：进度采样序列 {frames, totalFrames, atMs, stage}（通常来自
 * render_jobs.progress_detail 的 encodedFrames/totalFrames/updatedAt/stage）。
 * 输出：{fps, remainingSec, finishAt} 或 null（不可估算 → UI 显示「正在估算…」）。
 *
 * 规则：
 * - 仅 stage 为 encode/render 且有帧计数时估算；其余阶段返回 null
 * - 至少 2 个样本（首个样本仅作基线）；instantFps = deltaFrames/deltaTime
 * - EMA 平滑（alpha=0.25），抗单轮询抖动
 * - fps<=0 / NaN / deltaFrames<0（阶段切换/计数重置）→ 丢弃该样本
 * - bootstrap：可以服务端 detail.fps 作先验（F5 刷新后立即有估值），
 *   随后客户端采样 EMA 接管
 */

export interface ProgressSample {
  /** 当前已完成帧数（编码阶段为 encodedFrames）。 */
  frames: number;
  totalFrames: number;
  /** 采样时间（epoch ms）。 */
  atMs: number;
  /** 进度明细阶段；仅 'encode' / 'render' 可估算。 */
  stage: string;
}

export interface EtaEstimate {
  /** EMA 平滑后的速度（帧/秒）。 */
  fps: number;
  /** 预计剩余秒数。 */
  remainingSec: number;
  /** 预计完成时刻（epoch ms）。 */
  finishAt: number;
}

export interface EtaPrior {
  /** 服务端 detail.fps 先验；非法值（<=0 / NaN / null）视为无先验。 */
  fps?: number | null;
}

export interface EtaEstimator {
  /** 喂入一个样本；返回当前估值或 null（样本不足 / 被丢弃 / 阶段不可估算）。 */
  add(sample: ProgressSample): EtaEstimate | null;
  /** 清空采样状态（job 切换时调用），可重新给先验。 */
  reset(prior?: EtaPrior): void;
}

const EMA_ALPHA = 0.25;
const ESTIMABLE_STAGES = new Set(['encode', 'render']);

function sanitizePriorFps(fps: number | null | undefined): number | null {
  return fps != null && Number.isFinite(fps) && fps > 0 ? fps : null;
}

export function createEtaEstimator(prior?: EtaPrior): EtaEstimator {
  let emaFps: number | null = sanitizePriorFps(prior?.fps);
  let last: ProgressSample | null = null;

  const estimateFrom = (sample: ProgressSample): EtaEstimate | null => {
    if (emaFps === null || emaFps <= 0) return null;
    const remainingFrames = sample.totalFrames - sample.frames;
    if (!Number.isFinite(remainingFrames) || remainingFrames < 0) return null;
    const remainingSec = remainingFrames / emaFps;
    return {fps: emaFps, remainingSec, finishAt: sample.atMs + remainingSec * 1000};
  };

  return {
    add(sample: ProgressSample): EtaEstimate | null {
      if (!ESTIMABLE_STAGES.has(sample.stage)) return null;
      if (!Number.isFinite(sample.frames) || !Number.isFinite(sample.atMs)) return null;
      if (!last) {
        // 首个样本仅作基线；有服务端 fps 先验时可立即估值（bootstrap）
        last = sample;
        return estimateFrom(sample);
      }
      const deltaFrames = sample.frames - last.frames;
      const deltaSec = (sample.atMs - last.atMs) / 1000;
      if (deltaFrames < 0) {
        // 阶段切换 / 计数重置：丢弃速率，以本样本为新基线
        last = sample;
        return null;
      }
      const instant = deltaSec > 0 ? deltaFrames / deltaSec : NaN;
      if (!Number.isFinite(instant) || instant <= 0) {
        // 停滞 / 无效间隔：丢弃该样本（不动 EMA，也不动基线）
        return null;
      }
      emaFps = emaFps === null ? instant : EMA_ALPHA * instant + (1 - EMA_ALPHA) * emaFps;
      last = sample;
      return estimateFrom(sample);
    },
    reset(nextPrior?: EtaPrior): void {
      emaFps = sanitizePriorFps(nextPrior?.fps);
      last = null;
    },
  };
}

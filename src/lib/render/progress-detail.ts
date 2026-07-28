/**
 * 渲染任务步骤级进度明细（M5）。
 *
 * 背景：render_jobs.progress 只有一个百分比，用户无法判断「卡在哪一步」。
 * 本模块定义 worker 写入 render_jobs.progress_detail 的 JSON 契约：
 * 阶段（准备/整理旁白/打包环境/渲染画面/编码/封装）+ 帧级计数 + 预计剩余。
 *
 * 写入方：src/worker（heartbeat 附带）；读取方：/api/jobs、final-render
 * readiness、Jobs 页与 FinalRenderPanel。label 为面向普通用户的中文。
 */

export type RenderStage =
  | 'prepare'   // 校验渲染素材
  | 'staging'   // 整理旁白素材
  | 'compose'   // 解析合成结构
  | 'bundle'    // 打包渲染环境
  | 'render'    // 渲染画面（帧级）
  | 'encode'    // 编码视频（帧级）
  | 'mux'       // 封装视频文件
  | 'done';     // 完成

export interface RenderProgressDetail {
  stage: RenderStage;
  /** 面向用户的中文描述，如「渲染画面 1234/18013 帧」。 */
  label: string;
  renderedFrames?: number;
  encodedFrames?: number;
  totalFrames?: number;
  stitchStage?: string;
  /** 预计剩余毫秒（Remotion renderEstimatedTime；可能为 null）。 */
  etaMs?: number | null;
  updatedAt: string;
}

export const RENDER_STAGE_LABELS: Record<RenderStage, string> = {
  prepare: '检查渲染素材',
  staging: '整理旁白素材',
  compose: '解析合成结构',
  bundle: '打包渲染环境（首次较慢）',
  render: '渲染画面',
  encode: '编码视频',
  mux: '封装视频文件',
  done: '完成',
};

export function buildStageDetail(
  stage: RenderStage,
  extra?: Partial<Omit<RenderProgressDetail, 'stage' | 'updatedAt'>>,
  now: () => string = () => new Date().toISOString(),
): RenderProgressDetail {
  return {
    stage,
    label: extra?.label ?? RENDER_STAGE_LABELS[stage],
    ...extra,
    updatedAt: now(),
  } as RenderProgressDetail;
}

/** Remotion RenderMediaProgress → 步骤明细（帧级 + stitch 阶段 + 预计剩余）。 */
export function detailFromRemotionProgress(progress: {
  renderedFrames: number;
  encodedFrames: number;
  stitchStage: 'encoding' | 'muxing';
  renderEstimatedTime: number | null;
  progress: number;
}, totalFrames: number): Omit<RenderProgressDetail, 'updatedAt'> {
  if (progress.stitchStage === 'encoding') {
    return {
      stage: 'encode',
      label: `编码视频 ${progress.encodedFrames}/${totalFrames} 帧`,
      renderedFrames: progress.renderedFrames,
      encodedFrames: progress.encodedFrames,
      totalFrames,
      stitchStage: progress.stitchStage,
      etaMs: progress.renderEstimatedTime,
    };
  }
  if (progress.stitchStage === 'muxing') {
    return {
      stage: 'mux',
      label: '封装视频文件',
      renderedFrames: progress.renderedFrames,
      encodedFrames: progress.encodedFrames,
      totalFrames,
      stitchStage: progress.stitchStage,
      etaMs: progress.renderEstimatedTime,
    };
  }
  return {
    stage: 'render',
    label: `渲染画面 ${progress.renderedFrames}/${totalFrames} 帧`,
    renderedFrames: progress.renderedFrames,
    totalFrames,
    etaMs: progress.renderEstimatedTime,
  };
}

/** 安全解析 DB 里的 progress_detail JSON；损坏/缺失返回 null（不阻塞展示）。 */
export function parseRenderProgressDetail(json: string | null | undefined): RenderProgressDetail | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as RenderProgressDetail;
    if (typeof obj !== 'object' || obj === null || typeof obj.stage !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

/** 供 blocker/列表使用的单行摘要：「渲染画面 1234/18013 帧（7%）」。 */
export function summarizeRenderProgress(
  progress: number,
  detailJson: string | null | undefined,
): string {
  const detail = parseRenderProgressDetail(detailJson);
  const pct = `${Math.round(progress * 10) / 10}%`;
  return detail ? `${detail.label}（${pct}）` : pct;
}

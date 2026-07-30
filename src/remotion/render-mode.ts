/**
 * M6.3.12：渲染模式上下文 + Final 模式 placeholder kill switch。
 *
 * Contract：
 * - Preview（Studio / Visual Preview / playerPreviewProps）：placeholder 合法可见
 * - Final（worker Final Render，renderMode='final'）：任何 placeholder 路径
 *   必须 throw MissingVisualAssetError → renderMedia 失败 → job failed，
 *   绝不生成含「视觉素材待准备」的残缺 MP4
 */
import {createContext, useContext} from 'react';

export type RenderMode = 'preview' | 'final';

export class MissingVisualAssetError extends Error {
  readonly sceneId: string;
  readonly reason: string;
  constructor(sceneId: string, reason: string) {
    super(`Final Render 不允许 placeholder：scene=${sceneId} reason=${reason}`);
    this.name = 'MissingVisualAssetError';
    this.sceneId = sceneId;
    this.reason = reason;
  }
}

export const RenderModeContext = createContext<RenderMode>('preview');

export function useRenderMode(): RenderMode {
  return useContext(RenderModeContext);
}

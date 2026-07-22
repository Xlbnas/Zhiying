'use client';

import {forwardRef} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
// 同构原则（CONTRACT §2）：Player 与服务端渲染使用同一个组件。
// Template agent 交付的 props 驱动组件是 ZhiyingFullCut（FullCutV1 只是 defaultProps 薄包装），
// 组件签名：({ data, subtitles, audio, showSubtitles }: ZhiyingFullCutProps) => JSX.Element
import {ZhiyingFullCut} from '@/remotion/compositions/FullCutV1';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';

type FullCutPlayerProps = {
  /** 来自 GET /api/projects/[id]/scenes 的 ZhiyingFullCutProps */
  inputProps: ZhiyingFullCutProps;
};

/**
 * Remotion Player 封装（工作台预览）。
 * 通过 ref 暴露 PlayerRef，供 Scene 列表 seekTo(startFrame) 定位播放。
 */
export const FullCutPlayer = forwardRef<PlayerRef, FullCutPlayerProps>(
  function FullCutPlayer({inputProps}, ref) {
    const {project} = inputProps.data;
    return (
      <Player
        ref={ref}
        component={ZhiyingFullCut}
        inputProps={inputProps}
        durationInFrames={project.durationInFrames}
        fps={project.fps}
        compositionWidth={project.width}
        compositionHeight={project.height}
        style={{width: '100%', aspectRatio: `${project.width} / ${project.height}`}}
        controls
        clickToPlay
        doubleClickToFullscreen
        spaceKeyToPlayOrPause
        acknowledgeRemotionLicense
      />
    );
  },
);

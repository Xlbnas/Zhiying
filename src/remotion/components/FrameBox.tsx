import type {ReactNode} from 'react';
import {borderRadius, colors, lineWidth, spacing} from '../design/tokens';

export type FrameMode = 'historical' | 'modern' | 'research';

const modeStyle: Record<FrameMode, {border: string; background: string}> = {
  historical: {border: colors.historical, background: colors.historicalSurface},
  modern: {border: colors.muted, background: colors.surface},
  research: {border: colors.researchSoft, background: colors.surface},
};

export type FrameBoxProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: FrameMode;
  children: ReactNode;
  opacity?: number;
};

export const FrameBox = ({x, y, width, height, mode, children, opacity = 1}: FrameBoxProps) => {
  const palette = modeStyle[mode];
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        boxSizing: 'border-box',
        padding: spacing.md,
        border: `${lineWidth.normal}px solid ${palette.border}`,
        borderRadius: borderRadius.lg,
        background:
          mode === 'historical'
            ? `linear-gradient(135deg, ${palette.background}, ${colors.surface})`
            : palette.background,
        opacity,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
};

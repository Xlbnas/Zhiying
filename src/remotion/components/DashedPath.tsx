import {colors, lineWidth, opacity as opacityTokens} from '../design/tokens';

export type DashedPathProps = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  progress: number;
  opacity?: number;
};

export const DashedPath = ({
  x1,
  y1,
  x2,
  y2,
  progress,
  opacity = opacityTokens.secondary,
}: DashedPathProps) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  return (
    <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity}}>
      <line
        x1={x1}
        y1={y1}
        x2={x1 + (x2 - x1) * progress}
        y2={y1 + (y2 - y1) * progress}
        stroke={colors.accent}
        strokeWidth={lineWidth.normal}
        strokeLinecap="round"
        strokeDasharray="12 18"
        pathLength={length}
      />
    </svg>
  );
};

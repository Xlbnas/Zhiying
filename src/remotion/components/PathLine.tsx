import {colors, lineWidth} from '../design/tokens';

export type PathLineProps = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  progress: number;
  color?: string;
  opacity?: number;
  width?: number;
};

export const PathLine = ({
  x1,
  y1,
  x2,
  y2,
  progress,
  color = colors.primary,
  opacity = 1,
  width = lineWidth.normal,
}: PathLineProps) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  return (
    <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity}}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - progress)}
      />
      {progress > 0.96 ? <circle cx={x2} cy={y2} r={5} fill={color} /> : null}
    </svg>
  );
};

import {colors, lineWidth} from '../design/tokens';

export type PersonProps = {
  x: number;
  y: number;
  color?: string;
  size?: number;
  opacity?: number;
  scale?: number;
};

export const Person = ({
  x,
  y,
  color = colors.accent,
  size = 150,
  opacity = 1,
  scale = 1,
}: PersonProps) => (
  <svg
    width={size}
    height={size * 1.45}
    viewBox="0 0 100 145"
    style={{
      position: 'absolute',
      left: x,
      top: y,
      overflow: 'visible',
      opacity,
      transform: `scale(${scale})`,
      transformOrigin: '50% 70%',
    }}
  >
    <circle cx="50" cy="28" r="20" fill="none" stroke={color} strokeWidth={lineWidth.normal} />
    <path
      d="M18 118 C22 77, 33 61, 50 61 C67 61, 78 77, 82 118"
      fill="none"
      stroke={color}
      strokeWidth={lineWidth.normal}
      strokeLinecap="round"
    />
    <line x1="50" y1="62" x2="50" y2="130" stroke={color} strokeWidth={lineWidth.normal} />
  </svg>
);

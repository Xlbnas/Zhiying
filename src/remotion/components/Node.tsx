import type {CSSProperties} from 'react';
import {colors, borderRadius, lineWidth, opacity, spacing} from '../design/tokens';
import {Typography} from '../design/typography';

export type NodeShape = 'circle' | 'rounded' | 'pill';

export type NodeProps = {
  label: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: string;
  active?: boolean;
  dimmed?: boolean;
  shape?: NodeShape;
  scale?: number;
  style?: CSSProperties;
};

export const Node = ({
  label,
  x,
  y,
  width = 240,
  height = 92,
  color = colors.primary,
  active = false,
  dimmed = false,
  shape = 'rounded',
  scale = 1,
  style,
}: NodeProps) => {
  const radius =
    shape === 'circle' ? '50%' : shape === 'pill' ? borderRadius.pill : borderRadius.md;

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `0 ${spacing.sm}px`,
        boxSizing: 'border-box',
        border: `${active ? lineWidth.emphasis : lineWidth.normal}px solid ${color}`,
        borderRadius: radius,
        backgroundColor: active ? `${color}18` : colors.surface,
        opacity: dimmed ? opacity.dimmed : opacity.full,
        transform: `scale(${scale})`,
        ...style,
      }}
    >
      <Typography
        variant="BodyLabel"
        color={color}
        style={{textAlign: 'center', whiteSpace: 'nowrap'}}
      >
        {label}
      </Typography>
    </div>
  );
};

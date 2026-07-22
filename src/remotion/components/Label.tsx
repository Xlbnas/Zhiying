import type {CSSProperties, ReactNode} from 'react';
import {colors} from '../design/tokens';
import {Typography} from '../design/typography';

export type LabelTone = 'white' | 'gray' | 'red' | 'blue';

const toneColor: Record<LabelTone, string> = {
  white: colors.primary,
  gray: colors.secondary,
  red: colors.accent,
  blue: colors.research,
};

export type LabelProps = {
  children: ReactNode;
  x?: number;
  y?: number;
  tone?: LabelTone;
  opacity?: number;
  style?: CSSProperties;
};

export const Label = ({
  children,
  x,
  y,
  tone = 'white',
  opacity = 1,
  style,
}: LabelProps) => (
  <Typography
    variant="SmallLabel"
    color={toneColor[tone]}
    style={{position: x === undefined ? undefined : 'absolute', left: x, top: y, opacity, ...style}}
  >
    {children}
  </Typography>
);

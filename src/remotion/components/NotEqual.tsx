import {colors, fontSize} from '../design/tokens';
import {Typography} from '../design/typography';

export type NotEqualProps = {
  x: number;
  y: number;
  scale?: number;
  opacity?: number;
  color?: string;
};

export const NotEqual = ({
  x,
  y,
  scale = 1,
  opacity = 1,
  color = colors.accent,
}: NotEqualProps) => (
  <Typography
    variant="Title"
    color={color}
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: 260,
      textAlign: 'center',
      fontSize: fontSize.boundary,
      lineHeight: 1,
      opacity,
      transform: `scale(${scale})`,
      transformOrigin: '50% 50%',
    }}
  >
    ≠
  </Typography>
);

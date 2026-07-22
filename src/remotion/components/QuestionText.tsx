import {colors} from '../design/tokens';
import {Typography} from '../design/typography';

export type QuestionTextProps = {
  children: string;
  y: number;
  opacity?: number;
  scale?: number;
};

export const QuestionText = ({children, y, opacity = 1, scale = 1}: QuestionTextProps) => (
  <Typography
    variant="Question"
    color={colors.primary}
    style={{
      position: 'absolute',
      left: 180,
      right: 180,
      top: y,
      textAlign: 'center',
      opacity,
      transform: `scale(${scale})`,
    }}
  >
    {children}
  </Typography>
);

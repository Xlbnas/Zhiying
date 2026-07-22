import {colors, lineWidth} from '../design/tokens';

export type TimelineProps = {
  x: number;
  y: number;
  width: number;
  progress: number;
};

export const Timeline = ({x, y, width, progress}: TimelineProps) => (
  <div style={{position: 'absolute', left: x, top: y, width, height: 20}}>
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 9,
        width,
        height: lineWidth.hairline,
        backgroundColor: colors.muted,
      }}
    />
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 8,
        width: width * progress,
        height: lineWidth.normal,
        backgroundColor: colors.primary,
      }}
    />
  </div>
);

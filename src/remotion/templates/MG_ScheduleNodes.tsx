import {AbsoluteFill, interpolateColors, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {NotEqual} from '../components/NotEqual';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn, safeInterpolate} from '../utils/motion';

export type ScheduleNodesProps = {
  items?: string[];
  completedIndices?: number[];
  missedIndex?: number;
  focusIndex?: number;
  showBoundary?: boolean;
  showDebugLabel?: boolean;
};

export const MG_ScheduleNodes = ({
  items = ['回复消息', '团队会议', '赴约', '交付文件', '买生活用品'],
  completedIndices = [0, 1, 3, 4],
  missedIndex = 2,
  focusIndex = 2,
  showBoundary = false,
  showDebugLabel = false,
}: ScheduleNodesProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const path = drawProgress(frame, atFrame(0.08, fps), atFrame(motionTiming.pathDraw, fps));
  const focus = focusIndex >= 0
    ? safeInterpolate(frame, [atFrame(1.38, fps), atFrame(1.98, fps)], [0, 1])
    : 0;
  const boundary = showBoundary ? fadeIn(frame, atFrame(2.25, fps), atFrame(0.4, fps)) : 0;
  const startX = 250;
  const step = 355;

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_ScheduleNodes
        </Label>
      ) : null}
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <line
          x1={startX}
          y1={435}
          x2={startX + step * (items.length - 1)}
          y2={435}
          stroke={colors.muted}
          strokeWidth={lineWidth.normal}
          strokeDasharray={1600}
          strokeDashoffset={1600 * (1 - path)}
        />
      </svg>
      {items.map((item, index) => {
        const x = startX + step * index;
        const isFocused = index === focusIndex;
        const isMissed = index === missedIndex;
        const color = isFocused
          ? interpolateColors(focus, [0, 1], [colors.primary, colors.accent])
          : colors.primary;
        const nodeScale = calmSpring(frame, fps, atFrame(0.3 + index * 0.1, fps), {
          damping: 32,
          stiffness: 185,
        });
        const checkOpacity = completedIndices.includes(index)
          ? fadeIn(frame, atFrame(0.7 + index * 0.18, fps), atFrame(0.2, fps))
          : 0;
        return (
          <div key={`${item}-${index}`}>
            <div
              style={{
                position: 'absolute',
                left: x - 24,
                top: 411,
                width: 48,
                height: 48,
                borderRadius: '50%',
                border: `${isFocused ? lineWidth.emphasis : lineWidth.normal}px solid ${color}`,
                backgroundColor: colors.background,
                transform: `scale(${nodeScale})`,
              }}
            />
            <Typography
              variant="SmallLabel"
              color={color}
              style={{position: 'absolute', left: x - 105, top: 500, width: 210, textAlign: 'center'}}
            >
              {item}
            </Typography>
            {completedIndices.includes(index) ? (
              <Typography
                variant="SmallLabel"
                color={colors.primary}
                style={{position: 'absolute', left: x - 13, top: 414, opacity: checkOpacity}}
              >
                ✓
              </Typography>
            ) : null}
            {isMissed ? (
              <Label x={x - 120} y={575} tone="gray" opacity={focus} style={{width: 240, textAlign: 'center'}}>
                为什么偏偏？
              </Label>
            ) : null}
          </div>
        );
      })}

      <Label
        x={655}
        y={760}
        tone="gray"
        opacity={focus}
        style={{width: 610, textAlign: 'center', fontSize: 22}}
      >
        红色表示观察焦点，不表示已经发现隐藏动机
      </Label>

      {showBoundary ? (
        <div style={{position: 'absolute', left: 585, top: 785, width: 750, height: 220, opacity: boundary}}>
          <Typography variant="BodyLabel" color={colors.primary} style={{position: 'absolute', left: 0, top: 80}}>
            忘记赴约
          </Typography>
          <NotEqual x={250} y={20} scale={0.72} opacity={1} />
          <Typography variant="BodyLabel" color={colors.primary} style={{position: 'absolute', right: 0, top: 80}}>
            不爱
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

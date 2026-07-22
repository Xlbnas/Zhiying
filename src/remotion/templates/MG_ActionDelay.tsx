import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {IntentPathLayout} from '../components/IntentPathLayout';
import {Label} from '../components/Label';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn, safeInterpolate} from '../utils/motion';

export type ActionDelayProps = {
  delayLabels?: string[];
  currentDelayIndex?: number;
  intentLabel?: string;
  actionLabel?: string;
  showPossibleStructure?: boolean;
  showDebugLabel?: boolean;
  initiallyEstablished?: boolean;
  actionStartX?: number;
  shiftPerDelay?: number;
};

export const MG_ActionDelay = ({
  delayLabels = ['等会儿', '明天', '状态好一点'],
  currentDelayIndex,
  intentLabel = '意图：我要做',
  actionLabel = '执行',
  showPossibleStructure = true,
  showDebugLabel = false,
  initiallyEstablished = false,
  actionStartX = 1030,
  shiftPerDelay = 190,
}: ActionDelayProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const reasonStart = 1.25;
  const eventGap = 1.05;
  const eventDuration = motionTiming.fast;
  const progresses = delayLabels.map((_, index) =>
    currentDelayIndex === undefined
      ? safeInterpolate(
          frame,
          [atFrame(reasonStart + index * eventGap, fps), atFrame(reasonStart + index * eventGap + eventDuration, fps)],
          [0, 1],
        )
      : index <= currentDelayIndex
        ? 1
        : 0,
  );
  const totalShift = progresses.reduce((sum, value) => sum + value, 0) * shiftPerDelay;
  const actionX = actionStartX + totalShift;
  const established = initiallyEstablished || currentDelayIndex !== undefined;
  const personScale = established ? 1 : calmSpring(frame, fps, 0, {damping: 31, stiffness: 175});
  const intentScale = established
    ? 1
    : calmSpring(frame, fps, atFrame(0.05, fps), {damping: 31, stiffness: 175});
  const pathProgress = established
    ? 1
    : drawProgress(frame, atFrame(0.25, fps), atFrame(motionTiming.pathDraw, fps));
  const actionScale = established
    ? 1
    : calmSpring(frame, fps, atFrame(0.68, fps), {damping: 32, stiffness: 190});

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_ActionDelay
        </Label>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: 1510,
          top: 235,
          width: lineWidth.normal,
          height: 510,
          backgroundColor: colors.muted,
        }}
      />
      <Label x={1280} y={185} tone="gray" style={{fontSize: 22}}>
        当前可执行范围
      </Label>
      <IntentPathLayout
        intentLabel={intentLabel}
        actionLabel={actionLabel}
        personScale={personScale}
        intentScale={intentScale}
        actionScale={actionScale}
        pathProgress={pathProgress}
        actionX={actionX}
        actionOpacity={safeInterpolate(
          actionX,
          [actionStartX, actionStartX + shiftPerDelay * delayLabels.length],
          [1, 0.76],
        )}
      />

      {delayLabels.map((label, index) => {
        const opacity = currentDelayIndex === undefined
          ? fadeIn(frame, atFrame(reasonStart + index * eventGap, fps), atFrame(0.22, fps))
          : index <= currentDelayIndex
            ? 1
            : 0;
        return (
          <div
            key={`${label}-${index}`}
            style={{position: 'absolute', left: actionStartX + 25 + index * shiftPerDelay, top: 265, opacity}}
          >
            <Typography variant="SmallLabel" color={colors.secondary}>
              {label}
            </Typography>
            <div style={{width: 1, height: 58, margin: '12px auto 0', backgroundColor: colors.muted}} />
          </div>
        );
      })}

      <Label x={1380} y={700} tone="gray" opacity={fadeIn(frame, atFrame(4.15, fps), atFrame(0.3, fps))}>
        行动仍在，只是被推到以后
      </Label>
      {showPossibleStructure ? (
        <Label x={96} y={978} tone="gray" opacity={0.72} style={{letterSpacing: 1.4}}>
          一种可能的结构
        </Label>
      ) : null}
    </AbsoluteFill>
  );
};

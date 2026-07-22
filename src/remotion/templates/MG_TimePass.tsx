import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {Timeline} from '../components/Timeline';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn} from '../utils/motion';

export type TimePassProps = {
  markers?: string[];
  currentIndex?: number;
  pendingLabel?: string;
  showPendingNode?: boolean;
  highlightLast?: boolean;
  showDebugLabel?: boolean;
};

export const MG_TimePass = ({
  markers = ['现在', '几小时', '一天', '两天'],
  currentIndex,
  pendingLabel = '未回复',
  showPendingNode = true,
  highlightLast = true,
  showDebugLabel = false,
}: TimePassProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const lineProgress = drawProgress(frame, atFrame(0.08, fps), atFrame(motionTiming.pathDraw, fps));
  const automaticIndex = Math.min(
    markers.length - 1,
    Math.max(0, Math.floor((frame - atFrame(0.62, fps)) / atFrame(0.48, fps))),
  );
  const activeIndex = Math.max(0, Math.min(currentIndex ?? automaticIndex, markers.length - 1));
  const startX = 280;
  const width = 1360;
  const step = markers.length > 1 ? width / (markers.length - 1) : 0;

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_TimePass
        </Label>
      ) : null}
      <Timeline x={startX} y={430} width={width} progress={lineProgress} />

      {markers.map((marker, index) => {
        const x = startX + step * index;
        const reached = index <= activeIndex;
        const isLast = index === markers.length - 1 && highlightLast && reached;
        const scale = calmSpring(
          frame,
          fps,
          atFrame(0.52 + index * 0.48, fps),
          {damping: 31, stiffness: 190},
        );
        return (
          <div key={`${marker}-${index}`}>
            <div
              style={{
                position: 'absolute',
                left: x - 9,
                top: 430,
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: `${lineWidth.normal}px solid ${isLast ? colors.accent : colors.primary}`,
                backgroundColor: reached ? (isLast ? colors.accent : colors.primary) : colors.background,
                opacity: reached ? 1 : 0.3,
                transform: `scale(${scale})`,
              }}
            />
            <Typography
              variant="SmallLabel"
              color={isLast ? colors.accent : reached ? colors.primary : colors.secondary}
              style={{position: 'absolute', left: x - 90, top: 485, width: 180, textAlign: 'center'}}
            >
              {marker}
            </Typography>
          </div>
        );
      })}

      {showPendingNode ? (
        <div style={{position: 'absolute', left: startX - 80, top: 635, width: 250}}>
          <div
            style={{
              position: 'absolute',
              left: 72,
              top: -115,
              width: lineWidth.normal,
              height: 90,
              backgroundColor: colors.accentSoft,
              opacity: 0.75,
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 64,
              top: 0,
              width: 18,
              height: 18,
              borderRadius: '50%',
              backgroundColor: colors.accent,
              opacity: fadeIn(frame, atFrame(0.48, fps), atFrame(0.25, fps)),
            }}
          />
          <Typography variant="BodyLabel" color={colors.accent} style={{position: 'absolute', left: 42, top: -13}}>
            {pendingLabel}
          </Typography>
        </div>
      ) : null}

      <Label x={650} y={835} tone="gray" style={{width: 620, textAlign: 'center'}}>
        时间向前，事情仍停在原处
      </Label>
    </AbsoluteFill>
  );
};

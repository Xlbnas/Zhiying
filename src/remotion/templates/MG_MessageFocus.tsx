import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {FrameBox} from '../components/FrameBox';
import {Label} from '../components/Label';
import {Person} from '../components/Person';
import {QuestionText} from '../components/QuestionText';
import {Typography} from '../design/typography';
import {borderRadius, colors, lineWidth, spacing} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, fadeIn, safeInterpolate} from '../utils/motion';

export type MessageFocusProps = {
  messages?: string[];
  targetIndex?: number;
  targetText?: string;
  focusProgress?: number;
  dimOthers?: boolean;
  showRedDot?: boolean;
  showSubject?: boolean;
  questionText?: string;
  showDebugLabel?: boolean;
};

const defaultMessages = ['项目更新已收到', '今晚要不要吃饭？', '周五会议改到三点', '照片发你了'];

export const MG_MessageFocus = ({
  messages = defaultMessages,
  targetIndex = 1,
  targetText = '我们谈谈吧。',
  focusProgress,
  dimOthers = true,
  showRedDot = true,
  showSubject = true,
  questionText = '为什么偏偏是这一条？',
  showDebugLabel = false,
}: MessageFocusProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const reveal = fadeIn(frame, 0, atFrame(0.22, fps));
  const targetReveal = calmSpring(frame, fps, atFrame(0.18, fps), {damping: 30});
  const focus =
    focusProgress ??
    safeInterpolate(
      frame,
      [atFrame(0.22, fps), atFrame(0.22 + motionTiming.dim, fps)],
      [0, 1],
    );
  const dotScale = calmSpring(frame, fps, atFrame(0.66, fps), {damping: 32, stiffness: 170});
  const questionOpacity = fadeIn(frame, atFrame(1.02, fps), atFrame(0.34, fps));
  const fullMessages = messages.map((message, index) =>
    index === targetIndex ? targetText : message,
  );

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{letterSpacing: 2.4}}>
          DEBUG · MG_MessageFocus
        </Label>
      ) : null}
      <FrameBox x={365} y={158} width={1190} height={720} mode="modern">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingBottom: spacing.sm,
            borderBottom: `${lineWidth.hairline}px solid ${colors.muted}`,
            opacity: reveal,
          }}
        >
          <Typography variant="SmallLabel" color={colors.secondary}>
            MESSAGES
          </Typography>
          <div style={{display: 'flex', gap: 8}}>
            {[0, 1, 2].map((dot) => (
              <div
                key={dot}
                style={{width: 6, height: 6, borderRadius: '50%', backgroundColor: colors.muted}}
              />
            ))}
          </div>
        </div>

        <div style={{position: 'relative', height: 590, marginTop: spacing.sm}}>
          {fullMessages.map((message, index) => {
            const isTarget = index === targetIndex;
            const baseY = index * 124;
            const focusedY = 190;
            const y = isTarget ? safeInterpolate(focus, [0, 1], [baseY, focusedY]) : baseY;
            const rowOpacity = isTarget
              ? targetReveal
              : dimOthers
                ? safeInterpolate(focus, [0, 1], [0.82, 0.08])
                : 0.82;
            const scale = isTarget ? safeInterpolate(focus, [0, 1], [1, 1.045]) : 1;

            return (
              <div
                key={`${message}-${index}`}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: y,
                  height: 92,
                  display: 'flex',
                  alignItems: 'center',
                  gap: spacing.sm,
                  padding: `0 ${spacing.md}px`,
                  boxSizing: 'border-box',
                  borderRadius: borderRadius.md,
                  border: `${isTarget ? lineWidth.normal : lineWidth.hairline}px solid ${
                    isTarget ? colors.accentSoft : colors.muted
                  }`,
                  backgroundColor: isTarget ? `${colors.accent}0D` : colors.surfaceRaised,
                  opacity: rowOpacity,
                  transform: `scale(${scale})`,
                }}
              >
                <div
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: '50%',
                    border: `${lineWidth.normal}px solid ${isTarget ? colors.accent : colors.secondary}`,
                  }}
                />
                <Typography variant="BodyLabel" color={isTarget ? colors.primary : colors.secondary}>
                  {message}
                </Typography>
                {isTarget && showRedDot ? (
                  <div
                    style={{
                      marginLeft: 'auto',
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: colors.accent,
                      transform: `scale(${dotScale})`,
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </FrameBox>

      {showSubject ? (
        <Person
          x={205}
          y={420}
          size={118}
          opacity={safeInterpolate(focus, [0.18, 0.62], [0, 1])}
        />
      ) : null}
      <QuestionText y={906} opacity={questionOpacity} scale={safeInterpolate(questionOpacity, [0, 1], [0.98, 1])}>
        {questionText}
      </QuestionText>
    </AbsoluteFill>
  );
};

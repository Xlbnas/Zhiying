import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {Person} from '../components/Person';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn, safeInterpolate} from '../utils/motion';

export type InwardQuestionProps = {
  outwardLabel?: string;
  inwardQuestion?: string;
  showOtherPerson?: boolean;
  showDebugLabel?: boolean;
};

export const MG_InwardQuestion = ({
  outwardLabel = '他真正怎么想？',
  inwardQuestion = '我为什么总是在这里停下来？',
  showOtherPerson = true,
  showDebugLabel = false,
}: InwardQuestionProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const directInward = !showOtherPerson;
  const outwardProgress = directInward
    ? 0
    : drawProgress(frame, atFrame(0.2, fps), atFrame(motionTiming.pathDraw, fps));
  const outwardOpacity = directInward
    ? 0
    : safeInterpolate(frame, [atFrame(1.55, fps), atFrame(2.12, fps)], [1, 0]);
  const otherOpacity = showOtherPerson
    ? safeInterpolate(frame, [atFrame(1.75, fps), atFrame(2.45, fps)], [1, 0])
    : 0;
  const inwardStart = directInward ? 0.25 : 1.95;
  const inwardProgress = drawProgress(frame, atFrame(inwardStart, fps), atFrame(0.75, fps));
  const questionOpacity = fadeIn(frame, atFrame(directInward ? 0.72 : 2.42, fps), atFrame(0.38, fps));
  const personScale = calmSpring(frame, fps, 0, {damping: 32, stiffness: 180});
  const outwardLabelOpacity = directInward
    ? 0
    : fadeIn(frame, atFrame(0.32, fps), atFrame(0.3, fps)) * outwardOpacity;

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_InwardQuestion
        </Label>
      ) : null}
      <Person x={570} y={350} size={165} scale={personScale} />
      {showOtherPerson ? (
        <Person x={1280} y={350} size={165} color={colors.primary} opacity={otherOpacity} />
      ) : null}

      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <defs>
          <marker id="arrow-white" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.primary} />
          </marker>
          <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={colors.accent} />
          </marker>
        </defs>
        <line
          x1={750}
          y1={450}
          x2={1220}
          y2={450}
          stroke={colors.primary}
          strokeWidth={lineWidth.normal}
          strokeDasharray={470}
          strokeDashoffset={470 * (1 - outwardProgress)}
          opacity={outwardOpacity}
          markerEnd="url(#arrow-white)"
        />
        <path
          d="M 690 520 C 870 720, 540 790, 620 560"
          fill="none"
          stroke={colors.accent}
          strokeWidth={lineWidth.normal}
          strokeDasharray={580}
          strokeDashoffset={580 * (1 - inwardProgress)}
          opacity={inwardProgress}
          markerEnd="url(#arrow-red)"
        />
      </svg>

      <Typography
        variant="SectionTitle"
        color={colors.primary}
        style={{position: 'absolute', left: 720, right: 300, top: 220, textAlign: 'center', opacity: outwardLabelOpacity}}
      >
        {outwardLabel}
      </Typography>
      <Typography
        variant="SectionTitle"
        color={colors.primary}
        style={{
          position: 'absolute',
          left: 390,
          top: 780,
          width: 900,
          textAlign: 'center',
          opacity: questionOpacity,
        }}
      >
        {inwardQuestion}
      </Typography>
      <Label x={565} y={920} tone="gray" opacity={questionOpacity * 0.75} style={{width: 520, textAlign: 'center'}}>
        向内的问题，不是向外的读心术
      </Label>
    </AbsoluteFill>
  );
};

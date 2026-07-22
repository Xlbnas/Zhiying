import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {NotEqual} from '../components/NotEqual';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn} from '../utils/motion';

export type WorthQuestioningProps = {
  clues?: string[];
  questionLabel?: string;
  proofLabel?: string;
  showBoundary?: boolean;
  showDebugLabel?: boolean;
};

export const MG_WorthQuestioning = ({
  clues = ['反复发生？', '总在同类任务？', '总卡在最后一步？'],
  questionLabel = '值得追问',
  proofLabel = '已经证明',
  showBoundary = true,
  showDebugLabel = false,
}: WorthQuestioningProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const mergeProgress = drawProgress(frame, atFrame(0.72, fps), atFrame(0.5, fps));
  const questionScale = calmSpring(frame, fps, atFrame(1.05, fps), {damping: 32, stiffness: 185});
  const boundaryOpacity = showBoundary
    ? fadeIn(frame, atFrame(1.72, fps), atFrame(motionTiming.notEqualEnter, fps))
    : 0;

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_WorthQuestioning
        </Label>
      ) : null}
      {clues.map((clue, index) => {
        const y = 280 + index * 180;
        const opacity = fadeIn(frame, atFrame(0.12 + index * 0.18, fps), atFrame(0.24, fps));
        return (
          <div key={`${clue}-${index}`}>
            <div
              style={{
                position: 'absolute',
                left: 210,
                top: y + 14,
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: `${lineWidth.normal}px solid ${colors.secondary}`,
                opacity,
              }}
            />
            <Typography
              variant="SmallLabel"
              color={colors.secondary}
              style={{position: 'absolute', left: 260, top: y, opacity}}
            >
              {clue}
            </Typography>
            <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: 0.55}}>
              <line
                x1={540}
                y1={y + 24}
                x2={820}
                y2={500}
                stroke={colors.secondary}
                strokeWidth={lineWidth.hairline}
                strokeDasharray={330}
                strokeDashoffset={330 * (1 - mergeProgress)}
              />
            </svg>
          </div>
        );
      })}

      <div
        style={{
          position: 'absolute',
          left: 760,
          top: 430,
          width: 330,
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: `2px solid ${colors.research}`,
          borderBottom: `1px solid ${colors.muted}`,
          transform: `scale(${questionScale})`,
        }}
      >
        <Typography variant="SectionTitle" color={colors.research}>
          {questionLabel}
        </Typography>
      </div>

      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <line
          x1={1090}
          y1={500}
          x2={1230}
          y2={500}
          stroke={colors.secondary}
          strokeWidth={lineWidth.normal}
          strokeDasharray="10 15"
          opacity={fadeIn(frame, atFrame(1.25, fps), atFrame(0.3, fps)) * 0.45}
        />
      </svg>
      <NotEqual x={1120} y={390} scale={0.72} opacity={boundaryOpacity} />

      <div
        style={{
          position: 'absolute',
          left: 1430,
          top: 430,
          width: 330,
          height: 140,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: `2px solid ${colors.primary}`,
          borderBottom: `1px solid ${colors.muted}`,
          opacity: fadeIn(frame, atFrame(0.45, fps), atFrame(0.35, fps)),
        }}
      >
        <Typography variant="SectionTitle" color={colors.primary}>
          {proofLabel}
        </Typography>
      </div>
      <Label x={640} y={820} tone="gray" opacity={boundaryOpacity} style={{width: 640, textAlign: 'center'}}>
        观察线索可以提出问题，不能自动完成因果证明
      </Label>
    </AbsoluteFill>
  );
};

import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {DashedPath} from '../components/DashedPath';
import {IntentPathLayout} from '../components/IntentPathLayout';
import {Label} from '../components/Label';
import {Node} from '../components/Node';
import {colors} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn, safeInterpolate} from '../utils/motion';

export type IntentConflictProps = {
  intentLabel?: string;
  actionLabel?: string;
  conflictLabel?: string;
  showConflict?: boolean;
  interferenceStrength?: number;
  showPossibleOutcomes?: boolean;
  showFrameworkBoundary?: boolean;
  showDebugLabel?: boolean;
  initiallyEstablished?: boolean;
};

export const MG_IntentConflict = ({
  intentLabel = '意图：我要做',
  actionLabel = '执行',
  conflictLabel = '反向意愿：我不想面对结果',
  showConflict = true,
  interferenceStrength = 0.72,
  showPossibleOutcomes = true,
  showFrameworkBoundary = true,
  showDebugLabel = false,
  initiallyEstablished = false,
}: IntentConflictProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const personScale = initiallyEstablished
    ? 1
    : calmSpring(frame, fps, 0, {damping: 30, stiffness: 160});
  const intentScale = initiallyEstablished
    ? 1
    : calmSpring(frame, fps, atFrame(0.08, fps), {damping: 30, stiffness: 160});
  const pathProgress = initiallyEstablished
    ? 1
    : drawProgress(frame, atFrame(0.32, fps), atFrame(motionTiming.pathDraw, fps));
  const actionScale = initiallyEstablished
    ? 1
    : calmSpring(frame, fps, atFrame(0.7, fps), {damping: 32, stiffness: 180});
  const conflictProgress = showConflict
    ? drawProgress(
        frame,
        atFrame(1.45, fps),
        atFrame(motionTiming.interferenceDraw, fps),
      )
    : 0;
  const interference = safeInterpolate(
    frame,
    [atFrame(2.08, fps), atFrame(2.53, fps)],
    [0, interferenceStrength],
  );
  const actionX = 1290 + interference * 150;
  const impactOpacity = safeInterpolate(
    frame,
    [atFrame(1.92, fps), atFrame(2.08, fps), atFrame(2.42, fps)],
    [0, 0.8, 0],
  );

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{letterSpacing: 2.4}}>
          DEBUG · MG_IntentConflict
        </Label>
      ) : null}

      <IntentPathLayout
        intentLabel={intentLabel}
        actionLabel={actionLabel}
        personScale={personScale}
        intentScale={intentScale}
        actionScale={actionScale}
        pathProgress={pathProgress}
        actionX={actionX}
        actionOpacity={safeInterpolate(interference, [0, 1], [1, 0.72])}
      />

      {showConflict ? (
        <>
          <Label
            x={650}
            y={620}
            tone="red"
            opacity={fadeIn(frame, atFrame(1.22, fps), atFrame(0.28, fps)) * 0.76}
            style={{
              padding: '10px 16px',
              borderLeft: `2px solid ${colors.accent}`,
              backgroundColor: `${colors.accent}0D`,
              borderRadius: 6,
              fontSize: 24,
            }}
          >
            {conflictLabel}
          </Label>
          <DashedPath
            x1={930}
            y1={650}
            x2={1115}
            y2={406}
            progress={conflictProgress}
            opacity={0.48}
          />
          <div
            style={{
              position: 'absolute',
              left: 1107,
              top: 398,
              width: 16,
              height: 16,
              borderRadius: '50%',
              backgroundColor: colors.accent,
              opacity: impactOpacity,
            }}
          />
        </>
      ) : null}

      {showPossibleOutcomes ? (
        <div
          style={{
            position: 'absolute',
            left: 1120,
            top: 550,
            display: 'flex',
            gap: 22,
          }}
        >
          {['拖延？', '失误？', '遗忘？'].map((label, index) => (
            <Node
              key={label}
              label={label}
              x={0}
              y={0}
              width={170}
              height={66}
              color={colors.secondary}
              dimmed
              shape="pill"
              style={{
                position: 'relative',
                left: undefined,
                top: undefined,
                opacity: showPossibleOutcomes
                  ? fadeIn(frame, atFrame(2.7 + index * 0.2, fps), atFrame(0.22, fps)) * 0.72
                  : 0,
              }}
            />
          ))}
        </div>
      ) : null}

      {showFrameworkBoundary ? (
        <Label
          x={96}
          y={978}
          tone="gray"
          opacity={fadeIn(frame, atFrame(3.2, fps), atFrame(0.35, fps))}
          style={{letterSpacing: 1.6}}
        >
          一种解释框架 · 不是事实判决
        </Label>
      ) : null}
    </AbsoluteFill>
  );
};

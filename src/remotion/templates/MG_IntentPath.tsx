import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {IntentPathLayout} from '../components/IntentPathLayout';
import {Label} from '../components/Label';
import {atFrame, motionTiming} from '../design/motion';
import {colors} from '../design/tokens';
import {calmSpring, drawProgress} from '../utils/motion';

export type IntentPathProps = {
  intentLabel?: string;
  actionLabel?: string;
  showPerson?: boolean;
  pathProgress?: number;
  showDebugLabel?: boolean;
  initiallyEstablished?: boolean;
};

export const MG_IntentPath = ({
  intentLabel = '意图：我要做',
  actionLabel = '执行',
  showPerson = true,
  pathProgress,
  showDebugLabel = false,
  initiallyEstablished = false,
}: IntentPathProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const personScale = initiallyEstablished
    ? 1
    : calmSpring(frame, fps, 0, {damping: 31, stiffness: 175});
  const intentScale = initiallyEstablished
    ? 1
    : calmSpring(frame, fps, atFrame(0.06, fps), {damping: 31, stiffness: 175});
  const path =
    pathProgress ??
    (initiallyEstablished
      ? 1
      : drawProgress(frame, atFrame(0.3, fps), atFrame(motionTiming.pathDraw, fps)));
  const actionScale = initiallyEstablished
    ? 1
    : calmSpring(frame, fps, atFrame(0.72, fps), {damping: 32, stiffness: 190});

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_IntentPath
        </Label>
      ) : null}
      <IntentPathLayout
        intentLabel={intentLabel}
        actionLabel={actionLabel}
        showPerson={showPerson}
        personScale={personScale}
        intentScale={intentScale}
        actionScale={actionScale}
        pathProgress={path}
      />
      <Label x={760} y={650} tone="gray" style={{width: 400, textAlign: 'center'}}>
        计划已经形成
      </Label>
    </AbsoluteFill>
  );
};

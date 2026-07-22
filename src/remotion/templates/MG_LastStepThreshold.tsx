import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame} from '../design/motion';
import {calmSpring, drawProgress, fadeIn} from '../utils/motion';

export type LastStepThresholdProps = {
  steps?: string[];
  progress?: number;
  lastStepLabel?: string;
  consequenceLabels?: string[];
  showConsequences?: boolean;
  showPossibilityLabel?: boolean;
  showDebugLabel?: boolean;
};

export const MG_LastStepThreshold = ({
  steps = ['准备', '草稿', '修改', '完成'],
  progress,
  lastStepLabel = '发送',
  consequenceLabels = ['评价？', '拒绝？', '冲突？'],
  showConsequences = true,
  showPossibilityLabel = true,
  showDebugLabel = false,
}: LastStepThresholdProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const completedProgress =
    progress ?? drawProgress(frame, atFrame(0.05, fps), atFrame(0.95, fps)) * 0.95;
  const thresholdOpacity = fadeIn(frame, atFrame(0.8, fps), atFrame(0.24, fps));
  const consequencesOpacity = showConsequences
    ? fadeIn(frame, atFrame(1.55, fps), atFrame(0.3, fps))
    : 0;
  const startX = 210;
  const stepGap = 245;
  const lineEnd = 1120;

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={72} tone="gray" style={{fontSize: 20}}>
          MG_LastStepThreshold
        </Label>
      ) : null}
      <Label x={170} y={210} tone="gray" style={{letterSpacing: 1.5}}>
        任务完成区
      </Label>
      <Label x={1350} y={210} tone="gray" style={{letterSpacing: 1.5}}>
        现实后果区
      </Label>

      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <line x1={startX} y1={490} x2={lineEnd} y2={490} stroke={colors.muted} strokeWidth={2} />
        <line
          x1={startX}
          y1={490}
          x2={startX + (lineEnd - startX) * Math.min(completedProgress / 0.95, 1)}
          y2={490}
          stroke={colors.primary}
          strokeWidth={3}
        />
        <line
          x1={1195}
          y1={275}
          x2={1195}
          y2={755}
          stroke={colors.accent}
          strokeWidth={lineWidth.emphasis}
          opacity={thresholdOpacity}
        />
      </svg>

      {steps.map((step, index) => {
        const x = startX + stepGap * index;
        const check = calmSpring(frame, fps, atFrame(0.18 + index * 0.16, fps), {
          damping: 32,
          stiffness: 190,
        });
        return (
          <div key={`${step}-${index}`}>
            <div
              style={{
                position: 'absolute',
                left: x - 15,
                top: 475,
                width: 30,
                height: 30,
                borderRadius: '50%',
                backgroundColor: colors.primary,
                transform: `scale(${check})`,
              }}
            />
            <Typography
              variant="SmallLabel"
              color={colors.primary}
              style={{position: 'absolute', left: x - 80, top: 545, width: 160, textAlign: 'center'}}
            >
              {step}
            </Typography>
          </div>
        );
      })}

      <Typography
        variant="SectionTitle"
        color={colors.primary}
        style={{position: 'absolute', left: 1015, top: 380, opacity: thresholdOpacity}}
      >
        95%
      </Typography>
      <div
        style={{
          position: 'absolute',
          left: 1248,
          top: 425,
          width: 150,
          height: 128,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `${lineWidth.emphasis}px solid ${colors.accent}`,
          borderRadius: '50%',
          opacity: thresholdOpacity,
        }}
      >
        <Typography variant="BodyLabel" color={colors.accent} style={{textAlign: 'center'}}>
          {lastStepLabel}
        </Typography>
      </div>
      <Label x={1205} y={590} tone="red" opacity={thresholdOpacity} style={{width: 240, textAlign: 'center'}}>
        最后一步 · 未触发
      </Label>

      <div style={{position: 'absolute', left: 1500, top: 330, opacity: consequencesOpacity}}>
        {consequenceLabels.map((label, index) => (
          <Typography
            key={`${label}-${index}`}
            variant="BodyLabel"
            color={colors.secondary}
            style={{marginBottom: 72, opacity: fadeIn(frame, atFrame(1.55 + index * 0.18, fps), atFrame(0.22, fps))}}
          >
            {label.endsWith('？') ? label : `${label}？`}
          </Typography>
        ))}
      </div>

      {showPossibilityLabel ? (
        <Label x={1500} y={760} tone="gray" opacity={consequencesOpacity * 0.75} style={{fontSize: 22}}>
          一种可能
        </Label>
      ) : null}
    </AbsoluteFill>
  );
};

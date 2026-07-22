import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {NotEqual} from '../components/NotEqual';
import {Typography} from '../design/typography';
import {colors} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, fadeIn, safeInterpolate} from '../utils/motion';

export type ConceptSeparationProps = {
  leftConcept?: string;
  rightConcept?: string;
  centerSymbol?: '≠';
  leftColor?: string;
  rightColor?: string;
  annotation?: string;
  mode?: 'research-vs-freud' | 'question-vs-proof' | 'appointment-vs-love' | 'framework-vs-fact';
  showDebugLabel?: boolean;
};

const modeDefaults: Record<
  NonNullable<ConceptSeparationProps['mode']>,
  {left: string; right: string; annotation: string}
> = {
  'research-vs-freud': {
    left: '主动检索抑制',
    right: '反向意愿',
    annotation: '概念边界 · 不能互相替换',
  },
  'question-vs-proof': {
    left: '值得追问',
    right: '已经证明',
    annotation: '线索不是因果证据',
  },
  'appointment-vs-love': {
    left: '忘记赴约',
    right: '不爱',
    annotation: '一次行为不能自动测出关系真假',
  },
  'framework-vs-fact': {
    left: '解释框架',
    right: '已判明事实',
    annotation: '保持不确定性',
  },
};

export const MG_ConceptSeparation = ({
  leftConcept,
  rightConcept,
  centerSymbol = '≠',
  leftColor = colors.research,
  rightColor = colors.primary,
  annotation,
  mode = 'question-vs-proof',
  showDebugLabel = false,
}: ConceptSeparationProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const defaults = modeDefaults[mode];
  const left = leftConcept ?? defaults.left;
  const right = rightConcept ?? defaults.right;
  const note = annotation ?? defaults.annotation;
  const conceptsOpacity = fadeIn(frame, atFrame(0.08, fps), atFrame(motionTiming.fast, fps));
  const conceptOffset = safeInterpolate(conceptsOpacity, [0, 1], [18, 0]);
  const symbolScale = calmSpring(frame, fps, atFrame(0.82, fps), {damping: 30, stiffness: 190});
  const symbolOpacity = fadeIn(frame, atFrame(0.78, fps), atFrame(motionTiming.notEqualEnter, fps));
  const noteOpacity = fadeIn(frame, atFrame(1.25, fps), atFrame(0.32, fps));

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={70} tone="gray" style={{letterSpacing: 2.4}}>
          DEBUG · MG_ConceptSeparation
        </Label>
      ) : null}

      <div
        style={{
          position: 'absolute',
          left: 150,
          top: 250,
          width: 610,
          height: 430,
          borderTop: `2px solid ${colors.researchSoft}`,
          borderBottom: `1px solid ${colors.muted}`,
          opacity: conceptsOpacity,
          transform: `translateY(${conceptOffset}px)`,
        }}
      >
        <Typography
          variant="SectionTitle"
          color={leftColor}
          style={{height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center'}}
        >
          {left}
        </Typography>
      </div>

      <NotEqual x={830} y={360} scale={symbolScale} opacity={symbolOpacity} />

      <div
        style={{
          position: 'absolute',
          left: 1160,
          top: 250,
          width: 610,
          height: 430,
          borderTop: `2px solid ${colors.primary}`,
          borderBottom: `1px solid ${colors.muted}`,
          opacity: conceptsOpacity,
          transform: `translateY(${conceptOffset}px)`,
        }}
      >
        <Typography
          variant="SectionTitle"
          color={rightColor}
          style={{height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center'}}
        >
          {right}
        </Typography>
      </div>

      <Label
        x={510}
        y={815}
        tone="gray"
        opacity={noteOpacity}
        style={{width: 900, textAlign: 'center', letterSpacing: 1.8}}
      >
        {centerSymbol} · {note}
      </Label>
    </AbsoluteFill>
  );
};

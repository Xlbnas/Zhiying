import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {Node} from '../components/Node';
import {PathLine} from '../components/PathLine';
import {Typography} from '../design/typography';
import {colors} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {calmSpring, drawProgress, fadeIn, safeInterpolate} from '../utils/motion';

export type ThinkNoThinkProps = {
  cueLabel?: string;
  memoryLabel?: string;
  suppressionProgress?: number;
  showResult?: boolean;
  showDebugLabel?: boolean;
  showBoundaryComparison?: boolean;
};

export const MG_ThinkNoThink = ({
  cueLabel = '提示',
  memoryLabel = '目标记忆',
  suppressionProgress,
  showResult = true,
  showDebugLabel = false,
  showBoundaryComparison = false,
}: ThinkNoThinkProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const cueScale = calmSpring(frame, fps, atFrame(0.05, fps), {damping: 31, stiffness: 180});
  const pathProgress = drawProgress(frame, atFrame(0.28, fps), atFrame(motionTiming.pathDraw, fps));
  const memoryScale = calmSpring(frame, fps, atFrame(0.62, fps), {damping: 32, stiffness: 185});
  const suppress =
    suppressionProgress ?? safeInterpolate(frame, [atFrame(0.94, fps), atFrame(1.55, fps)], [0, 1]);
  const resultOpacity = showResult ? fadeIn(frame, atFrame(2.15, fps), atFrame(0.4, fps)) : 0;
  const boundaryOpacity = showBoundaryComparison
    ? fadeIn(frame, atFrame(2.65, fps), atFrame(0.4, fps))
    : 0;
  const memoryOpacity = safeInterpolate(suppress, [0, 1], [1, 0.44]);

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={70} tone="gray" style={{letterSpacing: 2.4}}>
          DEBUG · MG_ThinkNoThink
        </Label>
      ) : null}
      <Label x={96} y={76} tone="blue" opacity={0.72} style={{fontSize: 22}}>
        现代研究
      </Label>
      <div
        style={{
          position: 'absolute',
          left: 960,
          top: 170,
          width: 1,
          height: 560,
          backgroundColor: colors.researchSoft,
          opacity: 0.7,
        }}
      />

      <Label x={150} y={190} tone="blue" style={{letterSpacing: 2}}>
        THINK · 主动回忆
      </Label>
      <Node label={cueLabel} x={180} y={360} width={210} color={colors.research} scale={cueScale} />
      <PathLine x1={390} y1={406} x2={670} y2={406} progress={pathProgress} color={colors.research} />
      <Node label={memoryLabel} x={670} y={360} width={230} color={colors.primary} scale={memoryScale} />
      <Label x={330} y={540} tone="gray" opacity={fadeIn(frame, atFrame(0.75, fps), atFrame(0.3, fps))}>
        提示 → 目标记忆 → 主动回忆
      </Label>

      <Label x={1065} y={190} tone="blue" style={{letterSpacing: 2}}>
        NO-THINK · 阻止检索
      </Label>
      <Node label={cueLabel} x={1095} y={360} width={210} color={colors.research} scale={cueScale} />
      <PathLine
        x1={1305}
        y1={406}
        x2={1580}
        y2={406}
        progress={pathProgress}
        color={colors.research}
        opacity={safeInterpolate(suppress, [0, 1], [1, 0.3])}
      />
      <div
        style={{
          position: 'absolute',
          left: 1438,
          top: 348,
          width: 7,
          height: 116,
          backgroundColor: colors.research,
          opacity: safeInterpolate(suppress, [0.06, 0.45], [0, 1]),
        }}
      />
      <Node
        label={memoryLabel}
        x={1580}
        y={360}
        width={230}
        color={colors.primary}
        scale={memoryScale}
        style={{opacity: memoryOpacity}}
      />
      <Label x={1198} y={540} tone="gray" opacity={fadeIn(frame, atFrame(1.2, fps), atFrame(0.3, fps))}>
        记忆仍在 · 可及性降低
      </Label>

      <div
        style={{
          position: 'absolute',
          left: 310,
          right: 310,
          top: 775,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 56,
          opacity: boundaryOpacity,
        }}
      >
        <Typography variant="BodyLabel" color={colors.research}>
          主动检索抑制
        </Typography>
        <Typography variant="Title" color={colors.accent} style={{fontSize: 92}}>
          ≠
        </Typography>
        <Typography variant="BodyLabel" color={colors.primary}>
          弗洛伊德式反向意愿
        </Typography>
      </div>
      {showResult ? (
        <Label
          x={610}
          y={showBoundaryComparison ? 930 : 820}
          tone="gray"
          opacity={resultOpacity}
          style={{width: 700, textAlign: 'center', fontSize: 22}}
        >
          {showBoundaryComparison
            ? '实验结果提供线索，但不能替换概念边界'
            : '一些研究观察到：后续记忆表现可能受到影响'}
        </Label>
      ) : null}
    </AbsoluteFill>
  );
};

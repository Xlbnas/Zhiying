import type {CSSProperties} from 'react';
import {AbsoluteFill, interpolateColors, useCurrentFrame, useVideoConfig} from 'remotion';
import {Label} from '../components/Label';
import {Typography} from '../design/typography';
import {colors, lineWidth} from '../design/tokens';
import {atFrame, motionTiming} from '../design/motion';
import {fadeIn, safeInterpolate} from '../utils/motion';

export type LocalConflictSpreadProps = {
  primaryMessage?: string;
  otherMessages?: string[];
  spreadProgress?: number;
  freezeProgress?: number;
  historicalMode?: boolean;
  showDebugLabel?: boolean;
  showMessageLabels?: boolean;
};

const positions = [
  {x: 310, y: 235},
  {x: 735, y: 165},
  {x: 1310, y: 240},
  {x: 260, y: 690},
  {x: 755, y: 790},
  {x: 1390, y: 670},
];

const connections = [
  [390, 290, 850, 475],
  [815, 225, 900, 450],
  [1390, 300, 1060, 470],
  [350, 745, 850, 560],
  [835, 845, 920, 590],
  [1470, 725, 1065, 555],
] as const;

const LetterNode = ({
  x,
  y,
  label,
  color,
  opacity,
  translateY,
  primary = false,
  showLabel = true,
}: {
  x: number;
  y: number;
  label: string;
  color: string;
  opacity: number;
  translateY: number;
  primary?: boolean;
  showLabel?: boolean;
}) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      width: primary ? 340 : 230,
      opacity,
      transform: `translateY(${translateY}px)`,
    }}
  >
    <svg width={primary ? 92 : 70} height={primary ? 66 : 52} viewBox="0 0 92 66">
      <rect
        x="2"
        y="2"
        width="88"
        height="62"
        rx="6"
        fill={`${color}0A`}
        stroke={color}
        strokeWidth={primary ? 3 : 2}
      />
      <path d="M4 8 L46 39 L88 8" fill="none" stroke={color} strokeWidth={primary ? 3 : 2} />
    </svg>
    {showLabel ? (
      <Typography
        variant={primary ? 'BodyLabel' : 'SmallLabel'}
        color={color}
        style={{position: 'absolute', left: primary ? 112 : 86, top: primary ? 10 : 8, whiteSpace: 'nowrap'}}
      >
        {label}
      </Typography>
    ) : null}
  </div>
);

export const MG_LocalConflictSpread = ({
  primaryMessage = '重要来信',
  otherMessages = ['普通信件 A', '普通信件 B', '普通信件 C', '普通信件 D', '普通信件 E', '普通信件 F'],
  spreadProgress,
  freezeProgress,
  historicalMode = true,
  showDebugLabel = false,
  showMessageLabels = false,
}: LocalConflictSpreadProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const primaryProgress = safeInterpolate(frame, [atFrame(0.2, fps), atFrame(0.8, fps)], [0, 1]);
  const spread =
    spreadProgress ?? safeInterpolate(frame, [atFrame(0.95, fps), atFrame(2.35, fps)], [0, 1]);
  const freeze =
    freezeProgress ?? safeInterpolate(frame, [atFrame(2.35, fps), atFrame(2.35 + motionTiming.dim, fps)], [0, 1]);
  const primaryColor = interpolateColors(primaryProgress, [0, 1], [colors.primary, colors.accent]);
  const chainOpacity = fadeIn(frame, atFrame(0.72, fps), atFrame(0.4, fps));

  return (
    <AbsoluteFill style={{backgroundColor: historicalMode ? colors.historicalSurface : colors.background}}>
      {showDebugLabel ? (
        <Label x={96} y={70} tone="gray" style={{letterSpacing: 2.4}}>
          DEBUG · MG_LocalConflictSpread
        </Label>
      ) : null}
      <Label x={96} y={76} tone="gray" opacity={0.58} style={{fontSize: 22}}>
        {historicalMode ? '原书案例' : '现代类比'}
      </Label>
      <div
        style={{
          position: 'absolute',
          left: 96,
          right: 96,
          top: 126,
          height: 1,
          backgroundColor: historicalMode ? colors.historical : colors.muted,
          opacity: 0.28,
        }}
      />

      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, opacity: 0.25}}>
        {connections.map(([x1, y1, x2, y2], index) => (
          <line
            key={`${x1}-${y1}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={historicalMode ? colors.historical : colors.secondary}
            strokeWidth={lineWidth.hairline}
            strokeDasharray={index % 2 === 0 ? '6 12' : undefined}
          />
        ))}
      </svg>

      {positions.map((position, index) => {
        const firstDim = safeInterpolate(spread, [0, 0.52], [1, 0.6]);
        const secondDim = safeInterpolate(spread, [0.42 + index * 0.035, 1], [firstDim, 0.25]);
        const settle = safeInterpolate(
          frame,
          [0, atFrame(0.55, fps), atFrame(2.35, fps), atFrame(2.85, fps)],
          [index % 2 === 0 ? -8 : 8, 0, index % 2 === 0 ? 3 : -3, 0],
        );
        const opacity = safeInterpolate(freeze, [0, 1], [secondDim, Math.min(secondDim, 0.25)]);
        const label = otherMessages[index] ?? `普通信件 ${String.fromCharCode(65 + index)}`;
        return (
          <LetterNode
            key={`${label}-${index}`}
            x={position.x}
            y={position.y}
            label={label}
            color={colors.secondary}
            opacity={opacity}
            translateY={settle}
            showLabel={showMessageLabels || showDebugLabel}
          />
        );
      })}

      <LetterNode
        x={790}
        y={430}
        label={primaryMessage}
        color={primaryColor}
        opacity={1}
        translateY={0}
        primary
        showLabel
      />

      <div
        style={{
          position: 'absolute',
          left: 686,
          top: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          opacity: chainOpacity,
        }}
      >
        {['需要回复', '犹豫', '未回复'].map((item, index) => (
          <div key={item} style={{display: 'flex', alignItems: 'center', gap: 18} as CSSProperties}>
            <Label tone={index === 2 ? 'red' : 'white'} style={{fontSize: 25}}>
              {item}
            </Label>
            {index < 2 ? <Label tone="gray">→</Label> : null}
          </div>
        ))}
      </div>

      <Label
        x={650}
        y={932}
        tone="gray"
        opacity={fadeIn(frame, atFrame(2.55, fps), atFrame(0.35, fps)) * 0.7}
        style={{width: 620, textAlign: 'center', fontSize: 22}}
      >
        弗洛伊德 / Brill 解释框架 · 不是现代因果模拟
      </Label>
    </AbsoluteFill>
  );
};

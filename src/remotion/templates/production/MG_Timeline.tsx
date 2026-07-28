/**
 * M6 Production MG_Timeline — 时间线（年代/阶段推进）。
 * 数据驱动：只消费 templateProps，无任何 demo 默认值。
 * templateProps: { title: string; events: {label: string; time?: string}[]; caption?: string }
 */
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Typography} from '../../design/typography';
import {colors, lineWidth} from '../../design/tokens';

export interface TimelineProps {
  title: string;
  events: Array<{label: string; time?: string}>;
  caption?: string;
}

export const MG_Timeline = ({title, events, caption}: TimelineProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const startX = 200, endX = 1720, lineY = 580;

  return (
    <AbsoluteFill style={{backgroundColor: colors.background, overflow: 'hidden'}}>
      {/* 标题 */}
      <div style={{
        position: 'absolute', left: 120, top: 80,
        opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'}),
      }}>
        <Typography variant="SectionTitle" color={colors.accent} style={{fontSize: 36, letterSpacing: 2}}>
          {title}
        </Typography>
        <div style={{width: 60, height: 3, background: colors.accent, marginTop: 12}} />
      </div>

      {/* 时间线 */}
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <line x1={startX} y1={lineY} x2={endX} y2={lineY}
          stroke={colors.muted} strokeWidth={lineWidth.normal} />
      </svg>

      {/* 事件节点 */}
      {events.map((event, i) => {
        const x = startX + ((endX - startX) * i) / Math.max(1, events.length - 1);
        const opacity = interpolate(frame, [10 + i * 8, 25 + i * 8], [0, 1], {extrapolateRight: 'clamp'});
        const isLast = i === events.length - 1;

        return (
          <div key={i} style={{position: 'absolute', left: x - 100, top: lineY - 130, width: 200, opacity}}>
            {/* 圆点 */}
            <div style={{
              position: 'absolute', left: 92, top: 122,
              width: 16, height: 16, borderRadius: '50%',
              background: isLast ? colors.accent : colors.primary,
              border: `2px solid ${colors.accentSoft}`,
            }} />
            {/* 时间标签 */}
            {event.time ? (
              <Typography variant="SmallLabel" color={colors.secondary} style={{textAlign: 'center', fontSize: 14, marginBottom: 8}}>
                {event.time}
              </Typography>
            ) : null}
            {/* 事件标签（在线上方） */}
            <Typography variant="BodyLabel" color={colors.primary} style={{
              textAlign: 'center', fontSize: 18, fontWeight: 600,
              padding: '8px 12px', borderRadius: 8,
              background: `${colors.accent}0D`,
              border: `1px solid ${colors.accentSoft}`,
            }}>
              {event.label}
            </Typography>
          </div>
        );
      })}

      {/* caption */}
      {caption ? (
        <div style={{
          position: 'absolute', left: 120, bottom: 80,
          opacity: interpolate(frame, [50, 65], [0, 1], {extrapolateRight: 'clamp'}),
        }}>
          <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 18}}>
            {caption}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

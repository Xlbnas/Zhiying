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
    <AbsoluteFill style={{background: 'linear-gradient(180deg, #eee5d7 0%, #f7f3eb 100%)', overflow: 'hidden'}}>
      {/* 标题 */}
      <div style={{
        position: 'absolute', left: 120, top: 80,
        opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'}),
      }}>
        <Typography variant="SectionTitle" color="#7d3e39" style={{fontSize: 36, letterSpacing: 2}}>
          {title}
        </Typography>
        <div style={{width: 60, height: 3, background: colors.accent, marginTop: 12}} />
      </div>

      {/* 时间线 */}
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <line x1={startX} y1={lineY} x2={endX} y2={lineY}
          stroke="#9d8775" strokeWidth={lineWidth.normal + 1} />
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
              background: isLast ? '#7d3e39' : '#f7f3eb',
              border: '3px solid #7d3e39',
            }} />
            {/* 时间标签 */}
            {event.time ? (
              <Typography variant="SmallLabel" color="#7d3e39" style={{textAlign: 'center', fontSize: 16, marginBottom: 8, fontWeight: 700}}>
                {event.time}
              </Typography>
            ) : null}
            {/* 事件标签（在线上方） */}
            <Typography variant="BodyLabel" color="#2e2924" style={{
              textAlign: 'center', fontSize: 18, fontWeight: 600,
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(255,255,255,.72)',
              border: '1px solid #c8b8aa',
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
          <Typography variant="BodyLabel" color="#5a5148" style={{fontSize: 20}}>
            {caption}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

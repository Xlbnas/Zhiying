/**
 * M6 Production MG_ScheduleNodes — 清单/步骤节点（数据驱动版）。
 * 与 M1 demo MG_ScheduleNodes 分离：本组件只消费 templateProps，无 demo 默认。
 * templateProps: { title: string; items: {label: string; done?: boolean}[]; caption?: string }
 */
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Typography} from '../../design/typography';
import {colors, lineWidth} from '../../design/tokens';

export interface ScheduleNodesProdProps {
  title: string;
  items: Array<{label: string; done?: boolean}>;
  caption?: string;
}

export const MG_ScheduleNodesProd = ({title, items, caption}: ScheduleNodesProdProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const startY = 220;
  const itemGap = 100;

  return (
    <AbsoluteFill style={{background: '#f2eee6', overflow: 'hidden'}}>
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

      <div style={{position: 'absolute', left: 243, top: startY + 26, width: 3,
        height: Math.max(0, (items.length - 1) * itemGap), background: '#bdaea0'}} />
      {/* 证据阶梯 / 步骤列表 */}
      {items.map((item, i) => {
        const y = startY + i * itemGap;
        const opacity = interpolate(frame, [8 + i * 6, 22 + i * 6], [0, 1], {extrapolateRight: 'clamp'});
        const checkOpacity = item.done ? interpolate(frame, [18 + i * 8, 30 + i * 8], [0, 1], {extrapolateRight: 'clamp'}) : 0;

        return (
          <div key={i} style={{
            position: 'absolute', left: 220, top: y,
            display: 'flex', alignItems: 'center', gap: 24,
            opacity,
          }}>
            {/* 序号圆圈 */}
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              border: `2px solid ${item.done ? '#7d3e39' : '#81786e'}`,
              background: item.done ? '#7d3e39' : '#f2eee6',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {item.done ? (
                <span style={{color: '#fff8ef', fontSize: 20, fontWeight: 700, opacity: checkOpacity}}>✓</span>
              ) : (
                <Typography variant="SmallLabel" color="#5a5148" style={{fontSize: 18}}>
                  {i + 1}
                </Typography>
              )}
            </div>
            {/* 标签 */}
            <Typography variant="BodyLabel" color="#2e2924" style={{fontSize: 27, fontWeight: 650}}>
              {item.label}
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

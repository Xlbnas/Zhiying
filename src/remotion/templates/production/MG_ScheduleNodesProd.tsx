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

      {/* 步骤列表 */}
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
              border: `1.5px solid ${item.done ? colors.accent : colors.muted}`,
              background: item.done ? `${colors.accent}18` : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {item.done ? (
                <span style={{color: colors.accent, fontSize: 20, fontWeight: 700, opacity: checkOpacity}}>✓</span>
              ) : (
                <Typography variant="SmallLabel" color={colors.secondary} style={{fontSize: 18}}>
                  {i + 1}
                </Typography>
              )}
            </div>
            {/* 标签 */}
            <Typography variant="BodyLabel" color={colors.primary} style={{fontSize: 24, fontWeight: 600}}>
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
          <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 18}}>
            {caption}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

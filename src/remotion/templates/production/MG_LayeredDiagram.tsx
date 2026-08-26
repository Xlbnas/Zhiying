/**
 * M6 Production MG_LayeredDiagram — 分层结构图（冰山/金字塔/层级模型）。
 * 数据驱动：只消费 templateProps，无任何 demo 默认值。
 * templateProps: { title: string; layers: {label: string; note?: string}[]; caption?: string }
 */
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Typography} from '../../design/typography';
import {colors} from '../../design/tokens';

export interface LayeredDiagramProps {
  title: string;
  layers: Array<{label: string; note?: string}>;
  caption?: string;
}

export const MG_LayeredDiagram = ({title, layers, caption}: LayeredDiagramProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const layerCount = layers.length;
  const layerHeight = 720 / (layerCount + 1);

  return (
    <AbsoluteFill style={{background: 'linear-gradient(135deg, #edf2f3 0%, #d9e4e7 100%)', overflow: 'hidden'}}>
      {/* 标题 */}
      <div style={{
        position: 'absolute', left: 120, top: 80,
        opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'}),
      }}>
        <Typography variant="SectionTitle" color="#2d6978" style={{fontSize: 36, letterSpacing: 2}}>
          {title}
        </Typography>
        <div style={{width: 60, height: 3, background: colors.accent, marginTop: 12}} />
      </div>

      {/* 层级（从下往上渲染，底部最宽） */}
      {layers.map((layer, index) => {
        const fromBottom = layerCount - 1 - index;
        const width = 420 + fromBottom * 260;
        const top = 160 + index * (layerHeight - 20);
        const opacity = interpolate(frame, [10 + index * 6, 25 + index * 6], [0, 1], {extrapolateRight: 'clamp'});
        const labelOpacity = interpolate(frame, [25 + index * 6, 40 + index * 6], [0, 1], {extrapolateRight: 'clamp'});

        return (
          <div key={index} style={{
            position: 'absolute',
            left: (1920 - width) / 2,
            top,
            width,
            height: layerHeight - 30,
            opacity,
          }}>
            {/* 机制层级：亮底 activation band，与历史/暗色卡片区分 */}
            <div style={{
              width: '100%', height: '100%',
              borderRadius: 4,
              borderLeft: `${8 + index * 3}px solid ${index === layerCount - 1 ? '#2d6978' : '#78a8b3'}`,
              background: `rgba(255,255,255,${0.9 - index * 0.12})`,
              boxShadow: '0 12px 30px rgba(30,60,66,.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column',
            }}>
              <Typography variant="BodyLabel" color="#162c32" style={{
                fontSize: 28, fontWeight: 650, opacity: labelOpacity,
              }}>
                {layer.label}
              </Typography>
              {layer.note ? (
                <Typography variant="SmallLabel" color="#526c72" style={{
                  fontSize: 16, marginTop: 6, opacity: labelOpacity,
                }}>
                  {layer.note}
                </Typography>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* caption */}
      {caption ? (
        <div style={{
          position: 'absolute', left: 120, bottom: 80,
          opacity: interpolate(frame, [45, 60], [0, 1], {extrapolateRight: 'clamp'}),
        }}>
          <Typography variant="BodyLabel" color="#405b62" style={{fontSize: 20}}>
            {caption}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

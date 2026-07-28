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
            {/* 层级背景 */}
            <div style={{
              width: '100%', height: '100%',
              borderRadius: 16,
              border: `1.5px solid ${colors.accentSoft}`,
              background: `linear-gradient(180deg, ${colors.accent}12, ${colors.accent}04)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column',
            }}>
              <Typography variant="BodyLabel" color={colors.primary} style={{
                fontSize: 24, fontWeight: 600, opacity: labelOpacity,
              }}>
                {layer.label}
              </Typography>
              {layer.note ? (
                <Typography variant="SmallLabel" color={colors.secondary} style={{
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
          <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 18}}>
            {caption}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

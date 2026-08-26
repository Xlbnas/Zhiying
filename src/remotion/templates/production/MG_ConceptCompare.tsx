/**
 * M6 Production MG_ConceptCompare — 双概念对比（左 vs 右）。
 * 数据驱动：只消费 templateProps，无任何 demo 默认值。
 * templateProps: { title?: string; left: string; right: string; note?: string }
 */
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Typography} from '../../design/typography';
import {colors, lineWidth} from '../../design/tokens';

export interface ConceptCompareProps {
  title?: string;
  left: string;
  right: string;
  note?: string;
}

export const MG_ConceptCompare = ({title, left, right, note}: ConceptCompareProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const leftOpacity = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  const rightOpacity = interpolate(frame, [12, 27], [0, 1], {extrapolateRight: 'clamp'});
  const vsOpacity = interpolate(frame, [8, 20], [0, 1], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{background: 'linear-gradient(90deg, #eee5d8 0 49.8%, #dfe8eb 50.2% 100%)', overflow: 'hidden'}}>
      {/* 标题 */}
      {title ? (
        <div style={{
          position: 'absolute', left: 120, top: 80,
          opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'}),
        }}>
          <Typography variant="SectionTitle" color="#743b37" style={{fontSize: 32, letterSpacing: 2}}>
            {title}
          </Typography>
          <div style={{width: 60, height: 3, background: colors.accent, marginTop: 12}} />
        </div>
      ) : null}

      {/* 左侧 */}
      <div style={{
        position: 'absolute', left: 180, top: 280,
        width: 580, minHeight: 260,
        borderTop: '5px solid #8f3f3a',
        background: 'rgba(255,252,247,.56)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '58px 42px',
        opacity: leftOpacity,
      }}>
        <Typography variant="Title" color="#2b211c" style={{fontSize: 44, fontWeight: 680, textAlign: 'left'}}>
          {left}
        </Typography>
      </div>

      {/* VS */}
      <div style={{
        position: 'absolute', left: 840, top: 330,
        width: 120, height: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: vsOpacity,
      }}>
        <Typography variant="SectionTitle" color="#465c64" style={{fontSize: 48, fontWeight: 700, letterSpacing: 6}}>
          ≠
        </Typography>
      </div>

      {/* 右侧 */}
      <div style={{
        position: 'absolute', left: 1040, top: 280,
        width: 580, minHeight: 260,
        borderTop: '5px solid #397789',
        background: 'rgba(247,251,252,.7)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '58px 42px',
        opacity: rightOpacity,
      }}>
        <Typography variant="Title" color="#15272d" style={{fontSize: 44, fontWeight: 680, textAlign: 'left'}}>
          {right}
        </Typography>
      </div>

      {/* note */}
      {note ? (
        <div style={{
          position: 'absolute', left: 120, bottom: 100,
          opacity: interpolate(frame, [30, 45], [0, 1], {extrapolateRight: 'clamp'}),
        }}>
          <div style={{width: 40, height: 2, background: colors.muted, marginBottom: 12}} />
          <Typography variant="BodyLabel" color="#34484f" style={{fontSize: 21}}>
            {note}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

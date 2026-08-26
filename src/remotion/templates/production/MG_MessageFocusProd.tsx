/**
 * M6 Production MG_MessageFocus — 单一关键信息聚焦（数据驱动版）。
 * 与 M1 demo MG_MessageFocus 分离：本组件只消费 templateProps，无 demo 默认。
 * templateProps: { message: string; context?: string }
 */
import {AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {Typography} from '../../design/typography';
import {colors} from '../../design/tokens';

export interface MessageFocusProdProps {
  message: string;
  context?: string;
}

export const MG_MessageFocusProd = ({message, context}: MessageFocusProdProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const messageOpacity = interpolate(frame, [0, 18], [0, 1], {extrapolateRight: 'clamp'});
  const contextOpacity = interpolate(frame, [20, 38], [0, 1], {extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{
      background: 'linear-gradient(120deg, #101617 0%, #1b2729 72%, #30201f 100%)',
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      flexDirection: 'column',
    }}>
      {/* 核心信息 */}
      <div style={{
        maxWidth: 1320, textAlign: 'left', marginLeft: 150,
        opacity: messageOpacity,
        transform: `translateY(${10 * (1 - messageOpacity)}px)`,
      }}>
        <Typography variant="Title" color={colors.primary} style={{
          fontSize: 62, fontWeight: 680, lineHeight: 1.32,
        }}>
          {message}
        </Typography>
      </div>

      {/* 上下文 */}
      {context ? (
        <div style={{
          maxWidth: 980, textAlign: 'left', marginTop: 50, marginLeft: 150,
          opacity: contextOpacity,
        }}>
          <div style={{width: 240, height: 3, background: colors.accent, marginBottom: 24,
            transform: `scaleX(${contextOpacity})`, transformOrigin: 'left'}} />
          <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 22, lineHeight: 1.5}}>
            {context}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

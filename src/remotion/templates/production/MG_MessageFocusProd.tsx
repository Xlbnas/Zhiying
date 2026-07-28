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
      backgroundColor: colors.background,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'column',
    }}>
      {/* 核心信息 */}
      <div style={{
        maxWidth: 1300, textAlign: 'center',
        opacity: messageOpacity,
        transform: `translateY(${10 * (1 - messageOpacity)}px)`,
      }}>
        <Typography variant="Title" color={colors.primary} style={{
          fontSize: 56, fontWeight: 700, lineHeight: 1.3,
        }}>
          {message}
        </Typography>
      </div>

      {/* 上下文 */}
      {context ? (
        <div style={{
          maxWidth: 1000, textAlign: 'center', marginTop: 50,
          opacity: contextOpacity,
        }}>
          <div style={{width: 40, height: 2, background: colors.accent, margin: '0 auto 24px'}} />
          <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 22, lineHeight: 1.5}}>
            {context}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

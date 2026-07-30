/**
 * M6 Production Placeholder — 明确标记缺失素材/模板，绝不伪装成真实画面。
 * 与 M1 demo Placeholder([MG PLACEHOLDER] 等) 分离：本组件仅用于 production 路径。
 */
import {AbsoluteFill} from 'remotion';
import {Typography} from '../design/typography';
import {colors} from '../design/tokens';
import type {Scene} from '@/lib/scene-schema';
import {MissingVisualAssetError, useRenderMode} from '../render-mode';

export interface ProductionPlaceholderProps {
  scene: Scene;
  reason: string;
}

export const ProductionPlaceholder = ({scene, reason}: ProductionPlaceholderProps) => {
  // M6.3.12 kill switch：Final 模式 placeholder 即渲染失败（Phase 4/17）
  const renderMode = useRenderMode();
  if (renderMode === 'final') {
    throw new MissingVisualAssetError(scene.id, reason);
  }
  return (
    <AbsoluteFill style={{
      backgroundColor: colors.background,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 20,
    }}>
      {/* 场景 ID */}
      <Typography variant="SmallLabel" color={colors.secondary} style={{fontSize: 16, letterSpacing: 2}}>
        {scene.id} · {scene.category}
      </Typography>

      {/* 原因 */}
      <div style={{
        border: `1.5px solid ${colors.accentSoft}`,
        borderRadius: 16,
        background: `${colors.accent}0D`,
        padding: '30px 50px',
        maxWidth: 1000,
        textAlign: 'center',
      }}>
        <Typography variant="SectionTitle" color={colors.accent} style={{fontSize: 28}}>
          视觉素材待准备
        </Typography>
        <div style={{width: 40, height: 2, background: colors.muted, margin: '16px auto 20px'}} />
        <Typography variant="BodyLabel" color={colors.secondary} style={{fontSize: 18}}>
          {reason}
        </Typography>
        <Typography variant="SmallLabel" color={colors.muted} style={{fontSize: 14, marginTop: 12}}>
          {scene.narrationSummary.slice(0, 80)}{scene.narrationSummary.length > 80 ? '…' : ''}
        </Typography>
      </div>
    </AbsoluteFill>
  );
};

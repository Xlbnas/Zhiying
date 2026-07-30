/**
 * M6 Production SceneRenderer — 数据驱动、production-only。
 *
 * 与 M1 demo SceneRenderer 彻底分离：
 * - MG：消费 scene.template + scene.templateProps → production 模板组件
 * - Archive / B-roll：通过 assetMap 获取真实素材 → 渲染实际媒体
 * - Minimal：排版驱动（scene.narrationSummary / description）
 * - 缺失素材/模板：显示明确占位，行为 fail-closed
 * - 绝不 fallback 到 M1 demo 内容
 */
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import type {Scene as SchemaScene, ResolvedAsset} from '@/lib/scene-schema';
import {Typography} from '../design/typography';
import {colors} from '../design/tokens';
import {MG_LayeredDiagram} from '../templates/production/MG_LayeredDiagram';
import {MG_RelationGraph} from '../templates/production/MG_RelationGraph';
import {MG_Timeline} from '../templates/production/MG_Timeline';
import {MG_ConceptCompare} from '../templates/production/MG_ConceptCompare';
import {MG_MessageFocusProd} from '../templates/production/MG_MessageFocusProd';
import {MG_ScheduleNodesProd} from '../templates/production/MG_ScheduleNodesProd';
import {ProductionPlaceholder} from './ProductionPlaceholder';

export interface ProductionSceneRendererProps {
  scene: SchemaScene;
  /** sceneId → 已绑定的 usable 素材（bridge 注入）。 */
  assetMap?: Record<string, ResolvedAsset[]>;
}

/** MG template → 组件映射（production only） */
const MG_COMPONENTS: Record<string, React.ComponentType<any>> = {
  MG_LayeredDiagram,
  MG_RelationGraph,
  MG_Timeline,
  MG_ConceptCompare,
  MG_MessageFocus: MG_MessageFocusProd,
  MG_ScheduleNodes: MG_ScheduleNodesProd,
};

export const ProductionSceneRenderer = ({scene, assetMap}: ProductionSceneRendererProps) => {
  const category = scene.category;

  // ---- MG: production template + templateProps ----
  if (category === 'MG') {
    const template = scene.template as string | null;
    if (!template) {
      return <ProductionPlaceholder scene={scene} reason="缺少 MG 模板" />;
    }
    const Component = MG_COMPONENTS[template];
    if (!Component) {
      return <ProductionPlaceholder scene={scene} reason={`未知 MG 模板：${template}`} />;
    }
    if (!scene.templateProps || Object.keys(scene.templateProps).length === 0) {
      return <ProductionPlaceholder scene={scene} reason="缺少 templateProps" />;
    }
    try {
      return <Component {...(scene.templateProps as Record<string, unknown>)} />;
    } catch {
      return <ProductionPlaceholder scene={scene} reason="templateProps 渲染失败" />;
    }
  }

  // ---- Archive / B-roll: 真实素材 ----
  if (category === 'Archive' || category === 'B-roll') {
    const assets = assetMap?.[scene.id];
    if (!assets || assets.length === 0) {
      return <ProductionPlaceholder scene={scene} reason="视觉素材待准备" />;
    }
    // 取第一个 usable asset 渲染
    const asset = assets[0]!;
    if (asset.mediaType === 'image') {
      return (
        <ProductionAssetImage
          publicPath={asset.publicPath}
          description={asset.description}
          attribution={asset.attribution}
          narrationSummary={scene.narrationSummary}
          sceneId={scene.id}
          durationInFrames={scene.durationInFrames}
        />
      );
    }
    // video 暂不支持，显示占位
    return <ProductionPlaceholder scene={scene} reason={`暂不支持视频素材：${asset.mediaType}`} />;
  }

  // ---- Minimal / Editorial Graphic: 排版 ----
  return (
    <ProductionMinimal
      narrationSummary={scene.narrationSummary}
      chapterTitle={scene.chapterTitle}
    />
  );
};

// ---- 子组件 ----

function ProductionMinimal({narrationSummary}: {narrationSummary: string; chapterTitle: string}) {
  return (
    <AbsoluteFill style={{
      backgroundColor: colors.background,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{maxWidth: 1420, textAlign: 'center', padding: '0 60px'}}>
        <Typography variant="Title" color={colors.primary} style={{fontSize: 48, fontWeight: 650, lineHeight: 1.3}}>
          {narrationSummary}
        </Typography>
        <div style={{width: 60, height: 3, background: colors.accent, margin: '40px auto 0'}} />
      </div>
    </AbsoluteFill>
  );
}

/**
 * 确定性 Ken Burns：按 sceneId 哈希在 zoom-in / zoom-out / pan-left / pan-right
 * 中选一种，整段 scene 内缓动。同一 scene 每次 render 结果完全一致。
 */
export function kenBurnsTransform(sceneId: string, frame: number, durationInFrames: number): string {
  let hash = 0;
  for (let i = 0; i < sceneId.length; i++) hash = (hash * 31 + sceneId.charCodeAt(i)) >>> 0;
  const mode = hash % 4;
  const t = Math.max(0, durationInFrames - 1);
  const progress = t > 0 ? Math.min(1, Math.max(0, frame / t)) : 0;
  if (mode === 0) {
    const scale = interpolate(progress, [0, 1], [1.0, 1.04]);
    return `scale(${scale.toFixed(5)})`;
  }
  if (mode === 1) {
    const scale = interpolate(progress, [0, 1], [1.04, 1.0]);
    return `scale(${scale.toFixed(5)})`;
  }
  // pan 需要保持基础放大，避免边缘露底
  const x = mode === 2
    ? interpolate(progress, [0, 1], [0, -1.5])
    : interpolate(progress, [0, 1], [-1.5, 0]);
  return `scale(1.05) translateX(${x.toFixed(4)}%)`;
}

function ProductionAssetImage({
  publicPath, description, attribution, narrationSummary, sceneId, durationInFrames,
}: {
  publicPath: string;
  description: string;
  attribution: string;
  narrationSummary: string;
  sceneId: string;
  durationInFrames: number;
}) {
  const frame = useCurrentFrame();
  const transform = kenBurnsTransform(sceneId, frame, durationInFrames);
  return (
    <AbsoluteFill style={{backgroundColor: '#111'}}>
      <Img
        src={staticFile(publicPath)}
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.75, transform}}
      />
      {/* 左侧旁白摘要 */}
      <div style={{
        position: 'absolute', left: 100, bottom: 140,
        maxWidth: 800,
        background: 'rgba(0,0,0,.65)', borderRadius: 12,
        padding: '24px 32px',
      }}>
        <Typography variant="BodyLabel" color={colors.primary} style={{fontSize: 26, lineHeight: 1.4}}>
          {narrationSummary}
        </Typography>
      </div>
      {/* 底部 attribution */}
      {attribution ? (
        <div style={{
          position: 'absolute', right: 60, bottom: 40,
          opacity: 0.55,
        }}>
          <Typography variant="SmallLabel" color={colors.secondary} style={{fontSize: 14}}>
            {attribution}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

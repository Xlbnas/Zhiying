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

  // ---- Editorial Graphic: 信息排版（不得退回 Minimal 中心卡） ----
  if (category === 'Editorial Graphic') {
    return (
      <ProductionEditorial
        narrationSummary={scene.narrationSummary}
        chapterTitle={scene.chapterTitle}
        chapter={scene.chapter}
      />
    );
  }

  // ---- Minimal: 只承担留白/标点场景 ----
  return (
    <ProductionMinimal
      narrationSummary={scene.narrationSummary}
      chapterTitle={scene.chapterTitle}
    />
  );
};

// ---- 子组件 ----

function ProductionEditorial({narrationSummary, chapterTitle, chapter}: {
  narrationSummary: string;
  chapterTitle: string;
  chapter: number;
}) {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});
  const modern = chapter === 3;
  const background = modern ? '#e9eef0' : '#efe8dd';
  const ink = modern ? '#15272d' : '#2a211d';
  const accent = modern ? '#397789' : '#8f3f3a';
  const parts = narrationSummary.split(/([：｜／—])/).filter(Boolean);
  return (
    <AbsoluteFill style={{backgroundColor: background, color: ink, overflow: 'hidden'}}>
      <div style={{position: 'absolute', left: 92, top: 72, fontSize: 16, letterSpacing: 4, color: accent}}>
        {chapterTitle.toUpperCase()}
      </div>
      <div style={{position: 'absolute', left: 92, top: 164, width: 10, height: 610, background: accent,
        transform: `scaleY(${reveal})`, transformOrigin: 'top'}} />
      <div style={{position: 'absolute', left: 158, top: 194, right: 170, display: 'flex', flexWrap: 'wrap',
        alignItems: 'baseline', gap: '10px 18px', opacity: reveal}}>
        {parts.map((part, index) => (
          <span key={`${part}-${index}`} style={{
            fontFamily: 'Noto Sans SC, sans-serif',
            fontSize: index % 3 === 0 ? 66 : 42,
            lineHeight: 1.28,
            fontWeight: index % 3 === 0 ? 760 : 520,
            color: index % 3 === 1 ? accent : ink,
            transform: `translateY(${index % 2 === 0 ? 0 : 18}px)`,
          }}>
            {part}
          </span>
        ))}
      </div>
      <div style={{position: 'absolute', right: 96, bottom: 88, width: 380, height: 1, background: `${accent}88`}} />
    </AbsoluteFill>
  );
}

function ProductionMinimal({narrationSummary}: {narrationSummary: string; chapterTitle: string}) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 18], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{
      backgroundColor: colors.background,
      display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
    }}>
      <div style={{maxWidth: 1280, textAlign: 'left', marginLeft: 170, padding: '0 60px', opacity}}>
        <Typography variant="Title" color={colors.primary} style={{fontSize: 58, fontWeight: 580, lineHeight: 1.35}}>
          {narrationSummary}
        </Typography>
        <div style={{width: 140, height: 3, background: colors.accent, marginTop: 42,
          transform: `scaleX(${opacity})`, transformOrigin: 'left'}} />
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
  const reveal = interpolate(frame, [8, 28], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: '#d8cbb7', padding: 38}}>
      <div style={{position: 'absolute', inset: 38, backgroundColor: '#241d19', overflow: 'hidden'}}>
      <Img
        src={staticFile(publicPath)}
        style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.84, transform}}
      />
      <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(30,23,19,.82) 0%, rgba(30,23,19,.18) 58%, rgba(30,23,19,.42) 100%)'}} />
      </div>
      {/* 纸本边注式摘要 */}
      <div style={{
        position: 'absolute', left: 92, top: 140,
        width: 610,
        background: 'rgba(238,229,213,.94)',
        padding: '34px 38px 40px',
        borderLeft: '8px solid #8f3f3a',
        opacity: reveal,
      }}>
        <div style={{fontSize: 15, color: '#8f3f3a', letterSpacing: 4, marginBottom: 22}}>ARCHIVAL EVIDENCE</div>
        <Typography variant="BodyLabel" color="#2b211c" style={{fontSize: 32, lineHeight: 1.42, fontWeight: 620}}>
          {narrationSummary}
        </Typography>
        <div style={{marginTop: 26, width: `${Math.round(reveal * 100)}%`, height: 2, background: '#8f3f3a'}} />
      </div>
      {/* 底部 attribution */}
      {attribution ? (
        <div style={{
          position: 'absolute', right: 60, bottom: 40,
          opacity: 0.82,
          textShadow: '0 1px 5px rgba(0,0,0,.9)',
        }}>
          <Typography variant="SmallLabel" color="#f2e9dc" style={{fontSize: 18}}>
            {attribution}
          </Typography>
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

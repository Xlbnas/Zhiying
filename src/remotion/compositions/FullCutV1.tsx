import {useMemo} from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  COMPOSITION_ID,
  DEFAULT_BGM_PATH,
  DEFAULT_SFX_PATH,
  SCHEMA_VERSION,
  TEMPLATE_VERSION,
  type ChapterTiming,
  type Scene as SchemaScene,
  type SubtitleCue,
  type ZhiyingFullCutProps,
} from '@/lib/scene-schema';
import {Typography} from '../design/typography';
import {borderRadius, colors, fontFamily} from '../design/tokens';
import {RenderModeContext, type RenderMode} from '../render-mode';
import {
  FULL_CUT_DURATION_FRAMES,
  fullCutChapterTiming,
  fullCutProject,
  fullCutScenes,
  type FullCutCategory,
  type FullCutScene,
  type FullCutVisualType,
} from '../data/fullCutScenes';
import subtitleData from '../data/fullCutSubtitles.json';
import {PilotVisualTrack} from './PilotCutV1';
import {ProductionSceneRenderer} from './ProductionSceneRenderer';
import {isV2VisualR2Scene} from '../templates/production/V2VisualR2Scene';
import {isMemoryLabEditorialScene} from '../templates/production/MemoryLabEditorialScene';

const PILOT_VISUAL_END = 119.107;
const CROSSFADE_FRAMES = 8;

/**
 * 契约 Scene（zod，subtitlePosition 仅 'bottom' | 'mid'）→ 模板内部 FullCutScene
 * （subtitlePosition 为 'bottom' | 'lowerThird' | 'midLower'）。
 * 运行时数据可能携带 schema 枚举之外的原始值（lowerThird/midLower），此处原样透传，
 * 保证与旧 FullCutV1 的字幕定位逻辑逐像素一致；schema 内的 'mid' 归一到 'midLower'。
 */
const normalizeSubtitlePosition = (
  position: SchemaScene['subtitlePosition'],
): FullCutScene['subtitlePosition'] => {
  const raw = position as string;
  if (raw === 'lowerThird' || raw === 'midLower') return raw;
  return raw === 'mid' ? 'midLower' : 'bottom';
};

/**
 * 模板内置预览数据（FullCutScenes.json）→ 契约 Scene。
 * subtitlePosition 的原始值（lowerThird/midLower）超出 schema 枚举，
 * 经 string 窄化保留运行时原值，使 defaultProps 预览与线上渲染一致。
 */
const toSchemaScene = (scene: FullCutScene): SchemaScene => ({
  ...scene,
  assetRequirements: [],
  subtitlePosition: scene.subtitlePosition as string as SchemaScene['subtitlePosition'],
});

/** CONTRACT §2：defaultProps，保证 Composition 独立可预览。 */
export const zhiyingFullCutDefaultProps: ZhiyingFullCutProps = {
  data: {
    schemaVersion: SCHEMA_VERSION,
    templateVersion: TEMPLATE_VERSION,
    project: {...fullCutProject, composition: COMPOSITION_ID, showPilotIntro: true},
    chapterTiming: fullCutChapterTiming,
    scenes: fullCutScenes.map(toSchemaScene),
  },
  subtitles: subtitleData as SubtitleCue[],
  audio: {
    narration: 'full/audio/FullCut_TTS.wav',
    bgm: DEFAULT_BGM_PATH,
    sfx: DEFAULT_SFX_PATH,
  },
  showSubtitles: true,
};

const ChapterLabel = ({scene, chapterTiming}: {scene: FullCutScene; chapterTiming: ChapterTiming[]}) => {
  const frame = useCurrentFrame();
  const chapter = chapterTiming.find((item) => item.chapter === scene.chapter);
  const isChapterStart = Math.abs(scene.start - Number(chapter?.start ?? -99)) < 0.05;
  if (!isChapterStart || scene.chapter <= 2) return null;
  const opacity = interpolate(frame, [0, 15, 70, 92], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{position: 'absolute', left: 104, top: 78, opacity, fontFamily, letterSpacing: 2.4}}>
      <div style={{fontSize: 19, color: scene.chapter === 7 ? colors.research : colors.secondary}}>
        CHAPTER {String(scene.chapter).padStart(2, '0')}
      </div>
      <div style={{fontSize: 28, color: colors.primary, marginTop: 10}}>{scene.chapterTitle}</div>
    </div>
  );
};

const SceneContent = ({scene, chapterTiming, assetMap, templateProps}: {
  scene: FullCutScene;
  chapterTiming: ChapterTiming[];
  assetMap?: Record<string, unknown>;
  /** M6.3.12：templateProps 从 SchemaScene 显式穿线（此前经 TimedScene
      字段裁剪被丢弃，导致全部 MG scene 渲染成 placeholder —— P0 根因）。 */
  templateProps?: SchemaScene['templateProps'];
}) => {
  // 重建 SchemaScene（包含 templateProps / assetRequirements）
  const schemaScene: SchemaScene = {
    id: scene.id,
    chapter: scene.chapter,
    chapterTitle: scene.chapterTitle,
    start: scene.start,
    end: scene.end,
    duration: scene.duration,
    startFrame: scene.startFrame,
    durationInFrames: scene.durationInFrames,
    category: scene.category,
    visualType: scene.visualType as SchemaScene['visualType'],
    template: scene.template as SchemaScene['template'],
    sourceTemplate: scene.sourceTemplate,
    templateProps,
    assetRequirements: (scene as unknown as Record<string, unknown>).assetRequirements as SchemaScene['assetRequirements'] ?? [],
    narrationSummary: scene.narrationSummary,
    description: scene.description,
    notes: scene.notes,
    assetIds: scene.assetIds,
    licenseStatus: scene.licenseStatus as SchemaScene['licenseStatus'],
    subtitlePosition: scene.subtitlePosition as SchemaScene['subtitlePosition'],
    transitionIn: scene.transitionIn,
    transitionOut: scene.transitionOut,
  };
  return (
    <AbsoluteFill>
      <ProductionSceneRenderer scene={schemaScene} assetMap={assetMap as Record<string, import('@/lib/scene-schema').ResolvedAsset[]>} />
      {isV2VisualR2Scene(schemaScene) || isMemoryLabEditorialScene(schemaScene) ? null : <ChapterLabel scene={scene} chapterTiming={chapterTiming} />}
    </AbsoluteFill>
  );
};

const TimedScene = ({scene, lead, tail, chapterTiming, assetMap}: {
  scene: SchemaScene;
  lead: number;
  tail: number;
  chapterTiming: ChapterTiming[];
  assetMap?: Record<string, unknown>;
}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fadeIn = lead === 0 ? 1 : interpolate(frame, [0, lead], [0, 1], {extrapolateRight: 'clamp'});
  const fadeOut = tail === 0 ? 1 : interpolate(frame, [durationInFrames - tail, durationInFrames - 1], [1, 0], {extrapolateLeft: 'clamp'});
  const fcs: FullCutScene = {
    id: scene.id,
    chapter: scene.chapter,
    chapterTitle: scene.chapterTitle,
    start: scene.start,
    end: scene.end,
    duration: scene.duration,
    startFrame: scene.startFrame,
    durationInFrames: scene.durationInFrames,
    category: scene.category as FullCutCategory,
    visualType: (scene.visualType ?? 'UI') as FullCutVisualType,
    template: scene.template,
    sourceTemplate: scene.sourceTemplate,
    narrationSummary: scene.narrationSummary,
    description: scene.description,
    notes: scene.notes,
    assetIds: scene.assetIds,
    licenseStatus: scene.licenseStatus as FullCutScene['licenseStatus'],
    subtitlePosition: normalizeSubtitlePosition(scene.subtitlePosition),
    transitionIn: scene.transitionIn,
    transitionOut: scene.transitionOut,
  };
  return (
    <AbsoluteFill style={{opacity: Math.min(fadeIn, fadeOut)}}>
      <SceneContent scene={fcs} chapterTiming={chapterTiming} assetMap={assetMap} templateProps={scene.templateProps} />
    </AbsoluteFill>
  );
};

const FullVisualTrack = ({scenes, chapterTiming, assetMap, showPilotIntro = false}: {
  scenes: SchemaScene[];
  chapterTiming: ChapterTiming[];
  assetMap?: Record<string, unknown>;
  showPilotIntro?: boolean;
}) => (
  <AbsoluteFill>
    {scenes.map((scene, index) => {
      const logicalStart = scene.startFrame;
      const previousScene = scenes[index - 1];
      const nextScene = scenes[index + 1];
      const exactEditorial = isV2VisualR2Scene(scene) || isMemoryLabEditorialScene(scene);
      const previousExactEditorial = previousScene && (isV2VisualR2Scene(previousScene) || isMemoryLabEditorialScene(previousScene));
      const nextExactEditorial = nextScene && (isV2VisualR2Scene(nextScene) || isMemoryLabEditorialScene(nextScene));
      const lead = index === 0 || exactEditorial || previousExactEditorial
        ? 0
        : CROSSFADE_FRAMES;
      const tail = index === scenes.length - 1 || exactEditorial || nextExactEditorial
        ? 0
        : CROSSFADE_FRAMES;
      const from = Math.max(0, logicalStart - lead);
      return (
        <Sequence key={scene.id} from={from} durationInFrames={scene.durationInFrames + lead + tail} layout="none">
          <TimedScene scene={scene} lead={lead} tail={tail} chapterTiming={chapterTiming} assetMap={assetMap} />
        </Sequence>
      );
    })}
    {/* M1 demo 专用 Pilot 开场（拖延示例手机界面）：仅 defaultProps / Legacy M1
        链路经 showPilotIntro 显式开启；workflow 项目渲染不得携带该残留 */}
    {showPilotIntro ? (
      <Sequence from={0} durationInFrames={Math.ceil(PILOT_VISUAL_END * 30)} layout="none">
        <PilotVisualTrack />
      </Sequence>
    ) : null}
  </AbsoluteFill>
);

const FullSubtitles = ({cues, scenes, darkEditorial}: {cues: SubtitleCue[]; scenes: FullCutScene[]; darkEditorial: boolean}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const cue = cues.find((item) => time >= item.start && time < item.end);
  if (!cue) return null;
  const scene = scenes.find((item) => time >= item.start && time < item.end);
  const position = darkEditorial ? 944 : cue.position === 'mid' || scene?.subtitlePosition === 'midLower' ? 840 : scene?.subtitlePosition === 'lowerThird' ? 910 : 900;
  const alpha = interpolate(time, [cue.start, cue.start + .1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{position: 'absolute', left: 300, top: position, width: 1320, display: 'flex', justifyContent: 'center', opacity: alpha, pointerEvents: 'none'}}>
      <div style={{fontFamily, fontSize: darkEditorial ? 36 : 42, fontWeight: darkEditorial ? 470 : 540, lineHeight: 1.36, color: '#f5f5f5', padding: darkEditorial ? '7px 18px 9px' : '10px 22px 12px', borderRadius: borderRadius.sm, background: darkEditorial ? 'rgba(5,5,7,.42)' : 'rgba(5,5,7,.58)', boxShadow: darkEditorial ? 'none' : '0 8px 28px rgba(0,0,0,.2)', textShadow: '0 2px 10px rgba(0,0,0,.7)', textAlign: 'center'}}>{cue.text}</div>
    </div>
  );
};

const bgmVolume = (frame: number) => {
  const second = frame / 30;
  const critical = [33.57, 399.0, 472.0, 595.0];
  const close = critical.some((item) => Math.abs(item - second) < 3.2);
  return close ? 0.56 : 0.72;
};

/**
 * CONTRACT §2：props 驱动的全片组件。
 * 数据流：props.data.scenes/chapterTiming → 视觉轨；props.subtitles → 字幕轨；
 * props.audio.narration（staticFile 相对路径，null 不挂 Audio）→ 旁白轨；
 * props.showSubtitles=false → 不渲染字幕轨。
 * props.audio.bgm / props.audio.sfx（M2-E-D）：Freud 示例配乐，
 * 默认沿用原路径（Legacy 行为不变）；显式 null → 不挂载（Workflow Visual Preview）。
 */
export const ZhiyingFullCut = ({data, subtitles, audio, showSubtitles, renderMode}: ZhiyingFullCutProps) => {
  const darkEditorial = data.scenes.some((scene) => {
    const marker = scene.templateProps?.v2VisualR2;
    const version = typeof marker === 'object' && marker !== null
      ? (marker as {version?: unknown}).version
      : null;
    return version === 'dark-editorial-v1@1' ||
      version === 'dark-editorial-v1@2' ||
      version === 'dark-editorial-v1@3';
  });
  const scenes = useMemo(() => data.scenes.map((s): FullCutScene => ({
    id: s.id, chapter: s.chapter, chapterTitle: s.chapterTitle,
    start: s.start, end: s.end, duration: s.duration,
    startFrame: s.startFrame, durationInFrames: s.durationInFrames,
    category: s.category as FullCutCategory,
    visualType: (s.visualType ?? 'UI') as FullCutVisualType,
    template: s.template, sourceTemplate: s.sourceTemplate,
    narrationSummary: s.narrationSummary, description: s.description,
    notes: s.notes, assetIds: s.assetIds,
    licenseStatus: s.licenseStatus as FullCutScene['licenseStatus'],
    subtitlePosition: normalizeSubtitlePosition(s.subtitlePosition),
    transitionIn: s.transitionIn, transitionOut: s.transitionOut,
  })), [data.scenes]);
  return (
    <RenderModeContext.Provider value={renderMode ?? 'preview'}>
      <AbsoluteFill style={{backgroundColor: colors.background}}>
        <FullVisualTrack scenes={data.scenes} chapterTiming={data.chapterTiming} assetMap={data.assetMap as Record<string, unknown>} showPilotIntro={data.project.showPilotIntro === true} />
        {audio.bgm ? <Audio src={staticFile(audio.bgm)} volume={bgmVolume} /> : null}
        {audio.sfx ? <Audio src={staticFile(audio.sfx)} volume={0.9} /> : null}
        {audio.narration ? <Audio src={staticFile(audio.narration)} volume={1} /> : null}
        {showSubtitles ? <FullSubtitles cues={subtitles} scenes={scenes} darkEditorial={darkEditorial} /> : null}
      </AbsoluteFill>
    </RenderModeContext.Provider>
  );
};

// ---- 旧版 Composition 包装（保留原预览入口，视觉与音频行为与迁移前一致）----

export const FullCutV1 = ({showSubtitles = true, includeNarration = true}: {showSubtitles?: boolean; includeNarration?: boolean}) => (
  <ZhiyingFullCut
    {...zhiyingFullCutDefaultProps}
    audio={{
      narration: includeNarration ? 'full/audio/FullCut_TTS.wav' : null,
      bgm: DEFAULT_BGM_PATH,
      sfx: DEFAULT_SFX_PATH,
    }}
    showSubtitles={showSubtitles}
  />
);

export const FullCutNoNarration = () => <FullCutV1 includeNarration={false} />;
export const FullCutNoNarrationNoSubtitles = () => <FullCutV1 includeNarration={false} showSubtitles={false} />;
export {FULL_CUT_DURATION_FRAMES};

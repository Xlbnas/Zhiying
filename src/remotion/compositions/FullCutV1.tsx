import {useMemo, type CSSProperties} from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
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
import type {Scene, TemplateName} from '../types/scene';
import {SceneRenderer} from './SceneRenderer';
import {PilotVisualTrack} from './PilotCutV1';

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

const toRenderableScene = (scene: SchemaScene): FullCutScene => ({
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
});

/**
 * 模板内置预览数据（FullCutScenes.json）→ 契约 Scene。
 * subtitlePosition 的原始值（lowerThird/midLower）超出 schema 枚举，
 * 经 string 窄化保留运行时原值，使 defaultProps 预览与线上渲染一致。
 */
const toSchemaScene = (scene: FullCutScene): SchemaScene => ({
  ...scene,
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

const texture = (warm: boolean, research: boolean): CSSProperties => ({
  backgroundImage: warm
    ? 'radial-gradient(circle at 26% 32%,rgba(155,145,131,.16),transparent 35%),repeating-linear-gradient(0deg,transparent 0 6px,rgba(255,255,255,.015) 7px)'
    : research
      ? 'radial-gradient(circle at 74% 28%,rgba(84,116,138,.16),transparent 34%),repeating-linear-gradient(90deg,transparent 0 39px,rgba(84,116,138,.025) 40px)'
      : 'radial-gradient(circle at 70% 30%,rgba(179,58,66,.08),transparent 28%),repeating-linear-gradient(0deg,transparent 0 6px,rgba(255,255,255,.012) 7px)',
});

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

const ModernEditorial = ({scene, chapterTiming}: {scene: FullCutScene; chapterTiming: ChapterTiming[]}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const research = scene.chapter === 7;
  const accent = research ? colors.research : colors.accent;
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cards = Array.from({length: 5}, (_, index) => index);
  const mode = scene.chapter >= 8 ? 'boundary' : scene.chapter === 7 ? 'research' : scene.chapter === 6 ? 'model' : 'interface';
  return (
    <AbsoluteFill style={{background: `linear-gradient(135deg,${colors.background},${research ? '#101820' : '#15151a'})`, overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, opacity: 0.38, ...texture(false, research)}} />
      <div
        style={{
          position: 'absolute', left: 118, top: 154, width: 1060, height: 690,
          borderRadius: 28, border: `1px solid ${research ? colors.researchSoft : '#34343b'}`,
          background: research ? '#101820' : '#111217', boxShadow: '0 28px 90px rgba(0,0,0,.5)', overflow: 'hidden',
        }}
      >
        <div style={{height: 72, borderBottom: `1px solid ${research ? colors.researchSoft : '#303039'}`, display: 'flex', alignItems: 'center', padding: '0 30px'}}>
          <div style={{fontFamily, color: colors.secondary, fontSize: 18, letterSpacing: 2}}>{mode === 'research' ? 'RESEARCH CONDITION' : mode === 'model' ? 'ACTION MODEL' : mode === 'boundary' ? 'EVIDENCE BOUNDARY' : 'EVERYDAY CONTEXT'}</div>
          <div style={{marginLeft: 'auto', display: 'flex', gap: 8}}>
            {cards.slice(0, 3).map((item) => <div key={item} style={{width: 7, height: 7, borderRadius: 9, background: item === 0 ? accent : colors.muted}} />)}
          </div>
        </div>
        <div style={{padding: '38px 42px', display: 'grid', gridTemplateColumns: '1.12fr .88fr', gap: 30}}>
          <div>
            {cards.map((item) => {
              const enter = interpolate(frame, [item * 9, item * 9 + 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
              const active = item === Math.min(4, Math.floor(progress * 5));
              return (
                <div key={item} style={{height: 82, marginBottom: 17, borderRadius: 14, border: `1px solid ${active ? accent : '#363741'}`, background: active ? `${accent}14` : '#181920', opacity: .35 + .65 * enter, transform: `translateX(${14 * (1 - enter)}px)`, display: 'flex', alignItems: 'center', padding: '0 24px'}}>
                  <div style={{width: 13, height: 13, borderRadius: 13, background: active ? accent : colors.muted}} />
                  <div style={{marginLeft: 20, width: `${62 - item * 5}%`, height: 7, background: active ? colors.primary : colors.secondary, opacity: active ? .72 : .26}} />
                </div>
              );
            })}
          </div>
          <div style={{borderRadius: 20, border: `1px solid ${research ? colors.researchSoft : '#363741'}`, background: '#14151a', padding: 30}}>
            <div style={{fontFamily, fontSize: 18, color: research ? colors.research : colors.secondary, letterSpacing: 2}}>CURRENT THOUGHT</div>
            <div style={{width: 56, height: 3, background: accent, margin: '26px 0 34px'}} />
            <Typography variant="SectionTitle" color={colors.primary} style={{fontSize: 40}}>{scene.narrationSummary}</Typography>
            <div style={{position: 'absolute', right: 38, bottom: 34, width: 170, height: 2, background: colors.muted}}>
              <div style={{width: `${progress * 100}%`, height: '100%', background: accent}} />
            </div>
          </div>
        </div>
      </div>
      <div style={{position: 'absolute', left: 1310, top: 350, width: 440}}>
        <div style={{fontFamily, fontSize: 20, color: colors.secondary, lineHeight: 1.55}}>同一问题，在不同情境里反复出现。</div>
        <div style={{height: 1, background: colors.muted, margin: '28px 0'}} />
        <div style={{fontFamily, fontSize: 18, color: research ? colors.research : colors.secondary, lineHeight: 1.55}}>画面提供结构；旁白保留判断边界。</div>
      </div>
      <ChapterLabel scene={scene} chapterTiming={chapterTiming} />
    </AbsoluteFill>
  );
};

const ArchiveEditorial = ({scene, chapterTiming}: {scene: FullCutScene; chapterTiming: ChapterTiming[]}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {extrapolateRight: 'clamp'});
  const isPortrait = scene.assetIds.includes('freud_1909_loc');
  if (isPortrait) {
    return (
      <AbsoluteFill style={{backgroundColor: colors.historicalSurface, overflow: 'hidden'}}>
        <Img src={staticFile('pilot/images/freud_1909_loc.jpg')} style={{position: 'absolute', left: 0, top: 0, width: 1040, height: 1080, objectFit: 'cover', objectPosition: '48% 30%', filter: 'grayscale(1) sepia(.13) contrast(1.12)', transform: `scale(${1.02 + progress * .06})`}} />
        <AbsoluteFill style={{background: 'linear-gradient(90deg,transparent 30%,#191714 58%)'}} />
        <div style={{position: 'absolute', left: 1080, top: 270, width: 700}}>
          <div style={{fontFamily, fontSize: 19, color: colors.historical, letterSpacing: 2.4}}>HISTORICAL CONTEXT</div>
          <div style={{width: 70, height: 3, background: colors.accent, margin: '32px 0'}} />
          <Typography variant="Title" color={colors.primary}>{scene.narrationSummary}</Typography>
        </div>
        <div style={{position: 'absolute', inset: 0, opacity: .32, ...texture(true, false)}} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{background: '#171512', overflow: 'hidden'}}>
      <div style={{position: 'absolute', inset: 0, opacity: .42, ...texture(true, false)}} />
      <div style={{position: 'absolute', left: 180, top: 120, width: 1510, height: 780, background: '#ded6c8', border: '1px solid #5b554d', boxShadow: '0 34px 110px rgba(0,0,0,.56)', transform: `rotate(${-0.6 + progress * .3}deg)`, padding: '78px 100px', boxSizing: 'border-box'}}>
        <div style={{fontFamily: 'Georgia, serif', color: '#4b443c', fontSize: 21, letterSpacing: 2.2}}>ARCHIVAL RECONSTRUCTION · SOURCE-BOUND</div>
        <div style={{fontFamily, color: '#201d19', fontSize: 54, fontWeight: 650, marginTop: 66, width: 1040}}>{scene.narrationSummary}</div>
        <div style={{marginTop: 68, width: 1030}}>
          {[0, 1, 2, 3, 4].map((line) => (
            <div key={line} style={{height: 2, background: '#8d8579', marginTop: 27, width: `${94 - line * 7}%`, opacity: .55}} />
          ))}
        </div>
        <div style={{position: 'absolute', right: 100, bottom: 85, width: 210, height: 126, border: '2px solid #8f3e42', color: '#8f3e42', fontFamily, fontSize: 22, letterSpacing: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'rotate(-4deg)', opacity: .7}}>INTERPRETATION</div>
      </div>
      <ChapterLabel scene={scene} chapterTiming={chapterTiming} />
    </AbsoluteFill>
  );
};

const MinimalEditorial = ({scene, chapterTiming}: {scene: FullCutScene; chapterTiming: ChapterTiming[]}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 16], [0, 1], {extrapolateRight: 'clamp'});
  if (scene.id === 'S085') return <AbsoluteFill style={{backgroundColor: '#000'}} />;
  const isBoundary = scene.chapter >= 7;
  return (
    <AbsoluteFill style={{backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center'}}>
      <div style={{width: 1420, textAlign: 'center', opacity, transform: `translateY(${8 * (1 - opacity)}px)`}}>
        <Typography variant={scene.narrationSummary.length > 24 ? 'SectionTitle' : 'Question'} color={colors.primary}>
          {scene.narrationSummary}
        </Typography>
        <div style={{width: isBoundary ? 84 : 44, height: 3, background: isBoundary ? colors.secondary : colors.accent, margin: '42px auto 0'}} />
      </div>
      <div style={{position: 'absolute', inset: 0, opacity: .25, ...texture(false, false)}} />
      <ChapterLabel scene={scene} chapterTiming={chapterTiming} />
    </AbsoluteFill>
  );
};

const MGEditorial = ({scene, chapterTiming}: {scene: FullCutScene; chapterTiming: ChapterTiming[]}) => {
  const mapped: Scene = {
    id: scene.id,
    start: scene.start,
    end: scene.end,
    duration: scene.duration,
    chapter: scene.chapter,
    visualType: 'A',
    template: scene.template as TemplateName,
    narrationSummary: scene.narrationSummary,
    visual: {description: scene.description, elements: []},
    assets: scene.assetIds,
    transitionIn: scene.transitionIn,
    transitionOut: scene.transitionOut,
    notes: scene.notes,
  };
  return (
    <AbsoluteFill>
      <SceneRenderer scene={mapped} />
      <ChapterLabel scene={scene} chapterTiming={chapterTiming} />
    </AbsoluteFill>
  );
};

const SceneContent = ({scene, chapterTiming}: {scene: FullCutScene; chapterTiming: ChapterTiming[]}) => {
  if (scene.category === 'MG') return <MGEditorial scene={scene} chapterTiming={chapterTiming} />;
  if (scene.category === 'Archive') return <ArchiveEditorial scene={scene} chapterTiming={chapterTiming} />;
  if (scene.category === 'Minimal') return <MinimalEditorial scene={scene} chapterTiming={chapterTiming} />;
  return <ModernEditorial scene={scene} chapterTiming={chapterTiming} />;
};

const TimedScene = ({scene, lead, tail, chapterTiming}: {scene: FullCutScene; lead: number; tail: number; chapterTiming: ChapterTiming[]}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fadeIn = lead === 0 ? 1 : interpolate(frame, [0, lead], [0, 1], {extrapolateRight: 'clamp'});
  const fadeOut = tail === 0 ? 1 : interpolate(frame, [durationInFrames - tail, durationInFrames - 1], [1, 0], {extrapolateLeft: 'clamp'});
  return <AbsoluteFill style={{opacity: Math.min(fadeIn, fadeOut)}}><SceneContent scene={scene} chapterTiming={chapterTiming} /></AbsoluteFill>;
};

const FullVisualTrack = ({scenes, chapterTiming, showPilotIntro = false}: {scenes: FullCutScene[]; chapterTiming: ChapterTiming[]; showPilotIntro?: boolean}) => (
  <AbsoluteFill>
    {scenes.map((scene, index) => {
      const logicalStart = scene.startFrame;
      const lead = index === 0 ? 0 : CROSSFADE_FRAMES;
      const tail = index === scenes.length - 1 ? 0 : CROSSFADE_FRAMES;
      const from = Math.max(0, logicalStart - lead);
      return (
        <Sequence key={scene.id} from={from} durationInFrames={scene.durationInFrames + lead + tail} layout="none">
          <TimedScene scene={scene} lead={lead} tail={tail} chapterTiming={chapterTiming} />
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

const FullSubtitles = ({cues, scenes}: {cues: SubtitleCue[]; scenes: FullCutScene[]}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const cue = cues.find((item) => time >= item.start && time < item.end);
  if (!cue) return null;
  const scene = scenes.find((item) => time >= item.start && time < item.end);
  const position = cue.position === 'mid' || scene?.subtitlePosition === 'midLower' ? 840 : scene?.subtitlePosition === 'lowerThird' ? 910 : 958;
  const alpha = interpolate(time, [cue.start, cue.start + .1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{position: 'absolute', left: 300, top: position, width: 1320, display: 'flex', justifyContent: 'center', opacity: alpha, pointerEvents: 'none'}}>
      <div style={{fontFamily, fontSize: 34, fontWeight: 540, lineHeight: 1.34, color: '#f5f5f5', padding: '8px 18px 10px', borderRadius: borderRadius.sm, background: 'rgba(5,5,7,.54)', boxShadow: '0 8px 28px rgba(0,0,0,.2)', textShadow: '0 2px 10px rgba(0,0,0,.7)', textAlign: 'center'}}>{cue.text}</div>
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
export const ZhiyingFullCut = ({data, subtitles, audio, showSubtitles}: ZhiyingFullCutProps) => {
  const scenes = useMemo(() => data.scenes.map(toRenderableScene), [data.scenes]);
  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      <FullVisualTrack scenes={scenes} chapterTiming={data.chapterTiming} showPilotIntro={data.project.showPilotIntro === true} />
      {audio.bgm ? <Audio src={staticFile(audio.bgm)} volume={bgmVolume} /> : null}
      {audio.sfx ? <Audio src={staticFile(audio.sfx)} volume={0.9} /> : null}
      {audio.narration ? <Audio src={staticFile(audio.narration)} volume={1} /> : null}
      {showSubtitles ? <FullSubtitles cues={subtitles} scenes={scenes} /> : null}
    </AbsoluteFill>
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

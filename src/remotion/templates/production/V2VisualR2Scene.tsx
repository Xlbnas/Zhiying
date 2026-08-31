import {createContext, useContext, type CSSProperties, type ReactNode} from 'react';
import {AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import type {ResolvedAsset, Scene as SchemaScene} from '@/lib/scene-schema';
import choreography from '@/data/v2-visual-r2-choreography-plan.json';
import {fontFamily} from '../../design/tokens';

export const V2_VISUAL_R2_VERSION = 'v2-visual-r2@2';
export const DARK_EDITORIAL_V1_VERSION = 'dark-editorial-v1@1';
export const DARK_EDITORIAL_V1_PACING_VERSION = 'dark-editorial-v1@2';
export const DARK_EDITORIAL_V1_STATE_PERSISTENCE_VERSION = 'dark-editorial-v1@3';

const lightPalette = {
  paper: '#f3f0e8',
  paperDeep: '#e7e1d5',
  ink: '#17272b',
  muted: '#647176',
  line: '#aab7b8',
  teal: '#216f78',
  tealSoft: '#d6e8e7',
  wine: '#943f42',
  wineSoft: '#ead9d6',
  gold: '#b68332',
  dark: '#101b1e',
  white: '#fffdf8',
};

const darkPalette = {
  paper: '#161719',
  paperDeep: '#232326',
  ink: '#f1eee8',
  muted: '#b9bdc0',
  line: '#505358',
  teal: '#4e9299',
  tealSoft: '#20383c',
  wine: '#9a4e52',
  wineSoft: '#3b2528',
  gold: '#b68c4e',
  dark: '#11191e',
  white: '#26272a',
};

type VisualPalette = typeof lightPalette;
const PaletteContext = createContext<VisualPalette>(lightPalette);
const DarkEditorialContext = createContext(false);
const usePalette = () => useContext(PaletteContext);
const useDarkEditorial = () => useContext(DarkEditorialContext);

type Beat = (typeof choreography.beats)[number];

export function isV2VisualR2Scene(scene: SchemaScene): boolean {
  const marker = scene.templateProps?.v2VisualR2;
  const version = typeof marker === 'object' && marker !== null
    ? (marker as {version?: unknown}).version
    : null;
  return version === V2_VISUAL_R2_VERSION ||
    version === DARK_EDITORIAL_V1_VERSION ||
    version === DARK_EDITORIAL_V1_PACING_VERSION ||
    version === DARK_EDITORIAL_V1_STATE_PERSISTENCE_VERSION;
}

function sceneRendererVersion(scene: SchemaScene): unknown {
  const marker = scene.templateProps?.v2VisualR2;
  return typeof marker === 'object' && marker !== null
    ? (marker as {version?: unknown}).version
    : null;
}

function isDarkEditorialScene(scene: SchemaScene): boolean {
  const version = sceneRendererVersion(scene);
  return version === DARK_EDITORIAL_V1_VERSION ||
    version === DARK_EDITORIAL_V1_PACING_VERSION ||
    version === DARK_EDITORIAL_V1_STATE_PERSISTENCE_VERSION;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function beatProgress(frame: number, beat: Beat): number {
  return clamp((frame - beat.startFrame) / Math.max(1, beat.endFrame - beat.startFrame - 1));
}

export function darkEditorialPacedBeatProgress(
  frame: number,
  beat: Pick<Beat, 'startFrame' | 'endFrame'>,
): number {
  const availableFrames = Math.max(1, beat.endFrame - beat.startFrame - 1);
  const settleFrames = Math.min(18, Math.max(10, Math.round(availableFrames * .24)));
  const motionFrames = Math.max(1, availableFrames - settleFrames);
  return clamp((frame - beat.startFrame) / motionFrames);
}

export function persistentBeatProgress(sceneId: string, beatId: string, activeProgress: number): number {
  const sceneBeats = choreography.beats.filter((candidate) => candidate.sceneId === sceneId);
  const beatIndex = sceneBeats.findIndex((candidate) => candidate.beatId === beatId);
  return beatIndex > 0 ? 1 : activeProgress;
}

function activeBeat(sceneId: string, frame: number): Beat {
  const beats = choreography.beats.filter((beat) => beat.sceneId === sceneId);
  return beats.find((beat) => frame >= beat.startFrame && frame < beat.endFrame) ?? beats.at(-1)!;
}

function Stage({chapter, label, children}: {chapter: string; label: string; children: ReactNode}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  const background = dark
    ? chapter === 'HISTORY' || chapter === 'HYPOTHESIS' || chapter === 'EXAMPLES' || chapter === 'CASE STUDY' || chapter === 'ASSOCIATION' || chapter === 'LEGACY'
      ? '#1b1816'
      : chapter === 'MODERN COGNITION' || chapter === 'LANGUAGE' || chapter === 'MONITOR' || chapter === 'MEMORY' || chapter === 'PROSPECTIVE MEMORY' || chapter === 'ACTION CONTROL' || chapter === 'MOTIVATION'
        ? '#11191e'
        : '#161719'
    : palette.paper;
  const chapterLabels: Record<string, string> = {
    OPENING: '开场', THESIS: '问题', HISTORY: '历史', HYPOTHESIS: '核心想法', EXAMPLES: '日常失误',
    'CASE STUDY': '案例', ASSOCIATION: '联想链', LEGACY: '影响', 'MODERN COGNITION': '现代认知',
    LANGUAGE: '语言', MONITOR: '语言监控', MEMORY: '记忆', 'PROSPECTIVE MEMORY': '未来意图记忆',
    'ACTION CONTROL': '行动控制', MOTIVATION: '动机与语境', REPLICATION: '复现', 'POST-HOC STORY': '事后解释',
    EVALUATION: '评价', CONCLUSION: '结论', 'NEXT ERROR': '下一次失误', FINAL: '收束',
  };
  return (
    <AbsoluteFill style={{backgroundColor: background, color: palette.ink, overflow: 'hidden', fontFamily}}>
      {dark ? null : <div style={{position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(23,39,43,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(23,39,43,.035) 1px, transparent 1px)', backgroundSize: '64px 64px'}} />}
      <div style={{position: 'absolute', left: 84, top: 58, display: 'flex', alignItems: 'center', gap: 18}}>
        <div style={{fontSize: dark ? 20 : 15, letterSpacing: dark ? 1.2 : 3.2, color: palette.wine, fontWeight: 700}}>{dark ? chapterLabels[chapter] ?? chapter : chapter}</div>
        <div style={{width: 48, height: 2, background: palette.wine}} />
        <div style={{fontSize: 22, color: palette.muted, fontWeight: 560}}>{label}</div>
      </div>
      {children}
    </AbsoluteFill>
  );
}

function Pill({children, x, y, width = 220, accent, opacity = 1, scale = 1, style}: {
  children: ReactNode; x: number; y: number; width?: number; accent?: string; opacity?: number; scale?: number; style?: CSSProperties;
}) {
  const palette = usePalette();
  const resolvedAccent = accent ?? palette.teal;
  return (
    <div style={{position: 'absolute', left: x, top: y, width, minHeight: 72, borderRadius: 18, border: `2px solid ${resolvedAccent}`, background: palette.white, boxShadow: '0 16px 42px rgba(0,0,0,.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 20px', textAlign: 'center', fontSize: 25, lineHeight: 1.22, fontWeight: 700, color: palette.ink, opacity, scale, ...style}}>
      {children}
    </div>
  );
}

function Dot({x, y, color, size = 18, opacity = 1}: {x: number; y: number; color: string; size?: number; opacity?: number}) {
  return <div style={{position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: '50%', background: color, boxShadow: `0 0 0 8px ${color}22`, opacity}} />;
}

function Path({d, color, progress = 1, dashed = false, width = 4}: {d: string; color?: string; progress?: number; dashed?: boolean; width?: number}) {
  const palette = usePalette();
  const length = 1000;
  return (
    <path d={d} fill="none" stroke={color ?? palette.teal} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={dashed ? '10 12' : length} strokeDashoffset={dashed ? 0 : length * (1 - clamp(progress))} />
  );
}

function EvidenceRail({active, support}: {active: number; support: string}) {
  const palette = usePalette();
  const labels = ['错误', '解释', '机制', '证据'];
  return (
    <div style={{position: 'absolute', left: 420, right: 180, top: 765, height: 70}}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 17, height: 3, background: palette.line}} />
      {labels.map((label, index) => {
        const x = index * 360;
        const on = index <= active;
        return (
          <div key={label} style={{position: 'absolute', left: x, top: 0, width: 100}}>
            <Dot x={16} y={18} color={on ? (index === 1 ? palette.wine : palette.teal) : palette.line} size={18} />
            <div style={{marginTop: 38, fontSize: 17, fontWeight: 650, color: on ? palette.ink : palette.muted}}>{label}</div>
          </div>
        );
      })}
      <div style={{position: 'absolute', right: 0, top: -16, width: 220, padding: '10px 14px', borderRadius: 12, background: palette.white, border: `2px solid ${palette.gold}`, color: palette.gold, fontSize: 15, fontWeight: 720, textAlign: 'center'}}>{support}</div>
    </div>
  );
}

function ArchiveFrame({asset, x, y, width, height, label, fit = 'cover', objectPosition = 'center'}: {asset?: ResolvedAsset; x: number; y: number; width: number; height: number; label: string; fit?: 'cover' | 'contain'; objectPosition?: string}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (!asset) throw new Error(`V2 Visual R2 缺少已绑定 archive asset: ${label}`);
  return (
    <div style={{position: 'absolute', left: x, top: y, width, height, borderRadius: 22, overflow: 'hidden', border: `2px solid ${palette.ink}`, background: palette.paperDeep, boxShadow: '0 24px 70px rgba(28,45,48,.18)'}}>
      <Img src={staticFile(asset.publicPath)} style={{width: '100%', height: '100%', objectFit: fit, objectPosition, padding: fit === 'contain' ? 18 : 0, filter: dark ? 'sepia(.26) saturate(.68) contrast(1.08) brightness(.82)' : 'sepia(.18) saturate(.78) contrast(1.04)'}} />
      <div style={{position: 'absolute', left: 18, top: 18, padding: '8px 13px', background: dark ? 'rgba(27,24,22,.88)' : 'rgba(255,253,248,.9)', borderRadius: 10, fontSize: 15, letterSpacing: dark ? .6 : 1.5, fontWeight: 760, color: dark ? palette.gold : palette.wine}}>{label}</div>
      <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, padding: '12px 18px', background: 'rgba(16,27,30,.78)', color: palette.white, fontSize: 13, lineHeight: 1.35}}>{asset.attribution}</div>
    </div>
  );
}

function HookVisual({scene, frame, beat, progress, activeProgress}: {scene: SchemaScene; frame: number; beat: Beat; progress: number; activeProgress: number}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (scene.id === 'S001') {
    const targetTravel = interpolate(progress, [.05, .62], [0, .72], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.16, 1, .3, 1)});
    const rivalTravel = interpolate(progress, [.18, .58], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.16, 1, .3, 1)});
    const resolved = interpolate(progress, [.58, .72], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return (
      <Stage chapter="OPENING" label="一次口误如何发生">
        <div style={{position: 'absolute', left: 180, right: 610, top: 363, height: 2, background: palette.line}} />
        <div style={{position: 'absolute', left: 180, right: 610, top: 648, height: 2, background: palette.line}} />
        <Pill x={220 + targetTravel * 960} y={270} width={330} accent={palette.teal} opacity={1 - resolved * .75} style={{minHeight: 104, fontSize: 36}}>现任</Pill>
        <Pill x={220 + rivalTravel * 1060} y={555} width={330} accent={palette.wine} opacity={1 - resolved} style={{minHeight: 104, fontSize: 36}}>前任</Pill>
        <Pill x={1320} y={395} width={440} accent={resolved > .4 ? palette.wine : palette.line} style={{minHeight: 112, fontSize: 35}}>{dark ? (resolved > .4 ? '说出口：前任' : '还没说出口') : `OUTPUT：${resolved > .4 ? '前任' : '等待候选'}`}</Pill>
        <div style={{position: 'absolute', left: 1240, top: 700, width: 540, fontSize: 28, color: palette.wine, fontWeight: 760, opacity: resolved}}>竞争词先到达同一个输出槽</div>
      </Stage>
    );
  }

  if (scene.id === 'S002') {
    const explanation = beat.beatId === 'B003' ? activeProgress : 0;
    return (
      <Stage chapter="OPENING" label="错误先发生，解释后进入">
        <Pill x={820} y={330} width={280} accent={palette.wine} scale={1.06}>前任</Pill>
        <div style={{position: 'absolute', left: 882, top: 425, color: palette.wine, fontWeight: 700, fontSize: dark ? 23 : 18}}>{dark ? '这次口误' : 'ERROR TOKEN'}</div>
        <Pill x={210} y={540} width={460} accent={palette.teal} opacity={interpolate(explanation, [.12, .4], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} style={{minHeight: 110, fontSize: 34}}>普通口误</Pill>
        <Pill x={1250} y={540} width={460} accent={palette.wine} opacity={interpolate(explanation, [.35, .65], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} style={{minHeight: 110, fontSize: 34}}>潜意识解释</Pill>
        <div style={{position: 'absolute', left: 570, top: 485, fontSize: 52, color: palette.teal, opacity: explanation}}>↙</div>
        <div style={{position: 'absolute', left: 1280, top: 485, fontSize: 52, color: palette.wine, opacity: explanation}}>↘</div>
        <div style={{position: 'absolute', left: 590, top: 735, width: 740, textAlign: 'center', color: palette.muted, fontSize: dark ? 30 : 21, opacity: explanation}}>同一次口误，可以有不止一种解释。</div>
      </Stage>
    );
  }

  if (scene.id === 'S003') {
    return (
      <Stage chapter="OPENING" label="同一错误，两条解释">
        <Pill x={110} y={350} width={460} accent={palette.wine} style={{minHeight: 118, fontSize: 33}}>{dark ? '这次口误' : 'ERROR：叫成前任'}</Pill>
        <Pill x={730} y={350} width={460} accent={palette.gold} style={{minHeight: 118, fontSize: 31}}>{dark ? '缺失的证据环节' : 'MISSING EVIDENCE'}</Pill>
        <Pill x={1350} y={350} width={460} accent={palette.wine} opacity={interpolate(progress, [.2, .5], [.35, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} style={{minHeight: 118, fontSize: 31}}>{dark ? '被推断的隐藏动机' : 'HIDDEN MOTIVE'}</Pill>
        <div style={{position: 'absolute', left: 620, top: 377, fontSize: 62, color: palette.gold}}>→</div>
        <div style={{position: 'absolute', left: 1240, top: 377, fontSize: 62, color: palette.wine}}>⇢</div>
        <div style={{position: 'absolute', left: 700, top: 545, width: 520, textAlign: 'center', color: palette.gold, fontSize: 30, fontWeight: 760}}>没有证据，推断不能跨过这里</div>
      </Stage>
    );
  }

  const secondBeat = beat.beatId === 'B006';
  const labels = secondBeat ? ['失误有原因', '原因未被意识到', '原因是被压抑愿望'] : ['错误发生', '原因机制', '隐藏欲望'];
  return (
    <Stage chapter="THESIS" label="把推断距离摊开">
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <Path d="M 280 450 C 620 450 900 450 1540 450" progress={interpolate(progress, [0, .65], [0, 1], {extrapolateRight: 'clamp', easing: Easing.bezier(.16, 1, .3, 1)})} color={palette.wine} />
      </svg>
      {labels.map((label, index) => {
        const x = 170 + index * 580;
        const reveal = interpolate(progress, [index * .16, index * .16 + .24], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return <Pill key={label} x={x} y={350 + (secondBeat ? index * 70 * activeProgress : 0)} width={380} accent={index === 2 ? palette.wine : palette.teal} opacity={reveal} scale={interpolate(reveal, [0, 1], [.88, 1], {extrapolateRight: 'clamp'})}>{label}</Pill>;
      })}
      <div style={{position: 'absolute', left: 640, top: 575, width: 640, textAlign: 'center', color: palette.muted, fontSize: 22, opacity: interpolate(progress, [.45, .72], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>{secondBeat ? '主张越强，需要跨过的证据门槛越高' : '不是一步推断，而是一整段待检验路径'}</div>
      <EvidenceRail active={secondBeat ? 2 : 1} support={secondBeat ? '主张增强，证据未足' : '仍是待检验路径'} />
    </Stage>
  );
}

function DarkHistoryVisual({scene, beat, progress, activeProgress, assets}: {scene: SchemaScene; beat: Beat; progress: number; activeProgress: number; assets: ResolvedAsset[]}) {
  const palette = usePalette();
  const reveal = (from: number, to: number) => interpolate(progress, [from, to], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  if (scene.id === 'S005') {
    return (
      <Stage chapter="HISTORY" label="一部研究日常失误的书">
        <ArchiveFrame asset={assets[0]} x={105} y={145} width={825} height={795} label="1904 年德文单行本" fit="contain" />
        <div style={{position: 'absolute', left: 1040, top: 230, width: 650}}>
          <div style={{fontSize: 46, lineHeight: 1.18, fontWeight: 760}}>日常生活心理病理学</div>
          <div style={{marginTop: 22, fontSize: 27, color: palette.gold}}>1904 年 · 德文单行本</div>
          <div style={{marginTop: 62, borderLeft: `4px solid ${palette.wine}`, paddingLeft: 28, fontSize: 32, lineHeight: 1.85, color: palette.muted, opacity: reveal(.16, .48)}}>忘记名字　·　口误<br />误读误写　·　忘记办事<br />拿错或弄丢东西</div>
        </div>
      </Stage>
    );
  }

  if (scene.id === 'S006') {
    const interference = beat.beatId === 'B009';
    const interferenceProgress = interference ? activeProgress : progress;
    return (
      <Stage chapter="HYPOTHESIS" label="弗洛伊德的核心想法">
        <ArchiveFrame asset={assets[0]} x={145} y={190} width={610} height={720} label="西格蒙德·弗洛伊德，约 1921" objectPosition="center 18%" />
        <div style={{position: 'absolute', left: 900, top: 215, width: 760}}>
          {!interference ? <>
            <div style={{fontSize: 31, color: palette.muted}}>不是：</div>
            <div style={{marginTop: 20, fontSize: 48, lineHeight: 1.28, fontWeight: 760, color: palette.ink}}>错误本身<br />会自动说出真话</div>
            <div style={{marginTop: 38, width: 600, height: 5, background: palette.wine, transformOrigin: 'left', scale: `${reveal(.08, .64)} 1`}} />
          </> : <>
            {['原本要说的事', '另一股没有承认的念头', '实际说出口'].map((text, index) => <div key={text} style={{marginTop: index === 0 ? 0 : 30, borderTop: `1px solid ${palette.line}`, paddingTop: 24, fontSize: index === 1 ? 32 : 38, color: index === 1 ? palette.wine : palette.ink, opacity: interpolate(interferenceProgress, [index * .16, index * .16 + .26], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>{text}</div>)}
            <div style={{marginTop: 46, fontSize: 23, color: palette.gold}}>他的解释：两股念头可能彼此干扰</div>
          </>}
        </div>
      </Stage>
    );
  }

  if (scene.id === 'S007') {
    const intention = beat.beatId === 'B011';
    return (
      <Stage chapter="EXAMPLES" label="同一本书里的两类日常失误">
        <ArchiveFrame asset={assets[0]} x={95} y={165} width={1080} height={760} label="1922 年英译本目录原页" objectPosition="center 55%" />
        <div style={{position: 'absolute', left: 1260, top: 240, width: 500}}>
          <div style={{fontSize: 27, color: palette.gold}}>原书中的分类</div>
          <div style={{marginTop: 42, padding: '30px 0', borderTop: `3px solid ${intention ? palette.line : palette.wine}`, fontSize: 52, fontWeight: 760, color: intention ? palette.muted : palette.ink}}>第五章　口误</div>
          <div style={{padding: '30px 0', borderTop: `3px solid ${intention ? palette.gold : palette.line}`, fontSize: 47, fontWeight: 760, color: intention ? palette.ink : palette.muted}}>第七章　忘记办事</div>
          <div style={{marginTop: 36, fontSize: 29, lineHeight: 1.5, color: palette.muted, opacity: reveal(.38, .68)}}>{intention ? '原本的意图，没有在正确时刻被想起来。' : '两种表达挤到一起，错误词先被说出口。'}</div>
        </div>
      </Stage>
    );
  }

  if (scene.id === 'S008') {
    const alternatives = beat.beatId === 'B013';
    return (
      <Stage chapter="CASE STUDY" label="西尼奥雷利忘名案例">
        <ArchiveFrame asset={assets[0]} x={120} y={190} width={560} height={720} label="卢卡·西尼奥雷利自画像" objectPosition="center 12%" />
        <ArchiveFrame asset={assets[1]} x={740} y={190} width={1050} height={590} label="《天堂中的获选者》，1499–1502" objectPosition="center 42%" />
        <div style={{position: 'absolute', left: 760, top: 825, width: 980, display: 'flex', justifyContent: 'space-between', fontSize: 32, color: palette.ink, opacity: reveal(.28, .58)}}>
          <span>想不起：西尼奥雷利</span><span style={{color: palette.wine}}>{alternatives ? '却冒出两个相近名字' : '姓名一时空缺'}</span>
        </div>
      </Stage>
    );
  }

  if (scene.id === 'S009') {
    const limitation = beat.beatId === 'B015';
    const namesFocus = !limitation && progress >= .38;
    const focusTransition = limitation
      ? interpolate(activeProgress, [0, .58], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.16, 1, .3, 1)})
      : 0;
    const sourceScale = limitation ? interpolate(focusTransition, [0, 1], [1.3, 1.48]) : namesFocus ? 1.3 : 1;
    const sourceTranslate = limitation
      ? `${interpolate(focusTransition, [0, 1], [135, -165])}px ${interpolate(focusTransition, [0, 1], [72, -92])}px`
      : namesFocus ? '135px 72px' : '0px 0px';
    return (
      <Stage chapter="ASSOCIATION" label="弗洛伊德的个案解释">
        {assets[0] ? <div style={{position: 'absolute', left: 90, top: 160, width: 1740, height: 760, borderRadius: 22, overflow: 'hidden', border: `2px solid ${palette.ink}`, background: palette.paperDeep}}>
          <Img src={staticFile(assets[0].publicPath)} style={{width: '100%', height: '100%', objectFit: 'contain', filter: 'sepia(.26) saturate(.68) contrast(1.08) brightness(.82)', scale: sourceScale, translate: sourceTranslate}} />
          <div style={{position: 'absolute', left: 22, top: 22, padding: '10px 15px', borderRadius: 10, background: 'rgba(27,24,22,.9)', color: palette.gold, fontSize: 18, fontWeight: 760}}>1922 年英译本 · 原始联想图</div>
          <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, padding: '13px 20px', background: 'rgba(16,27,30,.82)', color: palette.ink, fontSize: 14}}>{assets[0].attribution}</div>
        </div> : <ArchiveFrame asset={assets[0]} x={90} y={160} width={1740} height={760} label="1922 年英译本 · 原始联想图" fit="contain" />}
        <div style={{position: 'absolute', right: 135, top: 215, width: 500, padding: '20px 26px', background: 'rgba(27,24,22,.92)', borderLeft: `5px solid ${limitation ? palette.gold : palette.wine}`, fontSize: 31, lineHeight: 1.42}}>{limitation ? '死亡话题　→　痛苦联想' : namesFocus ? '姓名空缺　→　替代名字' : '先看原始联想图全貌'}</div>
        <div style={{position: 'absolute', right: 135, bottom: 110, width: 680, padding: '18px 24px', background: 'rgba(27,24,22,.92)', borderLeft: `5px solid ${limitation ? palette.gold : palette.wine}`, fontSize: 27, lineHeight: 1.45, opacity: reveal(.42, .7)}}>{limitation ? '他也承认：并非所有忘名都来自压抑。' : '图中把替代名字连回此前关于死亡与痛苦的谈话。'}</div>
      </Stage>
    );
  }

  const zoom = beat.beatId === 'B017';
  return (
    <Stage chapter="LEGACY" label="一种解释如何进入公共生活">
      <ArchiveFrame asset={assets[0]} x={90} y={165} width={1740} height={760} label="海牙国际精神分析大会，1920" objectPosition="center 38%" />
      <div style={{position: 'absolute', right: 130, bottom: 110, width: 720, padding: '24px 30px', background: 'rgba(27,24,22,.92)', borderLeft: `5px solid ${palette.gold}`, fontSize: 34, lineHeight: 1.42, color: zoom ? palette.gold : palette.ink, opacity: reveal(.22, .55)}}>{zoom ? '小错误，也被当作观察心理冲突的窗口。' : '精神分析从诊室进入普通人的日常语言。'}</div>
    </Stage>
  );
}

function HistoryVisual({scene, beat, progress, activeProgress, assets}: {scene: SchemaScene; beat: Beat; progress: number; activeProgress: number; assets?: ResolvedAsset[]}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (dark) return <DarkHistoryVisual scene={scene} beat={beat} progress={progress} activeProgress={activeProgress} assets={assets ?? []} />;
  const asset = assets?.[0];
  if (scene.id === 'S005') {
    const topics = ['忘记名字', '口误', '误读误写', '忘记办事', '拿错 / 弄丢'];
    return (
      <Stage chapter="HISTORY" label="把日常失误放进同一研究计划">
        <ArchiveFrame asset={asset} x={220} y={260} width={500} height={455} label="1904 · PRIMARY SOURCE" />
        {topics.map((topic, index) => {
          const reveal = interpolate(progress, [index * .1, index * .1 + .28], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return <Pill key={topic} x={900 + (index % 2) * 360} y={250 + Math.floor(index / 2) * 145} width={300} accent={index === 4 ? palette.wine : palette.teal} opacity={reveal} style={{translate: `${(1 - reveal) * 90}px 0`}}>{topic}</Pill>;
        })}
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 720 470 C 810 470 850 470 900 470" progress={progress} /></svg>
      </Stage>
    );
  }

  if (scene.id === 'S006') {
    const interference = beat.beatId === 'B009';
    const force = interpolate(progress, [.16, .72], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.16, 1, .3, 1)});
    return (
      <Stage chapter="HYPOTHESIS" label={interference ? '计划路径受到竞争念头干扰' : '先划掉一个过强命题'}>
        {!interference ? <>
          <Pill x={560} y={350} width={800} accent={palette.wine}>错误本身会自动说出真话</Pill>
          <div style={{position: 'absolute', left: 520, top: 397, width: 880, height: 8, background: palette.wine, rotate: `${interpolate(progress, [0, .65], [-8, 0], {extrapolateRight: 'clamp'})}deg`, transformOrigin: 'left', scale: `${interpolate(progress, [0, .7], [0, 1], {extrapolateRight: 'clamp'})} 1`}} />
          <Pill x={760} y={545} width={400} accent={palette.teal} opacity={interpolate(progress, [.55, .8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>ERROR TOKEN 保持中性</Pill>
        </> : <>
          <Pill x={220} y={330} width={330} accent={palette.teal}>原本计划</Pill>
          <Pill x={1330} y={330 + force * 130} width={340} accent={palette.wine}>实际动作偏移</Pill>
          <Pill x={750} y={560 - force * 170} width={390} accent={palette.wine} scale={.9 + force * .1}>未承认的竞争念头</Pill>
          <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
            <Path d="M 550 366 C 810 366 1030 366 1330 366" progress={1} />
            <Path d="M 940 595 C 1030 560 1150 490 1330 460" progress={force} color={palette.wine} />
          </svg>
        </>}
      </Stage>
    );
  }

  if (scene.id === 'S007') {
    const intention = beat.beatId === 'B011';
    const travel = interpolate(progress, [.1, .72], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return (
      <Stage chapter="EXAMPLES" label={intention ? '未来意图没有越过行动阈值' : '两种表达挤进同一出口'}>
        {!intention ? <>
          <div style={{position: 'absolute', left: 180, top: 225, color: palette.muted, fontSize: 18, fontWeight: 760}}>语言输出通道</div>
          <div style={{position: 'absolute', left: 180, right: 300, top: 470, height: 3, background: palette.line}} />
          <Pill x={230 + travel * 670} y={300} width={300} accent={palette.teal}>目标：现任</Pill>
          <Pill x={230 + travel * 790} y={520} width={300} accent={palette.wine}>竞争：前任</Pill>
          <div style={{position: 'absolute', left: 1125, top: 405, width: 170, height: 125, border: `3px solid ${palette.gold}`, borderRadius: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.gold, fontSize: 20, fontWeight: 760}}>同一出口</div>
          <Pill x={1400} y={425} width={310} accent={palette.wine} opacity={interpolate(progress, [.64, .86], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>说出口：前任</Pill>
        </> : <>
          <div style={{position: 'absolute', left: 180, top: 225, color: palette.muted, fontSize: 18, fontWeight: 760}}>未来意图通道</div>
          <div style={{position: 'absolute', left: 180, right: 300, top: 470, height: 3, background: palette.line}} />
          <Pill x={720} y={245} width={340} accent={palette.gold}>CUE：稍后执行</Pill>
          <Pill x={220 + travel * 600} y={395} width={390} accent={palette.teal}>待办：回消息 / 带钥匙</Pill>
          <div style={{position: 'absolute', left: 1110, top: 350, width: 190, height: 170, border: `3px solid ${palette.gold}`, borderRadius: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: palette.gold, fontSize: 20, lineHeight: 1.35, fontWeight: 760}}>行动阈值<br />未达到</div>
          <Pill x={1410} y={395} width={300} accent={palette.line} opacity={.35}>行动未触发</Pill>
        </>}
      </Stage>
    );
  }

  if (scene.id === 'S008') {
    const alternatives = beat.beatId === 'B013';
    return (
      <Stage chapter="CASE STUDY" label="西尼奥雷利忘名案例">
        <ArchiveFrame asset={asset} x={230} y={245} width={520} height={480} label="SIGNORELLI · ARCHIVE" />
        <Pill x={970} y={285} width={460} accent={palette.gold}>{alternatives ? '目标姓名：仍未取回' : '目标姓名槽：空'}</Pill>
        {alternatives ? <>
          <Pill x={880} y={500} width={310} accent={palette.wine} opacity={interpolate(progress, [.12, .4], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>相近名字 A</Pill>
          <Pill x={1320} y={500} width={310} accent={palette.wine} opacity={interpolate(progress, [.34, .64], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>相近名字 B</Pill>
          <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 1035 500 C 1080 430 1120 410 1180 360 M 1475 500 C 1420 430 1370 410 1320 360" progress={progress} color={palette.wine} dashed /></svg>
        </> : null}
      </Stage>
    );
  }

  if (scene.id === 'S009') {
    const limitation = beat.beatId === 'B015';
    const chain = interpolate(progress, [.12, .82], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return (
      <Stage chapter="ASSOCIATION" label={limitation ? '历史解释也留下了适用边界' : '替代词如何连回被避开的联想'}>
        <Pill x={150} y={350} width={300} accent={palette.wine}>替代名字</Pill>
        <Pill x={610} y={280} width={280} accent={palette.teal}>死亡谈话</Pill>
        <Pill x={610} y={500} width={280} accent={palette.teal}>痛苦谈话</Pill>
        <Pill x={1080} y={390} width={360} accent={palette.wine}>被避开的联想</Pill>
        <Pill x={1540} y={390} width={270} accent={limitation ? palette.gold : palette.wine} opacity={interpolate(chain, [.62, .86], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>{limitation ? '有限假设' : '压抑假设'}</Pill>
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
          <Path d="M 450 386 C 520 350 550 330 610 316 M 450 386 C 520 440 550 500 610 536 M 890 316 C 990 340 1010 390 1080 426 M 890 536 C 990 510 1010 450 1080 426 M 1440 426 C 1480 426 1510 426 1540 426" progress={chain} color={palette.wine} />
        </svg>
        {limitation ? <div style={{position: 'absolute', left: 1010, top: 625, width: 650, padding: '18px 24px', background: palette.gold + '20', borderLeft: `6px solid ${palette.gold}`, fontSize: 22, fontWeight: 720}}>并非所有忘名都来自压抑</div> : null}
      </Stage>
    );
  }

  const zoom = beat.beatId === 'B017';
  return (
    <Stage chapter="LEGACY" label={zoom ? '小错误成为观察窗口' : '解释从诊室进入日常生活'}>
      <ArchiveFrame asset={asset} x={180} y={250} width={500} height={455} label="HISTORICAL CONTEXT" />
      <Pill x={790} y={290} width={280} accent={palette.wine}>梦 / 诊室</Pill>
      <Pill x={1370} y={290} width={340} accent={palette.teal} opacity={interpolate(progress, [.28, .55], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>普通人的日常</Pill>
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 1070 326 C 1190 326 1260 326 1370 326" progress={progress} /></svg>
      <div style={{position: 'absolute', left: 930, top: 500, width: zoom ? 610 : 280, height: zoom ? 190 : 110, border: `4px solid ${palette.gold}`, borderRadius: 26, scale: interpolate(progress, [0, .72], [.72, 1], {extrapolateRight: 'clamp'}), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 760, color: palette.ink}}>{zoom ? '冲突假设观察窗　？' : '一个普通小错误'}</div>
    </Stage>
  );
}

function ActivationRace({progress}: {progress: number}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  const target = interpolate(progress, [0, .38, .68, 1], [.18, .74, .64, .9], {extrapolateRight: 'clamp'});
  const rival = interpolate(progress, [0, .38, .68, 1], [.12, .52, .94, .74], {extrapolateRight: 'clamp'});
  const other = interpolate(progress, [0, .5, 1], [.08, .46, .34], {extrapolateRight: 'clamp'});
  const rivalAhead = rival > target;
  if (dark) {
    const candidates = [
      ['目标词：现任', target, palette.teal],
      ['竞争词：前任', rival, palette.wine],
      ['其他可能的词', other, palette.gold],
    ] as const;
    return (
      <div style={{position: 'absolute', left: 300, top: 245, width: 1040, borderTop: `1px solid ${palette.line}`}}>
        <div style={{padding: '28px 0 34px', fontSize: 28, color: palette.muted}}>说话时，几个词可能同时被想到</div>
        {candidates.map(([label, value, color], index) => {
          const leading = Number(value) === Math.max(target, rival, other);
          return <div key={label} style={{display: 'grid', gridTemplateColumns: '1fr 280px', alignItems: 'center', minHeight: 118, borderTop: `1px solid ${palette.line}`, opacity: .58 + Number(value) * .42}}><div style={{fontSize: leading ? 42 : 34, fontWeight: leading ? 760 : 620, color: leading ? color : palette.ink}}>{label}</div><div style={{fontSize: 25, color, textAlign: 'right'}}>{leading ? '此刻更容易被说出' : index === 2 ? '仍在背景里' : '也在竞争'}</div></div>;
        })}
        <div style={{borderTop: `1px solid ${palette.line}`, paddingTop: 28, fontSize: 28, color: rivalAhead ? palette.wine : palette.teal}}>领先的词，会先进入语言监控。</div>
      </div>
    );
  }
  return (
    <div style={{position: 'absolute', left: 320, top: 260, width: 940, height: 440, borderRadius: 28, background: palette.white, border: `1px solid ${palette.line}`, padding: 42}}>
      <div style={{fontSize: 20, letterSpacing: dark ? .4 : 2.5, color: palette.muted}}>{dark ? '多个词同时竞争' : 'LEXICAL ACTIVATION RACE'}</div>
      {[['目标词：现任', target, palette.teal], ['竞争词：前任', rival, palette.wine], ['其他候选', other, palette.gold]].map(([label, value, color]) => (
        <div key={String(label)} style={{marginTop: 46}}>
          <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 22, fontWeight: 650}}><span>{label}</span><span style={{color: String(color)}}>{String(label).includes('其他') ? '低激活' : rivalAhead === String(label).includes('竞争词') ? '暂时领先' : '竞争中'}</span></div>
          <div style={{marginTop: 12, height: 18, borderRadius: 9, background: '#dfe5e2', overflow: 'hidden'}}><div style={{height: '100%', width: `${Number(value) * 100}%`, background: String(color), borderRadius: 9}} /></div>
        </div>
      ))}
      <div style={{position: 'absolute', left: 42, right: 42, top: 178, borderTop: `2px dashed ${palette.gold}`, opacity: .7}} />
      <div style={{position: 'absolute', right: 44, top: 150, fontSize: 15, color: palette.gold}}>输出阈值</div>
      <div style={{position: 'absolute', right: 42, top: 28, padding: '8px 14px', borderRadius: 12, background: rivalAhead ? palette.wineSoft : palette.tealSoft, color: rivalAhead ? palette.wine : palette.teal, fontSize: 18, fontWeight: 760}}>{rivalAhead ? '竞争词短暂领先' : '目标词领先'}</div>
    </div>
  );
}

function MechanismVisual({scene, frame, beat, progress, activeProgress}: {scene: SchemaScene; frame: number; beat: Beat; progress: number; activeProgress: number}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (scene.id === 'S011') {
    if (dark) {
      const modules = [
        ['语言竞争', '多个词项同时活跃'],
        ['记忆取回', '知道，不等于此刻能想起'],
        ['注意负荷', '资源被眼前任务占用'],
        ['行动控制', '熟练动作可能抢先'],
      ] as const;
      return (
        <Stage chapter="MODERN COGNITION" label="同一次失误，可以拆成四个机制问题">
          <div style={{position: 'absolute', left: 150, top: 205, width: 1620, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 34}}>
            {modules.map(([title, note], index) => {
              const reveal = interpolate(progress, [.08 + index * .1, .34 + index * .1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
              return <div key={title} style={{minHeight: 250, padding: '44px 48px', borderTop: `5px solid ${index === 0 ? palette.wine : palette.teal}`, background: palette.white, opacity: reveal}}><div style={{fontSize: 47, fontWeight: 760}}>{title}</div><div style={{marginTop: 34, fontSize: 30, lineHeight: 1.45, color: palette.muted}}>{note}</div></div>;
            })}
          </div>
        </Stage>
      );
    }
    return (
      <Stage chapter="MODERN COGNITION" label="错误不变，解释空间扩大">
        <Pill x={160} y={350} width={340} accent={palette.wine} opacity={interpolate(progress, [0, .42], [1, .42], {extrapolateRight: 'clamp'})}>旧框架：隐藏动机</Pill>
        <div style={{position: 'absolute', left: 545, top: 365, fontSize: 44, color: palette.muted}}>→</div>
        <Pill x={650} y={350} width={280} accent={palette.wine}>{dark ? '同一次失误' : '同一个 ERROR'}</Pill>
        <div style={{position: 'absolute', left: 975, top: 365, fontSize: 44, color: palette.teal}}>→</div>
        <div style={{position: 'absolute', left: 1080, top: 230, width: 680, height: 430, borderRadius: 28, border: `2px solid ${palette.teal}`, background: palette.tealSoft + '66', padding: '32px 36px'}}>
          <div style={{fontSize: dark ? 22 : 18, color: palette.teal, fontWeight: 780, letterSpacing: dark ? .4 : 2}}>{dark ? '换一种解释：认知机制' : 'MECHANISM ANALYSIS'}</div>
        {['语言竞争', '记忆取回', '注意监控', '行动控制'].map((label, index) => {
          const reveal = interpolate(progress, [.14 + index * .1, .38 + index * .1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return <div key={label} style={{position: 'absolute', left: 35 + (index % 2) * 325, top: 95 + Math.floor(index / 2) * 145, width: 275, height: 92, borderRadius: 18, border: `2px solid ${palette.teal}`, background: palette.white, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 23, fontWeight: 720, opacity: reveal}}>{label}</div>;
        })}
        </div>
      </Stage>
    );
  }

  if (scene.id === 'S012' && beat.beatId === 'B019') {
    const split = interpolate(progress, [.2, .72], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(.16, 1, .3, 1)});
    return (
      <Stage chapter="LANGUAGE" label="不是预写句子再播放">
        <Pill x={440} y={280} width={1040} accent={palette.teal} opacity={1 - split * .65}>我把现任叫成了前任　▶</Pill>
        {['语义层', '词项层', '语音层'].map((label, index) => <Pill key={label} x={530 + index * 350} y={420 + index * 70 * split} width={280} accent={index === 1 ? palette.wine : palette.teal} opacity={split}>{label}</Pill>)}
        <div style={{position: 'absolute', left: 610, top: 665, color: palette.muted, fontSize: 23, opacity: split}}>逐层生成　→　候选同时竞争</div>
      </Stage>
    );
  }

  if (scene.id === 'S012') {
    const raceProgress = beat.beatId === 'B020' ? activeProgress : progress;
    return <Stage chapter="LANGUAGE" label="多个词项同时竞争"><ActivationRace progress={raceProgress} /><Pill x={1390} y={390} width={260} accent={palette.gold} opacity={interpolate(raceProgress, [.58, .82], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>{dark ? '领先的词进入语言监控' : '领先者进入监控闸门'}</Pill></Stage>;
  }

  if (scene.id === 'S013') {
    const wrongWins = beat.beatId === 'B022';
    const stateReveal = interpolate(progress, [.22, .62], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return (
      <Stage chapter="MONITOR" label={wrongWins ? '偶尔，错误候选被放行' : '大多数时候，错误候选被拦住'}>
        <Pill x={170} y={365} width={420} accent={palette.wine} style={{minHeight: 112, fontSize: 33}}>错误候选：前任</Pill>
        <div style={{position: 'absolute', left: 790, top: 270, width: 340, height: 320, borderRadius: 24, border: `4px solid ${wrongWins ? palette.wine : palette.teal}`, background: palette.white, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: wrongWins ? palette.wine : palette.teal, fontSize: 32, lineHeight: 1.45, fontWeight: 780}}><span>语言监控</span><span style={{marginTop: 30, fontSize: 38}}>{wrongWins ? '放行' : '拦住'}</span></div>
        <Pill x={1330} y={365} width={420} accent={wrongWins ? palette.wine : palette.teal} opacity={stateReveal} style={{minHeight: 112, fontSize: 32}}>{wrongWins ? '放行说出口' : '拦住错误词'}</Pill>
        <div style={{position: 'absolute', left: 1215, top: 585, width: 650, textAlign: 'center', color: wrongWins ? palette.wine : palette.teal, fontSize: 29, fontWeight: 760, opacity: stateReveal}}>{wrongWins ? '结果：说出口“前任”' : '结果：错误词没有出口'}</div>
      </Stage>
    );
  }

  const funnel = beat.beatId === 'B024';
  const retrievalProgress = funnel ? activeProgress : progress;
  return (
    <Stage chapter="MEMORY" label="信息仍在，但暂时不可达">
      <Pill x={250} y={300} width={310} accent={palette.teal}>姓名记忆痕迹</Pill>
      <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
        <Path d="M 560 336 C 770 336 760 600 1030 600 C 1240 600 1280 430 1450 430" progress={funnel ? interpolate(activeProgress, [0, 1], [.25, 1]) : .25} color={palette.teal} />
        <line x1="1010" y1="535" x2="1010" y2="690" stroke={palette.gold} strokeWidth="5" strokeDasharray="12 10" />
      </svg>
      <Pill x={1380} y={390} width={320} accent={palette.wine} opacity={funnel ? interpolate(activeProgress, [.58, .8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : .2}>输出槽：空</Pill>
      <div style={{position: 'absolute', left: 855, top: 705, color: palette.gold, fontSize: 20, fontWeight: 720}}>取回阈值</div>
      <div style={{position: 'absolute', left: 705, top: 260, width: 560, textAlign: 'center', fontSize: 28, fontWeight: 720, color: palette.ink, opacity: interpolate(retrievalProgress, [.15, .42], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>{funnel ? '痕迹没有越过阈值' : '仍在记忆里 ≠ 此刻能说出来'}</div>
    </Stage>
  );
}

function AppliedMechanismVisual({scene, beat, progress, activeProgress}: {scene: SchemaScene; beat: Beat; progress: number; activeProgress: number}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (scene.id === 'S015') {
    const load = beat.beatId === 'B026';
    const taskX = interpolate(progress, [0, 1], [250, 1450], {extrapolateRight: 'clamp'});
    return (
      <Stage chapter="PROSPECTIVE MEMORY" label={load ? '当前负荷遮住未来线索' : '任务必须在正确时刻触发'}>
        <div style={{position: 'absolute', left: 210, right: 220, top: 510, height: 7, borderRadius: 4, background: palette.line}} />
        {[['现在', 250], [dark ? '环境提示' : '环境 cue', 870], ['稍后执行', 1450]].map(([label, x], index) => <div key={String(label)} style={{position: 'absolute', left: Number(x), top: 475}}><Dot x={0} y={38} color={index === 1 ? palette.gold : palette.teal} size={22} /><div style={{marginTop: 62, fontSize: dark ? 24 : 18, fontWeight: 700}}>{label}</div></div>)}
        <Pill x={taskX} y={350} width={330} accent={palette.teal}>买牛奶 / 回消息 / 带钥匙</Pill>
        {load ? <div style={{position: 'absolute', left: 650, top: 245, width: 630, height: 330, borderRadius: 28, background: palette.wineSoft, border: `3px solid ${palette.wine}`, opacity: interpolate(activeProgress, [.15, .5], [.2, .94], {extrapolateRight: 'clamp'}), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 780, color: palette.wine}}>{dark ? '手头的事太占注意力' : '当前任务高负荷'}<div style={{position: 'absolute', right: 24, bottom: 20, fontSize: 16}}>40 篇研究系统综述</div></div> : null}
      </Stage>
    );
  }

  if (scene.id === 'S016') {
    const takeover = beat.beatId === 'B028';
    const familiar = interpolate(progress, [.08, .68], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    const current = takeover ? interpolate(activeProgress, [.36, .9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}) : progress * .32;
    return (
      <Stage chapter="ACTION CONTROL" label={takeover ? '当前目标来迟一步' : '熟练脚本抢先启动'}>
        <Pill x={170} y={385} width={300} accent={palette.teal}>动作起点</Pill>
        <Pill x={1390} y={265} width={350} accent={palette.wine}>熟悉旧路线 / 旧杯子</Pill>
        <Pill x={1390} y={545} width={350} accent={palette.teal}>今天的目标</Pill>
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
          <Path d="M 470 421 C 790 421 970 300 1390 301" progress={familiar} color={palette.wine} width={7} />
          <Path d="M 470 421 C 800 421 980 580 1390 581" progress={current} color={palette.teal} width={6} dashed={takeover} />
        </svg>
        {takeover ? <div style={{position: 'absolute', left: 1070, top: 610, color: palette.teal, fontSize: 23, fontWeight: 760, opacity: current}}>纠正信号亮起，但路径已选</div> : null}
      </Stage>
    );
  }

  if (scene.id === 'S017') {
    const context = beat.beatId === 'B030';
    const bias = interpolate(progress, [0, 1], [.25, .8], {extrapolateRight: 'clamp'});
    if (dark) {
      const candidates = [
        ['普通候选', '平时更容易出现', palette.teal],
        ['语境相关候选', context ? '眼下更容易被想到' : '也可能出现', palette.wine],
        ['其他候选', '仍然可能出现', palette.gold],
      ] as const;
      return (
        <Stage chapter="MOTIVATION" label="动机可能参与，但不能替我们下结论">
          <div style={{position: 'absolute', left: 150, top: 205, width: 1620}}>
            <div style={{fontSize: 48, lineHeight: 1.3, fontWeight: 760}}>语境可能改变候选词的竞争权重</div>
            <div style={{marginTop: 48, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 32}}>
              {candidates.map(([label, note, color], index) => <div key={label} style={{minHeight: 270, padding: '38px 36px', borderTop: `5px solid ${color}`, background: palette.white, opacity: index === 1 && context ? 1 : .74}}><div style={{fontSize: 36, fontWeight: 760, color: index === 1 && context ? color : palette.ink}}>{label}</div><div style={{marginTop: 54, fontSize: 30, lineHeight: 1.4, color}}>{note}</div></div>)}
            </div>
            <div style={{marginTop: 42, paddingTop: 28, borderTop: `2px solid ${palette.wine}`, fontSize: 34, color: palette.ink}}>但这不等于已经发现被压抑的欲望。</div>
          </div>
        </Stage>
      );
    }
    return (
      <Stage chapter="MOTIVATION" label={context ? '语境改变概率，不锁定答案' : '动机是输入，不是结论'}>
        <Pill x={210} y={300} width={330} accent={palette.wine}>动机权重</Pill>
        <Pill x={210} y={510} width={330} accent={palette.teal}>当前语境</Pill>
        <div style={{position: 'absolute', left: 710, top: 275, width: 760, height: 340, borderRadius: 28, background: palette.white, border: `2px solid ${palette.line}`, padding: 38}}>
          <div style={{fontSize: 19, color: palette.muted, letterSpacing: 2}}>CANDIDATE RELATIVE ACTIVATION · 示意</div>
          {[['普通候选', context ? 1 - bias * .45 : .64, palette.teal], ['语境相关候选', context ? bias : .42, palette.wine], ['其他候选', .31, palette.gold]].map(([label, value, color]) => <div key={String(label)} style={{marginTop: 38, fontSize: 20, fontWeight: 700}}><div style={{display: 'flex', justifyContent: 'space-between'}}><span>{label}</span><span style={{color: String(color)}}>相对强度</span></div><div style={{marginTop: 10, height: 16, background: '#dfe5e2', borderRadius: 8, overflow: 'hidden'}}><div style={{height: '100%', width: `${Number(value) * 100}%`, background: String(color)}} /></div></div>)}
        </div>
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 540 336 C 620 336 650 360 710 390 M 540 546 C 620 546 650 510 710 485" progress={progress} /></svg>
      </Stage>
    );
  }

  if (scene.id === 'S018') {
    const boundary = beat.beatId === 'B032';
    const cards = [
      ['初始研究', '初始支持', 86],
      ['后续研究', '结果波动', 63],
      ['再次检验', '支持减弱', 44],
      ['复现检查', '未稳定复现', 31],
    ] as const;
    if (dark) {
      return (
        <Stage chapter="REPLICATION" label={boundary ? '心理状态可能参与，不等于欲望已经被证实' : '复现之后，支持没有稳定下来'}>
          <div style={{position: 'absolute', left: 100, top: 265, width: 1720, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 26}}>
            {cards.map(([label, state], index) => {
              const reveal = interpolate(progress, [index * .1, index * .1 + .25], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
              return <div key={label} style={{position: 'relative', minHeight: 300, padding: '38px 32px', borderTop: `6px solid ${index < 2 ? palette.teal : palette.gold}`, background: palette.white, opacity: reveal}}><div style={{fontSize: 26, color: palette.muted}}>{label}</div><div style={{marginTop: 64, fontSize: 38, lineHeight: 1.35, fontWeight: 760, color: index < 2 ? palette.teal : palette.gold}}>{state}</div>{index < 3 ? <div style={{position: 'absolute', right: -25, top: 132, fontSize: 46, color: palette.line}}>→</div> : null}</div>;
            })}
          </div>
          <div style={{position: 'absolute', left: 310, right: 310, bottom: 140, borderTop: `2px solid ${palette.wine}`, paddingTop: 24, textAlign: 'center', fontSize: 31, lineHeight: 1.4, color: boundary ? palette.ink : palette.muted}}>{boundary ? '“可能参与竞争”与“被压抑欲望已被抓住”，不是同一个结论。' : '一次有趣的结果，还需要经得住再次检验。'}</div>
        </Stage>
      );
    }
    return (
      <Stage chapter="REPLICATION" label={boundary ? '可能参与，不等于欲望已被证实' : '支持度随复现而下降'}>
        {cards.map(([label, state], index) => {
          const reveal = interpolate(progress, [index * .1, index * .1 + .25], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return <div key={label} style={{position: 'absolute', left: 150 + index * 420, top: 300 + (index % 2) * 70, width: 330, height: 180, borderRadius: 20, background: palette.white, border: `2px solid ${index < 2 ? palette.teal : palette.gold}`, padding: 25, opacity: reveal}}><div style={{fontSize: 23, fontWeight: 760}}>{label}</div><div style={{marginTop: 44, padding: '13px 16px', borderRadius: 12, background: index < 2 ? palette.tealSoft : palette.paperDeep, color: index < 2 ? palette.teal : palette.gold, fontSize: 17, fontWeight: 720, textAlign: 'center'}}>{state}</div></div>;
        })}
        {boundary ? <>
          <Pill x={390} y={600} width={380} accent={palette.teal}>心理状态可能参与</Pill>
          <Pill x={1170} y={600} width={480} accent={palette.wine} opacity={.25}>被压抑欲望已被证实</Pill>
        </> : null}
        <EvidenceRail active={3} support={boundary ? '心理参与不等于动机已证实' : '复现支持减弱'} />
      </Stage>
    );
  }

  const storyReveal = interpolate(progress, [.52, .78], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  if (dark) {
    return (
      <Stage chapter="POST-HOC STORY" label="结果出来以后，解释才被补上">
        <div style={{position: 'absolute', left: 170, top: 245, width: 1580, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 70}}>
          {[['事前', '没有留下预测'], ['结果', '错误已经发生'], ['事后解释', '再从经历里挑一条吻合故事']].map(([title, text], index) => <div key={title} style={{minHeight: 380, paddingTop: 26, borderTop: `4px solid ${index === 0 ? palette.gold : palette.wine}`, opacity: index === 2 ? storyReveal : 1}}><div style={{fontSize: 26, color: index === 0 ? palette.gold : palette.wine}}>{title}</div><div style={{marginTop: 42, fontSize: 40, lineHeight: 1.45, fontWeight: 720}}>{text}</div></div>)}
        </div>
        <div style={{position: 'absolute', left: 790, top: 775, fontSize: 27, color: palette.muted, opacity: storyReveal}}>童年、关系、压力……都可能在结果之后才被挑中。</div>
      </Stage>
    );
  }
  return (
    <Stage chapter="POST-HOC STORY" label="结果之后，总能回填一条吻合故事">
      <Pill x={160} y={350} width={390} accent={palette.gold}>BEFORE：没有事前预测</Pill>
      <div style={{position: 'absolute', left: 610, top: 365, fontSize: 48, color: palette.muted}}>→</div>
      <Pill x={730} y={350} width={390} accent={palette.wine}>OUTCOME：错误已发生</Pill>
      <div style={{position: 'absolute', left: 1175, top: 365, fontSize: 48, color: palette.wine, opacity: storyReveal}}>→</div>
      <Pill x={1300} y={350} width={440} accent={palette.wine} opacity={storyReveal}>AFTER：故事才接上结果</Pill>
      <div style={{position: 'absolute', left: 1260, top: 520, width: 500, textAlign: 'center', color: palette.wine, fontSize: 21, fontWeight: 760, opacity: storyReveal}}>童年 / 关系 / 压力等经历只在结果后被挑选</div>
    </Stage>
  );
}

function EvidenceCard({x, y, title, status, accent, opacity = 1}: {x: number; y: number; title: string; status: string; accent: string; opacity?: number}) {
  const palette = usePalette();
  return (
    <div style={{position: 'absolute', left: x, top: y, width: 360, minHeight: 150, padding: '28px 30px', borderRadius: 20, border: `2px solid ${accent}`, background: palette.white, boxShadow: '0 18px 48px rgba(28,45,48,.1)', opacity}}>
      <div style={{fontSize: 24, fontWeight: 760}}>{title}</div>
      <div style={{marginTop: 22, fontSize: 17, color: accent, fontWeight: 700, letterSpacing: 1.2}}>{status}</div>
    </div>
  );
}

function EvaluationVisual({scene, beat, progress, activeProgress}: {scene: SchemaScene; beat: Beat; progress: number; activeProgress: number}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (scene.id === 'S020') {
    const prediction = beat.beatId === 'B035';
    return (
      <Stage chapter="EVALUATION" label="故事通顺，不等于科学解释">
        <EvidenceCard x={220} y={280} title="故事讲得通" status="叙事一致性：高" accent={palette.wine} />
        <EvidenceCard x={780} y={280} title="可检验" status={prediction ? '事前预测：已冻结' : '事前预测：缺失'} accent={prediction ? palette.teal : palette.gold} />
        <EvidenceCard x={1340} y={280} title="结果" status={prediction ? '等待揭示' : '尚未进入'} accent={palette.line} opacity={interpolate(progress, [.4, .68], [.35, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})} />
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 580 355 C 680 355 700 355 780 355 M 1140 355 C 1230 355 1260 355 1340 355" progress={progress} color={prediction ? palette.teal : palette.gold} /></svg>
        <div style={{position: 'absolute', left: 650, top: 570, width: 620, textAlign: 'center', color: palette.muted, fontSize: 23}}>解释必须在结果出现之前留下可失败的预测</div>
        <EvidenceRail active={3} support={prediction ? '已留下可失败预测' : '缺少事前预测'} />
      </Stage>
    );
  }

  if (scene.id === 'S021') {
    const rewrite = beat.beatId === 'B037';
    const alternatives = ['词频', '语音相似', '疲劳', '注意下降'];
    const outcomeReveal = interpolate(activeProgress, [.18, .42], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    const rewriteReveal = interpolate(activeProgress, [.58, .82], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return (
      <Stage chapter="EVALUATION" label={rewrite ? '结果相反，故事还能改写吗？' : '让普通原因进入同一比较'}>
        {!rewrite ? <Pill x={760} y={220} width={400} accent={palette.wine}>隐藏动机解释</Pill> : <>
          <Pill x={170} y={220} width={390} accent={palette.wine}>事前预测：隐藏动机</Pill>
          <div style={{position: 'absolute', left: 600, top: 235, fontSize: 46, color: palette.wine}}>→</div>
          <Pill x={700} y={220} width={390} accent={palette.gold} opacity={outcomeReveal}>相反结果出现</Pill>
          <div style={{position: 'absolute', left: 1130, top: 235, fontSize: 46, color: palette.wine, opacity: outcomeReveal}}>→</div>
          <Pill x={1230} y={220} width={390} accent={palette.wine} opacity={outcomeReveal}>预测失败　×</Pill>
        </>}
        {alternatives.map((label, index) => {
          const reveal = rewrite ? 1 : interpolate(progress, [index * .1, index * .1 + .28], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return <Pill key={label} x={180 + index * 420} y={470} width={300} accent={palette.teal} opacity={reveal}>{label}</Pill>;
        })}
        {rewrite ? <div style={{position: 'absolute', left: 590, top: 635, width: 740, minHeight: 84, padding: '20px 28px', borderRadius: 18, background: palette.wineSoft, border: `2px solid ${palette.wine}`, textAlign: 'center', color: palette.wine, fontSize: 23, fontWeight: 760, opacity: rewriteReveal}}>结果之后：换一条联想，改写故事</div> : null}
      </Stage>
    );
  }

  if (scene.id === 'S022') {
    const contribution = beat.beatId === 'B039';
    const center = interpolate(progress, [.18, .62], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    if (dark) {
      return (
        <Stage chapter="CONCLUSION" label="拒绝两个过度结论">
          <div style={{position: 'absolute', left: 160, top: 220, width: 1600}}>
            <div style={{display: 'flex', justifyContent: 'space-between', color: palette.wine, fontSize: 30}}><span>不是“弗洛伊德全错”</span><span>也不是“每次嘴瓢都是真心话”</span></div>
            <div style={{marginTop: 80, padding: '58px 70px', borderTop: `1px solid ${palette.line}`, borderBottom: `1px solid ${palette.line}`, fontSize: 64, lineHeight: 1.3, textAlign: 'center', fontWeight: 740, opacity: center}}>{contribution ? '行为并不总对意识完全透明' : '保留问题，限制结论'}</div>
            <div style={{marginTop: 56, textAlign: 'center', fontSize: 28, color: palette.gold, opacity: center}}>承认未知，比套上一把万能钥匙更诚实。</div>
          </div>
        </Stage>
      );
    }
    return (
      <Stage chapter="CONCLUSION" label="拒绝两个过度结论">
        <Pill x={150} y={340} width={430} accent={palette.wine} opacity={1 - center * .45}>弗洛伊德全错</Pill>
        <Pill x={1340} y={340} width={430} accent={palette.wine} opacity={1 - center * .45}>每次嘴瓢都是真心话</Pill>
        <Pill x={690} y={300} width={540} accent={palette.teal} opacity={center} scale={interpolate(center, [0, 1], [.86, 1], {extrapolateRight: 'clamp'})}>{contribution ? '行为并不总对意识完全透明' : '保留问题，限制结论'}</Pill>
        <div style={{position: 'absolute', left: 860, top: 480, width: 200, height: 150, borderRadius: 24, border: `2px dashed ${palette.gold}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.gold, fontSize: 22, fontWeight: 720, opacity: contribution ? center : .35}}>未知区</div>
        <EvidenceRail active={3} support="保留问题，限制结论" />
      </Stage>
    );
  }

  const modules = [['语言', '词项竞争'], ['记忆', '取回阈值'], ['注意', '资源偏移'], ['控制', '行动接管']];
  if (dark) {
    return (
      <Stage chapter="CONCLUSION" label="把一个大问题，拆成四条可以检验的线索">
        <div style={{position: 'absolute', left: 150, top: 215, width: 1620, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32}}>
          {modules.map(([title, note], index) => {
            const reveal = interpolate(progress, [index * .1, index * .1 + .32], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            return <div key={title} style={{minHeight: 285, padding: '42px 46px', borderTop: `5px solid ${index < 2 ? palette.teal : palette.gold}`, background: palette.white, opacity: reveal}}><div style={{display: 'flex', alignItems: 'baseline', gap: 26}}><div style={{fontSize: 49, fontWeight: 760}}>{title}</div><div style={{fontSize: 33, color: palette.muted}}>{note}</div></div><div style={{marginTop: 62, fontSize: 27, color: palette.teal}}>可以分别检验</div></div>;
          })}
        </div>
      </Stage>
    );
  }
  return (
    <Stage chapter="CONCLUSION" label="把大问题拆成可实验机制">
      {modules.map(([title, note], index) => {
        const x = 150 + index * 430;
        const reveal = interpolate(progress, [index * .1, index * .1 + .32], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return <EvidenceCard key={title} x={x} y={300 + (index % 2) * 90} title={title} status={`${note}　·　可检验`} accent={palette.teal} opacity={reveal} />;
      })}
      <div style={{position: 'absolute', left: 670, top: 690, width: 580, textAlign: 'center', color: palette.ink, fontSize: 25, fontWeight: 720}}>同一个问题　→　四条可失败的机制路径</div>
      <EvidenceRail active={3} support="机制可以分别检验" />
    </Stage>
  );
}

function ClosingVisual({scene, beat, progress, activeProgress}: {scene: SchemaScene; beat: Beat; progress: number; activeProgress: number}) {
  const palette = usePalette();
  const dark = useDarkEditorial();
  if (scene.id === 'S024') {
    const pause = beat.beatId === 'B042';
    const questions = ['语言竞争？', '记忆取回？', '注意负荷？', '行动控制？'];
    const positions = [[360, 245], [1170, 245], [360, 560], [1170, 560]] as const;
    return (
      <Stage chapter="NEXT ERROR" label={pause ? '证据不足，先别宣布破案' : '把错误当成调查起点'}>
        <Pill x={760} y={395} width={400} accent={palette.wine}>刚才为什么会错？</Pill>
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}>
          <Path d="M 760 431 L 650 331" progress={progress} />
          <Path d="M 1160 431 L 1170 331" progress={progress} />
          <Path d="M 760 431 L 650 596" progress={progress} />
          <Path d="M 1160 431 L 1170 596" progress={progress} />
        </svg>
        {questions.map((question, index) => <Pill key={question} x={positions[index]![0]} y={positions[index]![1]} width={300} accent={palette.teal} opacity={interpolate(progress, [index * .1, index * .1 + .3], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}>{question}</Pill>)}
        {pause ? <div style={{position: 'absolute', left: 635, top: 735, width: 650, height: 94, borderRadius: 22, background: palette.wine, color: palette.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 820, scale: interpolate(activeProgress, [0, .48], [.72, 1], {extrapolateRight: 'clamp'})}}>{dark ? '证据不足，暂不下结论' : '证据不足　｜　VERDICT HOLD'}</div> : null}
      </Stage>
    );
  }

  const finalBeat = beat.beatId === 'B044';
  const revealProgress = finalBeat ? activeProgress : progress;
  const reveal = interpolate(revealProgress, [0, .78], [0, 1], {extrapolateRight: 'clamp'});
  const slots = ['观察', '机制', '替代原因', '提前预测', '可失败结果', '复现'];
  return (
    <Stage chapter="FINAL" label={finalBeat ? '从错误到动机，还缺整条证据链' : '一次失误可以分流'}>
      {!finalBeat ? <>
        <Pill x={190} y={360} width={320} accent={palette.wine}>一次失误</Pill>
        <Pill x={790} y={250} width={360} accent={palette.teal}>可追踪的线索</Pill>
        <Pill x={790} y={520} width={360} accent={palette.gold}>忙碌大脑的噪声</Pill>
        <Pill x={1400} y={385} width={320} accent={palette.wine}>先看证据</Pill>
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 510 396 C 650 396 700 286 790 286 M 510 396 C 650 396 700 556 790 556 M 1150 286 C 1290 286 1320 421 1400 421 M 1150 556 C 1290 556 1320 421 1400 421" progress={progress} /></svg>
      </> : <>
        <Pill x={90} y={360} width={250} accent={palette.wine}>错误</Pill>
        {slots.map((slot, index) => {
          const x = 400 + index * 230;
          const filled = index === 0;
          return <div key={slot} style={{position: 'absolute', left: x, top: 340 + (index % 2) * 115, width: 190, height: 100, borderRadius: 18, border: `3px ${filled ? 'solid' : 'dashed'} ${filled ? palette.teal : palette.gold}`, background: filled ? palette.tealSoft : palette.white, opacity: interpolate(reveal, [index * .1, index * .1 + .25], [.18, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 19, fontWeight: 720}}>{slot}{filled ? ' ✓' : ' ？'}</div>;
        })}
        <Pill x={1590} y={360} width={250} accent={palette.wine} opacity={.28}>隐藏动机</Pill>
        <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><Path d="M 340 396 C 650 396 1050 396 1590 396" progress={reveal} color={palette.wine} dashed /></svg>
        <div style={{position: 'absolute', left: 520, top: 635, width: 880, textAlign: 'center', fontSize: 28, lineHeight: 1.35, fontWeight: 780, color: palette.ink, opacity: interpolate(revealProgress, [.58, .86], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>缺的不是一个漂亮故事<br /><span style={{color: palette.wine}}>而是一整条可以检验的证据链</span></div>
      </>}
      <EvidenceRail active={3} support={finalBeat ? '证据链尚未完成' : '先看证据'} />
    </Stage>
  );
}

export const V2VisualR2Scene = ({scene, assets}: {scene: SchemaScene; assets?: ResolvedAsset[]}) => {
  const localFrame = useCurrentFrame();
  const frame = scene.startFrame + localFrame;
  const beat = activeBeat(scene.id, frame);
  const rendererVersion = sceneRendererVersion(scene);
  const activeProgress = rendererVersion === DARK_EDITORIAL_V1_PACING_VERSION || rendererVersion === DARK_EDITORIAL_V1_STATE_PERSISTENCE_VERSION
    ? darkEditorialPacedBeatProgress(frame, beat)
    : beatProgress(frame, beat);
  const progress = rendererVersion === DARK_EDITORIAL_V1_STATE_PERSISTENCE_VERSION
    ? persistentBeatProgress(scene.id, beat.beatId, activeProgress)
    : activeProgress;

  const dark = isDarkEditorialScene(scene);
  const content = (() => {
    if (['S001', 'S002', 'S003', 'S004'].includes(scene.id)) {
      return <HookVisual scene={scene} frame={frame} beat={beat} progress={progress} activeProgress={activeProgress} />;
    }
    if (['S005', 'S006', 'S007', 'S008', 'S009', 'S010'].includes(scene.id)) {
      return <HistoryVisual scene={scene} beat={beat} progress={progress} activeProgress={activeProgress} assets={assets} />;
    }
    if (['S011', 'S012', 'S013', 'S014'].includes(scene.id)) {
      return <MechanismVisual scene={scene} frame={frame} beat={beat} progress={progress} activeProgress={activeProgress} />;
    }
    if (['S015', 'S016', 'S017', 'S018', 'S019'].includes(scene.id)) {
      return <AppliedMechanismVisual scene={scene} beat={beat} progress={progress} activeProgress={activeProgress} />;
    }
    if (['S020', 'S021', 'S022', 'S023'].includes(scene.id)) {
      return <EvaluationVisual scene={scene} beat={beat} progress={progress} activeProgress={activeProgress} />;
    }
    if (['S024', 'S025'].includes(scene.id)) {
      return <ClosingVisual scene={scene} beat={beat} progress={progress} activeProgress={activeProgress} />;
    }
    throw new Error(`V2 Visual R2 prototype scene 未实现: ${scene.id}`);
  })();
  return (
    <DarkEditorialContext.Provider value={dark}>
      <PaletteContext.Provider value={dark ? darkPalette : lightPalette}>{content}</PaletteContext.Provider>
    </DarkEditorialContext.Provider>
  );
};

import {AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ResolvedAsset, Scene as SchemaScene} from '@/lib/scene-schema';
import {fontFamily} from '../../design/tokens';

export const MEMORY_LAB_EDITORIAL_VERSION = 'memory-lab-editorial@1';
type Family = 'KINETIC_CLAIM' | 'VERSION_DIFF' | 'PROCESS_MAP' | 'TIMELINE' | 'EVIDENCE_ARCHIVE' | 'CONCEPT_SPACE' | 'COMPARISON' | 'CHAPTER_INTERSTITIAL' | 'FINAL_SYNTHESIS';
type Sequence = {id: string; phase: number; view: 'establish' | 'compare' | 'conclusion' | 'spectrum'};
type MemoryLabProps = {version: typeof MEMORY_LAB_EDITORIAL_VERSION; family: Family; compositionVariant?: 0 | 1 | 2; backgroundMode?: 'dark' | 'light'; narrationText: string; visualThesis: string; visualLabels?: string[]; label: string; archiveDisclosure?: string; evidenceRole?: '原始研究' | '后续证据' | '解释' | '边界'; sequence?: Sequence; debugOverlay?: boolean; showSceneId?: boolean};
const palette = {bg: '#101619', panel: '#172225', panelSoft: '#213035', ink: '#f2eee6', muted: '#aeb6b3', cyan: '#79b9b4', coral: '#b96158', paper: '#e8dfcf', paperInk: '#202724', line: '#41565a'};
const safeTop = 82;
const safeBottom = 224;

function propsOf(scene: SchemaScene): MemoryLabProps | null {
  const raw = scene.templateProps?.memoryLab;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<MemoryLabProps>;
  if (value.version !== MEMORY_LAB_EDITORIAL_VERSION || !value.family || !value.visualThesis || !value.narrationText || !value.label) return null;
  return value as MemoryLabProps;
}
export function isMemoryLabEditorialScene(scene: SchemaScene): boolean { return propsOf(scene) !== null; }
const inAt = (progress: number, start: number, end = start + .18) => interpolate(progress, [start, end], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
const labelsFor = (data: MemoryLabProps) => data.visualLabels?.slice(0, 4) ?? [];

function Meta({data, scene}: {data: MemoryLabProps; scene: SchemaScene}) {
  return <>
    <div style={{position: 'absolute', left: 82, top: 52, color: palette.cyan, fontSize: 17, letterSpacing: 2.2}}>记忆研究 / {String(scene.chapter).padStart(2, '0')}</div>
    {data.evidenceRole ? <div style={{position: 'absolute', right: 82, top: 50, color: palette.muted, fontSize: 16, letterSpacing: 1.4}}>{data.evidenceRole}</div> : null}
  </>;
}
function Thesis({data, size = 82, width = 1040}: {data: MemoryLabProps; size?: number; width?: number}) {
  return <div style={{position: 'absolute', left: 120, top: 226, width, color: palette.ink, fontSize: size, fontWeight: 720, lineHeight: 1.12, letterSpacing: -1}}>{data.visualThesis}</div>;
}
function LabelRail({labels, progress, vertical = false}: {labels: string[]; progress: number; vertical?: boolean}) {
  return <div style={{position: 'absolute', left: vertical ? 1360 : 120, top: vertical ? 260 : 720, display: 'flex', flexDirection: vertical ? 'column' : 'row', gap: 18}}>{labels.map((label, index) => <div key={label} style={{padding: '10px 14px', color: index % 2 ? palette.cyan : palette.muted, border: `1px solid ${index % 2 ? palette.cyan : palette.line}`, fontSize: 24, opacity: inAt(progress, .22 + index * .12), translate: `${vertical ? 18 : 0}px ${vertical ? 0 : 18}px`}}>{label}</div>)}</div>;
}
function KineticClaim({data, progress}: {data: MemoryLabProps; progress: number}) {
  const labels = labelsFor(data);
  const variant = data.compositionVariant ?? 0;
  return <><div style={{position: 'absolute', inset: 0, background: `radial-gradient(circle at 74% 32%, #244349 0, transparent 31%), linear-gradient(120deg, ${palette.bg}, #121c20)`}} />
    {variant === 0 ? <div style={{position: 'absolute', left: 120, top: 184, width: 8, height: 360, background: palette.coral, transform: `scaleY(${inAt(progress, .05)})`, transformOrigin: 'top'}} /> : variant === 1 ? <div style={{position: 'absolute', left: 120, top: 470, width: 820, height: 4, background: palette.coral, transform: `scaleX(${inAt(progress, .05)})`, transformOrigin: 'left'}} /> : <div style={{position: 'absolute', right: 230, top: 215, width: 270, height: 270, border: `2px solid ${palette.cyan}`, opacity: inAt(progress, .08), rotate: '45deg'}} />}
    <Thesis data={data} size={100} width={1220} />
    <LabelRail labels={labels} progress={progress} />
  </>;
}
function VersionDiff({data, progress}: {data: MemoryLabProps; progress: number}) {
  const labels = labelsFor(data);
  const variant = data.compositionVariant ?? 0;
  if (variant === 1) return <><Thesis data={data} size={76} width={900} /><div style={{position: 'absolute', left: 150, top: 470, width: 680, height: 260, borderLeft: `5px solid ${palette.cyan}`, padding: 28, fontSize: 34, color: palette.ink, background: palette.panel}}>原版本<br /><span style={{fontSize: 22, color: palette.muted}}>保留痕迹</span></div><div style={{position: 'absolute', right: 150, top: 470, width: 680, height: 260, borderRight: `5px solid ${palette.coral}`, padding: 28, textAlign: 'right', fontSize: 34, color: palette.ink, background: palette.panelSoft}}>后来版本<br /><span style={{fontSize: 22, color: palette.muted}}>发生偏移</span></div><LabelRail labels={labels} progress={progress} /></>;
  if (variant === 2) return <><div style={{position: 'absolute', left: 220, top: 230, width: 1280, height: 390, padding: 58, background: palette.paper, color: palette.paperInk, fontSize: 38, opacity: inAt(progress, .1)}}>可比较的记录<div style={{position: 'absolute', left: 170, right: 110, top: 168, height: 38, background: palette.coral, opacity: .72}} /><div style={{position: 'absolute', left: 340, right: 250, top: 250, height: 38, background: palette.panel}} /></div><Thesis data={data} size={70} width={880} /><LabelRail labels={labels} progress={progress} /></>;
  return <><div style={{position: 'absolute', left: 220, top: 200, width: 840, height: 400, background: '#d8e4df', color: palette.paperInk, padding: 52, fontSize: 34, lineHeight: 1.5, opacity: inAt(progress, .06), rotate: '-3deg'}}>最初版本<br /><span style={{fontSize: 22, color: '#68716d'}}>保留可比较的痕迹</span></div>
    <div style={{position: 'absolute', left: 710, top: 315, width: 850, height: 400, background: palette.panel, border: `2px solid ${palette.coral}`, padding: 52, color: palette.ink, fontSize: 34, lineHeight: 1.5, opacity: inAt(progress, .22), rotate: '2deg'}}>后来版本<br /><span style={{fontSize: 22, color: palette.muted}}>新增、遗漏或重新组织</span></div>
    <div style={{position: 'absolute', left: 660, top: 470, width: 450, height: 5, background: palette.coral, transform: `rotate(-5deg) scaleX(${inAt(progress, .42)})`, transformOrigin: 'left'}} />
    <div style={{position: 'absolute', left: 118, top: safeTop, color: palette.cyan, fontSize: 22}}>{data.visualThesis}</div><LabelRail labels={labels} progress={progress} />
  </>;
}
function ProcessMap({data, progress}: {data: MemoryLabProps; progress: number}) {
  const labels = labelsFor(data);
  const variant = data.compositionVariant ?? 0;
  if (variant === 1) return <><div style={{position: 'absolute', left: 140, top: 120, color: palette.muted, fontSize: 20, letterSpacing: 3}}>实验结果</div><div style={{position: 'absolute', left: 140, top: 168, width: 1260, color: palette.ink, fontSize: 68, fontWeight: 720, lineHeight: 1.1}}>{data.visualThesis}</div><div style={{position: 'absolute', left: 960, top: 365, height: 410, width: 3, background: palette.cyan}} />{labels.slice(0, 3).map((label, index) => <div key={label} style={{position: 'absolute', left: index === 1 ? 1030 : 510, top: 390 + index * 155, width: 380, color: index === 1 ? palette.coral : palette.ink, fontSize: 51, fontWeight: 720, opacity: inAt(progress, .18 + index * .18)}}><div style={{color: palette.muted, fontSize: 18, letterSpacing: 2, marginBottom: 12}}>0{index + 1} / {index === 0 ? '条件' : index === 1 ? '观察结果' : '解释边界'}</div>{label}</div>)}</>;
  if (variant === 2) return <><div style={{position: 'absolute', left: 140, top: 118, color: palette.muted, fontSize: 20, letterSpacing: 3}}>实验结果</div><div style={{position: 'absolute', left: 140, top: 166, width: 1360, color: palette.ink, fontSize: 68, fontWeight: 720, lineHeight: 1.1}}>{data.visualThesis}</div><div style={{position: 'absolute', left: 230, top: 480, width: 360, height: 190, border: `2px solid ${palette.cyan}`, color: palette.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 48, opacity: inAt(progress, .14)}}>{labels[0] ?? '条件'}</div><svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><path d="M 590 575 C 780 575, 800 425, 970 425 M 590 575 C 780 575, 800 735, 970 735" stroke={palette.line} strokeWidth="4" fill="none" /></svg>{labels.slice(1, 3).map((label, index) => <div key={label} style={{position: 'absolute', left: 1010, top: index ? 650 : 340, width: 520, minHeight: 175, padding: '34px 38px', color: palette.ink, background: index ? palette.panelSoft : palette.panel, borderLeft: `6px solid ${index ? palette.coral : palette.cyan}`, fontSize: 46, fontWeight: 700, opacity: inAt(progress, .34 + index * .18)}}><div style={{color: palette.muted, fontSize: 18, letterSpacing: 2, marginBottom: 12}}>{index ? '解释边界' : '观察结果'}</div>{label}</div>)}</>;
  return <><Thesis data={data} size={72} /><div style={{position: 'absolute', left: 176, top: 480, width: 1500, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>{labels.slice(0, 3).map((label, index) => <div key={label} style={{display: 'flex', alignItems: 'center', gap: 28, opacity: inAt(progress, .18 + index * .22)}}><div style={{width: 250, minHeight: 140, background: index === 1 ? palette.coral : palette.panel, border: `1px solid ${index === 1 ? palette.coral : palette.cyan}`, color: palette.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 680, textAlign: 'center'}}>{label}</div>{index < 2 ? <div style={{width: 210, height: 2, background: palette.cyan, transform: `scaleX(${inAt(progress, .34 + index * .22)})`, transformOrigin: 'left'}} /> : null}</div>)}</div></>;
}
function Timeline({data, progress}: {data: MemoryLabProps; progress: number}) {
  const labels = labelsFor(data);
  const phase = data.sequence?.phase ?? 0;
  return <><div style={{position: 'absolute', left: 170, top: 290, height: 420, width: 2, background: palette.cyan}} />
    {labels.map((label, index) => <div key={label} style={{position: 'absolute', left: 220 + index * 420, top: 350 + (index % 2) * 140, color: index === phase ? palette.ink : palette.muted, opacity: inAt(progress, .12 + index * .16)}}><div style={{width: 20, height: 20, borderRadius: 20, background: index === phase ? palette.coral : palette.cyan, marginBottom: 20}} /><div style={{fontSize: 32, fontWeight: 700}}>{label}</div></div>)}
    <div style={{position: 'absolute', left: 210, right: 210, top: 520, height: 2, background: palette.line}} /><Thesis data={data} size={72} width={850} />
  </>;
}
function EvidenceArchive({data, progress, asset}: {data: MemoryLabProps; progress: number; asset?: ResolvedAsset}) {
  if (asset?.mediaType !== 'image') throw new Error('EVIDENCE_ARCHIVE requires an exact bound image asset');
  const zoom = interpolate(progress, [0, 1], [1.03, 1.14]);
  return <><div style={{position: 'absolute', inset: 0, background: palette.bg}} />
    <Img src={staticFile(asset.publicPath)} style={{position: 'absolute', left: 720, top: 74, width: 1120, height: 810, objectFit: 'cover', scale: zoom, opacity: inAt(progress, .06), filter: 'contrast(.92) saturate(.75)'}} />
    <div style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: 820, background: 'linear-gradient(90deg, #101619 72%, transparent)'}} /><Thesis data={data} size={72} width={700} />
    <div style={{position: 'absolute', left: 120, top: 572, maxWidth: 650, padding: '12px 16px', color: palette.ink, background: '#172225', borderLeft: `4px solid ${palette.cyan}`, fontSize: 25, fontWeight: 650}}>{data.archiveDisclosure || '原始资料'}</div>
    <div style={{position: 'absolute', left: 120, top: 636, color: palette.muted, fontSize: 18}}>{asset.attribution || labelsFor(data).join(' · ')}</div>
    <div style={{position: 'absolute', left: 120, top: 652, width: 330, height: 4, background: palette.coral, transform: `scaleX(${inAt(progress, .5)})`, transformOrigin: 'left'}} />
  </>;
}
function ConceptSpace({data, progress}: {data: MemoryLabProps; progress: number}) {
  const labels = labelsFor(data); const locations = [[330, 540], [940, 360], [1330, 610], [780, 720]];
  const variant = data.compositionVariant ?? 0;
  if (variant === 1) return <><Thesis data={data} size={74} width={900} /><div style={{position: 'absolute', left: 210, top: 490, display: 'grid', gridTemplateColumns: 'repeat(2, 360px)', gap: 28}}>{labels.map((label, index) => <div key={label} style={{height: 125, borderTop: `3px solid ${index % 2 ? palette.coral : palette.cyan}`, color: palette.ink, background: palette.panel, display: 'flex', alignItems: 'center', paddingLeft: 26, fontSize: 31, opacity: inAt(progress, .14 + index * .14)}}>{label}</div>)}</div></>;
  if (variant === 2) return <><Thesis data={data} size={74} width={900} /><div style={{position: 'absolute', left: 780, top: 420, width: 360, height: 360, border: `2px solid ${palette.cyan}`, borderRadius: '50%', opacity: inAt(progress, .1)}} /><div style={{position: 'absolute', left: 845, top: 485, width: 230, height: 230, border: `2px solid ${palette.coral}`, borderRadius: '50%', opacity: inAt(progress, .25)}} />{labels.map((label, index) => <div key={label} style={{position: 'absolute', left: 260 + index * 420, top: index % 2 ? 760 : 560, color: palette.ink, fontSize: 30, opacity: inAt(progress, .3 + index * .12)}}>{label}</div>)}</>;
  return <><Thesis data={data} size={74} width={900} />{labels.map((label, index) => <div key={label} style={{position: 'absolute', left: locations[index]![0], top: locations[index]![1], width: 220, height: 110, borderRadius: 110, border: `2px solid ${index === 1 ? palette.coral : palette.cyan}`, color: palette.ink, background: index === 1 ? '#462d2e' : palette.panel, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 29, opacity: inAt(progress, .16 + index * .14), scale: .9 + inAt(progress, .16 + index * .14) * .1}}>{label}</div>)}<svg width="1920" height="1080" style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}><path d="M 480 595 C 670 430, 910 420, 1040 435 M 1040 435 C 1190 520, 1300 630, 1440 665" stroke={palette.line} strokeWidth="3" fill="none" /></svg></>;
}
function Comparison({data, progress}: {data: MemoryLabProps; progress: number}) {
  const labels = labelsFor(data); const variant = data.compositionVariant ?? 0;
  if (variant === 1) return <><Thesis data={data} size={76} width={880} /><div style={{position: 'absolute', left: 160, top: 490, width: 650, height: 220, borderTop: `4px solid ${palette.cyan}`, color: palette.ink, fontSize: 36, paddingTop: 24}}>{labels[0] ?? '一侧'}</div><div style={{position: 'absolute', right: 160, top: 490, width: 650, height: 220, borderTop: `4px solid ${palette.coral}`, color: palette.ink, fontSize: 36, paddingTop: 24, textAlign: 'right'}}>{labels[1] ?? '另一侧'}</div></>;
  if (variant === 2) return <><div style={{position: 'absolute', left: 140, top: 118, color: palette.muted, fontSize: 20, letterSpacing: 3}}>论证编辑</div><div style={{position: 'absolute', left: 140, top: 166, width: 1370, color: palette.ink, fontSize: 70, fontWeight: 720, lineHeight: 1.1}}>{data.visualThesis}</div><div style={{position: 'absolute', left: 140, top: 410, width: 690, minHeight: 200, padding: '28px 34px', color: palette.ink, background: palette.panel, borderTop: `5px solid ${palette.cyan}`, fontSize: 50, fontWeight: 720, opacity: inAt(progress, .16)}}><div style={{color: palette.muted, fontSize: 18, letterSpacing: 2, marginBottom: 16}}>可观察证据</div>{labels[0] ?? '一侧'}</div><div style={{position: 'absolute', right: 140, top: 500, width: 690, minHeight: 200, padding: '28px 34px', color: palette.ink, background: palette.panelSoft, borderTop: `5px solid ${palette.coral}`, fontSize: 50, fontWeight: 720, opacity: inAt(progress, .34)}}><div style={{color: palette.muted, fontSize: 18, letterSpacing: 2, marginBottom: 16}}>不能直接推出</div>{labels[1] ?? '另一侧'}</div><div style={{position: 'absolute', left: 140, right: 140, bottom: 130, paddingTop: 24, borderTop: `2px solid ${palette.line}`, color: palette.cyan, fontSize: 31}}>结论需要被条件限定</div></>;
  return <><div style={{position: 'absolute', inset: 0, background: `linear-gradient(90deg, ${palette.panel} 0 50%, ${palette.bg} 50% 100%)`}} /><div style={{position: 'absolute', left: 220, right: 220, top: 532, height: 2, background: palette.line}} />
    <div style={{position: 'absolute', left: 170, top: 330, width: 580, color: palette.cyan, fontSize: 34, fontWeight: 720, opacity: inAt(progress, .16)}}>{labels[0] ?? '一侧'}</div><div style={{position: 'absolute', right: 170, top: 570, width: 580, color: palette.ink, fontSize: 34, textAlign: 'right', fontWeight: 720, opacity: inAt(progress, .36)}}>{labels[1] ?? '另一侧'}</div><Thesis data={data} size={76} width={880} />
  </>;
}
function ChapterInterstitial({data, scene, progress}: {data: MemoryLabProps; scene: SchemaScene; progress: number}) { return <><div style={{position: 'absolute', left: 150, top: 220, color: palette.cyan, fontSize: 44, opacity: inAt(progress, .08)}}>第 {String(scene.chapter).padStart(2, '0')} 章</div><div style={{position: 'absolute', left: 150, top: 325, color: palette.ink, width: 1020, fontSize: 102, fontWeight: 720, lineHeight: 1.1}}>{data.visualThesis}</div><div style={{position: 'absolute', left: 150, top: 650, width: 170, height: 170, border: `3px solid ${palette.coral}`, rotate: '45deg', opacity: inAt(progress, .34)}} /></>; }
function FinalSynthesis({data, progress}: {data: MemoryLabProps; progress: number}) { const labels = labelsFor(data); return <><Thesis data={data} size={82} width={1180} /> <div style={{position: 'absolute', left: 190, top: 520, right: 190, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 28}}>{labels.map((label, index) => <div key={label} style={{height: 168, border: `1px solid ${index === 3 ? palette.coral : palette.cyan}`, background: index % 2 ? palette.panelSoft : palette.panel, color: palette.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 31, opacity: inAt(progress, .12 + index * .14)}}>{label}</div>)}</div><div style={{position: 'absolute', left: 190, right: 190, top: 770, height: 2, background: palette.coral, transform: `scaleX(${inAt(progress, .72)})`, transformOrigin: 'left'}} /></>; }

export const MemoryLabEditorialScene = ({scene, assets}: {scene: SchemaScene; assets?: ResolvedAsset[]}) => {
  const data = propsOf(scene); if (!data) throw new Error(`${scene.id} 缺少 memoryLab renderer props`);
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  const persistent = (data.sequence?.phase ?? 0) > 0;
  const progress = persistent ? 1 : spring({frame, fps, config: {damping: 18, stiffness: 82, mass: .85}, durationInFrames: Math.min(scene.durationInFrames, 34)});
  const outroOpacity = scene.transitionOut === 'fade-out'
    ? interpolate(frame, [Math.max(0, scene.durationInFrames - fps * 5), scene.durationInFrames - 1], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 1;
  const asset = assets?.[0];
  const content = data.family === 'KINETIC_CLAIM' ? <KineticClaim data={data} progress={progress} /> : data.family === 'VERSION_DIFF' ? <VersionDiff data={data} progress={progress} /> : data.family === 'PROCESS_MAP' ? <ProcessMap data={data} progress={progress} /> : data.family === 'TIMELINE' ? <Timeline data={data} progress={progress} /> : data.family === 'EVIDENCE_ARCHIVE' ? <EvidenceArchive data={data} progress={progress} asset={asset} /> : data.family === 'CONCEPT_SPACE' ? <ConceptSpace data={data} progress={progress} /> : data.family === 'COMPARISON' ? <Comparison data={data} progress={progress} /> : data.family === 'CHAPTER_INTERSTITIAL' ? <ChapterInterstitial data={data} scene={scene} progress={progress} /> : <FinalSynthesis data={data} progress={progress} />;
  const showSceneId = data.debugOverlay === true || data.showSceneId === true;
  const contextualArchive = asset?.mediaType === 'image' && data.family !== 'EVIDENCE_ARCHIVE' ? <><Img src={staticFile(asset.publicPath)} style={{position: 'absolute', right: -40, top: 110, width: 980, height: 730, objectFit: 'cover', opacity: .42, filter: 'grayscale(1) contrast(.9)'}} /><div style={{position: 'absolute', right: 70, top: 792, maxWidth: 780, padding: '12px 16px', color: palette.ink, background: '#172225', borderLeft: `4px solid ${palette.cyan}`, fontSize: 25, fontWeight: 650}}>{data.archiveDisclosure || '背景资料 · 非研究现场'}</div><div style={{position: 'absolute', right: 70, top: 852, color: palette.muted, fontSize: 17}}>{asset.attribution || asset.description}</div></> : null;
  return <AbsoluteFill style={{backgroundColor: data.backgroundMode === 'light' ? palette.paper : palette.bg, color: palette.ink, fontFamily, overflow: 'hidden', opacity: outroOpacity}}><Meta data={data} scene={scene} />{content}{contextualArchive}{showSceneId ? <div data-memory-lab-scene-id={scene.id} style={{position: 'absolute', right: 70, bottom: safeBottom, color: palette.coral, fontSize: 18}}>{scene.id}</div> : null}</AbsoluteFill>;
};

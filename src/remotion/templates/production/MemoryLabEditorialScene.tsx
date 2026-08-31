import {AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import type {ResolvedAsset, Scene as SchemaScene} from '@/lib/scene-schema';
import {fontFamily} from '../../design/tokens';

export const MEMORY_LAB_EDITORIAL_VERSION = 'memory-lab-editorial@1';

type Family =
  | 'fragment-assembly'
  | 'source-document'
  | 'provenance-chain'
  | 'experimental-stage'
  | 'semantic-field'
  | 'trace-comparison'
  | 'source-attribution'
  | 'longitudinal-record'
  | 'procedure-safeguard'
  | 'classification-funnel';

type MemoryLabProps = {
  version: typeof MEMORY_LAB_EDITORIAL_VERSION;
  family: Family;
  label: string;
  headline: string;
  supporting?: string;
  items?: string[];
  emphasis?: string;
  evidenceRole?: '原始研究' | '后续证据' | '解释' | '边界';
  variant?: 'confidence-feedback' | 'contamination' | 'external-verification';
};

const palette = {
  paper: '#ede8dc',
  paperDeep: '#ded5c3',
  ink: '#222724',
  muted: '#6b6e67',
  blue: '#315f66',
  blueSoft: '#cad9d5',
  red: '#94483f',
  amber: '#b18443',
  white: '#f8f4ea',
};

function propsOf(scene: SchemaScene): MemoryLabProps | null {
  const raw = scene.templateProps?.memoryLab;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<MemoryLabProps>;
  if (value.version !== MEMORY_LAB_EDITORIAL_VERSION || !value.family || !value.label || !value.headline) return null;
  return value as MemoryLabProps;
}

export function isMemoryLabEditorialScene(scene: SchemaScene): boolean {
  return propsOf(scene) !== null;
}

const revealAt = (progress: number, index: number, count: number) => interpolate(
  progress,
  [index / Math.max(1, count + 1), Math.min(1, (index + 1.4) / Math.max(1, count + 1))],
  [0, 1],
  {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
);

function Header({scene, data}: {scene: SchemaScene; data: MemoryLabProps}) {
  return <>
    <div style={{position: 'absolute', left: 78, top: 55, display: 'flex', alignItems: 'center', gap: 18}}>
      <div style={{fontSize: 17, fontWeight: 760, letterSpacing: 2.2, color: palette.red}}>第 {String(scene.chapter).padStart(2, '0')} 章</div>
      <div style={{width: 44, height: 2, background: palette.red}} />
      <div style={{fontSize: 22, color: palette.muted}}>{data.label}</div>
    </div>
    {data.evidenceRole ? <div style={{position: 'absolute', right: 76, top: 52, padding: '8px 14px', border: `1px solid ${palette.red}88`, color: palette.red, fontSize: 17, letterSpacing: 1.5}}>{data.evidenceRole}</div> : null}
  </>;
}

function SourceAsset({asset}: {asset?: ResolvedAsset}) {
  if (!asset || asset.mediaType !== 'image') return null;
  return <div style={{position: 'absolute', right: 88, top: 154, width: 680, height: 700, overflow: 'hidden', background: palette.paperDeep, boxShadow: '0 22px 60px rgba(53,44,32,.18)'}}>
    <Img src={staticFile(asset.publicPath)} style={{width: '100%', height: '100%', objectFit: 'contain', background: palette.white}} />
    <div style={{position: 'absolute', left: 0, right: 0, bottom: 0, padding: '18px 22px', background: 'rgba(28,31,29,.82)', color: palette.white, fontSize: 15}}>{asset.attribution || asset.description}</div>
  </div>;
}

function FragmentAssembly({data, progress}: {data: MemoryLabProps; progress: number}) {
  const items = (data.items?.length ? data.items : ['最初线索', '后来信息', '推断', '情绪', '反复讲述']).slice(0, 5);
  return <>
    <div style={{position: 'absolute', left: 120, top: 220, width: 560, fontSize: 64, fontWeight: 720, lineHeight: 1.18}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 850, top: 190, width: 760, height: 610}}>
      {items.map((item, index) => {
        const alpha = revealAt(progress, index, items.length);
        const x = (index % 2) * 300 + (index === 4 ? 150 : 0);
        const y = Math.floor(index / 2) * 170;
        return <div key={item} style={{position: 'absolute', left: x, top: y, width: 260, height: 122, border: `2px solid ${index === 0 ? palette.red : palette.blue}`, background: index === 0 ? '#ead3ca' : palette.blueSoft, opacity: alpha, transform: `translateY(${(1 - alpha) * 28}px)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 27, fontWeight: 650}}>{item}</div>;
      })}
      <div style={{position: 'absolute', left: 190, bottom: 0, width: 340, padding: '25px 30px', background: palette.ink, color: palette.white, fontSize: 31, fontWeight: 700, textAlign: 'center', opacity: revealAt(progress, items.length, items.length)}}>{data.emphasis || '当前可报告版本'}</div>
    </div>
  </>;
}

function SourceDocument({data, progress, asset}: {data: MemoryLabProps; progress: number; asset?: ResolvedAsset}) {
  return <>
    <div style={{position: 'absolute', left: 105, top: 190, width: asset ? 650 : 1120, fontSize: 58, fontWeight: 720, lineHeight: 1.18}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 108, top: 410, width: asset ? 600 : 980, paddingLeft: 25, borderLeft: `6px solid ${palette.red}`, fontSize: 28, lineHeight: 1.55, color: palette.muted, opacity: progress}}>{data.supporting}</div>
    <SourceAsset asset={asset} />
  </>;
}

function HorizontalProcess({data, progress, tone = 'blue'}: {data: MemoryLabProps; progress: number; tone?: 'blue' | 'red'}) {
  const items = (data.items?.length ? data.items : ['输入', '判断', '报告']).slice(0, 6);
  const accent = tone === 'red' ? palette.red : palette.blue;
  return <>
    <div style={{position: 'absolute', left: 115, top: 175, width: 1360, fontSize: 57, fontWeight: 710, lineHeight: 1.18}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 110, right: 110, top: 485, display: 'flex', gap: 28, alignItems: 'center'}}>
      {items.map((item, index) => {
        const alpha = revealAt(progress, index, items.length);
        return <div key={item} style={{display: 'contents'}}>
          <div style={{width: 240, minHeight: 120, padding: '24px 20px', border: `2px solid ${accent}`, background: index === items.length - 1 ? accent : palette.white, color: index === items.length - 1 ? palette.white : palette.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 32, lineHeight: 1.28, fontWeight: 650, opacity: alpha, transform: `translateX(${(1 - alpha) * -20}px)`}}>{item}</div>
          {index < items.length - 1 ? <div style={{height: 2, flex: 1, minWidth: 28, background: accent, transform: `scaleX(${alpha})`, transformOrigin: 'left'}} /> : null}
        </div>;
      })}
    </div>
    {data.supporting ? <div style={{position: 'absolute', left: 115, bottom: 125, width: 1320, color: palette.muted, fontSize: 27, lineHeight: 1.45}}>{data.supporting}</div> : null}
  </>;
}

function SemanticField({data, progress}: {data: MemoryLabProps; progress: number}) {
  const items = (data.items?.length ? data.items : ['床', '休息', '清醒', '疲倦', '梦', '被子', '打盹']).slice(0, 8);
  const center = data.emphasis || '睡眠';
  return <>
    <div style={{position: 'absolute', left: 110, top: 165, width: 1180, fontSize: 56, fontWeight: 710}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 180, right: 180, top: 390, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
      {items.map((item, index) => <div key={item} style={{fontSize: 34, color: palette.ink, padding: '15px 18px', borderBottom: `3px solid ${palette.blue}`, opacity: revealAt(progress, index, items.length)}}>{item}</div>)}
    </div>
    <div style={{position: 'absolute', left: 720, top: 585, width: 480, height: 145, border: `3px dashed ${palette.red}`, background: '#ead3ca66', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 46, fontWeight: 760, color: palette.red, opacity: interpolate(progress, [.55, .8], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>未出现：{center}</div>
  </>;
}

function TwoTrack({data, progress}: {data: MemoryLabProps; progress: number}) {
  const items = data.items?.length ? data.items : ['精确细节', '共同意义'];
  return <>
    <div style={{position: 'absolute', left: 110, top: 170, width: 1340, fontSize: 58, fontWeight: 720}}>{data.headline}</div>
    {items.slice(0, 3).map((item, index) => <div key={item} style={{position: 'absolute', left: 140, top: 410 + index * 150, width: 1500, height: 92, borderTop: `2px solid ${index === 0 ? palette.blue : palette.red}`, opacity: revealAt(progress, index, items.length)}}>
      <div style={{position: 'absolute', top: -25, left: 0, background: palette.paper, paddingRight: 22, fontSize: 27, fontWeight: 680, color: index === 0 ? palette.blue : palette.red}}>{item}</div>
      <div style={{position: 'absolute', left: 300, right: 0, top: 20, height: 22, background: index === 0 ? palette.blueSoft : '#ead3ca', transform: `scaleX(${progress})`, transformOrigin: 'left'}} />
    </div>)}
    {data.emphasis ? <div style={{position: 'absolute', right: 150, bottom: 110, fontSize: 31, fontWeight: 740, color: palette.red}}>{data.emphasis}</div> : null}
  </>;
}

function ConfidenceTimeline({data, progress}: {data: MemoryLabProps; progress: number}) {
  const items = data.items?.length ? data.items : ['首次选择', '即时信心 T0', '确认反馈', '后来信心'];
  return <>
    <div style={{position: 'absolute', left: 110, top: 165, width: 1380, fontSize: 57, fontWeight: 720, lineHeight: 1.18}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 120, right: 120, top: 465, display: 'flex', alignItems: 'center', gap: 22}}>
      {items.slice(0, 4).map((item, index) => {
        const alpha = revealAt(progress, index, 4);
        const feedback = index === 2;
        const pinned = index === 1;
        return <div key={item} style={{display: 'contents'}}>
          <div style={{position: 'relative', width: 330, height: 145, padding: '25px 24px', boxSizing: 'border-box', border: `3px ${pinned ? 'double' : 'solid'} ${feedback ? palette.red : palette.blue}`, background: feedback ? '#ead3ca' : pinned ? palette.blueSoft : palette.white, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 34, lineHeight: 1.25, fontWeight: 690, opacity: alpha}}>
            {pinned ? <div style={{position: 'absolute', left: 12, top: -18, background: palette.blue, color: palette.white, padding: '5px 10px', fontSize: 17}}>固定基线</div> : null}
            {item}
          </div>
          {index < 3 ? <div style={{height: 3, flex: 1, background: feedback ? palette.red : palette.blue, transform: `scaleX(${alpha})`, transformOrigin: 'left'}} /> : null}
        </div>;
      })}
    </div>
    <div style={{position: 'absolute', left: 440, bottom: 145, width: 1040, padding: '18px 24px', borderLeft: `6px solid ${palette.red}`, fontSize: 30, color: palette.muted, opacity: revealAt(progress, 3, 4)}}>{data.supporting || '反馈之后的信心另记；T0 原始陈述不被覆盖'}</div>
  </>;
}

function LongitudinalRecord({data, progress}: {data: MemoryLabProps; progress: number}) {
  const points = data.items?.length ? data.items : ['T0 初次记录', '数周后', '数年后', '十年后'];
  return <>
    <div style={{position: 'absolute', left: 110, top: 165, width: 1380, fontSize: 57, fontWeight: 720, lineHeight: 1.18}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 120, right: 120, top: 395, display: 'flex', gap: 22, alignItems: 'center'}}>
      {points.slice(0, 4).map((point, index) => <div key={point} style={{display: 'contents'}}>
        <div style={{position: 'relative', width: 330, height: 115, border: `3px ${index === 0 ? 'double' : 'solid'} ${index === 0 ? palette.red : palette.blue}`, background: index === 0 ? '#ead3ca' : palette.white, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 680, opacity: revealAt(progress, index, 4)}}>{index === 0 ? <span style={{position: 'absolute', top: -20, left: 14, padding: '5px 9px', color: palette.white, background: palette.red, fontSize: 16}}>保留原件</span> : null}{point}</div>
        {index < 3 ? <div style={{height: 2, flex: 1, background: palette.blue}} /> : null}
      </div>)}
    </div>
    <div style={{position: 'absolute', left: 160, right: 160, top: 650}}>
      <div style={{fontSize: 28, color: palette.blue, marginBottom: 22}}>报告一致性 <span style={{display: 'inline-block', marginLeft: 30, width: 700, height: 22, background: `linear-gradient(90deg, ${palette.blue} 0%, ${palette.blueSoft} 78%)`, transform: `scaleX(${progress})`, transformOrigin: 'left'}} /></div>
      <div style={{fontSize: 28, color: palette.red}}>主观确信 <span style={{display: 'inline-block', marginLeft: 58, width: 700, height: 22, background: palette.red, transform: `scaleX(${progress})`, transformOrigin: 'left'}} /></div>
    </div>
    <div style={{position: 'absolute', right: 155, bottom: 118, fontSize: 28, fontWeight: 710, color: palette.red}}>比较的是后来报告与 T0，不是客观录像</div>
  </>;
}

function ExternalVerification({data, progress}: {data: MemoryLabProps; progress: number}) {
  const items = data.items?.length ? data.items : ['照片', '文字', '时间戳', '独立证人'];
  return <>
    <div style={{position: 'absolute', left: 110, top: 165, width: 1400, fontSize: 57, fontWeight: 720, lineHeight: 1.18}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 155, top: 480, width: 330, height: 135, background: palette.ink, color: palette.white, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 720}}>当前记忆版本</div>
    <div style={{position: 'absolute', left: 625, top: 390, width: 650, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24}}>{items.slice(0, 4).map((item, index) => <div key={item} style={{height: 105, border: `2px solid ${palette.blue}`, background: palette.white, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, fontWeight: 660, opacity: revealAt(progress, index, 4)}}>{item}</div>)}</div>
    <div style={{position: 'absolute', right: 120, top: 480, width: 330, height: 135, border: `4px solid ${palette.red}`, background: '#ead3ca', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 34, fontWeight: 740, opacity: revealAt(progress, 4, 4)}}>校验后的结论<br />保留分歧</div>
    <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><path d="M 485 548 L 625 548 M 1275 548 L 1470 548" stroke={palette.red} strokeWidth="4" fill="none" strokeDasharray="10 8" /></svg>
  </>;
}

function ClassificationFunnel({data, progress}: {data: MemoryLabProps; progress: number}) {
  const items = (data.items?.length ? data.items : ['可能性', '相信发生过', '意象', '片段回忆', '完整自传体记忆']).slice(0, 6);
  return <>
    <div style={{position: 'absolute', left: 110, top: 165, width: 1350, fontSize: 57, fontWeight: 720}}>{data.headline}</div>
    <div style={{position: 'absolute', left: 185, right: 185, top: 385, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24}}>
      {items.map((item, index) => {
        return <div key={item} style={{height: 125, background: index === items.length - 1 ? '#ead3ca' : index % 2 ? palette.blueSoft : palette.white, border: `2px solid ${index === items.length - 1 ? palette.red : palette.blue}88`, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 32, fontWeight: 650, opacity: revealAt(progress, index, items.length)}}>{item}</div>;
      })}
    </div>
    <div style={{position: 'absolute', left: 560, bottom: 125, width: 800, padding: '18px 24px', border: `2px dashed ${palette.red}`, color: palette.red, textAlign: 'center', fontSize: 30, fontWeight: 720}}>这些是不同分类，不是一条自动升级路径</div>
  </>;
}

export const MemoryLabEditorialScene = ({scene, assets}: {scene: SchemaScene; assets?: ResolvedAsset[]}) => {
  const data = propsOf(scene);
  if (!data) throw new Error(`${scene.id} 缺少 memoryLab renderer props`);
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = spring({frame, fps, config: {damping: 18, stiffness: 82, mass: .85}, durationInFrames: Math.min(scene.durationInFrames, 34)});
  const content = (() => {
    if (data.family === 'fragment-assembly') return <FragmentAssembly data={data} progress={progress} />;
    if (data.family === 'source-document') return <SourceDocument data={data} progress={progress} asset={assets?.[0]} />;
    if (data.family === 'semantic-field') return <SemanticField data={data} progress={progress} />;
    if (data.family === 'longitudinal-record') return <LongitudinalRecord data={data} progress={progress} />;
    if (data.family === 'trace-comparison') return <TwoTrack data={data} progress={progress} />;
    if (data.family === 'classification-funnel') return <ClassificationFunnel data={data} progress={progress} />;
    if (data.variant === 'confidence-feedback' || data.variant === 'contamination') return <ConfidenceTimeline data={data} progress={progress} />;
    if (data.variant === 'external-verification') return <ExternalVerification data={data} progress={progress} />;
    return <HorizontalProcess data={data} progress={progress} tone={data.family === 'procedure-safeguard' ? 'red' : 'blue'} />;
  })();
  return <AbsoluteFill style={{backgroundColor: palette.paper, color: palette.ink, fontFamily, overflow: 'hidden'}}>
    <div style={{position: 'absolute', inset: 0, opacity: .2, backgroundImage: 'linear-gradient(rgba(49,95,102,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(49,95,102,.12) 1px, transparent 1px)', backgroundSize: '72px 72px'}} />
    <Header scene={scene} data={data} />
    {content}
    <div style={{position: 'absolute', left: 78, right: 78, bottom: 48, display: 'flex', justifyContent: 'space-between', color: palette.muted, fontSize: 15, letterSpacing: 1.2}}><span>记忆实验档案</span><span>{scene.id}</span></div>
  </AbsoluteFill>;
};

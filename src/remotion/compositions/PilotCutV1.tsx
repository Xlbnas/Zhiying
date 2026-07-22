import type {CSSProperties, ReactNode} from 'react';
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
import {Typography} from '../design/typography';
import {borderRadius, colors, fontFamily} from '../design/tokens';
import {pilotScenes, type PilotScene} from '../data/pilotScenes';
import subtitleData from '../data/pilotSubtitles.json';
import {MG_ConceptSeparation} from '../templates/MG_ConceptSeparation';
import {MG_IntentPath} from '../templates/MG_IntentPath';
import {MG_MessageFocus} from '../templates/MG_MessageFocus';
import {MG_ScheduleNodes} from '../templates/MG_ScheduleNodes';
import {MG_TimePass} from '../templates/MG_TimePass';

type SubtitleCue = {
  id: number;
  segmentId: string;
  text: string;
  start: number;
  end: number;
  position: 'bottom' | 'mid';
};

const subtitleCues = subtitleData as SubtitleCue[];
const CROSSFADE_FRAMES = 10;

const EditorialTexture = ({warm = false}: {warm?: boolean}) => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      opacity: 0.22,
      backgroundImage: warm
        ? 'radial-gradient(circle at 20% 30%, rgba(155,145,131,.18), transparent 32%), repeating-linear-gradient(0deg, transparent 0 5px, rgba(255,255,255,.012) 6px)'
        : 'radial-gradient(circle at 68% 30%, rgba(179,58,66,.09), transparent 28%), repeating-linear-gradient(0deg, transparent 0 5px, rgba(255,255,255,.009) 6px)',
    }}
  />
);

const SafeCaption = ({children, style}: {children: ReactNode; style?: CSSProperties}) => (
  <div
    style={{
      position: 'absolute',
      left: 104,
      top: 82,
      fontFamily,
      fontSize: 21,
      letterSpacing: 2.8,
      color: colors.secondary,
      ...style,
    }}
  >
    {children}
  </div>
);

const PhoneShell = ({mode}: {mode: 'arrival' | 'hesitation' | 'return' | 'processing'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const light = interpolate(frame, [0, fps * 0.45], [0.16, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const targetOpacity = mode === 'arrival'
    ? interpolate(frame, [fps * 0.45, fps * 0.9], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 1;
  const screenOpacity = mode === 'hesitation'
    ? interpolate(frame, [fps * 4.8, fps * 6.5], [1, 0.08], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : 1;
  const processed = mode === 'processing'
    ? Math.min(3, Math.floor(Math.max(0, frame - 25) / 55) + 1)
    : 0;
  const rows = ['项目进度已收到', '今晚吃什么？', '周五会议改到三点', '照片发你了'];

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(circle at 50% 58%, #22242b 0%, #0d0e12 38%, #070709 78%)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 655,
          top: 98,
          width: 610,
          height: 870,
          borderRadius: 66,
          border: '2px solid #3a3c44',
          background: '#111318',
          boxShadow: `0 0 ${90 * light}px rgba(221,231,255,${0.13 * light}), 0 30px 90px rgba(0,0,0,.72)`,
          transform: `perspective(1300px) rotateX(1deg) rotateY(-3deg) scale(${0.985 + 0.015 * light})`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 28,
            right: 28,
            top: 28,
            bottom: 28,
            borderRadius: 44,
            overflow: 'hidden',
            opacity: screenOpacity,
            background: 'linear-gradient(180deg,#171a20,#101116)',
          }}
        >
          <div style={{height: 84, borderBottom: '1px solid #34363d', display: 'flex', alignItems: 'center', padding: '0 34px'}}>
            <div style={{width: 34, height: 34, border: '2px solid #8a8a8f', borderRadius: '50%'}} />
            <div style={{fontFamily, fontSize: 25, marginLeft: 18, color: '#d8d8dc'}}>对话</div>
            <div style={{marginLeft: 'auto', display: 'flex', gap: 7}}>
              {[0, 1, 2].map((dot) => <div key={dot} style={{width: 5, height: 5, borderRadius: 9, background: '#777982'}} />)}
            </div>
          </div>

          {mode === 'processing' ? (
            <div style={{padding: '26px 26px 0'}}>
              {rows.map((row, index) => (
                <div
                  key={row}
                  style={{
                    height: 103,
                    borderBottom: '1px solid #2e3037',
                    display: 'flex',
                    alignItems: 'center',
                    opacity: index < processed ? 0.32 : 0.84,
                  }}
                >
                  <div style={{width: 46, height: 46, borderRadius: '50%', border: '1px solid #71737b'}} />
                  <div style={{fontFamily, fontSize: 24, marginLeft: 18, color: '#d7d7da'}}>{row}</div>
                  {index < processed ? <div style={{marginLeft: 'auto', color: '#8f919a', fontFamily, fontSize: 24}}>✓</div> : null}
                </div>
              ))}
              <div
                style={{
                  marginTop: 22,
                  height: 112,
                  borderRadius: 18,
                  border: `2px solid ${colors.accentSoft}`,
                  background: 'rgba(179,58,66,.045)',
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 24px',
                }}
              >
                <div style={{width: 48, height: 48, borderRadius: '50%', border: `2px solid ${colors.accent}`}} />
                <div style={{fontFamily, fontSize: 26, color: colors.primary, marginLeft: 20}}>我们谈谈吧。</div>
                <div style={{marginLeft: 'auto', width: 9, height: 9, borderRadius: 9, background: colors.accent}} />
              </div>
            </div>
          ) : (
            <div style={{padding: '70px 32px 0'}}>
              <div
                style={{
                  width: 388,
                  marginLeft: 18,
                  padding: '25px 28px',
                  borderRadius: '25px 25px 25px 8px',
                  background: '#252830',
                  border: `1px solid ${colors.muted}`,
                  opacity: targetOpacity,
                  transform: `translateY(${14 * (1 - targetOpacity)}px)`,
                }}
              >
                <div style={{fontFamily, fontSize: 31, color: colors.primary}}>我们谈谈吧。</div>
                <div style={{fontFamily, fontSize: 18, color: colors.secondary, marginTop: 12}}>刚刚</div>
              </div>
              {mode === 'return' ? (
                <div style={{marginTop: 115, textAlign: 'center', fontFamily, color: colors.secondary, fontSize: 24}}>
                  2 天前 · 未回复
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {mode === 'hesitation' ? (
        <div
          style={{
            position: 'absolute',
            left: 1120,
            top: 660,
            width: 96,
            height: 330,
            borderRadius: 52,
            background: 'linear-gradient(90deg,#8d6e63,#b48a7b 48%,#6f514a)',
            boxShadow: '0 20px 55px rgba(0,0,0,.55)',
            transform: `rotate(-19deg) translateY(${interpolate(frame, [0, 60], [90, 0], {extrapolateRight: 'clamp'})}px)`,
          }}
        >
          <div style={{position: 'absolute', left: 19, top: 10, width: 58, height: 72, borderRadius: '45%', background: '#bb9182'}} />
        </div>
      ) : null}

      {mode === 'return' ? (
        <div
          style={{
            position: 'absolute',
            left: 1260,
            top: 240,
            width: 410,
            padding: '28px 30px',
            borderLeft: `3px solid ${colors.accent}`,
            background: 'rgba(16,17,22,.88)',
            boxShadow: '0 18px 60px rgba(0,0,0,.55)',
          }}
        >
          <Typography variant="BodyLabel" color={colors.primary}>你为什么一直不回？</Typography>
        </div>
      ) : null}
      <EditorialTexture />
    </AbsoluteFill>
  );
};

const PhotoScene = ({
  src,
  title,
  kicker,
  align = 'left',
  warm = false,
}: {
  src: string;
  title?: string;
  kicker?: string;
  align?: 'left' | 'right';
  warm?: boolean;
}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const scale = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.025, 1.085], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{backgroundColor: warm ? colors.historicalSurface : colors.background, overflow: 'hidden'}}>
      <Img
        src={staticFile(src)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: warm ? 'grayscale(1) sepia(.16) contrast(1.08)' : 'saturate(.62) brightness(.58) contrast(1.1)',
          transform: `scale(${scale})`,
        }}
      />
      <AbsoluteFill style={{background: align === 'left' ? 'linear-gradient(90deg,rgba(8,8,10,.90),rgba(8,8,10,.46) 48%,rgba(8,8,10,.20))' : 'linear-gradient(270deg,rgba(8,8,10,.90),rgba(8,8,10,.42) 48%,rgba(8,8,10,.16))'}} />
      <div style={{position: 'absolute', left: align === 'left' ? 118 : 1000, top: 305, width: 760}}>
        {kicker ? <SafeCaption style={{position: 'relative', left: 0, top: 0, marginBottom: 22}}>{kicker}</SafeCaption> : null}
        {title ? <Typography variant="Title" color={colors.primary} style={{maxWidth: 760}}>{title}</Typography> : null}
      </div>
      <EditorialTexture warm={warm} />
    </AbsoluteFill>
  );
};

const FreudScene = ({prelude = false, bias = false}: {prelude?: boolean; bias?: boolean}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const portraitScale = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.03, 1.10], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: colors.historicalSurface, overflow: 'hidden'}}>
      <div style={{position: 'absolute', left: 0, top: 0, width: 1040, height: 1080, overflow: 'hidden'}}>
        <Img
          src={staticFile('pilot/images/freud_1909_loc.jpg')}
          style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: '48% 32%', filter: 'grayscale(1) sepia(.12) contrast(1.13)', transform: `scale(${portraitScale})`}}
        />
        <AbsoluteFill style={{background: 'linear-gradient(90deg,rgba(25,23,20,.06),rgba(25,23,20,.08) 60%,#191714 100%)'}} />
      </div>
      <div style={{position: 'absolute', left: 1040, top: 0, right: 0, bottom: 0, padding: '185px 118px'}}>
        <SafeCaption style={{position: 'relative', left: 0, top: 0, marginBottom: 36}}>HISTORICAL NOTE · 1909 PORTRAIT</SafeCaption>
        {bias ? (
          <>
            <Typography variant="Question" color={colors.primary}>偏偏</Typography>
            <div style={{width: 110, height: 4, background: colors.accent, margin: '36px 0'}} />
            <Typography variant="BodyLabel" color={colors.historical}>他感兴趣的，是遗忘落在了哪里。</Typography>
          </>
        ) : (
          <>
            <Typography variant="Title" color={colors.primary}>{prelude ? '对“忘记”的怀疑' : '西格蒙德·弗洛伊德'}</Typography>
            <div style={{width: 110, height: 3, background: colors.historical, margin: '34px 0'}} />
            <Typography variant="BodyLabel" color={colors.historical}>{prelude ? '不是人物传记。只是一个问题的入口。' : 'Sigmund Freud'}</Typography>
          </>
        )}
      </div>
      <EditorialTexture warm />
    </AbsoluteFill>
  );
};

const OrdinaryOverload = () => {
  const frame = useCurrentFrame();
  const cards = [
    ['09:30', '周会'],
    ['12:40', '交付提醒'],
    ['16:00', '未读 17'],
    ['23:48', '睡眠不足'],
  ];
  return (
    <AbsoluteFill style={{background: 'linear-gradient(135deg,#0a0b0e,#17191f)'}}>
      <div style={{position: 'absolute', left: 154, top: 160, width: 860, height: 670, borderRadius: 28, border: '1px solid #31343c', background: '#111319', boxShadow: '0 28px 90px rgba(0,0,0,.48)'}}>
        <div style={{height: 76, borderBottom: '1px solid #30323a', display: 'flex', alignItems: 'center', padding: '0 34px', fontFamily, fontSize: 22, color: colors.secondary}}>TODAY · 工作台</div>
        <div style={{padding: 36, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24}}>
          {cards.map(([time, label], index) => {
            const opacity = interpolate(frame, [index * 13, index * 13 + 20], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
            return (
              <div key={label} style={{height: 205, borderRadius: 20, border: '1px solid #393b43', padding: 28, opacity, transform: `translateY(${12 * (1 - opacity)}px)`, background: '#181a20'}}>
                <div style={{fontFamily, color: colors.secondary, fontSize: 22}}>{time}</div>
                <div style={{fontFamily, color: colors.primary, fontSize: 34, marginTop: 34}}>{label}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{position: 'absolute', left: 1135, top: 295, width: 570}}>
        <Typography variant="SectionTitle" color={colors.primary}>注意被切成很多小块</Typography>
        <div style={{width: 72, height: 3, background: colors.secondary, margin: '28px 0'}} />
        <Typography variant="BodyLabel" color={colors.secondary}>事情太多。睡眠不足。某个瞬间，确实可能没有想起来。</Typography>
      </div>
      <EditorialTexture />
    </AbsoluteFill>
  );
};

const MinimalStatement = ({title, note, accentWord}: {title: string; note?: string; accentWord?: string}) => (
  <AbsoluteFill style={{backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center'}}>
    <div style={{width: 1360, textAlign: 'center'}}>
      <Typography variant="Question" color={colors.primary}>
        {accentWord && title.includes(accentWord) ? (
          <>{title.split(accentWord)[0]}<span style={{color: colors.accent}}>{accentWord}</span>{title.split(accentWord)[1]}</>
        ) : title}
      </Typography>
      {note ? <Typography variant="Annotation" color={colors.secondary} style={{marginTop: 34, letterSpacing: 2.2}}>{note}</Typography> : null}
    </div>
    <EditorialTexture />
  </AbsoluteFill>
);

const HistoricalBook = () => {
  const frame = useCurrentFrame();
  const underline = interpolate(frame, [24, 60], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: colors.historicalSurface}}>
      <div style={{position: 'absolute', left: 150, top: 134, width: 1620, height: 760, border: '1px solid #4d473f', background: '#e4ddcf', boxShadow: '0 30px 100px rgba(0,0,0,.54)', padding: '88px 110px', boxSizing: 'border-box', transform: 'rotate(-.35deg)'}}>
        <div style={{fontFamily: 'Georgia, serif', color: '#2e2a25', fontSize: 25, letterSpacing: 2}}>SIGMUND FREUD · 1901</div>
        <div style={{fontFamily, color: '#171512', fontSize: 68, fontWeight: 650, marginTop: 86}}>《日常生活的心理分析》</div>
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 100, marginTop: 112}}>
          <div>
            <div style={{fontFamily, color: '#2f2b27', fontSize: 34}}>忘记过去的事情</div>
            <div style={{height: 3, width: `${underline * 100}%`, background: colors.historical, marginTop: 22}} />
          </div>
          <div>
            <div style={{fontFamily, color: '#2f2b27', fontSize: 34}}>忘记已经决定要做的事</div>
            <div style={{height: 3, width: `${underline * 100}%`, background: colors.accentSoft, marginTop: 22}} />
          </div>
        </div>
        <div style={{position: 'absolute', left: '50%', top: 405, bottom: 95, width: 1, background: '#a69e91'}} />
      </div>
      <EditorialTexture warm />
    </AbsoluteFill>
  );
};

const SceneContent = ({scene}: {scene: PilotScene}) => {
  switch (scene.variant) {
    case 'phone-arrival': return <PhoneShell mode="arrival" />;
    case 'phone-hesitation': return <PhoneShell mode="hesitation" />;
    case 'time-pass': return <MG_TimePass markers={['现在', '几小时', '一天', '两天']} pendingLabel="未回复" showDebugLabel={false} />;
    case 'phone-return': return <PhoneShell mode="return" />;
    case 'message-processing': return <PhoneShell mode="processing" />;
    case 'message-focus': return <MG_MessageFocus targetText="我们谈谈吧。" questionText="为什么偏偏是这一条？" showDebugLabel={false} />;
    case 'why-this-one': return <MinimalStatement title="为什么偏偏是这一条？" accentWord="偏偏" note="先别急着回答。" />;
    case 'freud-prelude': return <FreudScene prelude />;
    case 'freud-portrait': return <FreudScene />;
    case 'ordinary-keys': return <PhotoScene src="pilot/images/house_keys_cc0.jpg" kicker="ORDINARY FORGETTING" title="人本来就会忘事。" />;
    case 'ordinary-overload': return <OrdinaryOverload />;
    case 'ordinary-boundary': return <MinimalStatement title="忘记，不一定需要一个隐藏的理由。" note="普通遗忘，先按普通遗忘理解。" />;
    case 'schedule-neutral': return <MG_ScheduleNodes focusIndex={-1} missedIndex={2} completedIndices={[0, 1, 3, 4]} showDebugLabel={false} />;
    case 'schedule-focus': return <MG_ScheduleNodes focusIndex={2} missedIndex={2} completedIndices={[0, 1, 3, 4]} showDebugLabel={false} />;
    case 'forgotten-appointment': return <PhotoScene src="pilot/images/empty_cafe_cc0.jpg" align="right" kicker="A QUESTION, NOT A VERDICT" title="是不是这场约会，已经没那么重要？" />;
    case 'not-equal-love': return <MG_ConceptSeparation mode="appointment-vs-love" leftColor={colors.primary} rightColor={colors.primary} showDebugLabel={false} />;
    case 'relationship-question': return <MinimalStatement title="被忘掉的，为什么恰好是这件事？" accentWord="恰好" note="关系让同一句“我忘了”获得了新的追问。" />;
    case 'bias-word': return <FreudScene bias />;
    case 'historical-book': return <HistoricalBook />;
    case 'intent-intro': return <MinimalStatement title="后者并不是没有计划。" note="计划，已经形成。" />;
    case 'intent-path': return <MG_IntentPath intentLabel="意图：我要做" actionLabel="执行" showDebugLabel={false} />;
  }
};

const CrossfadeScene = ({scene, leadFrames, tailFrames}: {scene: PilotScene; leadFrames: number; tailFrames: number}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const fadeIn = leadFrames === 0 ? 1 : interpolate(frame, [0, leadFrames], [0, 1], {extrapolateRight: 'clamp'});
  const fadeOut = tailFrames === 0 ? 1 : interpolate(frame, [durationInFrames - tailFrames, durationInFrames - 1], [1, 0], {extrapolateLeft: 'clamp'});
  return <AbsoluteFill style={{opacity: Math.min(fadeIn, fadeOut)}}><SceneContent scene={scene} /></AbsoluteFill>;
};

export const PilotVisualTrack = () => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill>
      {pilotScenes.map((scene, index) => {
        const logicalStart = Math.round(scene.start * fps);
        const logicalEnd = Math.round(scene.end * fps);
        const lead = index === 0 ? 0 : CROSSFADE_FRAMES;
        const tail = index === pilotScenes.length - 1 ? 0 : CROSSFADE_FRAMES;
        const from = Math.max(0, logicalStart - lead);
        const duration = logicalEnd - logicalStart + lead + tail;
        return (
          <Sequence key={scene.id} from={from} durationInFrames={duration} layout="none">
            <CrossfadeScene scene={scene} leadFrames={lead} tailFrames={tail} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const PilotSubtitles = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const cue = subtitleCues.find((item) => time >= item.start && time < item.end);
  if (!cue) return null;
  const activeScene = pilotScenes.find((scene) => time >= scene.start && time < scene.end);
  const position = activeScene?.subtitlePosition ?? 'bottom';
  const top = position === 'midLower' ? 830 : position === 'lowerThird' ? 920 : 962;
  const cueProgress = Math.min(1, Math.max(0, (time - cue.start) / 0.12));
  return (
    <div
      style={{
        position: 'absolute',
        left: 350,
        top,
        width: 1220,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        opacity: cueProgress,
        transform: `translateY(${4 * (1 - cueProgress)}px)`,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 34,
          fontWeight: 540,
          lineHeight: 1.34,
          letterSpacing: 0.5,
          color: '#f5f5f5',
          padding: '8px 18px 10px',
          borderRadius: borderRadius.sm,
          background: 'rgba(5,5,7,.52)',
          boxShadow: '0 8px 28px rgba(0,0,0,.18)',
          textShadow: '0 2px 10px rgba(0,0,0,.65)',
          textAlign: 'center',
        }}
      >
        {cue.text}
      </div>
    </div>
  );
};

const bgmVolume = (frame: number) => {
  const second = frame / 30;
  if (second >= 33.1 && second <= 39.9) {
    return interpolate(second, [33.1, 34.0, 38.8, 39.9], [0.16, 0.035, 0.035, 0.15], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }
  return 0.16;
};

export const PilotCutV1 = ({showSubtitles = true}: {showSubtitles?: boolean}) => (
  <AbsoluteFill style={{backgroundColor: colors.background}}>
    <PilotVisualTrack />
    <Audio src={staticFile('pilot/audio/Pilot_BGM.wav')} volume={bgmVolume} />
    <Audio src={staticFile('pilot/audio/Pilot_SFX.wav')} volume={0.72} />
    <Audio src={staticFile('pilot/audio/Pilot_VO.wav')} volume={1} />
    {showSubtitles ? <PilotSubtitles /> : null}
  </AbsoluteFill>
);

export const PilotCutV1NoSubtitles = () => <PilotCutV1 showSubtitles={false} />;

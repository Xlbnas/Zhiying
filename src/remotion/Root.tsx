import {Composition, type CalculateMetadataFunction} from 'remotion';
import type {ZhiyingFullCutProps} from '@/lib/scene-schema';
import {FullTimelineTest} from './compositions/FullTimelineTest';
import {MGDemoAll, MG_DEMO_ALL_DURATION} from './compositions/MGDemoAll';
import {MGDemo} from './compositions/MGDemo';
import {MGDemoV2, MG_DEMO_V2_DURATION} from './compositions/MGDemoV2';
import {NarrativeMGDemo, NARRATIVE_MG_DEMO_DURATION} from './compositions/NarrativeMGDemo';
import {PilotCutV1, PilotCutV1NoSubtitles} from './compositions/PilotCutV1';
import {sceneProject} from './data/scenes';
import {PILOT_DURATION_FRAMES} from './data/pilotScenes';
import {
  FullCutNoNarration,
  FullCutNoNarrationNoSubtitles,
  FullCutV1,
  FULL_CUT_DURATION_FRAMES,
  ZhiyingFullCut,
  zhiyingFullCutDefaultProps,
} from './compositions/FullCutV1';

/**
 * CONTRACT §2：从 props.data.project 推导时长 / fps / 分辨率。
 */
const zhiyingCalculateMetadata: CalculateMetadataFunction<ZhiyingFullCutProps> = ({props}) => ({
  durationInFrames: props.data.project.durationInFrames,
  fps: props.data.project.fps,
  width: props.data.project.width,
  height: props.data.project.height,
});

export const RemotionRoot = () => (
  <>
    <Composition
      id="ZhiyingFullCut"
      component={ZhiyingFullCut}
      durationInFrames={FULL_CUT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={zhiyingFullCutDefaultProps}
      calculateMetadata={zhiyingCalculateMetadata}
    />
    <Composition
      id="ZhiyingFullCutNoSubtitles"
      component={ZhiyingFullCut}
      durationInFrames={FULL_CUT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{...zhiyingFullCutDefaultProps, showSubtitles: false}}
      calculateMetadata={zhiyingCalculateMetadata}
    />
    <Composition
      id="MGDemo"
      component={MGDemo}
      durationInFrames={2040}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="MGDemoV2"
      component={MGDemoV2}
      durationInFrames={MG_DEMO_V2_DURATION}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="MGDemoAll"
      component={MGDemoAll}
      durationInFrames={MG_DEMO_ALL_DURATION}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="NarrativeMGDemo"
      component={NarrativeMGDemo}
      durationInFrames={NARRATIVE_MG_DEMO_DURATION}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="FullTimelineTest"
      component={FullTimelineTest}
      durationInFrames={sceneProject.project.durationSec * sceneProject.project.fps}
      fps={sceneProject.project.fps}
      width={sceneProject.project.width}
      height={sceneProject.project.height}
    />
    <Composition
      id="PilotCutV1"
      component={PilotCutV1}
      durationInFrames={PILOT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="PilotCutV1NoSubtitles"
      component={PilotCutV1NoSubtitles}
      durationInFrames={PILOT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="FullCutV1"
      component={FullCutV1}
      durationInFrames={FULL_CUT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="FullCutNoNarration"
      component={FullCutNoNarration}
      durationInFrames={FULL_CUT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="FullCutNoNarrationNoSubtitles"
      component={FullCutNoNarrationNoSubtitles}
      durationInFrames={FULL_CUT_DURATION_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  </>
);

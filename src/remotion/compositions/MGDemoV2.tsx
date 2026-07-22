import {AbsoluteFill, Sequence} from 'remotion';
import {colors} from '../design/tokens';
import {MG_ConceptSeparation} from '../templates/MG_ConceptSeparation';
import {MG_IntentConflict} from '../templates/MG_IntentConflict';
import {MG_LocalConflictSpread} from '../templates/MG_LocalConflictSpread';
import {MG_MessageFocus} from '../templates/MG_MessageFocus';
import {MG_ThinkNoThink} from '../templates/MG_ThinkNoThink';

const BlackGap = () => <AbsoluteFill style={{backgroundColor: colors.background}} />;

export const MG_DEMO_V2_DURATION = 1386;

export const MGDemoV2 = () => (
  <AbsoluteFill style={{backgroundColor: colors.background}}>
    <Sequence from={0} durationInFrames={240} name="MG_MessageFocus V2">
      <MG_MessageFocus />
    </Sequence>
    <Sequence from={240} durationInFrames={24} name="Gap 1">
      <BlackGap />
    </Sequence>
    <Sequence from={264} durationInFrames={270} name="MG_IntentConflict V2">
      <MG_IntentConflict />
    </Sequence>
    <Sequence from={534} durationInFrames={24} name="Gap 2">
      <BlackGap />
    </Sequence>
    <Sequence from={558} durationInFrames={270} name="MG_LocalConflictSpread V2">
      <MG_LocalConflictSpread />
    </Sequence>
    <Sequence from={828} durationInFrames={24} name="Gap 3">
      <BlackGap />
    </Sequence>
    <Sequence from={852} durationInFrames={270} name="MG_ThinkNoThink V2">
      <MG_ThinkNoThink />
    </Sequence>
    <Sequence from={1122} durationInFrames={24} name="Gap 4">
      <BlackGap />
    </Sequence>
    <Sequence from={1146} durationInFrames={240} name="MG_ConceptSeparation V2">
      <MG_ConceptSeparation mode="question-vs-proof" />
    </Sequence>
  </AbsoluteFill>
);

import {AbsoluteFill, Sequence} from 'remotion';
import {colors} from '../design/tokens';
import {MG_ConceptSeparation} from '../templates/MG_ConceptSeparation';
import {MG_IntentConflict} from '../templates/MG_IntentConflict';
import {MG_LocalConflictSpread} from '../templates/MG_LocalConflictSpread';
import {MG_MessageFocus} from '../templates/MG_MessageFocus';
import {MG_ThinkNoThink} from '../templates/MG_ThinkNoThink';

const TemplateGap = () => <AbsoluteFill style={{backgroundColor: colors.background}} />;

export const MGDemo = () => (
  <AbsoluteFill style={{backgroundColor: colors.background}}>
    <Sequence from={0} durationInFrames={360} name="MG_MessageFocus">
      <MG_MessageFocus />
    </Sequence>
    <Sequence from={360} durationInFrames={60} name="Gap 1">
      <TemplateGap />
    </Sequence>
    <Sequence from={420} durationInFrames={360} name="MG_IntentConflict">
      <MG_IntentConflict />
    </Sequence>
    <Sequence from={780} durationInFrames={60} name="Gap 2">
      <TemplateGap />
    </Sequence>
    <Sequence from={840} durationInFrames={360} name="MG_LocalConflictSpread">
      <MG_LocalConflictSpread />
    </Sequence>
    <Sequence from={1200} durationInFrames={60} name="Gap 3">
      <TemplateGap />
    </Sequence>
    <Sequence from={1260} durationInFrames={360} name="MG_ThinkNoThink">
      <MG_ThinkNoThink />
    </Sequence>
    <Sequence from={1620} durationInFrames={60} name="Gap 4">
      <TemplateGap />
    </Sequence>
    <Sequence from={1680} durationInFrames={360} name="MG_ConceptSeparation">
      <MG_ConceptSeparation mode="question-vs-proof" />
    </Sequence>
  </AbsoluteFill>
);

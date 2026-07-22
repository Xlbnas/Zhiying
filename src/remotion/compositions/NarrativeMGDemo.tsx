import {AbsoluteFill, Sequence} from 'remotion';
import {colors} from '../design/tokens';
import {MG_ActionDelay} from '../templates/MG_ActionDelay';
import {MG_InwardQuestion} from '../templates/MG_InwardQuestion';
import {MG_IntentConflict} from '../templates/MG_IntentConflict';
import {MG_IntentPath} from '../templates/MG_IntentPath';
import {MG_LastStepThreshold} from '../templates/MG_LastStepThreshold';
import {MG_WorthQuestioning} from '../templates/MG_WorthQuestioning';

export const NARRATIVE_MG_DEMO_DURATION = 1710;

export const NarrativeMGDemo = () => (
  <AbsoluteFill style={{backgroundColor: colors.background}}>
    <Sequence from={0} durationInFrames={210} name="计划已经形成">
      <MG_IntentPath />
    </Sequence>
    <Sequence from={210} durationInFrames={270} name="反向意愿介入">
      <MG_IntentConflict initiallyEstablished />
    </Sequence>
    <Sequence from={480} durationInFrames={300} name="行动不断推迟">
      <MG_ActionDelay initiallyEstablished actionStartX={1398} shiftPerDelay={90} />
    </Sequence>
    <Sequence from={780} durationInFrames={300} name="完成 95%">
      <MG_LastStepThreshold />
    </Sequence>
    <Sequence from={1080} durationInFrames={270} name="值得追问不等于证明">
      <MG_WorthQuestioning />
    </Sequence>
    <Sequence from={1350} durationInFrames={360} name="问题转向自己">
      <MG_InwardQuestion />
    </Sequence>
  </AbsoluteFill>
);

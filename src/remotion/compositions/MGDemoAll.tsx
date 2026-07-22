import type {ReactNode} from 'react';
import {AbsoluteFill, Sequence} from 'remotion';
import {colors} from '../design/tokens';
import {MG_ActionDelay} from '../templates/MG_ActionDelay';
import {MG_ConceptSeparation} from '../templates/MG_ConceptSeparation';
import {MG_InwardQuestion} from '../templates/MG_InwardQuestion';
import {MG_IntentConflict} from '../templates/MG_IntentConflict';
import {MG_IntentPath} from '../templates/MG_IntentPath';
import {MG_LastStepThreshold} from '../templates/MG_LastStepThreshold';
import {MG_LocalConflictSpread} from '../templates/MG_LocalConflictSpread';
import {MG_MessageFocus} from '../templates/MG_MessageFocus';
import {MG_ScheduleNodes} from '../templates/MG_ScheduleNodes';
import {MG_ThinkNoThink} from '../templates/MG_ThinkNoThink';
import {MG_TimePass} from '../templates/MG_TimePass';
import {MG_WorthQuestioning} from '../templates/MG_WorthQuestioning';

const GAP = 18;

const demos: Array<{name: string; duration: number; element: ReactNode}> = [
  {name: 'MG_MessageFocus', duration: 210, element: <MG_MessageFocus showDebugLabel />},
  {name: 'MG_TimePass', duration: 210, element: <MG_TimePass showDebugLabel />},
  {name: 'MG_ScheduleNodes', duration: 210, element: <MG_ScheduleNodes showDebugLabel />},
  {name: 'MG_IntentPath', duration: 180, element: <MG_IntentPath showDebugLabel />},
  {name: 'MG_IntentConflict', duration: 240, element: <MG_IntentConflict showDebugLabel />},
  {
    name: 'MG_LocalConflictSpread',
    duration: 240,
    element: <MG_LocalConflictSpread showDebugLabel showMessageLabels />,
  },
  {
    name: 'MG_LastStepThreshold',
    duration: 240,
    element: <MG_LastStepThreshold showDebugLabel />,
  },
  {name: 'MG_ActionDelay', duration: 240, element: <MG_ActionDelay showDebugLabel />},
  {name: 'MG_ThinkNoThink', duration: 240, element: <MG_ThinkNoThink showDebugLabel />},
  {
    name: 'MG_ConceptSeparation',
    duration: 210,
    element: <MG_ConceptSeparation mode="question-vs-proof" showDebugLabel />,
  },
  {
    name: 'MG_WorthQuestioning',
    duration: 240,
    element: <MG_WorthQuestioning showDebugLabel />,
  },
  {name: 'MG_InwardQuestion', duration: 270, element: <MG_InwardQuestion showDebugLabel />},
];

export const MG_DEMO_ALL_DURATION =
  demos.reduce((sum, demo) => sum + demo.duration, 0) + GAP * (demos.length - 1);

export const MGDemoAll = () => (
  <AbsoluteFill style={{backgroundColor: colors.background}}>
    {demos.map((demo, index) => {
      const from = demos
        .slice(0, index)
        .reduce((sum, prior) => sum + prior.duration + GAP, 0);
      return (
        <Sequence key={demo.name} from={from} durationInFrames={demo.duration} name={demo.name}>
          {demo.element}
        </Sequence>
      );
    })}
  </AbsoluteFill>
);

import type {Scene} from '../types/scene';
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
import {Placeholder} from '../scenes/Placeholder';

export type SceneRendererProps = {
  scene: Scene;
};

const conceptModeForScene = (
  scene: Scene,
): 'research-vs-freud' | 'question-vs-proof' | 'appointment-vs-love' | 'framework-vs-fact' => {
  if (scene.id === 'S015') return 'appointment-vs-love';
  if (scene.chapter === 7) return 'research-vs-freud';
  if (scene.chapter === 8) return 'question-vs-proof';
  return 'framework-vs-fact';
};

const delayIndexForScene = (scene: Scene): number | undefined => {
  if (scene.id === 'S050') return 0;
  if (scene.id === 'S051') return 1;
  if (scene.id === 'S052' || scene.id === 'S053') return 2;
  return undefined;
};

const inwardPropsForScene = (
  scene: Scene,
): {outwardLabel?: string; inwardQuestion?: string; showOtherPerson?: boolean} => {
  switch (scene.id) {
    case 'S072':
      return {outwardLabel: '他潜意识里讨厌你？', inwardQuestion: '一次忘记，不能推出一个诊断'};
    case 'S074':
      return {outwardLabel: '我已经看穿他了', inwardQuestion: '怀疑，不等于诊断'};
    case 'S078':
      return {showOtherPerson: false, inwardQuestion: '也许，真的只是忘了？'};
    case 'S079':
      return {showOtherPerson: false, inwardQuestion: '也许，我一直告诉自己：晚一点？'};
    case 'S080':
      return {showOtherPerson: false, inwardQuestion: '也许，我拖延的是回复后的后果？'};
    case 'S083':
      return {showOtherPerson: false, inwardQuestion: '总是在忘，总是在拖，总在最后一步停下……'};
    case 'S084':
      return {showOtherPerson: false, inwardQuestion: '我是真的忘了？还是，我只是不想面对它？'};
    default:
      return {};
  }
};

export const SceneRenderer = ({scene}: SceneRendererProps) => {
  switch (scene.template) {
    case 'MG_MessageFocus':
      return <MG_MessageFocus targetText="我们谈谈吧。" />;
    case 'MG_TimePass':
      return <MG_TimePass />;
    case 'MG_ScheduleNodes':
      return (
        <MG_ScheduleNodes
          focusIndex={scene.id === 'S011' ? -1 : 2}
          showBoundary={scene.id === 'S015'}
        />
      );
    case 'MG_IntentPath':
      return <MG_IntentPath />;
    case 'MG_IntentConflict':
      return <MG_IntentConflict />;
    case 'MG_LocalConflictSpread':
      return <MG_LocalConflictSpread historicalMode={scene.chapter === 4} />;
    case 'MG_LastStepThreshold':
      return <MG_LastStepThreshold showPossibilityLabel={scene.id === 'S045'} />;
    case 'MG_ActionDelay':
      return <MG_ActionDelay currentDelayIndex={delayIndexForScene(scene)} />;
    case 'MG_ThinkNoThink':
      return <MG_ThinkNoThink showBoundaryComparison={false} />;
    case 'MG_ConceptSeparation':
      return <MG_ConceptSeparation mode={conceptModeForScene(scene)} />;
    case 'MG_WorthQuestioning':
      return <MG_WorthQuestioning />;
    case 'MG_InwardQuestion':
      return <MG_InwardQuestion {...inwardPropsForScene(scene)} />;
    case null:
      return <Placeholder scene={scene} kind="asset" />;
    default:
      return <Placeholder scene={scene} kind="template" />;
  }
};

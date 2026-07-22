export type VisualType = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export type TemplateName =
  | 'MG_MessageFocus'
  | 'MG_TimePass'
  | 'MG_ScheduleNodes'
  | 'MG_IntentPath'
  | 'MG_IntentConflict'
  | 'MG_LocalConflictSpread'
  | 'MG_LastStepThreshold'
  | 'MG_ActionDelay'
  | 'MG_ThinkNoThink'
  | 'MG_ConceptSeparation'
  | 'MG_WorthQuestioning'
  | 'MG_InwardQuestion';

export type SceneVisual = {
  description: string;
  elements: string[];
};

export type Scene = {
  id: string;
  start: number;
  end: number;
  duration: number;
  chapter: number;
  visualType: VisualType;
  template: TemplateName | null;
  narrationSummary: string;
  visual: SceneVisual;
  assets: string[];
  transitionIn: string;
  transitionOut: string;
  notes: string;
};

export type Project = {
  title: string;
  fps: number;
  width: number;
  height: number;
  durationSec: number;
};

export type VisualSystem = {
  background: string;
  primary: string;
  accent: string;
  secondaryAccent: string;
};

export type SceneProjectData = {
  project: Project;
  visualSystem: VisualSystem;
  scenes: Scene[];
};

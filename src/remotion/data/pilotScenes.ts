export type PilotSceneKind = 'b-roll' | 'mg' | 'historical' | 'minimal';

export type PilotScene = {
  id: string;
  start: number;
  end: number;
  kind: PilotSceneKind;
  variant:
    | 'phone-arrival'
    | 'phone-hesitation'
    | 'time-pass'
    | 'phone-return'
    | 'message-processing'
    | 'message-focus'
    | 'why-this-one'
    | 'freud-prelude'
    | 'freud-portrait'
    | 'ordinary-keys'
    | 'ordinary-overload'
    | 'ordinary-boundary'
    | 'schedule-neutral'
    | 'schedule-focus'
    | 'forgotten-appointment'
    | 'not-equal-love'
    | 'relationship-question'
    | 'bias-word'
    | 'historical-book'
    | 'intent-intro'
    | 'intent-path';
  subtitlePosition: 'bottom' | 'lowerThird' | 'midLower';
};

export const PILOT_FPS = 30;
export const PILOT_DURATION_SECONDS = 119.107;
export const PILOT_DURATION_FRAMES = Math.ceil(PILOT_DURATION_SECONDS * PILOT_FPS);

export const pilotScenes: PilotScene[] = [
  {id: 'PV001', start: 0, end: 5.607, kind: 'b-roll', variant: 'phone-arrival', subtitlePosition: 'bottom'},
  {id: 'PV002', start: 5.607, end: 12.574, kind: 'b-roll', variant: 'phone-hesitation', subtitlePosition: 'bottom'},
  {id: 'PV003', start: 12.574, end: 18.246, kind: 'mg', variant: 'time-pass', subtitlePosition: 'lowerThird'},
  {id: 'PV004', start: 18.246, end: 23.935, kind: 'b-roll', variant: 'phone-return', subtitlePosition: 'bottom'},
  {id: 'PV005', start: 23.935, end: 33.569, kind: 'b-roll', variant: 'message-processing', subtitlePosition: 'bottom'},
  {id: 'PV006', start: 33.569, end: 36.100, kind: 'mg', variant: 'message-focus', subtitlePosition: 'lowerThird'},
  {id: 'PV007', start: 36.100, end: 39.921, kind: 'minimal', variant: 'why-this-one', subtitlePosition: 'midLower'},
  {id: 'PV008', start: 39.921, end: 47.202, kind: 'historical', variant: 'freud-prelude', subtitlePosition: 'bottom'},
  {id: 'PV009', start: 47.202, end: 50.006, kind: 'historical', variant: 'freud-portrait', subtitlePosition: 'bottom'},
  {id: 'PV010', start: 50.006, end: 55.700, kind: 'b-roll', variant: 'ordinary-keys', subtitlePosition: 'bottom'},
  {id: 'PV011', start: 55.700, end: 59.680, kind: 'b-roll', variant: 'ordinary-overload', subtitlePosition: 'bottom'},
  {id: 'PV012', start: 59.680, end: 63.293, kind: 'minimal', variant: 'ordinary-boundary', subtitlePosition: 'midLower'},
  {id: 'PV013', start: 63.293, end: 70.019, kind: 'mg', variant: 'schedule-neutral', subtitlePosition: 'lowerThird'},
  {id: 'PV014', start: 70.019, end: 74.666, kind: 'mg', variant: 'schedule-focus', subtitlePosition: 'lowerThird'},
  {id: 'PV015', start: 74.666, end: 86.704, kind: 'b-roll', variant: 'forgotten-appointment', subtitlePosition: 'bottom'},
  {id: 'PV016', start: 86.704, end: 90.195, kind: 'mg', variant: 'not-equal-love', subtitlePosition: 'lowerThird'},
  {id: 'PV017', start: 90.195, end: 98.644, kind: 'minimal', variant: 'relationship-question', subtitlePosition: 'midLower'},
  {id: 'PV018', start: 98.644, end: 102.239, kind: 'historical', variant: 'bias-word', subtitlePosition: 'bottom'},
  {id: 'PV019', start: 102.239, end: 109.872, kind: 'historical', variant: 'historical-book', subtitlePosition: 'bottom'},
  {id: 'PV020', start: 109.872, end: 112.010, kind: 'minimal', variant: 'intent-intro', subtitlePosition: 'midLower'},
  {id: 'PV021', start: 112.010, end: PILOT_DURATION_SECONDS, kind: 'mg', variant: 'intent-path', subtitlePosition: 'lowerThird'},
];

export const pilotSceneCounts = pilotScenes.reduce<Record<PilotSceneKind, number>>(
  (counts, scene) => ({...counts, [scene.kind]: counts[scene.kind] + 1}),
  {'b-roll': 0, mg: 0, historical: 0, minimal: 0},
);

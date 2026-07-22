import data from './fullCutScenes.json';

export type FullCutCategory = 'MG' | 'B-roll' | 'Archive' | 'Minimal';
export type FullCutVisualType = 'MG' | 'Asset' | 'Archive' | 'Minimal' | 'UI';
export type FullCutScene = {
  id: string;
  chapter: number;
  chapterTitle: string;
  start: number;
  end: number;
  duration: number;
  startFrame: number;
  durationInFrames: number;
  category: FullCutCategory;
  visualType: FullCutVisualType;
  template: string | null;
  sourceTemplate: string | null;
  narrationSummary: string;
  description: string;
  notes: string;
  assetIds: string[];
  licenseStatus: 'verified' | 'not-applicable';
  subtitlePosition: 'bottom' | 'lowerThird' | 'midLower';
  transitionIn: string;
  transitionOut: string;
};

export const fullCutProject = data.project;
export const fullCutChapterTiming = data.chapterTiming;
export const fullCutScenes = data.scenes as FullCutScene[];
export const FULL_CUT_DURATION_SECONDS = data.project.durationSec;
export const FULL_CUT_DURATION_FRAMES = data.project.durationInFrames;

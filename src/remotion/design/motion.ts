export const motionTiming = {
  fast: 0.45,
  normal: 0.8,
  structure: 1.2,
  hold: 2.2,
  questionHold: 2.4,
  nodeEnter: 0.4,
  pathDraw: 0.65,
  interferenceDraw: 0.65,
  dim: 0.5,
  notEqualEnter: 0.4,
  structureExpand: 1.1,
} as const;

export const atFrame = (seconds: number, fps: number) => Math.round(seconds * fps);

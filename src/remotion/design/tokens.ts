export const colors = {
  background: '#0B0B0D',
  surface: '#121216',
  surfaceRaised: '#18181D',
  primary: '#F2F2F2',
  secondary: '#8A8A8F',
  muted: '#3A3A3F',
  accent: '#B33A42',
  accentSoft: '#7E3036',
  research: '#54748A',
  researchSoft: '#334A59',
  historical: '#9B9183',
  historicalSurface: '#191714',
} as const;

export const spacing = {
  xxs: 8,
  xs: 16,
  sm: 24,
  md: 40,
  lg: 64,
  xl: 96,
  xxl: 144,
} as const;

export const fontSize = {
  annotation: 22,
  small: 26,
  body: 34,
  section: 48,
  title: 68,
  question: 74,
  boundary: 190,
} as const;

export const lineWidth = {
  hairline: 1,
  normal: 2,
  emphasis: 4,
} as const;

export const borderRadius = {
  sm: 10,
  md: 18,
  lg: 28,
  pill: 999,
} as const;

export const opacity = {
  hidden: 0,
  faint: 0.18,
  dimmed: 0.34,
  secondary: 0.68,
  full: 1,
} as const;

export const zIndex = {
  background: 0,
  content: 10,
  overlay: 20,
  annotation: 30,
} as const;

export const motion = {
  enterFrames: 18,
  drawFrames: 32,
  holdFrames: 60,
  damping: 28,
  stiffness: 120,
  mass: 0.9,
} as const;

export const fontFamily =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

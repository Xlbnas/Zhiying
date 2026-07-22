import type {CSSProperties, ReactNode} from 'react';
import {fontFamily, fontSize} from './tokens';

export type TypographyVariant =
  | 'Title'
  | 'SectionTitle'
  | 'BodyLabel'
  | 'SmallLabel'
  | 'Question'
  | 'Annotation';

const variantStyle: Record<TypographyVariant, CSSProperties> = {
  Title: {fontSize: fontSize.title, fontWeight: 650, lineHeight: 1.16},
  SectionTitle: {fontSize: fontSize.section, fontWeight: 600, lineHeight: 1.2},
  BodyLabel: {fontSize: fontSize.body, fontWeight: 520, lineHeight: 1.3},
  SmallLabel: {fontSize: fontSize.small, fontWeight: 520, lineHeight: 1.28},
  Question: {fontSize: fontSize.question, fontWeight: 600, lineHeight: 1.18},
  Annotation: {
    fontSize: fontSize.annotation,
    fontWeight: 500,
    lineHeight: 1.35,
    letterSpacing: 1.2,
  },
};

export type TypographyProps = {
  variant: TypographyVariant;
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
};

export const Typography = ({variant, children, color, style}: TypographyProps) => (
  <div
    style={{
      fontFamily,
      color,
      textRendering: 'geometricPrecision',
      ...variantStyle[variant],
      ...style,
    }}
  >
    {children}
  </div>
);

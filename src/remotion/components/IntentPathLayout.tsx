import {Node} from './Node';
import {PathLine} from './PathLine';
import {Person} from './Person';
import {colors} from '../design/tokens';

export type IntentPathLayoutProps = {
  intentLabel: string;
  actionLabel: string;
  showPerson?: boolean;
  personScale?: number;
  intentScale?: number;
  actionScale?: number;
  pathProgress: number;
  actionX?: number;
  actionOpacity?: number;
  pathOpacity?: number;
};

export const IntentPathLayout = ({
  intentLabel,
  actionLabel,
  showPerson = true,
  personScale = 1,
  intentScale = 1,
  actionScale = 1,
  pathProgress,
  actionX = 1290,
  actionOpacity = 1,
  pathOpacity = 1,
}: IntentPathLayoutProps) => (
  <>
    {showPerson ? <Person x={180} y={390} size={150} scale={personScale} /> : null}
    <Node
      label={intentLabel}
      x={480}
      y={360}
      width={300}
      color={colors.primary}
      scale={intentScale}
    />
    <PathLine
      x1={780}
      y1={406}
      x2={actionX}
      y2={406}
      progress={pathProgress}
      opacity={pathOpacity}
    />
    <Node
      label={actionLabel}
      x={actionX}
      y={360}
      width={250}
      color={colors.primary}
      scale={actionScale}
      style={{opacity: actionOpacity}}
    />
  </>
);

import {AbsoluteFill} from 'remotion';
import {FrameBox} from '../components/FrameBox';
import {Label} from '../components/Label';
import {Typography} from '../design/typography';
import {colors} from '../design/tokens';
import type {Scene} from '../types/scene';

export type PlaceholderProps = {
  scene: Scene;
  kind: 'template' | 'asset';
};

export const Placeholder = ({scene, kind}: PlaceholderProps) => {
  const mode = scene.visualType === 'C' ? 'historical' : scene.chapter === 7 ? 'research' : 'modern';
  const heading =
    kind === 'template'
      ? '[MG PLACEHOLDER]'
      : scene.visualType === 'C'
        ? '[ARCHIVE PLACEHOLDER]'
        : '[B-ROLL / TEXT PLACEHOLDER]';

  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      <FrameBox x={210} y={160} width={1500} height={760} mode={mode}>
        <Label x={54} y={48} tone={scene.chapter === 7 ? 'blue' : 'gray'}>
          {heading}
        </Label>
        <Typography
          variant="Title"
          color={colors.primary}
          style={{position: 'absolute', left: 54, top: 155}}
        >
          {scene.id}
        </Typography>
        <Typography
          variant="SectionTitle"
          color={colors.secondary}
          style={{position: 'absolute', left: 54, top: 278}}
        >
          {scene.template ?? (scene.assets.join(' · ') || 'no_asset_required')}
        </Typography>
        <Typography
          variant="BodyLabel"
          color={colors.primary}
          style={{position: 'absolute', left: 54, right: 54, top: 430}}
        >
          {scene.narrationSummary}
        </Typography>
        <Label x={54} y={610} tone="gray">
          {scene.start.toFixed(1)}s – {scene.end.toFixed(1)}s · Chapter {scene.chapter}
        </Label>
      </FrameBox>
    </AbsoluteFill>
  );
};

import {AbsoluteFill, Sequence, useVideoConfig} from 'remotion';
import {sceneProject} from '../data/scenes';
import {colors} from '../design/tokens';
import {SceneRenderer} from './SceneRenderer';

export const FullTimelineTest = () => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{backgroundColor: colors.background}}>
      {sceneProject.scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={Math.round(scene.start * fps)}
          durationInFrames={Math.round(scene.duration * fps)}
          name={`${scene.id} · ${scene.template ?? scene.visualType}`}
        >
          <SceneRenderer scene={scene} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

import rawData from './Scenes.json';
import type {SceneProjectData} from '../types/scene';

export const sceneProject = rawData as SceneProjectData;

export const assertSceneContinuity = (data: SceneProjectData): void => {
  if (data.scenes.length !== 85) {
    throw new Error(`Expected 85 scenes, received ${data.scenes.length}`);
  }

  if (data.project.durationSec !== 620) {
    throw new Error(`Expected 620 seconds, received ${data.project.durationSec}`);
  }

  data.scenes.forEach((scene, index) => {
    if (scene.end - scene.start !== scene.duration) {
      throw new Error(`Duration mismatch in ${scene.id}`);
    }

    const previous = data.scenes[index - 1];
    if (previous && previous.end !== scene.start) {
      throw new Error(`Timeline gap or overlap before ${scene.id}`);
    }
  });

  const first = data.scenes[0];
  const last = data.scenes[data.scenes.length - 1];
  if (!first || !last || first.start !== 0 || last.end !== 620) {
    throw new Error('Scene timeline does not cover 0–620 seconds');
  }
};

assertSceneContinuity(sceneProject);

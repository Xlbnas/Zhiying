#!/usr/bin/env node

import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const required = ['--visual', '--reconciliation', '--subtitles', '--output'];
for (const flag of required) {
  if (!args.get(flag)) throw new Error(`Missing required argument: ${flag}`);
}

const readJson = (flag) => JSON.parse(readFileSync(resolve(args.get(flag)), 'utf8'));
const visual = readJson('--visual');
const reconciliation = readJson('--reconciliation');
const subtitleTiming = readJson('--subtitles');
const output = resolve(args.get('--output'));
const markedSceneIds = new Set((args.get('--scene-ids') ?? '').split(',').filter(Boolean));
const rendererVersion = args.get('--renderer-version') ?? 'v2-visual-r2@2';
if (!['v2-visual-r2@2', 'dark-editorial-v1@1', 'dark-editorial-v1@2', 'dark-editorial-v1@3'].includes(rendererVersion)) {
  throw new Error(`Unsupported preview renderer version: ${rendererVersion}`);
}

if (visual.schemaVersion !== 'visual-source@2.0') throw new Error('Expected visual-source@2.0');
if (reconciliation.schemaVersion !== 'timing-reconciliation@1.0') throw new Error('Expected timing-reconciliation@1.0');
if (subtitleTiming.schemaVersion !== 'subtitle-timing@2.0') throw new Error('Expected subtitle-timing@2.0');

const visualAudio = visual.source?.narrationAudioV2;
const subtitleAudio = {
  id: subtitleTiming.source?.narrationAudioV2ArtifactId,
  version: subtitleTiming.source?.narrationAudioV2ArtifactVersion,
};
if (!visualAudio || visualAudio.id !== subtitleAudio.id || visualAudio.version !== subtitleAudio.version) {
  throw new Error('Visual and subtitle exact narration_audio source mismatch');
}
if (visual.source?.masterSha256 !== subtitleTiming.source?.masterSha256 ||
    visual.source?.masterDurationMs !== subtitleTiming.source?.masterDurationMs) {
  throw new Error('Visual and subtitle master media facts mismatch');
}

const timings = new Map(reconciliation.scenes.map((timing) => [timing.sceneId, timing]));
const sourceScenes = visual.data?.scenes ?? [];
const sourceSceneIds = new Set(sourceScenes.map((scene) => scene.id));
for (const sceneId of markedSceneIds) {
  if (!sourceSceneIds.has(sceneId)) throw new Error(`Unknown scene requested for R2 preview: ${sceneId}`);
}

const scenes = sourceScenes.map((scene) => {
  const timing = timings.get(scene.id);
  if (!timing) throw new Error(`Missing reconciliation timing for ${scene.id}`);
  const startFrame = timing.effectiveStartFrame;
  const durationInFrames = timing.effectiveDurationFrames;
  const marker = markedSceneIds.has(scene.id)
    ? {v2VisualR2: {version: rendererVersion}}
    : {};
  return {
    ...scene,
    start: startFrame / reconciliation.fps,
    end: timing.effectiveEndFrame / reconciliation.fps,
    duration: durationInFrames / reconciliation.fps,
    startFrame,
    durationInFrames,
    templateProps: {...(scene.templateProps ?? {}), ...marker},
  };
});

const chapters = [...new Set(scenes.map((scene) => scene.chapter))].map((chapter) => {
  const chapterScenes = scenes.filter((scene) => scene.chapter === chapter);
  return {
    chapter,
    title: chapterScenes[0].chapterTitle,
    start: chapterScenes[0].start,
    end: chapterScenes.at(-1).end,
  };
});

const props = {
  data: {
    schemaVersion: '1.0',
    templateVersion: 'freud-mg-v1.0',
    project: {
      title: '你真的只是“口误”了吗？重新审视弗洛伊德的日常生活心理分析',
      projectId: '3778ffb0-c430-4499-9f7f-2590f45cb8cb',
      composition: 'ZhiyingFullCut',
      fps: reconciliation.fps,
      width: 1920,
      height: 1080,
      durationSec: reconciliation.target.totalFrames / reconciliation.fps,
      durationInFrames: reconciliation.target.totalFrames,
      timingBasis: reconciliation.strategy,
      sceneCount: scenes.length,
      showPilotIntro: false,
    },
    chapterTiming: chapters,
    scenes,
    assetMap: visual.assetMap,
  },
  subtitles: subtitleTiming.cues.map((cue) => ({
    id: cue.id,
    segmentId: cue.segmentId,
    chapter: cue.chapter,
    text: cue.text,
    start: cue.startMs / 1000,
    end: cue.endMs / 1000,
    position: cue.position,
  })),
  audio: {narration: null, bgm: null, sfx: null},
  showSubtitles: true,
  renderMode: 'preview',
};

writeFileSync(output, `${JSON.stringify(props, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  scenes: scenes.length,
  markedScenes: [...markedSceneIds],
  subtitles: props.subtitles.length,
  frames: props.data.project.durationInFrames,
  exactAudio: `${visualAudio.id}@${visualAudio.version}`,
  masterSha256: visual.source.masterSha256,
  rendererVersion,
}, null, 2));

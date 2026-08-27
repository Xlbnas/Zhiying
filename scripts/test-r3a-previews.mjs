#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => JSON.parse(fs.readFileSync(path.resolve(root, relative), 'utf8'));
const props = read('outputs/r3a-previews/preview-props.json');
const timing = read('outputs/r3a-previews/sidecars/subtitle_timing_v2.json');
const manifest = read('src/data/r3a-historical-assets.json');
let passed = 0;
const ok = (condition, label) => {
  assert.ok(condition, label);
  passed += 1;
  console.log(`PASS  ${label}`);
};

ok(props.data.project.projectId === '3778ffb0-c430-4499-9f7f-2590f45cb8cb' && props.data.scenes.length === 25, '[R3A-1] exact project and 25-scene preview');
ok(props.data.scenes.every((scene) => scene.templateProps?.v2VisualR2?.version === 'dark-editorial-v1@1'), '[R3A-2] dark theme requires explicit preview-only marker');
ok(timing.source.narrationAudioV2ArtifactId === 'ff7ef85f-bf59-4814-ba9a-6306e56e8cb6' && timing.source.narrationAudioV2ArtifactVersion === 1, '[R3A-3] sidecars retain exact narration audio identity');
ok(timing.source.masterSha256 === '801fadc172e7e5f20ff34337a44d889985fdec04f8609228897239f77c877c2a' && timing.source.masterDurationMs === 243560, '[R3A-4] sidecars retain exact master facts');
const exactMaster = path.resolve(root, 'public/runtime-audio/3778ffb0-c430-4499-9f7f-2590f45cb8cb/r3a-exact-master.wav');
ok(crypto.createHash('sha256').update(fs.readFileSync(exactMaster)).digest('hex') === timing.source.masterSha256, '[R3A-4a] local preview narration is the exact frozen master');
ok(timing.cues.length === 44 && timing.cues.every((cue, index) => cue.startMs < cue.endMs && (index === 0 || cue.startMs >= timing.cues[index - 1].endMs)) && timing.cues.at(-1).endMs <= timing.source.masterDurationMs, '[R3A-5] exact cues are monotonic, non-overlapping, and within master');
const srtBlocks = fs.readFileSync(path.resolve(root, 'outputs/r3a-previews/sidecars/subtitles.zh-CN.srt'), 'utf8').trim().split(/\n\n+/);
const vttBlocks = fs.readFileSync(path.resolve(root, 'outputs/r3a-previews/sidecars/subtitles.zh-CN.vtt'), 'utf8').replace(/^WEBVTT\n+/, '').trim().split(/\n\n+/);
const ass = fs.readFileSync(path.resolve(root, 'outputs/r3a-previews/sidecars/subtitles.zh-CN.ass'), 'utf8');
ok(srtBlocks.length === timing.cues.length && srtBlocks.every((block, index) => block.split('\n').slice(2).join('\n') === timing.cues[index].text), '[R3A-5a] SRT text is character-identical to the exact artifact');
ok(vttBlocks.length === timing.cues.length && vttBlocks.every((block, index) => block.split('\n').slice(2).join('\n') === timing.cues[index].text), '[R3A-5b] VTT text is character-identical to the exact artifact');
ok(timing.cues.every((cue) => ass.includes(`exact-ms:${cue.startMs}-${cue.endMs},${cue.segmentId}`) && ass.includes(`,,${cue.text}`)), '[R3A-5c] ASS retains every exact-ms pair and cue text');

const uniqueAssetIds = new Set(manifest.assets.map((asset) => asset.assetId));
ok(manifest.assets.length === 6 && uniqueAssetIds.size === 6, '[R3A-6] six unique traceable historical assets');
ok(manifest.assets.every((asset) => /^https:\/\//.test(asset.sourceUrl) && asset.creator && asset.date && asset.license && asset.publicDomainBasis && asset.intendedUsage), '[R3A-7] historical provenance fields complete');
ok(manifest.assets.every((asset) => {
  const file = path.resolve(root, 'public', asset.publicPath);
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}), '[R3A-8] every planned historical file exists and is non-empty');
ok(Object.entries(manifest.sceneAssets).every(([sceneId, assetIds]) => props.data.assetMap[sceneId]?.length === assetIds.length && assetIds.every((id) => uniqueAssetIds.has(id))), '[R3A-9] S005-S010 preview bindings resolve only manifest assets');

const sceneById = new Map(props.data.scenes.map((scene) => [scene.id, scene]));
const archiveDominantSeconds = manifest.archiveDominantSceneIds.reduce((sum, sceneId) => sum + sceneById.get(sceneId).duration, 0);
ok(archiveDominantSeconds >= 40 && archiveDominantSeconds <= 50, `[R3A-10] archive-dominant runtime is ${archiveDominantSeconds.toFixed(2)}s`);

const sceneSource = fs.readFileSync(path.resolve(root, 'src/remotion/templates/production/V2VisualR2Scene.tsx'), 'utf8');
ok(['#1b1816', '#11191e', '#161719', '#f1eee8', '#a9afb2', '#9a4e52', '#4e9299', '#b68c4e'].every((token) => sceneSource.includes(token)), '[R3A-10a] dark editorial palette is explicit and contains no pure-black background token');
ok(sceneSource.includes("dark ? null : <div style={{position: 'absolute', inset: 0, backgroundImage:"), '[R3A-10b] global grid is disabled on the dark editorial path');

for (const id of ['history', 'language', 'editorial']) {
  const clean = path.resolve(root, `outputs/r3a-previews/preview-${id}-clean.mp4`);
  const burned = path.resolve(root, `outputs/r3a-previews/preview-${id}-burned.mp4`);
  const sheet = path.resolve(root, `outputs/r3a-previews/${id}-contact-sheet.png`);
  ok([clean, burned, sheet].every((file) => fs.existsSync(file) && fs.statSync(file).size > 0), `[R3A-${id}] clean, burned, and contact sheet exist`);
  for (const video of [clean, burned]) {
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', video], {encoding: 'utf8'});
    ok(probe.status === 0 && probe.stdout.includes('video') && probe.stdout.includes('audio'), `[R3A-${id}-${path.basename(video)}] contains video and exact narration audio streams`);
  }
}

ok(fs.readFileSync(path.resolve(root, 'package.json'), 'utf8').match(/"remotion": "4\.0\.492"/), '[R3A-11] Remotion remains frozen at 4.0.492');
console.log(`\n[test] R3-A PASS=${passed}`);

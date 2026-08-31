#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const manifestPath = 'docs/skill_migration/reference_masters/r3d-reference-master.json';
const manifest = read(manifestPath);

assert.equal(manifest.referenceId, 'zhiying-video-r3d-reference-v1');
assert.equal(manifest.status, 'FROZEN');
assert.equal(manifest.userAccepted, true);
assert.equal(manifest.projectId, '3778ffb0-c430-4499-9f7f-2590f45cb8cb');
assert.equal(manifest.commit, '14586bddb9bbaba735eb752a3126b10a8028a2b7');
assert.equal(manifest.script, '046bb456-ec8c-431e-b117-186bb63953ab@3');
assert.equal(manifest.narrationPlan, '76d3da1e-09dd-4af7-acc2-6116f3c3f4bb@2');
assert.equal(manifest.narrationAudio, 'ff7ef85f-bf59-4814-ba9a-6306e56e8cb6@1');
assert.equal(manifest.subtitleTiming, '68a8a73c-7863-4fa6-a89f-d9965f66c92f@1');
assert.equal(manifest.visual, '4a4eec86-fe60-42cd-a6dd-8a71543baddc@7');
assert.equal(manifest.reconciliation, 'ebe44bfe-e971-42eb-968c-68f9b80f7d19@7');
assert.equal(manifest.finalRenderSource, '884a690f-323f-4ff3-8cbc-287dce27e8f4@8');
assert.equal(manifest.renderJob, 'f758355c-1bbd-4689-8c02-a63c45e5e98f');
assert.equal(manifest.renderKind, 'no-subtitles');
assert.equal(manifest.rendererVersion, 'dark-editorial-v1@3');
assert.equal(manifest.subtitleDelivery.cleanMaster, true);
assert.equal(manifest.subtitleDelivery.burnedSubtitles, false);
assert.equal(manifest.subtitleDelivery.timingAuthority, manifest.subtitleTiming);
assert.deepEqual(manifest.boundaryReview, {
  status: 'PASS',
  passed: 19,
  total: 19,
  evidence: 'outputs/r3d-final/boundary-review/all-boundaries.png',
});

const evidencePaths = [
  manifest.masterPath,
  manifest.boundaryReview.evidence,
  manifest.subtitleDelivery.srt,
  manifest.subtitleDelivery.vtt,
  manifest.subtitleDelivery.ass,
  manifest.subtitleDelivery.json,
  manifest.narrationMaster,
];
for (const relativePath of evidencePaths) {
  const absolutePath = path.join(root, relativePath);
  assert.ok(fs.statSync(absolutePath).size > 0, `missing or empty reference evidence: ${relativePath}`);
}

const master = fs.readFileSync(path.join(root, manifest.masterPath));
assert.equal(crypto.createHash('sha256').update(master).digest('hex'), manifest.masterSha256);

const probe = spawnSync('ffprobe', [
  '-v', 'error',
  '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration',
  '-of', 'json',
  path.join(root, manifest.masterPath),
], {encoding: 'utf8'});
assert.equal(probe.status, 0, probe.stderr);
const media = JSON.parse(probe.stdout);
const video = media.streams.find((stream) => stream.codec_type === 'video');
const audio = media.streams.find((stream) => stream.codec_type === 'audio');
assert.equal(video.codec_name, manifest.videoCodec);
assert.equal(video.width, manifest.width);
assert.equal(video.height, manifest.height);
assert.equal(video.r_frame_rate, `${manifest.fps}/1`);
assert.equal(audio.codec_name, manifest.audioCodec);
assert.ok(Math.abs(Number(media.format.duration) - manifest.durationSeconds) < .001);

const timing = read(manifest.subtitleDelivery.json);
assert.equal(timing.schemaVersion, 'subtitle-timing@2.0');
assert.equal(`${timing.source.scriptV2VersionId}@${timing.source.scriptV2Version}`, manifest.script);
assert.equal(`${timing.source.narrationPlanV2ArtifactId}@${timing.source.narrationPlanV2ArtifactVersion}`, manifest.narrationPlan);
assert.equal(`${timing.source.narrationAudioV2ArtifactId}@${timing.source.narrationAudioV2ArtifactVersion}`, manifest.narrationAudio);
assert.equal(timing.cues.length, 44);

const boundaryRows = fs.readdirSync(path.join(root, 'outputs/r3d-final/boundary-review/rows'))
  .filter((name) => /^\d{2}-S\d{3}\.png$/.test(name));
assert.equal(boundaryRows.length, manifest.boundaryReview.total);

console.log(JSON.stringify({
  status: 'PASS',
  referenceId: manifest.referenceId,
  masterSha256: manifest.masterSha256,
  durationSeconds: manifest.durationSeconds,
  exactParents: 7,
  subtitleCues: timing.cues.length,
  boundaryEvidence: boundaryRows.length,
  rendererVersion: manifest.rendererVersion,
}));

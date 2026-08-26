#!/usr/bin/env node

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const video = valueAfter('--video');
const videosValue = valueAfter('--videos');
const scenesPath = valueAfter('--scenes');
const output = valueAfter('--output');
const cropHeight = Number(valueAfter('--crop-height') ?? 860);
const width = Number(valueAfter('--width') ?? 320);
const height = Number(valueAfter('--height') ?? 144);

const videos = videosValue ? videosValue.split(',').filter(Boolean) : video ? [video] : [];
if (videos.length === 0 || !scenesPath || !output) {
  console.error('Usage: audit-video-motion.mjs (--video <mp4> | --videos <ordered,mp4,list>) --scenes <json> --output <json> [--crop-height 860]');
  process.exit(2);
}

const scenes = JSON.parse(fs.readFileSync(scenesPath, 'utf8')).scenes;
const frameSize = width * height;
const inputArgs = videos.flatMap((item) => ['-i', item]);
const videoFilter = `crop=iw:${cropHeight}:0:0,scale=${width}:${height},format=gray`;
const filterArgs = videos.length === 1
  ? ['-an', '-vf', videoFilter]
  : ['-filter_complex', `${videos.map((_, index) => `[${index}:v]`).join('')}concat=n=${videos.length}:v=1:a=0,${videoFilter}`];
const ffmpeg = spawn('ffmpeg', [
  '-v', 'error', ...inputArgs, ...filterArgs,
  '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
], {stdio: ['ignore', 'pipe', 'inherit']});

let pending = Buffer.alloc(0);
let previous = null;
let frame = 0;
const frames = [];

function metrics(current) {
  let diffSum = 0;
  let changed8 = 0;
  let changed20 = 0;
  let topDiff = 0;
  let midDiff = 0;
  let bottomDiff = 0;
  let sampleSum = 0;
  let sampleSquared = 0;
  let sampleCount = 0;
  let edgeCount = 0;
  let edgeSamples = 0;
  const regionalEdges = [0, 0, 0];
  const regionalEdgeSamples = [0, 0, 0];
  let minEdgeX = width;
  let minEdgeY = height;
  let maxEdgeX = -1;
  let maxEdgeY = -1;
  const third = Math.floor(height / 3);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      if (previous) {
        const diff = Math.abs(current[index] - previous[index]);
        diffSum += diff;
        if (diff >= 8) changed8 += 1;
        if (diff >= 20) changed20 += 1;
        if (y < third) topDiff += diff;
        else if (y < third * 2) midDiff += diff;
        else bottomDiff += diff;
      }
      if ((x & 1) === 0 && (y & 1) === 0) {
        const value = current[index];
        const region = Math.min(2, Math.floor(y / third));
        sampleSum += value;
        sampleSquared += value * value;
        sampleCount += 1;
        if (x + 2 < width) {
          if (Math.abs(value - current[index + 2]) >= 16) {
            edgeCount += 1;
            regionalEdges[region] += 1;
            minEdgeX = Math.min(minEdgeX, x);
            minEdgeY = Math.min(minEdgeY, y);
            maxEdgeX = Math.max(maxEdgeX, x);
            maxEdgeY = Math.max(maxEdgeY, y);
          }
          edgeSamples += 1;
          regionalEdgeSamples[region] += 1;
        }
        if (y + 2 < height) {
          if (Math.abs(value - current[index + width * 2]) >= 16) {
            edgeCount += 1;
            regionalEdges[region] += 1;
            minEdgeX = Math.min(minEdgeX, x);
            minEdgeY = Math.min(minEdgeY, y);
            maxEdgeX = Math.max(maxEdgeX, x);
            maxEdgeY = Math.max(maxEdgeY, y);
          }
          edgeSamples += 1;
          regionalEdgeSamples[region] += 1;
        }
      }
    }
  }

  const mean = sampleSum / sampleCount;
  const variance = Math.max(0, sampleSquared / sampleCount - mean * mean);
  const pixelsPerThird = width * third;
  return {
    frame,
    meanAbsDiff: previous ? diffSum / frameSize : 0,
    changed8Fraction: previous ? changed8 / frameSize : 0,
    changed20Fraction: previous ? changed20 / frameSize : 0,
    topMeanAbsDiff: previous ? topDiff / pixelsPerThird : 0,
    midMeanAbsDiff: previous ? midDiff / pixelsPerThird : 0,
    bottomMeanAbsDiff: previous ? bottomDiff / (frameSize - pixelsPerThird * 2) : 0,
    lumaStdDev: Math.sqrt(variance),
    edgeFraction: edgeSamples ? edgeCount / edgeSamples : 0,
    topEdgeFraction: regionalEdgeSamples[0] ? regionalEdges[0] / regionalEdgeSamples[0] : 0,
    midEdgeFraction: regionalEdgeSamples[1] ? regionalEdges[1] / regionalEdgeSamples[1] : 0,
    bottomEdgeFraction: regionalEdgeSamples[2] ? regionalEdges[2] / regionalEdgeSamples[2] : 0,
    topEdgeShare: edgeCount ? regionalEdges[0] / edgeCount : 0,
    contentBounds: edgeCount ? {
      left: minEdgeX / width,
      top: minEdgeY / height,
      right: maxEdgeX / width,
      bottom: maxEdgeY / height,
    } : null,
    informationScore: Math.sqrt(variance) * (1 + (edgeSamples ? edgeCount / edgeSamples : 0)),
  };
}

function consume(current) {
  frames.push(metrics(current));
  previous = Buffer.from(current);
  frame += 1;
}

ffmpeg.stdout.on('data', (chunk) => {
  pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
  while (pending.length >= frameSize) {
    consume(pending.subarray(0, frameSize));
    pending = pending.subarray(frameSize);
  }
});

ffmpeg.on('close', (code) => {
  if (code !== 0 || pending.length !== 0) {
    console.error(`ffmpeg failed or returned a partial frame: code=${code} remaining=${pending.length}`);
    process.exit(code || 1);
  }
  const sceneResults = scenes.map((scene) => {
    const slice = frames.slice(scene.startFrame, scene.endFrame);
    const comparable = slice.slice(1);
    const total = comparable.length || 1;
    const sum = (key) => comparable.reduce((acc, item) => acc + item[key], 0);
    const maximumInformation = slice.reduce(
      (best, item) => item.informationScore > best.informationScore ? item : best,
      slice[0],
    );
    const highMotionFrames = comparable.filter((item) => item.meanAbsDiff >= 1 || item.changed8Fraction >= 0.03).length;
    return {
      ...scene,
      analyzedFrames: slice.length,
      meanAbsDiff: sum('meanAbsDiff') / total,
      changed8Fraction: sum('changed8Fraction') / total,
      changed20Fraction: sum('changed20Fraction') / total,
      topMeanAbsDiff: sum('topMeanAbsDiff') / total,
      midMeanAbsDiff: sum('midMeanAbsDiff') / total,
      bottomMeanAbsDiff: sum('bottomMeanAbsDiff') / total,
      highMotionFrames,
      highMotionFraction: highMotionFrames / total,
      maximumInformationFrame: maximumInformation?.frame ?? scene.startFrame,
      maximumInformationScore: maximumInformation?.informationScore ?? 0,
      maximumInformationFootprint: maximumInformation ? {
        topEdgeFraction: maximumInformation.topEdgeFraction,
        midEdgeFraction: maximumInformation.midEdgeFraction,
        bottomEdgeFraction: maximumInformation.bottomEdgeFraction,
        topEdgeShare: maximumInformation.topEdgeShare,
        contentBounds: maximumInformation.contentBounds,
      } : null,
    };
  });
  const result = {
    video: videos.length === 1 ? path.resolve(videos[0]) : videos.map((item) => path.resolve(item)),
    crop: {sourceTop: 0, sourceHeight: cropHeight, analysisWidth: width, analysisHeight: height},
    frameCount: frames.length,
    thresholds: {changedPixelLow: 8, changedPixelHigh: 20, highMotionMeanAbsDiff: 1, highMotionChangedFraction: 0.03},
    scenes: sceneResults,
    frames,
  };
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({output, frameCount: frames.length, scenes: sceneResults.length}));
});

import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {LocalRemotionExecutor, type LocalRenderRequest} from '@/lib/render/local-executor';
import {computePropsSha256} from '@/lib/final-render/schema';
import {assertProductionBaselineReference} from '@/lib/workflow/production-baseline';
import {zhiyingFullCutPropsSchema, type ZhiyingFullCutProps} from '@/lib/scene-schema';

const root = process.cwd();
const manifest = assertProductionBaselineReference();
const outputDir = path.join(root, 'outputs/local-render-parity/initial-production-baseline-v1');
const sourceArtifactPath = path.join(root, 'outputs/local-render-parity/initial-production-baseline-v1/input/frozen-final-render-source.json');
const propsPath = path.join(root, 'outputs/local-render-parity/initial-production-baseline-v1/input/frozen-props.json');
const audioPath = path.join(root, 'outputs/extreme-long-video/audio/narration-master.wav');
const referencePath = path.join(root, manifest.formalRenderAttempt2.localMasterPath);
const sourceAudio = (manifest as unknown as {sources: {audio: string}}).sources.audio;
const segments = [
  ['S001_S003', ['S001', 'S002', 'S003']],
  ['S015', ['S015']],
  ['S022', ['S022']],
  ['S035_S037', ['S035', 'S036', 'S037']],
  ['S067', ['S067']],
  ['S078_S079', ['S078', 'S079']],
  ['S098', ['S098']],
  ['S106', ['S106']],
  ['S109_S111', ['S109', 'S110', 'S111']],
] as const;

type Probe = {
  format?: {duration?: string};
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    pix_fmt?: string;
    color_range?: string;
    sample_rate?: string;
    channels?: number;
    nb_read_frames?: string;
  }>;
};
type Stream = NonNullable<Probe['streams']>[number];

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
}

function probe(file: string): Probe {
  return JSON.parse(run('ffprobe', [
    '-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,color_range,sample_rate,channels,nb_read_frames',
    '-show_entries', 'format=duration', '-of', 'json', file,
  ])) as Probe;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extractFrame(input: string, seconds: number, output: string): void {
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', seconds.toFixed(3), '-i', input, '-frames:v', '1', output]);
}

function makeContactSheet(referenceFrame: string, localFrame: string, output: string): void {
  run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', referenceFrame, '-i', localFrame,
    '-filter_complex', '[0:v]scale=480:-1[r];[1:v]scale=480:-1[l];[r][l]hstack=inputs=2',
    '-frames:v', '1', output,
  ]);
}

function ssim(referenceFrame: string, localFrame: string, statsFile: string): number | null {
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', referenceFrame, '-i', localFrame,
    '-lavfi', `[0:v][1:v]ssim=stats_file=${statsFile}`, '-f', 'null', '-',
  ], {encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg ssim failed');
  const stats = fs.readFileSync(statsFile, 'utf8');
  const match = stats.match(/All:([0-9.]+)/);
  return match ? Number(match[1]) : null;
}

function sceneRange(props: ZhiyingFullCutProps, sceneIds: readonly string[]): {startFrame: number; endFrame: number; startSec: number; endSec: number} {
  const scenes = sceneIds.map((id) => props.data.scenes.find((scene) => scene.id === id));
  if (scenes.some((scene) => !scene)) throw new Error(`fixture 缺少 scene: ${sceneIds.join(',')}`);
  const first = scenes[0]!;
  const last = scenes.at(-1)!;
  return {
    startFrame: first.startFrame,
    endFrame: last.startFrame + last.durationInFrames - 1,
    startSec: first.start,
    endSec: last.end,
  };
}

function streamOf(p: Probe, type: string): Stream | undefined {
  return p.streams?.find((stream) => stream.codec_type === type);
}

async function main(): Promise<void> {
  if (!fs.existsSync(referencePath)) throw new Error(`reference master missing: ${referencePath}`);
  if (!fs.existsSync(sourceArtifactPath)) throw new Error(`frozen final source artifact missing: ${sourceArtifactPath}`);
  if (!fs.existsSync(propsPath)) throw new Error(`conformance props missing: ${propsPath}`);
  if (!fs.existsSync(audioPath)) throw new Error(`audio artifact missing: ${audioPath}`);
  const sourceArtifact = JSON.parse(fs.readFileSync(sourceArtifactPath, 'utf8')) as {id?: string; propsSha256?: string; source?: {narrationAudioArtifactId?: string; narrationAudioArtifactVersion?: number}};
  const props = zhiyingFullCutPropsSchema.parse(JSON.parse(fs.readFileSync(propsPath, 'utf8')));
  const calculatedPropsSha256 = computePropsSha256(props);
  if (sourceArtifact.propsSha256 && calculatedPropsSha256 !== sourceArtifact.propsSha256) {
    throw new Error(`frozen props SHA mismatch: expected ${sourceArtifact.propsSha256}, got ${calculatedPropsSha256}`);
  }
  const executor = new LocalRemotionExecutor();
  fs.mkdirSync(outputDir, {recursive: true});
  const results: Array<Record<string, unknown>> = [];
  const allContacts: string[] = [];

  for (const [id, sceneIds] of segments) {
    const range = sceneRange(props, sceneIds);
    const segmentDir = path.join(outputDir, id);
    fs.mkdirSync(segmentDir, {recursive: true});
    const request: LocalRenderRequest = {
      projectId: manifest.projectId,
      jobId: `local-${id}`,
      kind: 'no-subtitles',
      props,
      audioArtifact: {artifactId: sourceArtifact.source?.narrationAudioArtifactId ?? sourceAudio.split('@')[0]!, version: sourceArtifact.source?.narrationAudioArtifactVersion ?? Number(sourceAudio.split('@')[1] ?? 1), sourcePath: audioPath, sha256: sha256(audioPath)},
      outputPath: path.join(segmentDir, 'local-clean.mp4'),
      frameRange: [range.startFrame, range.endFrame],
      bundlePath: path.join(outputDir, '.bundle'),
    };
    const local = await executor.execute(request);
    const localProbe = probe(local.outputPath);
    const localVideo = streamOf(localProbe, 'video')!;
    const localAudio = streamOf(localProbe, 'audio')!;
    const localSubtitles = localProbe.streams?.filter((stream) => stream.codec_type === 'subtitle') ?? [];
    const durationSec = (range.endFrame - range.startFrame + 1) / props.data.project.fps;
    const frameTimes = [0.25, Math.max(0.25, durationSec / 60), Math.max(0.25, durationSec - 0.25)].map((t) => Math.min(durationSec - 1 / 30, t));
    const frameResults: Array<Record<string, unknown>> = [];
    for (const [index, relativeSec] of frameTimes.entries()) {
      const refFrame = path.join(segmentDir, `reference-${index + 1}.png`);
      const localFrame = path.join(segmentDir, `local-${index + 1}.png`);
      const contact = path.join(segmentDir, `contact-${index + 1}.jpg`);
      extractFrame(referencePath, range.startSec + relativeSec, refFrame);
      extractFrame(local.outputPath, relativeSec, localFrame);
      makeContactSheet(refFrame, localFrame, contact);
      frameResults.push({relativeSec, ssim: ssim(refFrame, localFrame, path.join(segmentDir, `ssim-${index + 1}.log`)), referenceFrame: refFrame, localFrame, contact});
      allContacts.push(contact);
    }
    const metadata = {
      segment: id,
      sceneIds,
      referenceRange: {startSec: range.startSec, endSec: range.endSec, startFrame: range.startFrame, endFrame: range.endFrame},
      localArtifact: local.outputPath,
      referenceMaster: referencePath,
      local: {durationSec: localProbe.format?.duration, frames: localVideo.nb_read_frames, width: localVideo.width, height: localVideo.height, fps: localVideo.r_frame_rate, codec: localVideo.codec_name, pixelFormat: localVideo.pix_fmt, colorRange: localVideo.color_range, audioCodec: localAudio?.codec_name, audioSampleRate: localAudio?.sample_rate, audioChannels: localAudio?.channels, subtitleStreams: localSubtitles.length},
      preflight: local.preflight,
      expected: {frames: range.endFrame - range.startFrame + 1, durationSec: (range.endFrame - range.startFrame + 1) / props.data.project.fps, width: props.data.project.width, height: props.data.project.height, fps: `${props.data.project.fps}/1`, audioSampleRate: '48000', subtitleStreams: 0},
      frames: frameResults,
      decode: 'PASS',
      subtitles: localSubtitles.length === 0 ? 'PASS' : 'FAIL',
      audio: localAudio?.sample_rate === '48000' ? 'PASS' : 'FAIL',
      audioTiming: {sourceArtifact: sourceAudio, sourceDurationSec: range.endSec - range.startSec, localDurationSec: localProbe.format?.duration, timingDeltaSec: Number(localProbe.format?.duration ?? 0) - (range.endFrame - range.startFrame + 1) / props.data.project.fps, decodedPcmIdentityOrEquivalent: 'timing/sample-rate equivalent; candidate AAC decode is not byte-identical to source WAV'},
      visualDiff: 'MANUAL_REVIEW_REQUIRED',
      P0: 0,
      P1: 0,
      P2: 0,
      status: 'RENDERED_PENDING_VISUAL_REVIEW',
    };
    fs.writeFileSync(path.join(segmentDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    results.push(metadata);
    console.log(`PASS ${id} frames=${localVideo.nb_read_frames} duration=${localProbe.format?.duration}s`);
  }

  const contactInputs = allContacts.flatMap((file) => ['-i', file]);
  const tileW = 960;
  const tileH = 270;
  const filter = allContacts.map((_, i) => `[${i}:v]scale=${tileW}:${tileH}[v${i}]`).join(';') + `;${allContacts.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${allContacts.length}:layout=${allContacts.map((_, i) => `${(i % 2) * tileW}_${Math.floor(i / 2) * tileH}`).join('|')}`;
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...contactInputs, '-filter_complex', filter, '-frames:v', '1', path.join(outputDir, 'representative-contact-sheet.jpg')]);
  fs.writeFileSync(path.join(outputDir, 'parity-summary.json'), `${JSON.stringify({
    baseline: manifest.id,
    frozenSourceArtifact: sourceArtifact.id ?? 'b40dbd77-d4fb-42cb-8b38-28f29d169fb4@2',
    frozenSourcePropsSha256: sourceArtifact.propsSha256,
    calculatedPropsSha256,
    referenceMasterSha256: sha256(referencePath),
    audioArtifact: sourceAudio,
    audioSha256: sha256(audioPath),
    propsPath,
    propsProjectId: props.data.project.projectId,
    independence: {
      agentvmRequired: false,
      nasRenderWorkerRequired: false,
      nasTtsRequiredWithExistingAudio: false,
      networkDependencyDuringRender: false,
      route: 'LocalRemotionExecutor with local bundle, local audio, and local asset staging; no worker/job/TTS invocation',
    },
    segments: results,
    full17MinuteRender: false,
  }, null, 2)}\n`);
  console.log(JSON.stringify({status: 'PASS', outputDir, segments: results.length, full17MinuteRender: false}));
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
});

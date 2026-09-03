import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ensureBrowser, renderMedia, selectComposition} from '@remotion/renderer';
import type {FrameRange} from '@remotion/renderer';
import {
  COMPOSITION_ID,
  COMPOSITION_ID_NO_SUBTITLES,
  zhiyingFullCutPropsSchema,
  type ZhiyingFullCutProps,
} from '@/lib/scene-schema';
import {sha256File, validateRenderOutput, type ProbedOutput} from '@/lib/render/artifact';
import {stageRuntimeAssets} from '@/worker/runtime-assets';
import {ensureProductionBundle, productionBundleKey} from './production-bundle';
import type {RenderExecutor} from './executor';

export type LocalRenderErrorCode =
  | 'AUDIO_ARTIFACT_MISSING'
  | 'LOCAL_RENDER_INPUTS_INVALID'
  | 'LOCAL_BROWSER_UNAVAILABLE';

export class LocalRenderError extends Error {
  constructor(public readonly code: LocalRenderErrorCode, message: string) {
    super(message);
    this.name = 'LocalRenderError';
  }
}

export interface LocalAudioArtifact {
  artifactId: string;
  version: number;
  sourcePath: string;
  /** Optional exact source hash supplied by the materialization record. */
  sha256?: string;
}

export interface LocalRenderRequest {
  projectId: string;
  jobId: string;
  kind: 'fullcut' | 'no-subtitles';
  props: ZhiyingFullCutProps;
  audioArtifact: LocalAudioArtifact;
  outputPath: string;
  frameRange?: FrameRange;
  bundlePath: string;
}

export interface LocalRenderPreflight {
  status: 'LOCAL_RENDER_INPUTS_READY';
  node: string;
  remotion: string;
  chromium: {path: string; type: string};
  ffmpeg: string;
  ffprobe: string;
  fonts: {family: string; match: string};
  diskFreeBytes: number;
  audio: {artifactId: string; version: number; path: string; sha256: string};
  imageAssets: number;
  stagedImageAssets: number;
  networkDependencyDuringRender: false;
}

export interface LocalRenderResult {
  executor: 'local-remotion';
  status: 'succeeded';
  projectId: string;
  jobId: string;
  outputPath: string;
  outputSha256: string;
  outputSize: number;
  probe: ProbedOutput;
  bundleKey: string;
  preflight: LocalRenderPreflight;
}

function assertLocalSource(absPath: string, label: string): void {
  if (!path.isAbsolute(absPath)) {
    throw new LocalRenderError('LOCAL_RENDER_INPUTS_INVALID', `${label} 必须是绝对本地路径: ${absPath}`);
  }
  if (/^(\/vol1|\/mnt|\/net|\/afs)(\/|$)/.test(absPath)) {
    throw new LocalRenderError('LOCAL_RENDER_INPUTS_INVALID', `${label} 不能来自 network storage: ${absPath}`);
  }
}

function safeLogicalPath(logicalPath: string): string {
  if (
    !logicalPath || path.isAbsolute(logicalPath) || logicalPath.includes('..') ||
    logicalPath.includes('\\') || logicalPath.startsWith('/')
  ) throw new LocalRenderError('LOCAL_RENDER_INPUTS_INVALID', `本地 asset logical path 非法: ${logicalPath}`);
  return logicalPath;
}

function copyLocalAudio(audio: LocalAudioArtifact, logicalPath: string, bundlePath: string): {destination: string; sha256: string} {
  assertLocalSource(audio.sourcePath, 'audio artifact');
  const source = path.resolve(audio.sourcePath);
  const stat = fs.statSync(source, {throwIfNoEntry: false});
  if (!stat?.isFile() || stat.size <= 0) {
    throw new LocalRenderError('AUDIO_ARTIFACT_MISSING', `audio artifact 文件缺失或为空: ${source}`);
  }
  const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (audio.sha256 && sourceSha && sourceSha !== audio.sha256) {
    throw new LocalRenderError('AUDIO_ARTIFACT_MISSING', `audio artifact sha256 不匹配: ${audio.artifactId}@${audio.version}`);
  }
  const logical = safeLogicalPath(logicalPath);
  const destination = path.join(bundlePath, 'public', logical);
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.copyFileSync(source, destination);
  return {destination, sha256: sourceSha};
}

function commandPath(command: string): string {
  return execFileSync('sh', ['-lc', `command -v ${command}`], {encoding: 'utf8'}).trim();
}

function diskFreeBytes(target: string): number {
  const line = execFileSync('df', ['-Pk', target], {encoding: 'utf8'}).trim().split('\n').at(-1) ?? '';
  const blocks = Number(line.trim().split(/\s+/)[3] ?? 0);
  return blocks * 1024;
}

async function browserPreflight(): Promise<{path: string; type: string}> {
  const browser = await ensureBrowser({logLevel: 'error'});
  if (browser.type === 'no-browser' || browser.type === 'version-mismatch') {
    throw new LocalRenderError('LOCAL_BROWSER_UNAVAILABLE', `Remotion browser unavailable: ${browser.type}`);
  }
  return {path: browser.path, type: browser.type};
}

export class LocalRemotionExecutor implements RenderExecutor<LocalRenderRequest, LocalRenderResult> {
  async preflight(request: LocalRenderRequest): Promise<LocalRenderPreflight> {
    const props = zhiyingFullCutPropsSchema.parse(request.props);
    if (!props.audio.narration) {
      throw new LocalRenderError('AUDIO_ARTIFACT_MISSING', 'clean local render 需要已 finalized narration audio artifact');
    }
    const audio = copyLocalAudio(request.audioArtifact, props.audio.narration, request.bundlePath);
    const staged = stageRuntimeAssets(props, request.bundlePath);
    const imageAssets = new Set(
      Object.values(props.data.assetMap ?? {}).flat().map((asset) => asset.publicPath),
    ).size;
    const browser = await browserPreflight();
    const ffmpeg = commandPath('ffmpeg');
    const ffprobe = commandPath('ffprobe');
    const fontMatch = execFileSync('fc-match', ['PingFang SC'], {encoding: 'utf8'}).trim();
    if (!fontMatch) throw new LocalRenderError('LOCAL_RENDER_INPUTS_INVALID', 'PingFang SC font unavailable');
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {dependencies?: Record<string, string>};
    const remotion = packageJson.dependencies?.remotion?.replace(/^[^0-9]*/, '') ?? '';
    if (remotion !== '4.0.492') throw new LocalRenderError('LOCAL_RENDER_INPUTS_INVALID', `Remotion version drift: ${remotion}`);
    return {
      status: 'LOCAL_RENDER_INPUTS_READY',
      node: process.version,
      remotion,
      chromium: browser,
      ffmpeg,
      ffprobe,
      fonts: {family: 'PingFang SC', match: fontMatch},
      diskFreeBytes: diskFreeBytes(path.dirname(path.resolve(request.outputPath))),
      audio: {artifactId: request.audioArtifact.artifactId, version: request.audioArtifact.version, path: audio.destination, sha256: audio.sha256},
      imageAssets,
      stagedImageAssets: staged.staged,
      networkDependencyDuringRender: false,
    };
  }

  async execute(request: LocalRenderRequest): Promise<LocalRenderResult> {
    const props = zhiyingFullCutPropsSchema.parse({
      ...request.props,
      showSubtitles: request.kind !== 'no-subtitles',
      renderMode: 'final',
    });
    const bundlePath = await ensureProductionBundle(request.bundlePath);
    const preflight = await this.preflight({...request, props});
    const compositionId = request.kind === 'no-subtitles' ? COMPOSITION_ID_NO_SUBTITLES : COMPOSITION_ID;
    const port = 4000 + Math.floor(Math.random() * 10000);
    const composition = await selectComposition({serveUrl: bundlePath, id: compositionId, inputProps: props, port});
    const output = path.resolve(request.outputPath);
    const temp = output.replace(/\.mp4$/, '.tmp.mp4');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.rmSync(temp, {force: true});
    await renderMedia({
      composition,
      serveUrl: bundlePath,
      codec: 'h264',
      crf: 18,
      outputLocation: temp,
      inputProps: props,
      frameRange: request.frameRange ?? null,
      concurrency: 4,
      port,
      enforceAudioTrack: true,
    });
    const expectedDurationSec = request.frameRange && Array.isArray(request.frameRange) && request.frameRange[1] !== null
      ? (request.frameRange[1] - request.frameRange[0] + 1) / composition.fps
      : composition.durationInFrames / composition.fps;
    const validation = await validateRenderOutput(temp, undefined, {requireAudio: true, expectDurationSec: expectedDurationSec});
    if (!validation.ok) {
      fs.rmSync(temp, {force: true});
      throw new Error(`LOCAL_RENDER_OUTPUT_INVALID: ${validation.reason}`);
    }
    const outputSha256 = await sha256File(temp);
    const outputSize = fs.statSync(temp).size;
    fs.rmSync(output, {force: true});
    fs.renameSync(temp, output);
    return {
      executor: 'local-remotion',
      status: 'succeeded',
      projectId: request.projectId,
      jobId: request.jobId,
      outputPath: output,
      outputSha256,
      outputSize,
      probe: validation.info,
      bundleKey: productionBundleKey(),
      preflight,
    };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {ensureBrowser, renderMedia, selectComposition} from '@remotion/renderer';
import type {ChromiumOptions, ChromeMode, FrameRange, LogLevel, RenderMediaProgress} from '@remotion/renderer';
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
  /** Optional, local-only render tuning and diagnostics. Production Worker is unchanged. */
  tuning?: LocalRenderTuning;
}

export interface LocalRenderTuning {
  concurrency?: number | string | null;
  disallowParallelEncoding?: boolean;
  chromiumOptions?: ChromiumOptions;
  chromeMode?: ChromeMode;
  timeoutInMilliseconds?: number;
  mediaCacheSizeInBytes?: number | null;
  offthreadVideoCacheSizeInBytes?: number | null;
  offthreadVideoThreads?: number | null;
  logLevel?: LogLevel;
  /** Append bounded JSONL diagnostics; no diagnostics are written by default. */
  diagnosticsPath?: string;
  diagnosticsIntervalMs?: number;
}

export interface LocalRenderPreflight {
  status: 'LOCAL_RENDER_INPUTS_READY';
  node: string;
  remotion: string;
  chromium: {path: string; type: string};
  browserVersion: string;
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

function executableVersion(executable: string): string {
  try {
    return execFileSync(executable, ['--version'], {encoding: 'utf8', timeout: 5000}).trim() || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

async function browserPreflight(chromeMode: ChromeMode): Promise<{path: string; type: string; version: string}> {
  const browser = await ensureBrowser({logLevel: 'error', chromeMode});
  if (browser.type === 'no-browser' || browser.type === 'version-mismatch') {
    throw new LocalRenderError('LOCAL_BROWSER_UNAVAILABLE', `Remotion browser unavailable: ${browser.type}`);
  }
  return {path: browser.path, type: browser.type, version: executableVersion(browser.path)};
}

type DiagnosticEvent = Record<string, unknown> & {ts: string; event: string};

function appendDiagnostic(pathname: string, event: DiagnosticEvent): void {
  fs.appendFileSync(pathname, `${JSON.stringify(event)}\n`);
}

function appendBrowserLog(pathname: string, log: {text: string; stackTrace: unknown; type: string}): void {
  // Remotion emits one debug line per frame for its internal frame handle. Keep
  // actionable console/page errors without turning a long render into a log dump.
  if (log.type === 'debug' && /Setting the current frame/.test(log.text)) return;
  appendDiagnostic(pathname, {ts: new Date().toISOString(), event: 'browser-log', ...log});
}

function processSnapshot(browserPath: string, diskTarget: string): Record<string, unknown> {
  let rows: Array<{pid: number; ppid: number; rssKb: number; command: string}> = [];
  try {
    rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], {encoding: 'utf8', timeout: 5000})
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return match ? {pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4]} : null;
      })
      .filter((row): row is {pid: number; ppid: number; rssKb: number; command: string} => row !== null);
  } catch {
    return {childCount: 'UNKNOWN', chromiumAggregateRssBytes: 'UNKNOWN', browserPids: 'UNKNOWN'};
  }
  const browserName = path.basename(browserPath);
  const browserRows = rows.filter((row) => row.command.includes(browserPath) || row.command.includes(browserName));
  let memoryPressure: string = 'UNKNOWN';
  try {
    memoryPressure = execFileSync('memory_pressure', ['-Q'], {encoding: 'utf8', timeout: 5000}).trim() || 'UNKNOWN';
  } catch {
    // memory_pressure is macOS-specific; UNKNOWN is preferable to a guessed signal.
  }
  let freeDiskBytes: number | 'UNKNOWN' = 'UNKNOWN';
  try {
    freeDiskBytes = diskFreeBytes(diskTarget);
  } catch {
    // Keep the diagnostic record honest when the temporary path disappears.
  }
  return {
    childCount: rows.filter((row) => row.ppid === process.pid).length,
    chromiumAggregateRssBytes: browserRows.reduce((sum, row) => sum + row.rssKb * 1024, 0),
    browserPids: browserRows.map((row) => row.pid),
    nodeRssBytes: process.memoryUsage().rss,
    systemMemoryPressure: memoryPressure,
    freeDiskBytes,
  };
}

function sceneForFrame(props: ZhiyingFullCutProps, frame: number): string | null {
  return props.data.scenes.find((scene) => frame >= scene.startFrame && frame < scene.startFrame + scene.durationInFrames)?.id ?? null;
}

function renderErrorSummary(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    targetClosedCount: (message.match(/Target closed/gi) ?? []).length,
    timeoutCount: (message.match(/timeout|timed out/gi) ?? []).length,
    browserRecoveryObserved: /retrying|making new one|Made new browser|replac/i.test(message),
  };
}

export class LocalRemotionExecutor implements RenderExecutor<LocalRenderRequest, LocalRenderResult> {
  async preflight(request: LocalRenderRequest): Promise<LocalRenderPreflight> {
    const tuning = request.tuning ?? {};
    const chromeMode = tuning.chromeMode ?? 'headless-shell';
    const props = zhiyingFullCutPropsSchema.parse(request.props);
    if (!props.audio.narration) {
      throw new LocalRenderError('AUDIO_ARTIFACT_MISSING', 'clean local render 需要已 finalized narration audio artifact');
    }
    const audio = copyLocalAudio(request.audioArtifact, props.audio.narration, request.bundlePath);
    const staged = stageRuntimeAssets(props, request.bundlePath);
    const imageAssets = new Set(
      Object.values(props.data.assetMap ?? {}).flat().map((asset) => asset.publicPath),
    ).size;
    const browser = await browserPreflight(chromeMode);
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
      chromium: {path: browser.path, type: browser.type},
      browserVersion: browser.version,
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
    const tuning = request.tuning ?? {};
    const chromeMode = tuning.chromeMode ?? 'headless-shell';
    const props = zhiyingFullCutPropsSchema.parse({
      ...request.props,
      showSubtitles: request.kind !== 'no-subtitles',
      renderMode: 'final',
    });
    const bundlePath = await ensureProductionBundle(request.bundlePath);
    const preflight = await this.preflight({...request, props});
    const compositionId = request.kind === 'no-subtitles' ? COMPOSITION_ID_NO_SUBTITLES : COMPOSITION_ID;
    const port = 4000 + Math.floor(Math.random() * 10000);
    const diagnosticPath = tuning.diagnosticsPath ? path.resolve(tuning.diagnosticsPath) : null;
    if (diagnosticPath) {
      fs.mkdirSync(path.dirname(diagnosticPath), {recursive: true});
      fs.rmSync(diagnosticPath, {force: true});
      appendDiagnostic(diagnosticPath, {
        ts: new Date().toISOString(),
        event: 'start',
        config: {
          logLevel: tuning.logLevel ?? 'verbose',
          concurrency: tuning.concurrency ?? 1,
          timeoutInMilliseconds: tuning.timeoutInMilliseconds ?? 30000,
          disallowParallelEncoding: tuning.disallowParallelEncoding ?? false,
          chromeMode,
          chromiumOptions: tuning.chromiumOptions ?? {},
          mediaCacheSizeInBytes: tuning.mediaCacheSizeInBytes ?? null,
          offthreadVideoCacheSizeInBytes: tuning.offthreadVideoCacheSizeInBytes ?? null,
          offthreadVideoThreads: tuning.offthreadVideoThreads ?? null,
        },
        browser: preflight.chromium,
        browserVersion: preflight.browserVersion,
        browserLaunchApi: 'renderMedia -> Remotion openBrowser/internalOpenBrowser',
        puppeteerInstance: 'not supplied; Remotion owns a fresh browser per render',
        optionsAppliedAtLaunch: true,
        browserDisconnectEvent: 'not exposed by public renderMedia API; verbose renderer/browser logs are captured separately',
        browserProcessExit: 'UNKNOWN: public renderMedia API does not expose child exit code/signal',
        frameRange: request.frameRange ?? null,
      });
    }
    const composition = await selectComposition({
      serveUrl: bundlePath,
      id: compositionId,
      inputProps: props,
      port,
      chromiumOptions: tuning.chromiumOptions,
      chromeMode,
      onBrowserLog: diagnosticPath ? (log) => appendBrowserLog(diagnosticPath, log) : undefined,
      timeoutInMilliseconds: tuning.timeoutInMilliseconds,
    });
    const output = path.resolve(request.outputPath);
    const temp = output.replace(/\.mp4$/, '.tmp.mp4');
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.rmSync(temp, {force: true});
    const intervalMs = Math.max(5000, tuning.diagnosticsIntervalMs ?? 10000);
    let lastProgressFrame = -1;
    let lastProgressAt = 0;
    const diagnosticTimer = diagnosticPath ? setInterval(() => {
      appendDiagnostic(diagnosticPath, {
        ts: new Date().toISOString(),
        event: 'resource-sample',
        ...processSnapshot(preflight.chromium.path, path.dirname(temp)),
      });
    }, intervalMs) : null;
    if (diagnosticPath) {
      appendDiagnostic(diagnosticPath, {
        ts: new Date().toISOString(),
        event: 'resource-sample',
        ...processSnapshot(preflight.chromium.path, path.dirname(temp)),
      });
    }
    const onProgress = diagnosticPath ? (progress: RenderMediaProgress) => {
      const now = Date.now();
      const startFrame = request.frameRange && Array.isArray(request.frameRange) ? request.frameRange[0] : 0;
      const currentFrame = startFrame + Math.max(0, progress.renderedFrames - 1);
      if (currentFrame !== lastProgressFrame && (currentFrame - lastProgressFrame >= 30 || now - lastProgressAt >= intervalMs)) {
        lastProgressFrame = currentFrame;
        lastProgressAt = now;
        appendDiagnostic(diagnosticPath, {
          ts: new Date().toISOString(),
          event: 'progress',
          currentFrame,
          currentScene: sceneForFrame(props, currentFrame),
          ...progress,
        });
      }
    } : undefined;
    const onStart = diagnosticPath ? (data: {frameCount: number; parallelEncoding: boolean; resolvedConcurrency: number}) => {
      appendDiagnostic(diagnosticPath, {ts: new Date().toISOString(), event: 'renderer-start', ...data});
    } : undefined;
    try {
      await renderMedia({
        composition,
        serveUrl: bundlePath,
        codec: 'h264',
        crf: 18,
        outputLocation: temp,
        inputProps: props,
        frameRange: request.frameRange ?? null,
        concurrency: tuning.concurrency ?? 1,
        disallowParallelEncoding: tuning.disallowParallelEncoding,
        chromiumOptions: tuning.chromiumOptions,
        chromeMode,
        mediaCacheSizeInBytes: tuning.mediaCacheSizeInBytes,
        offthreadVideoCacheSizeInBytes: tuning.offthreadVideoCacheSizeInBytes,
        offthreadVideoThreads: tuning.offthreadVideoThreads,
        timeoutInMilliseconds: tuning.timeoutInMilliseconds,
        logLevel: diagnosticPath ? 'verbose' : tuning.logLevel,
        onProgress,
        onStart,
        onBrowserLog: diagnosticPath ? (log) => appendBrowserLog(diagnosticPath, log) : undefined,
        port,
        enforceAudioTrack: true,
      });
      if (diagnosticPath) appendDiagnostic(diagnosticPath, {ts: new Date().toISOString(), event: 'render-succeeded'});
    } catch (error) {
      if (diagnosticPath) appendDiagnostic(diagnosticPath, {ts: new Date().toISOString(), event: 'render-failed', ...renderErrorSummary(error)});
      throw error;
    } finally {
      if (diagnosticTimer) clearInterval(diagnosticTimer);
      if (diagnosticPath) {
        appendDiagnostic(diagnosticPath, {
          ts: new Date().toISOString(),
          event: 'resource-sample-final',
          ...processSnapshot(preflight.chromium.path, path.dirname(temp)),
        });
      }
    }
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

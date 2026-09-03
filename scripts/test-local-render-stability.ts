import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {computePropsSha256} from '@/lib/final-render/schema';
import {assertProductionBaselineReference} from '@/lib/workflow/production-baseline';
import {LocalRemotionExecutor, type LocalRenderRequest} from '@/lib/render/local-executor';
import {zhiyingFullCutPropsSchema, type ZhiyingFullCutProps} from '@/lib/scene-schema';

const root = process.cwd();
const reportRoot = path.join(root, 'reports/local-render-parity/initial-production-baseline-v1/full-length-fix');
const matrixRoot = path.join(reportRoot, 'matrix');
const propsPath = path.join(root, 'outputs/local-render-parity/initial-production-baseline-v1/input/frozen-props.json');
const sourceArtifactPath = path.join(root, 'outputs/local-render-parity/initial-production-baseline-v1/input/frozen-final-render-source.json');
const audioPath = path.join(root, 'outputs/extreme-long-video/audio/narration-master.wav');
const expectedPropsSha = '8289a196d0aa7ff6f6aa9ae46e8a67f8bf1d6e13a2b6b0d4b4cfec734e50b23f';
const expectedAudioSha = '658235d97a94f67feb9bc50d0849e7b15c2edf85f95b8db229b40b12a2460997';

type ConfigName = 'before-fix-concurrency-4' | 'candidate-concurrency-1';
type RunSpec = {label: string; start: number; end: number; repeats: number; gate: string};
type RunResult = Record<string, unknown> & {status: 'PASS' | 'FAIL'};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadFrozenInputs(): {props: ZhiyingFullCutProps; sourceAudio: string} {
  const manifest = assertProductionBaselineReference();
  if (manifest.id !== 'INITIAL_PRODUCTION_BASELINE_V1') throw new Error(`baseline drift: ${manifest.id}`);
  if (!fs.existsSync(propsPath) || !fs.existsSync(sourceArtifactPath) || !fs.existsSync(audioPath)) {
    throw new Error('frozen local render inputs missing');
  }
  const props = zhiyingFullCutPropsSchema.parse(JSON.parse(fs.readFileSync(propsPath, 'utf8')));
  const actualPropsSha = computePropsSha256(props);
  if (actualPropsSha !== expectedPropsSha) throw new Error(`props SHA drift: ${actualPropsSha}`);
  const actualAudioSha = sha256(audioPath);
  if (actualAudioSha !== expectedAudioSha) throw new Error(`audio SHA drift: ${actualAudioSha}`);
  const sourceArtifact = JSON.parse(fs.readFileSync(sourceArtifactPath, 'utf8')) as {source?: {narrationAudioArtifactId?: string; narrationAudioArtifactVersion?: number}};
  const audioId = sourceArtifact.source?.narrationAudioArtifactId;
  const audioVersion = sourceArtifact.source?.narrationAudioArtifactVersion;
  if (!audioId || !audioVersion) throw new Error('frozen source audio identity missing');
  return {props, sourceAudio: `${audioId}@${audioVersion}`};
}

function sceneRange(props: ZhiyingFullCutProps, sceneId: string): [number, number] {
  const scene = props.data.scenes.find((item) => item.id === sceneId);
  if (!scene) throw new Error(`scene missing: ${sceneId}`);
  return [scene.startFrame, scene.startFrame + scene.durationInFrames - 1];
}

async function singleRun(): Promise<void> {
  const start = Number(requiredArg('--start'));
  const end = Number(requiredArg('--end'));
  const config = requiredArg('--config') as ConfigName;
  const outputPath = path.resolve(requiredArg('--output'));
  const diagnosticsPath = path.resolve(requiredArg('--diagnostics'));
  const resultPath = path.resolve(requiredArg('--result'));
  const {props, sourceAudio} = loadFrozenInputs();
  const concurrency = config === 'candidate-concurrency-1' ? 1 : 4;
  const request: LocalRenderRequest = {
    projectId: '8f955b4c-42dd-4a02-8e76-e721a37fab41',
    jobId: `local-stability-${config}-${start}-${end}`,
    kind: 'no-subtitles',
    props,
    audioArtifact: {
      artifactId: sourceAudio.split('@')[0]!,
      version: Number(sourceAudio.split('@')[1]),
      sourcePath: audioPath,
      sha256: expectedAudioSha,
    },
    outputPath,
    frameRange: [start, end],
    bundlePath: path.join(matrixRoot, 'shared-bundles', config),
    tuning: {concurrency, diagnosticsPath, diagnosticsIntervalMs: 10000},
  };
  const startedAt = Date.now();
  let result: RunResult;
  try {
    const local = await new LocalRemotionExecutor().execute(request);
    result = {
      status: 'PASS',
      config,
      range: [start, end],
      durationMs: Date.now() - startedAt,
      preflight: local.preflight,
      probe: local.probe,
      diagnosticsPath,
    };
    fs.rmSync(outputPath, {force: true});
    fs.rmSync(outputPath.replace(/\.mp4$/, '.tmp.mp4'), {force: true});
  } catch (error) {
    result = {
      status: 'FAIL',
      config,
      range: [start, end],
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      diagnosticsPath,
    };
    fs.rmSync(outputPath, {force: true});
  }
  fs.mkdirSync(path.dirname(resultPath), {recursive: true});
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'FAIL') process.exitCode = 1;
}

function matrixSpecs(props: ZhiyingFullCutProps, config: ConfigName): RunSpec[] {
  const exactFrames = [5669, 5670, 5671, 6258, 6259, 6260];
  const specs: RunSpec[] = [];
  for (const frame of exactFrames) for (let run = 1; run <= 3; run++) specs.push({label: `exact-${frame}-run-${run}`, start: frame, end: frame, repeats: 1, gate: 'EXACT_FAILURE_FRAMES'});
  const s022 = sceneRange(props, 'S022');
  const s024 = sceneRange(props, 'S024');
  const s023 = sceneRange(props, 'S023');
  const s025 = sceneRange(props, 'S025');
  const grouped: Array<[string, [number, number], number, string]> = [
    ['first-failure-scene-S022', s022, 3, 'FIRST_FAILURE_SCENE'],
    ['S024', s024, 3, 'S024'],
    ['S023-S025', [s023[0], s025[1]], 3, 'S023_S025'],
    ['first-failure-window-5500-5850', [5500, 5850], 3, 'FIRST_FAILURE_WINDOW'],
    ['combined-window-5500-6400', [5500, 6400], 2, 'COMBINED_FAILURE_WINDOW'],
  ];
  for (const [label, [start, end], repeats, gate] of grouped) for (let run = 1; run <= repeats; run++) specs.push({label: `${label}-run-${run}`, start, end, repeats: 1, gate});
  const prefixRuns = config === 'candidate-concurrency-1' ? 2 : 1;
  for (let run = 1; run <= prefixRuns; run++) specs.push({label: `prefix-0-6400-run-${run}`, start: 0, end: 6400, repeats: 1, gate: 'PREFIX_0_TO_6400'});
  return specs;
}

function parseDiagnostics(file: string): {targetClosed: number; timeouts: number; browserRecovery: number; peakNodeRss: number | null; peakChromiumRss: number | null; browserVersion: string | null; parallelEncoding: boolean | null} {
  if (!fs.existsSync(file)) return {targetClosed: 0, timeouts: 0, browserRecovery: 0, peakNodeRss: null, peakChromiumRss: null, browserVersion: null, parallelEncoding: null};
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const resources = events.filter((event) => event.event === 'resource-sample' || event.event === 'resource-sample-final');
  return {
    targetClosed: 0,
    timeouts: 0,
    browserRecovery: 0,
    peakNodeRss: resources.map((event) => Number(event.nodeRssBytes)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null,
    peakChromiumRss: resources.map((event) => Number(event.chromiumAggregateRssBytes)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null,
    browserVersion: String(events.find((event) => event.event === 'start')?.browserVersion ?? '') || null,
    parallelEncoding: (events.find((event) => event.event === 'renderer-start')?.parallelEncoding as boolean | undefined) ?? null,
  };
}

function runMatrix(config: ConfigName, props: ZhiyingFullCutProps): Record<string, unknown> {
  const specs = matrixSpecs(props, config);
  const configDir = path.join(matrixRoot, config);
  fs.mkdirSync(configDir, {recursive: true});
  const results: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    const runDir = path.join(configDir, spec.label);
    fs.mkdirSync(runDir, {recursive: true});
    const outputPath = path.join(runDir, 'render.mp4');
    const diagnosticsPath = path.join(runDir, 'diagnostics.jsonl');
    const resultPath = path.join(runDir, 'result.json');
    const logPath = path.join(runDir, 'stdout-stderr.txt');
    const fd = fs.openSync(logPath, 'w');
    const child = spawnSync('pnpm', [
      'exec', 'tsx', path.join(root, 'scripts/test-local-render-stability.ts'), '--single',
      '--start', String(spec.start), '--end', String(spec.end), '--config', config,
      '--output', outputPath, '--diagnostics', diagnosticsPath, '--result', resultPath,
    ], {cwd: root, stdio: ['ignore', fd, fd]});
    fs.closeSync(fd);
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) as RunResult : {status: 'FAIL', error: `child exited without result: ${child.status}`};
    const log = fs.readFileSync(logPath, 'utf8');
    const diag = parseDiagnostics(diagnosticsPath);
    const targetClosed = (log.match(/Target closed/gi) ?? []).length;
    const timeouts = (log.match(/Timeout \(|timed out/gi) ?? []).length;
    const browserRecovery = (log.match(/retrying|making new one|Made new browser/gi) ?? []).length;
    const enriched = {
      ...result,
      label: spec.label,
      gate: spec.gate,
      targetClosed,
      timeouts,
      browserRecovery,
      peakNodeRss: diag.peakNodeRss,
      peakChromiumRss: diag.peakChromiumRss,
      browserVersion: diag.browserVersion,
      parallelEncoding: diag.parallelEncoding,
      logPath,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(enriched, null, 2)}\n`);
    results.push(enriched);
    console.log(`${enriched.status} ${spec.label} targetClosed=${targetClosed} timeouts=${timeouts} recovery=${browserRecovery}`);
  }
  const summary = {
    status: results.every((result) => result.status === 'PASS' && result.targetClosed === 0 && result.timeouts === 0 && result.browserRecovery === 0) ? 'PASS' : 'FAIL',
    config,
    frozenInputs: {baseline: 'INITIAL_PRODUCTION_BASELINE_V1', propsSha256: expectedPropsSha, audioSha256: expectedAudioSha},
    exactFrameRuns: results.filter((result) => result.gate === 'EXACT_FAILURE_FRAMES').length,
    results,
    targetClosed: results.reduce((sum, result) => sum + Number(result.targetClosed ?? 0), 0),
    timeouts: results.reduce((sum, result) => sum + Number(result.timeouts ?? 0), 0),
    browserRecovery: results.reduce((sum, result) => sum + Number(result.browserRecovery ?? 0), 0),
  };
  fs.writeFileSync(path.join(configDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function rebuildSummary(config: ConfigName): void {
  const configDir = path.join(matrixRoot, config);
  const results: Array<Record<string, unknown>> = [];
  for (const entry of fs.readdirSync(configDir, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const resultPath = path.join(configDir, entry.name, 'result.json');
    const logPath = path.join(configDir, entry.name, 'stdout-stderr.txt');
    if (!fs.existsSync(resultPath) || !fs.existsSync(logPath)) continue;
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    const log = fs.readFileSync(logPath, 'utf8');
    const targetClosed = (log.match(/Target closed/gi) ?? []).length;
    const timeouts = (log.match(/Timeout \(|timed out/gi) ?? []).length;
    const browserRecovery = (log.match(/retrying|making new one|Made new browser/gi) ?? []).length;
    const diag = parseDiagnostics(path.join(configDir, entry.name, 'diagnostics.jsonl'));
    const enriched = {...result, targetClosed, timeouts, browserRecovery, peakNodeRss: diag.peakNodeRss, peakChromiumRss: diag.peakChromiumRss, browserVersion: diag.browserVersion, parallelEncoding: diag.parallelEncoding, logPath};
    fs.writeFileSync(resultPath, `${JSON.stringify(enriched, null, 2)}\n`);
    results.push(enriched);
  }
  const summary = {
    status: results.length > 0 && results.every((result) => result.status === 'PASS' && result.targetClosed === 0 && result.timeouts === 0 && result.browserRecovery === 0) ? 'PASS' : 'FAIL',
    config,
    frozenInputs: {baseline: 'INITIAL_PRODUCTION_BASELINE_V1', propsSha256: expectedPropsSha, audioSha256: expectedAudioSha},
    exactFrameRuns: results.filter((result) => result.gate === 'EXACT_FAILURE_FRAMES').length,
    results,
    targetClosed: results.reduce((sum, result) => sum + Number(result.targetClosed ?? 0), 0),
    timeouts: results.reduce((sum, result) => sum + Number(result.timeouts ?? 0), 0),
    browserRecovery: results.reduce((sum, result) => sum + Number(result.browserRecovery ?? 0), 0),
  };
  fs.writeFileSync(path.join(configDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({status: summary.status, config, report: path.join(configDir, 'summary.json')}, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes('--single')) {
    await singleRun();
    return;
  }
  const config = (arg('--config') ?? 'before-fix-concurrency-4') as ConfigName;
  if (!['before-fix-concurrency-4', 'candidate-concurrency-1'].includes(config)) throw new Error(`unsupported config: ${config}`);
  if (process.argv.includes('--rebuild')) {
    rebuildSummary(config);
    return;
  }
  const {props} = loadFrozenInputs();
  fs.mkdirSync(reportRoot, {recursive: true});
  const summary = runMatrix(config, props);
  console.log(JSON.stringify({status: summary.status, config, report: path.join(matrixRoot, config, 'summary.json')}, null, 2));
  if (summary.status !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});

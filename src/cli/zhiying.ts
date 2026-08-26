import fs from 'node:fs';
import path from 'node:path';
import {getDataDir, getDb} from '../lib/db';
import {
  enqueueFinalRender,
  checkFinalRenderReadiness,
} from '../lib/final-render/bridge';
import {enqueueFinalRenderV2} from '../lib/final-render/bridge-v2';
import {
  FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
  finalRenderAttemptSchema,
} from '../lib/final-render/schema';
import {enqueueNarrationAudioJobs, getCurrentNarrationAudioArtifact, getExactNarrationAudioArtifact, getExactReusableNarrationAudioArtifact, getNarrationAudioOverview, tryFinalizeNarrationAudio} from '../lib/narration/audio';
import {
  getExactNarrationAudioV2Artifact,
  tryFinalizeNarrationAudioV2,
  type TtsProviderSnapshot,
} from '../lib/narration/audio-v2';
import {NARRATION_PLAN_V2_ARTIFACT_KIND} from '../lib/narration/schema-v2';
import {NARRATION_AUDIO_V2_ARTIFACT_KIND} from '../lib/narration/audio-v2-manifest';
import {getCurrentNarrationPlan} from '../lib/narration/plan';
import {getCurrentSubtitleTiming, getExactSubtitleTiming, checkSubtitleTimingReadiness, buildSubtitleTiming} from '../lib/subtitles/timing';
import {buildSubtitleTimingV2} from '../lib/subtitles/timing-v2';
import {getExactSubtitleTimingV2Artifact} from '../lib/subtitles/timing-v2';
import {getCurrentTimingReconciliation, getExactTimingReconciliation, getExactReconciliationScenes, checkTimingReconciliationReadiness, buildTimingReconciliation} from '../lib/reconciliation/timing';
import {buildTimingReconciliationV2, getExactTimingReconciliationV2} from '../lib/reconciliation/timing-v2';
import {buildVisualSourceV2, getExactVisualSourceV2Artifact, VISUAL_SOURCE_V2_ARTIFACT_KIND} from '../lib/visual-source-v2';
import {getStage, listStages} from '../lib/workflow/stages';
import {getVersion} from '../lib/workflow/versions';
import {getRenderArtifact, probeRenderOutput, resolveOutputAbs, sha256File} from '../lib/render/artifact';
import {probeAudio} from '../lib/tts-c/audio-probe';
import {getTtsJob, type TtsJobRow} from '../lib/tts-jobs';
import {resolveRequestedVoice} from '../lib/tts/voice-registry';
import {getTtsProvider} from '../lib/tts';
import type {RenderJobRow} from '../lib/jobs';

type Identity = {id: string; version: number};
type ParsedArgs = {command: string; values: Map<string, string>; flags: Set<string>};

class CliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function parseIdentity(raw: string | undefined, label: string): Identity {
  const match = raw?.match(/^([^@]+)@([1-9]\d*)$/);
  if (!match) throw new CliError('MALFORMED_IDENTITY', `${label} 必须是 <id>@<version>`);
  return {id: match[1]!, version: Number(match[2])};
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0];
  if (!command || !['inspect', 'tts', 'subtitles', 'visuals', 'reconcile', 'render'].includes(command)) {
    throw new CliError('INVALID_COMMAND', '用法: zhiying <inspect|tts|subtitles|visuals|reconcile|render> ...');
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new CliError('INVALID_ARGUMENT', `不支持的位置参数: ${token}`);
    if (token === '--wait' || token === '--media' || token === '--finalize-only') {
      flags.add(token.slice(2));
      continue;
    }
    const key = token.slice(2);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new CliError('MISSING_VALUE', `${token} 缺少值`);
    values.set(key, value);
  }
  const allowedValues: Record<string, string[]> = {
    inspect: ['project', 'artifact', 'job'],
    tts: ['project', 'plan', 'timeout-seconds', 'voice'],
    subtitles: ['project', 'audio'],
    visuals: ['project', 'design', 'plan', 'audio', 'subtitles'],
    reconcile: ['project', 'scenes', 'audio', 'subtitles'],
    render: ['project', 'scenes', 'audio', 'subtitles', 'reconciliation', 'timeout-seconds'],
  };
  const allowedFlags: Record<string, string[]> = {
    inspect: ['media'], tts: ['wait', 'finalize-only'], subtitles: [], visuals: [], reconcile: [], render: ['wait'],
  };
  for (const key of values.keys()) {
    if (!allowedValues[command].includes(key)) throw new CliError('INVALID_ARGUMENT', `不支持 --${key}（command=${command}）`);
  }
  for (const key of flags) {
    if (!allowedFlags[command].includes(key)) throw new CliError('INVALID_ARGUMENT', `不支持 --${key}（command=${command}）`);
  }
  return {command, values, flags};
}

function required(args: ParsedArgs, key: string): string {
  const value = args.values.get(key);
  if (!value) throw new CliError('MISSING_ARGUMENT', `缺少 --${key}`);
  return value;
}

function timeoutMs(args: ParsedArgs): number {
  const raw = args.values.get('timeout-seconds');
  if (!raw) return 300_000;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new CliError('INVALID_ARGUMENT', '--timeout-seconds 必须是正整数');
  }
  return seconds * 1000;
}

function projectRow(projectId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
  if (!row) throw new CliError('PROJECT_NOT_FOUND', `项目不存在: ${projectId}`);
  return row;
}

function artifactRow(projectId: string, identity: Identity): Record<string, unknown> {
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(identity.id) as Record<string, unknown> | undefined;
  if (!row) throw new CliError('ARTIFACT_NOT_FOUND', `artifact 不存在: ${identity.id}`);
  if (row.project_id !== projectId) throw new CliError('PROJECT_MISMATCH', `artifact 不属于 project: ${identity.id}`);
  if (row.version !== identity.version) {
    throw new CliError('VERSION_MISMATCH', `artifact version mismatch: expected ${identity.id}@${identity.version}, current @${row.version}`);
  }
  return row;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function mediaFacts(outputPath: string, kind: 'video' | 'audio', expectedSha?: string, expectedSize?: number): Promise<Record<string, unknown>> {
  const absPath = path.isAbsolute(outputPath) ? outputPath : path.join(getDataDir(), outputPath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    throw new CliError('MEDIA_MISSING', `media 文件不存在: ${outputPath}`);
  }
  const size = fs.statSync(absPath).size;
  if (expectedSize !== undefined && size !== expectedSize) throw new CliError('MEDIA_MANIFEST_MISMATCH', 'media size 与 manifest 不一致');
  const sha256 = await sha256File(absPath);
  if (expectedSha && sha256 !== expectedSha) throw new CliError('MEDIA_MANIFEST_MISMATCH', 'media SHA256 与 manifest 不一致');
  let probe: unknown = null;
  try { probe = kind === 'video' ? await probeRenderOutput(absPath) : probeAudio(absPath, 'wav'); } catch (error) {
    throw new CliError('MEDIA_PROBE_FAILED', error instanceof Error ? error.message : String(error));
  }
  return {path: outputPath, absolutePath: absPath, sha256, size, probe};
}

async function inspectJob(projectId: string, jobId: string, includeMedia: boolean): Promise<Record<string, unknown>> {
  const db = getDb();
  const render = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(jobId) as RenderJobRow | undefined;
  if (render) {
    if (render.project_id !== projectId) throw new CliError('PROJECT_MISMATCH', `job 不属于 project: ${jobId}`);
    const manifest = render.status === 'succeeded' ? getRenderArtifact(render.id) : undefined;
    let media: Record<string, unknown> | null = null;
    if (render.status === 'succeeded') {
      if (!manifest) throw new CliError('ARTIFACT_UNVALIDATED', 'exact render job 缺少 manifest');
      if (manifest.output_path !== render.output_path) throw new CliError('ARTIFACT_PATH_MISMATCH', 'manifest 与 job output_path 不一致');
      media = await mediaFacts(manifest.output_path, 'video', manifest.output_sha256, manifest.output_size);
    } else if (includeMedia && render.output_path) {
      media = await mediaFacts(render.output_path, 'video');
    }
    return {kind: 'render', row: render, manifest: manifest ?? null, media};
  }
  const tts = getTtsJob(jobId);
  if (!tts) throw new CliError('JOB_NOT_FOUND', `job 不存在: ${jobId}`);
  if (tts.project_id !== projectId) throw new CliError('PROJECT_MISMATCH', `job 不属于 project: ${jobId}`);
  let media: Record<string, unknown> | null = null;
  if (tts.status === 'succeeded') {
    if (!tts.output_path || tts.audio_sha256 === null) throw new CliError('ARTIFACT_UNVALIDATED', 'exact TTS job 缺少 output/hash');
    media = await mediaFacts(tts.output_path, 'audio', tts.audio_sha256);
  } else if (includeMedia && tts.output_path) {
    media = await mediaFacts(tts.output_path, 'audio');
  }
  return {kind: 'tts', row: tts, media};
}

function currentSources(projectId: string): Record<string, unknown> {
  const scenesStage = getStage(projectId, 'scenes');
  const scenes = scenesStage?.status === 'locked' && scenesStage.locked_version !== null
    ? getVersion(projectId, 'scenes', scenesStage.locked_version)
    : null;
  const plan = getCurrentNarrationPlan(projectId);
  const audio = getCurrentNarrationAudioArtifact(projectId);
  const subtitle = getCurrentSubtitleTiming(projectId);
  const reconciliation = getCurrentTimingReconciliation(projectId);
  return {
    scenes: scenes ? {id: scenes.id, version: scenes.version, stage: scenes.stage} : null,
    narrationPlan: plan ? {id: plan.artifact.id, version: plan.artifact.version} : null,
    audio: audio ? {id: audio.artifact.id, version: audio.artifact.version, manifest: audio.manifest} : null,
    subtitles: subtitle ? {id: subtitle.artifact.id, version: subtitle.artifact.version, source: subtitle.timing.source} : null,
    reconciliation: reconciliation ? {id: reconciliation.artifact.id, version: reconciliation.artifact.version, source: reconciliation.reconciliation.source} : null,
  };
}

async function inspect(args: ParsedArgs): Promise<Record<string, unknown>> {
  const projectId = required(args, 'project');
  const project = projectRow(projectId);
  const result: Record<string, unknown> = {
    ok: true, command: 'inspect', project: {id: project.id, title: project.title, pipelineVersion: project.pipeline_version ?? null, row: project},
    stages: listStages(projectId), currentSources: currentSources(projectId), readiness: {
      subtitles: checkSubtitleTimingReadiness(projectId), reconciliation: checkTimingReconciliationReadiness(projectId), render: checkFinalRenderReadiness(projectId),
    },
  };
  const artifactArg = args.values.get('artifact');
  if (artifactArg) {
    const row = artifactRow(projectId, parseIdentity(artifactArg, '--artifact'));
    result.artifact = {...row, content: parsedJson(row.content_json)};
  }
  const jobId = args.values.get('job');
  if (jobId) result.job = await inspectJob(projectId, jobId, args.flags.has('media'));
  return result;
}

async function waitFor<T>(timeout: number, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    const result = await read();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new CliError('TIMEOUT', `等待超过 ${Math.ceil(timeout / 1000)} 秒`);
}

function ttsJobs(projectId: string, plan: Identity): TtsJobRow[] {
  return getDb().prepare('SELECT * FROM tts_jobs WHERE project_id = ? AND narration_plan_artifact_id = ? ORDER BY queued_at').all(projectId, plan.id) as TtsJobRow[];
}

function assertCurrentPlan(projectId: string, expected: Identity): void {
  const current = getCurrentNarrationPlan(projectId);
  if (
    !current ||
    current.artifact.id !== expected.id ||
    current.artifact.version !== expected.version
  ) {
    throw new CliError(
      'NARRATION_PLAN_SOURCE_MISMATCH',
      `Narration Plan source mismatch: expected ${expected.id}@${expected.version}, ` +
        `current ${current ? `${current.artifact.id}@${current.artifact.version}` : 'missing'}`,
    );
  }
}

async function tts(args: ParsedArgs): Promise<Record<string, unknown>> {
  const projectId = required(args, 'project');
  const plan = parseIdentity(required(args, 'plan'), '--plan');
  const requestedVoice = args.values.get('voice');
  const resolvedVoice = resolveRequestedVoice(requestedVoice);
  const voiceOptions = requestedVoice === undefined
    ? undefined
    : {
        voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
        referenceSha256: resolvedVoice.referenceSha256!,
      };
  projectRow(projectId);
  const exactPlanRow = artifactRow(projectId, plan);
  if (exactPlanRow.kind === NARRATION_PLAN_V2_ARTIFACT_KIND) {
    if (!args.flags.has('finalize-only')) {
      throw new CliError('FINALIZE_ONLY_REQUIRED', 'exact narration_plan_v2 只能通过 --finalize-only 消费；本路径绝不 enqueue');
    }
    if (args.flags.has('wait')) {
      throw new CliError('INVALID_ARGUMENT', '--finalize-only 不接受 --wait');
    }
    if (requestedVoice === undefined) {
      throw new CliError('MISSING_ARGUMENT', 'exact narration_plan_v2 --finalize-only 必须显式提供 --voice <id>@<revision>');
    }
    const provider = getTtsProvider();
    if (!provider.health) throw new CliError('PROVIDER_SNAPSHOT_UNAVAILABLE', 'TTS provider 不提供 health snapshot');
    const health = await provider.health();
    if (!health.ready || !health.model || health.provider !== provider.name) {
      throw new CliError('PROVIDER_SNAPSHOT_UNAVAILABLE', `TTS provider health snapshot 非 ready/不完整: ${JSON.stringify(health)}`);
    }
    const snapshot: TtsProviderSnapshot = {
      name: provider.name,
      model: health.model,
      providerVersion: null,
      providerCommit: health.repoCommit ?? null,
    };
    const result = await tryFinalizeNarrationAudioV2({
      projectId,
      narrationPlanV2ArtifactId: plan.id,
      narrationPlanV2ArtifactVersion: plan.version,
      provider: snapshot,
      voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
      referenceSha256: resolvedVoice.referenceSha256,
    });
    return {
      ok: true,
      command: 'tts',
      mode: 'finalize-only',
      plan,
      schemaVersion: result.manifest.schemaVersion,
      enqueue: {enqueued: 0, active: result.active},
      resolvedSources: result.resolvedSources,
      reusePlan: {
        reuse: result.decisions.filter((decision) => decision.decision === 'reuse').length,
        rebuild: result.decisions.filter((decision) => decision.decision === 'rebuild').length,
        decisions: result.decisions,
      },
      result: {
        status: 'ready',
        audio: {artifact: result.artifact, manifest: result.manifest},
        reusedExistingAudio: result.reused,
      },
    };
  }
  if (args.flags.has('finalize-only')) {
    throw new CliError('INVALID_ARGUMENT', '--finalize-only 仅支持 exact narration_plan_v2；V1 tts 行为保持不变');
  }
  assertCurrentPlan(projectId, plan);
  const reusableAudio = await getExactReusableNarrationAudioArtifact(projectId, {
    artifactId: plan.id,
    version: plan.version,
  }, voiceOptions);
  if (reusableAudio) {
    assertCurrentPlan(projectId, plan);
    const jobs = ttsJobs(projectId, plan);
    return {
      ok: true,
      command: 'tts',
      plan,
      enqueue: {
        enqueued: 0,
        reused: jobs.length,
        active: 0,
        planArtifactId: plan.id,
        planArtifactVersion: plan.version,
      },
      result: {
        status: 'ready',
        jobs,
        overview: getNarrationAudioOverview(projectId, voiceOptions),
        audio: {artifact: reusableAudio.artifact, manifest: reusableAudio.manifest},
        reusedExistingAudio: true,
      },
    };
  }
  const enqueued = enqueueNarrationAudioJobs(projectId, {
    expectedPlan: {artifactId: plan.id, version: plan.version},
    ...voiceOptions,
  });
  const read = async (): Promise<Record<string, unknown> | null> => {
    assertCurrentPlan(projectId, plan);
    const overview = getNarrationAudioOverview(projectId, voiceOptions);
    assertCurrentPlan(projectId, plan);
    const jobs = ttsJobs(projectId, plan);
    const failed = jobs.find((job) => job.status === 'failed' || job.status === 'cancelled');
    if (failed) throw new CliError('TTS_TERMINAL_FAILURE', `TTS job ${failed.id} terminal status=${failed.status}: ${failed.error_message ?? ''}`);
    if (!args.flags.has('wait')) return {status: 'queued', jobs, overview};
    tryFinalizeNarrationAudio(projectId, {
      expectedPlan: {artifactId: plan.id, version: plan.version},
      ...voiceOptions,
    });
    const audio = getCurrentNarrationAudioArtifact(projectId, voiceOptions);
    if (audio) {
      if (
        audio.manifest.source.narrationPlanArtifactId !== plan.id ||
        audio.manifest.source.narrationPlanArtifactVersion !== plan.version
      ) {
        throw new CliError('NARRATION_PLAN_SOURCE_MISMATCH', 'Narration Audio source 与 expected plan 不一致');
      }
      assertCurrentPlan(projectId, plan);
      return {status: 'ready', jobs, overview: getNarrationAudioOverview(projectId, voiceOptions), audio: {artifact: audio.artifact, manifest: audio.manifest}};
    }
    assertCurrentPlan(projectId, plan);
    return null;
  };
  return {ok: true, command: 'tts', plan, enqueue: enqueued, result: await waitFor(args.flags.has('wait') ? timeoutMs(args) : 1, read)};
}

async function subtitles(args: ParsedArgs): Promise<Record<string, unknown>> {
  const projectId = required(args, 'project');
  const audio = parseIdentity(required(args, 'audio'), '--audio');
  projectRow(projectId);
  const exactAudioRow = artifactRow(projectId, audio);
  if (exactAudioRow.kind === NARRATION_AUDIO_V2_ARTIFACT_KIND) {
    const exactAudioV2 = await getExactNarrationAudioV2Artifact(projectId, {
      artifactId: audio.id,
      version: audio.version,
    });
    if (!exactAudioV2) throw new CliError('AUDIO_SOURCE_MISMATCH', `exact narration audio v2 无效或不匹配: ${audio.id}@${audio.version}`);
    const result = await buildSubtitleTimingV2({
      projectId,
      narrationAudioV2ArtifactId: audio.id,
      narrationAudioV2ArtifactVersion: audio.version,
    });
    return {
      ok: true,
      command: 'subtitles',
      schemaVersion: result.timing.schemaVersion,
      source: audio,
      artifact: result.artifact,
      reused: result.reused,
      timing: result.timing,
    };
  }
  const exactAudio = await getExactNarrationAudioArtifact(projectId, {
    artifactId: audio.id,
    version: audio.version,
  });
  if (!exactAudio) throw new CliError('AUDIO_SOURCE_MISMATCH', `exact narration audio 无效或不匹配: ${audio.id}@${audio.version}`);
  const result = buildSubtitleTiming(projectId, {
    expectedAudio: {artifactId: audio.id, version: audio.version},
    exactAudio,
  });
  return {ok: true, command: 'subtitles', source: audio, artifact: result.artifact, reused: result.reused, timing: result.timing, readiness: checkSubtitleTimingReadiness(projectId)};
}

async function visuals(args: ParsedArgs): Promise<Record<string, unknown>> {
  const projectId = required(args, 'project');
  const design = parseIdentity(required(args, 'design'), '--design');
  const plan = parseIdentity(required(args, 'plan'), '--plan');
  const audio = parseIdentity(required(args, 'audio'), '--audio');
  const subtitles = parseIdentity(required(args, 'subtitles'), '--subtitles');
  projectRow(projectId);
  const result = await buildVisualSourceV2({
    projectId,
    designScenes: design,
    narrationPlanV2: plan,
    narrationAudioV2: audio,
    subtitleTimingV2: subtitles,
  });
  return {
    ok: true,
    command: 'visuals',
    sources: {design, plan, audio, subtitles},
    artifact: result.artifact,
    reused: result.reused,
    visual: result.visual,
  };
}

async function reconcile(args: ParsedArgs): Promise<Record<string, unknown>> {
  const projectId = required(args, 'project');
  const scenes = parseIdentity(required(args, 'scenes'), '--scenes');
  const audio = parseIdentity(required(args, 'audio'), '--audio');
  const subtitle = parseIdentity(required(args, 'subtitles'), '--subtitles');
  projectRow(projectId);
  const audioRow = artifactRow(projectId, audio);
  const subtitleRow = artifactRow(projectId, subtitle);
  const visualRow = getDb().prepare('SELECT project_id, kind, version FROM artifacts WHERE id = ?').get(scenes.id) as
    | {project_id: string; kind: string; version: number}
    | undefined;
  if (visualRow?.kind === VISUAL_SOURCE_V2_ARTIFACT_KIND) {
    if (visualRow.project_id !== projectId || visualRow.version !== scenes.version ||
        audioRow.kind !== NARRATION_AUDIO_V2_ARTIFACT_KIND || subtitleRow.kind !== 'subtitle_timing_v2') {
      throw new CliError('SOURCE_MISMATCH', 'V2 reconcile 必须使用 exact visual/audio/subtitle V2 identities');
    }
    const exactVisual = await getExactVisualSourceV2Artifact(projectId, {artifactId: scenes.id, version: scenes.version});
    const exactAudio = await getExactNarrationAudioV2Artifact(projectId, {artifactId: audio.id, version: audio.version});
    const exactSubtitle = exactAudio ? getExactSubtitleTimingV2Artifact(projectId, {artifactId: subtitle.id, version: subtitle.version}, exactAudio) : null;
    if (!exactVisual || !exactAudio || !exactSubtitle) throw new CliError('SOURCE_MISMATCH', 'V2 reconcile exact source validation failed');
    const result = buildTimingReconciliationV2(projectId, {visual: exactVisual, audio: exactAudio, subtitle: exactSubtitle});
    return {
      ok: true,
      command: 'reconcile',
      mode: 'v2-exact',
      sources: {scenes, audio, subtitles: subtitle},
      artifact: result.artifact,
      reused: result.reused,
      reconciliation: result.reconciliation,
    };
  }
  const exactScenes = getExactReconciliationScenes(projectId, {
    versionId: scenes.id,
    version: scenes.version,
  });
  if (!exactScenes) throw new CliError('SOURCE_MISMATCH', `exact scenes 无效或不匹配: ${scenes.id}@${scenes.version}`);
  const exactAudio = await getExactNarrationAudioArtifact(projectId, {
    artifactId: audio.id,
    version: audio.version,
  });
  if (!exactAudio) throw new CliError('SOURCE_MISMATCH', `exact narration audio 无效或不匹配: ${audio.id}@${audio.version}`);
  const exactSubtitle = getExactSubtitleTiming(projectId, {
    artifactId: subtitle.id,
    version: subtitle.version,
  }, exactAudio);
  if (!exactSubtitle) throw new CliError('SOURCE_MISMATCH', `exact subtitles 无效或 source audio 不匹配: ${subtitle.id}@${subtitle.version}`);
  const result = buildTimingReconciliation(projectId, {
    expectedScenes: {versionId: scenes.id, version: scenes.version}, expectedAudio: {artifactId: audio.id, version: audio.version}, expectedSubtitle: {artifactId: subtitle.id, version: subtitle.version},
    exactSources: {scenes: exactScenes, audio: exactAudio, subtitle: exactSubtitle},
  });
  const rec = result.reconciliation;
  return {
    ok: true,
    command: 'reconcile',
    sources: {scenes, audio, subtitles: subtitle},
    artifact: result.artifact,
    reused: result.reused,
    reconciliation: rec,
    readiness: {
      status: 'ready',
      compilerVersion: rec.compilerVersion,
      sources: {
        scenesVersion: scenes.version,
        audioArtifactVersion: audio.version,
        subtitleArtifactVersion: subtitle.version,
      },
      artifactVersion: result.artifact.version,
      sceneCount: rec.scenes.length,
      masterDurationMs: rec.source.masterDurationMs,
      sourceVisual: rec.sourceVisual,
      target: rec.target,
      unresolvedCount: rec.unresolvedNarrationUnitIds.length,
      reconciliation: rec,
    },
  };
}

function latestAttempt(projectId: string, jobId: string): Record<string, unknown> {
  const rows = getDb().prepare('SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC').all(projectId, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const parsed = finalRenderAttemptSchema.safeParse(parsedJson(row.content_json));
    if (parsed.success && parsed.data.jobId === jobId) return {id: row.id, version: row.version, content: parsed.data};
  }
  throw new CliError('ATTEMPT_NOT_FOUND', `exact render job 缺少 final_render_attempt: ${jobId}`);
}

async function render(args: ParsedArgs): Promise<Record<string, unknown>> {
  const projectId = required(args, 'project');
  const scenes = parseIdentity(required(args, 'scenes'), '--scenes');
  const audio = parseIdentity(required(args, 'audio'), '--audio');
  const subtitle = parseIdentity(required(args, 'subtitles'), '--subtitles');
  const reconciliation = parseIdentity(required(args, 'reconciliation'), '--reconciliation');
  projectRow(projectId);
  const audioRow = artifactRow(projectId, audio);
  const subtitleRow = artifactRow(projectId, subtitle);
  artifactRow(projectId, reconciliation);
  const visualRow = getDb().prepare('SELECT project_id, kind, version FROM artifacts WHERE id = ?').get(scenes.id) as
    | {project_id: string; kind: string; version: number}
    | undefined;
  if (visualRow?.kind === VISUAL_SOURCE_V2_ARTIFACT_KIND) {
    if (visualRow.project_id !== projectId || visualRow.version !== scenes.version ||
        audioRow.kind !== NARRATION_AUDIO_V2_ARTIFACT_KIND || subtitleRow.kind !== 'subtitle_timing_v2') {
      throw new CliError('SOURCE_MISMATCH', 'V2 render 必须使用 exact visual/audio/subtitle V2 identities');
    }
    const exactVisual = await getExactVisualSourceV2Artifact(projectId, {artifactId: scenes.id, version: scenes.version});
    const exactAudio = await getExactNarrationAudioV2Artifact(projectId, {artifactId: audio.id, version: audio.version});
    const exactSubtitle = exactAudio ? getExactSubtitleTimingV2Artifact(projectId, {artifactId: subtitle.id, version: subtitle.version}, exactAudio) : null;
    if (!exactVisual || !exactAudio || !exactSubtitle) throw new CliError('SOURCE_MISMATCH', 'V2 render exact source validation failed');
    const exactReconciliation = getExactTimingReconciliationV2(projectId, {
      artifactId: reconciliation.id,
      version: reconciliation.version,
    }, {visual: exactVisual, audio: exactAudio, subtitle: exactSubtitle});
    if (!exactReconciliation) throw new CliError('SOURCE_MISMATCH', 'V2 render exact reconciliation/source chain validation failed');
    const result = enqueueFinalRenderV2(projectId, {
      visual: exactVisual,
      audio: exactAudio,
      subtitle: exactSubtitle,
      reconciliation: exactReconciliation,
    });
    const read = async (): Promise<Record<string, unknown> | null> => {
      const job = getDb().prepare('SELECT * FROM render_jobs WHERE id = ?').get(result.job.id) as RenderJobRow | undefined;
      if (!job) throw new CliError('JOB_NOT_FOUND', `render job 不存在: ${result.job.id}`);
      if (job.status === 'failed' || job.status === 'cancelled') throw new CliError('RENDER_TERMINAL_FAILURE', `render job ${job.id} terminal status=${job.status}: ${job.error_message ?? ''}`);
      if (!args.flags.has('wait')) return {job, attempt: latestAttempt(projectId, job.id)};
      if (job.status !== 'succeeded') return null;
      const manifest = getRenderArtifact(job.id);
      if (!manifest || !job.output_path) throw new CliError('ARTIFACT_UNVALIDATED', 'exact render job 缺少 manifest/output');
      if (manifest.output_path !== job.output_path) throw new CliError('ARTIFACT_PATH_MISMATCH', 'manifest 与 job output_path 不一致');
      const media = await mediaFacts(manifest.output_path, 'video', manifest.output_sha256, manifest.output_size);
      return {job, attempt: latestAttempt(projectId, job.id), manifest, media};
    };
    return {
      ok: true,
      command: 'render',
      mode: 'v2-exact',
      sources: {scenes, audio, subtitles: subtitle, reconciliation},
      sourceArtifact: result.sourceArtifact,
      sourceReused: result.sourceReused,
      result: await waitFor(args.flags.has('wait') ? timeoutMs(args) : 1, read),
    };
  }
  const exactScenes = getExactReconciliationScenes(projectId, {
    versionId: scenes.id,
    version: scenes.version,
  });
  if (!exactScenes) throw new CliError('SOURCE_MISMATCH', `exact scenes 无效或不匹配: ${scenes.id}@${scenes.version}`);
  const exactAudio = await getExactNarrationAudioArtifact(projectId, {
    artifactId: audio.id,
    version: audio.version,
  });
  if (!exactAudio) throw new CliError('SOURCE_MISMATCH', `exact narration audio 无效或不匹配: ${audio.id}@${audio.version}`);
  const exactSubtitle = getExactSubtitleTiming(projectId, {
    artifactId: subtitle.id,
    version: subtitle.version,
  }, exactAudio);
  if (!exactSubtitle) throw new CliError('SOURCE_MISMATCH', `exact subtitles 无效或 source audio 不匹配: ${subtitle.id}@${subtitle.version}`);
  const exactReconciliation = getExactTimingReconciliation(projectId, {
    artifactId: reconciliation.id,
    version: reconciliation.version,
  }, {scenes: exactScenes, audio: exactAudio, subtitle: exactSubtitle});
  if (!exactReconciliation) {
    throw new CliError(
      'SOURCE_MISMATCH',
      `exact reconciliation 无效或 source chain 不匹配: ${reconciliation.id}@${reconciliation.version}`,
    );
  }
  const result = enqueueFinalRender(projectId, {
    expectedScenes: {versionId: scenes.id, version: scenes.version}, expectedAudio: {artifactId: audio.id, version: audio.version}, expectedSubtitle: {artifactId: subtitle.id, version: subtitle.version}, expectedReconciliation: {artifactId: reconciliation.id, version: reconciliation.version},
    exactSources: {
      scenes: exactScenes,
      audio: exactAudio,
      subtitle: exactSubtitle,
      reconciliation: exactReconciliation,
    },
  });
  const read = async (): Promise<Record<string, unknown> | null> => {
    const job = getDb().prepare('SELECT * FROM render_jobs WHERE id = ?').get(result.job.id) as RenderJobRow | undefined;
    if (!job) throw new CliError('JOB_NOT_FOUND', `render job 不存在: ${result.job.id}`);
    if (job.status === 'failed' || job.status === 'cancelled') throw new CliError('RENDER_TERMINAL_FAILURE', `render job ${job.id} terminal status=${job.status}: ${job.error_message ?? ''}`);
    if (!args.flags.has('wait')) return {job, attempt: latestAttempt(projectId, job.id)};
    if (job.status !== 'succeeded') return null;
    const manifest = getRenderArtifact(job.id);
    if (!manifest || !job.output_path) throw new CliError('ARTIFACT_UNVALIDATED', 'exact render job 缺少 manifest/output');
    if (manifest.output_path !== job.output_path) throw new CliError('ARTIFACT_PATH_MISMATCH', 'manifest 与 job output_path 不一致');
    const media = await mediaFacts(manifest.output_path, 'video', manifest.output_sha256, manifest.output_size);
    return {job, attempt: latestAttempt(projectId, job.id), manifest, media};
  };
  return {ok: true, command: 'render', sources: {scenes, audio, subtitles: subtitle, reconciliation}, sourceArtifact: result.sourceArtifact, sourceReused: result.sourceReused, result: await waitFor(args.flags.has('wait') ? timeoutMs(args) : 1, read)};
}

async function main(): Promise<void> {
  let command = 'unknown';
  try {
    const args = parseArgs(process.argv.slice(2)); command = args.command;
    const result = args.command === 'inspect' ? await inspect(args)
      : args.command === 'tts' ? await tts(args)
      : args.command === 'subtitles' ? await subtitles(args)
      : args.command === 'visuals' ? await visuals(args)
      : args.command === 'reconcile' ? await reconcile(args)
      : await render(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof CliError ? error.code : (error as {code?: string})?.code ?? 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ok: false, command, error: {code, message}})}\n`);
    process.exitCode = 1;
  }
}

void main();

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
import {
  NARRATION_AUDIO_REPAIR_HEADROOM_DB,
  analyzeS16WavHardClipping,
  assembleNarrationAudioMicroRepairParent,
  enqueueNarrationAudioJobs,
  enqueueNarrationAudioMicroRepairJobs,
  enqueueNarrationAudioQcReplacementJobs,
  getCurrentNarrationAudioArtifact,
  getExactNarrationAudioArtifact,
  getExactReusableNarrationAudioArtifact,
  getNarrationAudioOverview,
  tryFinalizeNarrationAudio,
} from '../lib/narration/audio';
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
import {buildSubtitleTimingV2Sidecars} from '../lib/subtitles/renderer';
import {getCurrentTimingReconciliation, getExactTimingReconciliation, getExactReconciliationScenes, checkTimingReconciliationReadiness, buildTimingReconciliation} from '../lib/reconciliation/timing';
import {buildTimingReconciliationV2, getExactTimingReconciliationV2} from '../lib/reconciliation/timing-v2';
import {buildVisualSourceV2, getExactVisualSourceV2Artifact, VISUAL_SOURCE_V2_ARTIFACT_KIND} from '../lib/visual-source-v2';
import {getStage, listStages} from '../lib/workflow/stages';
import {getVersion} from '../lib/workflow/versions';
import {getRenderArtifact, probeRenderOutput, resolveOutputAbs, sha256File} from '../lib/render/artifact';
import {probeAudio} from '../lib/tts-c/audio-probe';
import {getTtsJob, parseTtsJobPayload, payloadSpokenText, type TtsJobRow} from '../lib/tts-jobs';
import {resolveRequestedVoice} from '../lib/tts/voice-registry';
import {getTtsProvider} from '../lib/tts';
import type {RenderJobRow} from '../lib/jobs';
import {getProjectInput} from '../lib/project-inputs';
import {resolveProductionSubtitleMode} from '../lib/workflow/production-baseline';

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
    tts: ['project', 'plan', 'timeout-seconds', 'voice', 'qc-replace', 'qc-micro-repair', 'supersedes-audio'],
    subtitles: ['project', 'audio', 'artifact', 'export-dir'],
    visuals: ['project', 'design', 'plan', 'audio', 'subtitles', 'choreography'],
    reconcile: ['project', 'scenes', 'audio', 'subtitles'],
    render: ['project', 'scenes', 'audio', 'subtitles', 'reconciliation', 'timeout-seconds', 'subtitle-mode'],
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

function parseQcReplacementUnits(raw: string): string[] {
  const units = raw.split(',').map((unit) => unit.trim()).filter(Boolean);
  if (
    units.length === 0 || new Set(units).size !== units.length ||
    units.some((unit) => !/^N\d{3}$/.test(unit))
  ) {
    throw new CliError('INVALID_ARGUMENT', '--qc-replace 必须是逗号分隔且不重复的 N001 形式 unit IDs');
  }
  return units;
}

function splitAtExistingNaturalStops(text: string): string[] {
  const children = text.match(/[^。！？；]+[。！？；]|[^。！？；]+$/gu) ?? [];
  if (children.length < 2 || children.length > 3 || children.join('') !== text) {
    throw new CliError('INVALID_ARGUMENT', 'micro repair parent 必须能仅用现有句号/问号/感叹号/分号拆成 2-3 段');
  }
  return children;
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
    ok: true, command: 'inspect', project: {id: project.id, title: project.title, pipelineVersion: project.pipeline_version ?? null, workflow: getProjectInput(projectId), row: project},
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
  const qcReplaceRaw = args.values.get('qc-replace');
  const qcMicroRepairRaw = args.values.get('qc-micro-repair');
  const supersedesAudioRaw = args.values.get('supersedes-audio');
  if (qcReplaceRaw && qcMicroRepairRaw) {
    throw new CliError('INVALID_ARGUMENT', '--qc-replace 与 --qc-micro-repair 不能同时使用');
  }
  if ((qcReplaceRaw || qcMicroRepairRaw) && !supersedesAudioRaw) {
    throw new CliError('MISSING_ARGUMENT', 'QC repair 必须显式提供 --supersedes-audio');
  }
  if (!qcReplaceRaw && !qcMicroRepairRaw && supersedesAudioRaw) {
    throw new CliError('MISSING_ARGUMENT', '--supersedes-audio 必须与 QC repair 参数同时提供');
  }
  if (qcMicroRepairRaw && supersedesAudioRaw) {
    if (!args.flags.has('wait')) throw new CliError('INVALID_ARGUMENT', 'micro repair 必须显式使用 --wait');
    if (requestedVoice === undefined) {
      throw new CliError('MISSING_ARGUMENT', 'micro repair 必须显式提供 --voice <id>@<revision>');
    }
    assertCurrentPlan(projectId, plan);
    const supersedes = parseIdentity(supersedesAudioRaw, '--supersedes-audio');
    const originalAudio = await getExactNarrationAudioArtifact(projectId, {
      artifactId: supersedes.id,
      version: supersedes.version,
    });
    if (
      !originalAudio || originalAudio.manifest.source.narrationPlanArtifactId !== plan.id ||
      originalAudio.manifest.source.narrationPlanArtifactVersion !== plan.version ||
      originalAudio.manifest.provider.voiceProfile.id !== resolvedVoice.id ||
      originalAudio.manifest.provider.voiceProfile.revision !== resolvedVoice.revision
    ) {
      throw new CliError('AUDIO_SOURCE_MISMATCH', 'micro repair superseded audio identity/source/voice mismatch');
    }
    const requestedUnits = parseQcReplacementUnits(qcMicroRepairRaw);
    const originalSpeech = new Map(
      originalAudio.manifest.units.filter((unit) => unit.kind === 'speech').map((unit) => [unit.unitId, unit]),
    );
    if (requestedUnits.some((unitId) => !originalSpeech.has(unitId))) {
      throw new CliError('INVALID_ARGUMENT', '--qc-micro-repair 包含 superseded audio 中不存在的 speech unit');
    }
    const currentPlan = getCurrentNarrationPlan(projectId);
    if (!currentPlan || currentPlan.artifact.id !== plan.id || currentPlan.artifact.version !== plan.version) {
      throw new CliError('NARRATION_PLAN_SOURCE_MISMATCH', 'micro repair current plan changed');
    }
    const planSpeech = new Map(
      currentPlan.plan.units.filter((unit) => unit.kind === 'speech').map((unit) => [unit.id, unit]),
    );
    const repairs = requestedUnits.map((parentUnitId) => {
      const parent = planSpeech.get(parentUnitId);
      const original = originalSpeech.get(parentUnitId);
      if (!parent?.text || !original || parent.text !== original.text) {
        throw new CliError('AUDIO_SOURCE_MISMATCH', `${parentUnitId} locked parent text mismatch`);
      }
      return {
        parentUnitId,
        supersedesJobId: original.ttsJobId,
        splitPlan: 1 as const,
        children: splitAtExistingNaturalStops(parent.text),
      };
    });
    const expectedChildCount = repairs.reduce((sum, repair) => sum + repair.children.length, 0);
    const selectedChildren = new Map<string, string>();
    const childEvidence: Array<{
      parentUnitId: string;
      childUnitId: string;
      childIndex: number;
      candidateNumber: number;
      jobId: string;
      clipping: ReturnType<typeof analyzeS16WavHardClipping>;
    }> = [];
    const readChildRows = (repair: typeof repairs[number], childIndex: number): Array<{
      row: TtsJobRow;
      candidateNumber: number;
    }> => {
      const childUnitId = `${repair.parentUnitId}-R${repair.splitPlan}-${String.fromCharCode(64 + childIndex)}`;
      return (getDb().prepare(`
        SELECT * FROM tts_jobs
        WHERE project_id = ? AND narration_plan_artifact_id = ? AND unit_id = ?
          AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
        ORDER BY queued_at
      `).all(
        projectId, plan.id, childUnitId, getTtsProvider().name,
        resolvedVoice.id, resolvedVoice.revision,
      ) as TtsJobRow[]).flatMap((row) => {
        const payload = parseTtsJobPayload(row.payload_json);
        const micro = payload?.qcMicroSegment;
        return payload && micro?.parentUnitId === repair.parentUnitId &&
          micro.supersedesJobId === repair.supersedesJobId && micro.splitPlan === repair.splitPlan &&
          micro.childIndex === childIndex && micro.childCount === repair.children.length &&
          payloadSpokenText(payload) === repair.children[childIndex - 1]
          ? [{row, candidateNumber: micro.candidateNumber}] : [];
      });
    };

    for (let cycle = 0; cycle < 3 && selectedChildren.size < expectedChildCount; cycle++) {
      const enqueueRequests: Array<typeof repairs[number] & {childIndexes: number[]}> = [];
      const waitJobIds = new Set<string>();
      for (const repair of repairs) {
        const childIndexes: number[] = [];
        for (let childIndex = 1; childIndex <= repair.children.length; childIndex++) {
          const childKey = `${repair.parentUnitId}:${childIndex}`;
          if (selectedChildren.has(childKey)) continue;
          const rows = readChildRows(repair, childIndex);
          let accepted = false;
          for (const candidate of [...rows].reverse()) {
            if (candidate.row.status !== 'succeeded' || !candidate.row.output_path) continue;
            const clipping = analyzeS16WavHardClipping(path.join(getDataDir(), candidate.row.output_path));
            if (!childEvidence.some((item) => item.jobId === candidate.row.id)) {
              childEvidence.push({
                parentUnitId: repair.parentUnitId,
                childUnitId: candidate.row.unit_id,
                childIndex,
                candidateNumber: candidate.candidateNumber,
                jobId: candidate.row.id,
                clipping,
              });
            }
            if (clipping.fullScaleSamples === 0 && clipping.saturationRuns === 0) {
              selectedChildren.set(childKey, candidate.row.id);
              accepted = true;
              break;
            }
          }
          if (accepted) continue;
          const active = rows.find(({row}) => row.status === 'queued' || row.status === 'running');
          if (active) {
            waitJobIds.add(active.row.id);
            continue;
          }
          if (rows.length >= 2) {
            throw new CliError(
              'PROVIDER_CLIPPING_REQUIRES_DEEPER_INVESTIGATION',
              `${repair.parentUnitId} child ${childIndex} 两个 candidates 均未通过`,
            );
          }
          childIndexes.push(childIndex);
        }
        if (childIndexes.length > 0) enqueueRequests.push({...repair, childIndexes});
      }
      if (enqueueRequests.length > 0) {
        const enqueued = enqueueNarrationAudioMicroRepairJobs(projectId, enqueueRequests, {
          expectedPlan: {artifactId: plan.id, version: plan.version},
          voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
          referenceSha256: resolvedVoice.referenceSha256 ?? undefined,
        });
        enqueued.jobs.forEach((job) => waitJobIds.add(job.jobId));
      }
      if (waitJobIds.size > 0) {
        await waitFor(timeoutMs(args), async () => {
          const rows = [...waitJobIds].map((jobId) => getTtsJob(jobId));
          return rows.every((row) => row && ['succeeded', 'failed', 'cancelled'].includes(row.status)) ? rows : null;
        });
      }
    }
    if (selectedChildren.size !== expectedChildCount) {
      throw new CliError('PROVIDER_CLIPPING_REQUIRES_DEEPER_INVESTIGATION', '未获得全部 clean micro children');
    }

    const parentRepairs = repairs.map((repair) => assembleNarrationAudioMicroRepairParent(projectId, {
      parentUnitId: repair.parentUnitId,
      supersedesJobId: repair.supersedesJobId,
      splitPlan: repair.splitPlan,
      selectedChildJobIds: repair.children.map((_, index) => selectedChildren.get(`${repair.parentUnitId}:${index + 1}`)!),
    }, {
      expectedPlan: {artifactId: plan.id, version: plan.version},
      voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
      referenceSha256: resolvedVoice.referenceSha256 ?? undefined,
    }));
    const parentJobs = new Map(parentRepairs.map(({job}) => [job.unit_id, job.id]));
    const selectedTtsJobIds: Record<string, string> = {};
    const replacedSegments: string[] = [];
    let cleanOriginals = 0;
    let existingCleanReplacements = 0;
    for (const [unitId, unit] of originalSpeech) {
      const originalPath = path.join(getDataDir(), unit.filePath);
      const originalClipping = analyzeS16WavHardClipping(originalPath);
      if (originalClipping.fullScaleSamples === 0 && originalClipping.saturationRuns === 0) {
        selectedTtsJobIds[unitId] = unit.ttsJobId;
        cleanOriginals++;
        continue;
      }
      replacedSegments.push(unitId);
      const microParentJobId = parentJobs.get(unitId);
      if (microParentJobId) {
        selectedTtsJobIds[unitId] = microParentJobId;
        continue;
      }
      const replacement = (getDb().prepare(`
        SELECT * FROM tts_jobs
        WHERE project_id = ? AND narration_plan_artifact_id = ? AND unit_id = ?
          AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ? AND status = 'succeeded'
        ORDER BY queued_at
      `).all(
        projectId, plan.id, unitId, getTtsProvider().name,
        resolvedVoice.id, resolvedVoice.revision,
      ) as TtsJobRow[]).find((row) => {
        const payload = parseTtsJobPayload(row.payload_json);
        if (
          payload?.qcReplacement?.supersedesJobId !== unit.ttsJobId ||
          payload.qcReplacement.method === 'EXACT_TEXT_MICRO_SEGMENT' || !row.output_path
        ) return false;
        const clipping = analyzeS16WavHardClipping(path.join(getDataDir(), row.output_path));
        return clipping.fullScaleSamples === 0 && clipping.saturationRuns === 0;
      });
      if (!replacement) {
        throw new CliError('PROVIDER_CLIPPING_REQUIRES_DEEPER_INVESTIGATION', `${unitId} 没有 clean repair input`);
      }
      selectedTtsJobIds[unitId] = replacement.id;
      existingCleanReplacements++;
    }
    if (
      cleanOriginals + existingCleanReplacements + parentRepairs.length !== originalSpeech.size ||
      Object.keys(selectedTtsJobIds).length !== originalSpeech.size
    ) {
      throw new CliError('AUDIO_FINALIZE_FAILED', 'micro repair final input set count mismatch');
    }
    for (const jobId of Object.values(selectedTtsJobIds)) {
      const job = getTtsJob(jobId);
      if (!job?.output_path) throw new CliError('AUDIO_FINALIZE_FAILED', `selected input missing: ${jobId}`);
      const clipping = analyzeS16WavHardClipping(path.join(getDataDir(), job.output_path));
      if (clipping.fullScaleSamples !== 0 || clipping.saturationRuns !== 0) {
        throw new CliError('MASTER_HARD_CLIPPING', `selected input clips: ${job.unit_id}`);
      }
    }
    const manifest = tryFinalizeNarrationAudio(projectId, {
      expectedPlan: {artifactId: plan.id, version: plan.version},
      voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
      referenceSha256: resolvedVoice.referenceSha256,
      repair: {
        reason: 'AUDIO_QC_CLIPPING',
        supersedes,
        preResampleHeadroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB,
        selectedTtsJobIds,
        replacedSegments,
      },
    });
    const audio = getCurrentNarrationAudioArtifact(projectId, voiceOptions);
    if (!manifest || !audio || audio.manifest.repair?.supersedes.id !== supersedes.id) {
      throw new CliError('AUDIO_FINALIZE_FAILED', 'micro repair narration audio artifact 未形成');
    }
    const masterClipping = analyzeS16WavHardClipping(path.join(getDataDir(), audio.manifest.master.filePath));
    if (masterClipping.fullScaleSamples !== 0 || masterClipping.saturationRuns !== 0) {
      throw new CliError('MASTER_HARD_CLIPPING', 'micro repair master hard clipping gate failed');
    }
    return {
      ok: true,
      command: 'tts',
      mode: 'qc-micro-repair',
      plan,
      supersedesAudio: supersedes,
      requestedUnits,
      splitPlans: repairs.map(({parentUnitId, splitPlan, children}) => ({
        parentUnitId, splitPlan, children, reconstructedTextMatch: children.join('') === planSpeech.get(parentUnitId)?.text,
      })),
      childEvidence,
      parentRepairs: parentRepairs.map(({job, childJobIds, clipping}) => ({
        parentUnitId: job.unit_id, jobId: job.id, childJobIds, clipping,
      })),
      finalInputSet: {
        cleanOriginals,
        existingCleanReplacements,
        newBlockerRepairs: parentRepairs.length,
        logicalUnits: Object.keys(selectedTtsJobIds).length,
        physicalAudioPieces: Object.keys(selectedTtsJobIds).length + expectedChildCount,
      },
      repair: {headroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB, replacedSegments},
      result: {status: 'ready', audio: {artifact: audio.artifact, manifest: audio.manifest}, masterClipping},
    };
  }
  if (qcReplaceRaw && supersedesAudioRaw) {
    if (!args.flags.has('wait')) {
      throw new CliError('INVALID_ARGUMENT', 'QC replacement 必须显式使用 --wait');
    }
    if (requestedVoice === undefined) {
      throw new CliError('MISSING_ARGUMENT', 'QC replacement 必须显式提供 --voice <id>@<revision>');
    }
    assertCurrentPlan(projectId, plan);
    const supersedes = parseIdentity(supersedesAudioRaw, '--supersedes-audio');
    const originalAudio = await getExactNarrationAudioArtifact(projectId, {
      artifactId: supersedes.id,
      version: supersedes.version,
    });
    if (
      !originalAudio ||
      originalAudio.manifest.source.narrationPlanArtifactId !== plan.id ||
      originalAudio.manifest.source.narrationPlanArtifactVersion !== plan.version ||
      originalAudio.manifest.provider.voiceProfile.id !== resolvedVoice.id ||
      originalAudio.manifest.provider.voiceProfile.revision !== resolvedVoice.revision
    ) {
      throw new CliError('AUDIO_SOURCE_MISMATCH', 'QC replacement superseded audio identity/source/voice mismatch');
    }
    const requestedUnits = parseQcReplacementUnits(qcReplaceRaw);
    const originalSpeech = new Map(
      originalAudio.manifest.units
        .filter((unit) => unit.kind === 'speech')
        .map((unit) => [unit.unitId, unit]),
    );
    if (requestedUnits.some((unitId) => !originalSpeech.has(unitId))) {
      throw new CliError('INVALID_ARGUMENT', '--qc-replace 包含 superseded audio 中不存在的 speech unit');
    }

    const replacementEvidence: Array<{
      unitId: string;
      jobId: string;
      candidateNumber: number;
      clipping: ReturnType<typeof analyzeS16WavHardClipping>;
    }> = [];
    const selectedReplacementJobs = new Map<string, string>();
    const readReplacementRows = (unitId: string, originalJobId: string): Array<{
      row: TtsJobRow;
      candidateNumber: number;
    }> => (getDb().prepare(`
      SELECT * FROM tts_jobs
      WHERE project_id = ? AND narration_plan_artifact_id = ? AND unit_id = ?
        AND provider = ? AND voice_profile_id = ? AND voice_profile_revision = ?
      ORDER BY queued_at
    `).all(
      projectId, plan.id, unitId, getTtsProvider().name,
      resolvedVoice.id, resolvedVoice.revision,
    ) as TtsJobRow[]).flatMap((row) => {
      const payload = parseTtsJobPayload(row.payload_json);
      return payload?.qcReplacement?.supersedesJobId === originalJobId &&
        payload.qcReplacement.method !== 'EXACT_TEXT_MICRO_SEGMENT'
        ? [{row, candidateNumber: payload.qcReplacement.candidateNumber}]
        : [];
    });

    for (let cycle = 0; cycle < 3 && selectedReplacementJobs.size < requestedUnits.length; cycle++) {
      const enqueueRequests: Array<{unitId: string; supersedesJobId: string}> = [];
      const waitJobIds = new Set<string>();
      for (const unitId of requestedUnits) {
        if (selectedReplacementJobs.has(unitId)) continue;
        const originalJobId = originalSpeech.get(unitId)!.ttsJobId;
        const replacements = readReplacementRows(unitId, originalJobId);
        let accepted = false;
        for (const replacement of [...replacements].reverse()) {
          if (replacement.row.status !== 'succeeded' || !replacement.row.output_path) continue;
          const clipping = analyzeS16WavHardClipping(path.join(getDataDir(), replacement.row.output_path));
          if (!replacementEvidence.some((item) => item.jobId === replacement.row.id)) {
            replacementEvidence.push({unitId, jobId: replacement.row.id, candidateNumber: replacement.candidateNumber, clipping});
          }
          if (clipping.fullScaleSamples === 0 && clipping.saturationRuns === 0) {
            selectedReplacementJobs.set(unitId, replacement.row.id);
            accepted = true;
            break;
          }
        }
        if (accepted) continue;
        const active = replacements.find(({row}) => row.status === 'queued' || row.status === 'running');
        if (active) {
          waitJobIds.add(active.row.id);
          continue;
        }
        const failed = replacements.find(({row}) => row.status === 'failed' || row.status === 'cancelled');
        if (failed) {
          throw new CliError('TTS_TERMINAL_FAILURE', `${unitId} QC replacement ${failed.row.id} status=${failed.row.status}`);
        }
        if (replacements.length >= 2) {
          throw new CliError('PROVIDER_SEGMENT_CLIPPING_BLOCKER', `${unitId} 两个 replacement candidates 均有 hard clipping`);
        }
        enqueueRequests.push({unitId, supersedesJobId: originalJobId});
      }
      if (enqueueRequests.length > 0) {
        const enqueued = enqueueNarrationAudioQcReplacementJobs(projectId, enqueueRequests, {
          expectedPlan: {artifactId: plan.id, version: plan.version},
          voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
          referenceSha256: resolvedVoice.referenceSha256 ?? undefined,
        });
        for (const job of enqueued.jobs) waitJobIds.add(job.jobId);
      }
      if (waitJobIds.size > 0) {
        await waitFor(timeoutMs(args), async () => {
          const rows = [...waitJobIds].map((jobId) => getTtsJob(jobId));
          const failed = rows.find((row) => row?.status === 'failed' || row?.status === 'cancelled');
          if (failed) {
            throw new CliError('TTS_TERMINAL_FAILURE', `QC replacement ${failed.id} status=${failed.status}`);
          }
          return rows.every((row) => row?.status === 'succeeded') ? rows : null;
        });
      }
    }
    if (selectedReplacementJobs.size !== requestedUnits.length) {
      throw new CliError('PROVIDER_SEGMENT_CLIPPING_BLOCKER', '未能获得全部 clean QC replacements');
    }

    const selectedTtsJobIds = Object.fromEntries(
      [...originalSpeech].map(([unitId, unit]) => [unitId, selectedReplacementJobs.get(unitId) ?? unit.ttsJobId]),
    );
    const manifest = tryFinalizeNarrationAudio(projectId, {
      expectedPlan: {artifactId: plan.id, version: plan.version},
      voiceProfile: {id: resolvedVoice.id, revision: resolvedVoice.revision},
      referenceSha256: resolvedVoice.referenceSha256,
      repair: {
        reason: 'AUDIO_QC_CLIPPING',
        supersedes,
        preResampleHeadroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB,
        selectedTtsJobIds,
        replacedSegments: requestedUnits,
      },
    });
    const audio = getCurrentNarrationAudioArtifact(projectId, voiceOptions);
    if (!manifest || !audio || audio.manifest.repair?.supersedes.id !== supersedes.id) {
      throw new CliError('AUDIO_FINALIZE_FAILED', 'QC replacement repaired audio artifact 未形成');
    }
    const masterClipping = analyzeS16WavHardClipping(path.join(getDataDir(), audio.manifest.master.filePath));
    if (masterClipping.fullScaleSamples !== 0 || masterClipping.saturationRuns !== 0) {
      throw new CliError('MASTER_HARD_CLIPPING', 'repaired master hard clipping gate failed');
    }
    return {
      ok: true,
      command: 'tts',
      mode: 'qc-replacement',
      plan,
      supersedesAudio: supersedes,
      requestedUnits,
      replacementEvidence,
      repair: {
        headroomDb: NARRATION_AUDIO_REPAIR_HEADROOM_DB,
        reusedSegments: originalSpeech.size - requestedUnits.length,
        replacedSegments: requestedUnits.length,
      },
      result: {status: 'ready', audio: {artifact: audio.artifact, manifest: audio.manifest}, masterClipping},
    };
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
  const exportArtifactRaw = args.values.get('artifact');
  const exportDirRaw = args.values.get('export-dir');
  if ((exportArtifactRaw && !exportDirRaw) || (!exportArtifactRaw && exportDirRaw)) {
    throw new CliError('MISSING_ARGUMENT', '--artifact 与 --export-dir 必须同时提供');
  }
  if (exactAudioRow.kind === NARRATION_AUDIO_V2_ARTIFACT_KIND) {
    const exactAudioV2 = await getExactNarrationAudioV2Artifact(projectId, {
      artifactId: audio.id,
      version: audio.version,
    });
    if (!exactAudioV2) throw new CliError('AUDIO_SOURCE_MISMATCH', `exact narration audio v2 无效或不匹配: ${audio.id}@${audio.version}`);
    if (exportArtifactRaw && exportDirRaw) {
      const subtitleIdentity = parseIdentity(exportArtifactRaw, '--artifact');
      const subtitleRow = artifactRow(projectId, subtitleIdentity);
      if (subtitleRow.kind !== 'subtitle_timing_v2') {
        throw new CliError('SOURCE_MISMATCH', `exact artifact 不是 subtitle_timing_v2: ${subtitleIdentity.id}@${subtitleIdentity.version}`);
      }
      const exactSubtitle = getExactSubtitleTimingV2Artifact(projectId, {
        artifactId: subtitleIdentity.id,
        version: subtitleIdentity.version,
      }, exactAudioV2);
      if (!exactSubtitle) {
        throw new CliError('SOURCE_MISMATCH', `exact subtitle/audio source chain 无效: ${subtitleIdentity.id}@${subtitleIdentity.version}`);
      }
      const outputDir = path.resolve(exportDirRaw);
      fs.mkdirSync(outputDir, {recursive: true});
      const sidecars = buildSubtitleTimingV2Sidecars(exactSubtitle.timing);
      const files: Record<string, string> = {};
      for (const [filename, content] of Object.entries(sidecars)) {
        const outputPath = path.join(outputDir, filename);
        fs.writeFileSync(outputPath, content, 'utf8');
        files[filename] = outputPath;
      }
      return {
        ok: true,
        command: 'subtitles',
        mode: 'v2-exact-export',
        source: {audio, subtitles: subtitleIdentity},
        master: {
          sha256: exactSubtitle.timing.source.masterSha256,
          durationMs: exactSubtitle.timing.source.masterDurationMs,
        },
        files,
      };
    }
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
  const choreographyRaw = args.values.get('choreography');
  const choreography = choreographyRaw ? parseIdentity(choreographyRaw, '--choreography') : undefined;
  projectRow(projectId);
  const result = await buildVisualSourceV2({
    projectId,
    designScenes: design,
    narrationPlanV2: plan,
    narrationAudioV2: audio,
    subtitleTimingV2: subtitles,
    choreography,
  });
  return {
    ok: true,
    command: 'visuals',
    sources: {design, plan, audio, subtitles, ...(choreography ? {choreography} : {})},
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
  const subtitleModeRaw = args.values.get('subtitle-mode');
  if (subtitleModeRaw && subtitleModeRaw !== 'none' && subtitleModeRaw !== 'burned') {
    throw new CliError('INVALID_ARGUMENT', '--subtitle-mode 必须是 none 或 burned');
  }
  const subtitleMode = resolveProductionSubtitleMode(subtitleModeRaw as 'none' | 'burned' | undefined);
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
    }, {subtitleMode});
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
      subtitleMode,
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

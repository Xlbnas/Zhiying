/**
 * Production wrappers for Narration Audio V2 + Subtitle Timing V2.
 * Uses only deterministic local WAV fixtures; never calls/enqueues a provider.
 */
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m71-audio-subtitle-v2');
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDataDir, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import type {WorkflowStage} from '../src/lib/workflow/types';
import {buildNarrationPlanV2} from '../src/lib/narration/plan-v2';
import {
  getExactNarrationAudioV2Artifact,
  NarrationAudioV2Error,
  tryFinalizeNarrationAudioV2,
  type FinalizeNarrationAudioV2Input,
  type TtsProviderSnapshot,
} from '../src/lib/narration/audio-v2';
import {buildMockWav} from '../src/lib/tts/mock';
import type {TtsJobResult} from '../src/lib/tts-jobs';
import {
  buildSubtitleTimingV2,
  getExactSubtitleTimingV2Artifact,
  SubtitleTimingV2Error,
} from '../src/lib/subtitles/timing-v2';
import {NARRATION_AUDIO_V2_ARTIFACT_KIND} from '../src/lib/narration/audio-v2-manifest';
import {
  buildVisualSourceV2,
  DARK_EDITORIAL_V1_CHOREOGRAPHY,
  DARK_EDITORIAL_V1_RENDERER_VERSION,
  getExactVisualSourceV2Artifact,
  V2_VISUAL_R2_CHOREOGRAPHY,
  V2_VISUAL_R2_RENDERER_VERSION,
  VisualSourceV2Error,
} from '../src/lib/visual-source-v2';
import {buildTimingReconciliationV2, getExactTimingReconciliationV2} from '../src/lib/reconciliation/timing-v2';
import {buildFinalRenderPropsV2, enqueueFinalRenderV2} from '../src/lib/final-render/bridge-v2';
import {buildSubtitleTimingV2Sidecars} from '../src/lib/subtitles/renderer';
import {stageRuntimeNarrationAudio} from '../src/worker/runtime-audio';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';

let pass = 0;
let fail = 0;
const ok = (condition: boolean, label: string, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
};

async function expectCode(code: string, action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action();
    ok(false, label, '意外成功');
  } catch (error) {
    ok(
      (error instanceof NarrationAudioV2Error || error instanceof SubtitleTimingV2Error) && error.code === code,
      label,
      error instanceof Error ? `${error.name}: ${(error as {code?: string}).code ?? ''} ${error.message}` : error,
    );
  }
}

const SNAPSHOT: TtsProviderSnapshot = {
  name: 'mock',
  model: 'mock-tone-v1',
  providerVersion: null,
  providerCommit: 'mock-deterministic',
};
const VOICE = {id: 'xlbnas', revision: '1'};
const REFERENCE_BYTES = Buffer.from('deterministic-reference-fixture');
const REFERENCE_SHA = crypto.createHash('sha256').update(REFERENCE_BYTES).digest('hex');
const UPSTREAM: WorkflowStage[] = ['project_definition', 'research', 'evidence', 'argument_tree', 'script_v1'];

function scriptWith25Speech(): string {
  return [
    '# Script V2',
    '',
    '## 第 1 章 T（00:00–05:00）',
    '',
    ...Array.from({length: 25}, (_, index) => `第${index + 1}条独立旁白。\n`),
  ].join('\n');
}

function projectWithPlan(
  topic: string,
  script = scriptWith25Speech(),
): ReturnType<typeof buildNarrationPlanV2> & {projectId: string} {
  const projectId = createProjectWithWorkflow({topic, coreQuestion: 'q'}).project.id;
  for (const stage of UPSTREAM) {
    generateVersion({projectId, stage, content: `# ${stage}`, contentType: 'markdown', source: 'manual_edit'});
    lockStage(projectId, stage);
  }
  generateVersion({
    projectId,
    stage: 'script_v2',
    content: script,
    contentType: 'markdown',
    source: 'manual_edit',
    promptVersion: 'script-v2@2.0',
  });
  lockStage(projectId, 'script_v2');
  return {...buildNarrationPlanV2(projectId), projectId};
}

function insertSucceededSources(fixture: ReturnType<typeof projectWithPlan>): Map<string, string> {
  const ids = new Map<string, string>();
  const now = new Date().toISOString();
  for (const unit of fixture.plan.units) {
    if (unit.kind !== 'speech') continue;
    const id = crypto.randomUUID();
    const rel = path.posix.join('projects', fixture.projectId, 'audio', `${id}.wav`);
    const abs = path.join(getDataDir(), rel);
    const wav = buildMockWav(unit.spokenText, unit.id);
    fs.mkdirSync(path.dirname(abs), {recursive: true});
    fs.writeFileSync(abs, wav);
    const durationMs = Math.round(((wav.length - 44) / 2 / 48000) * 1000);
    const sha = crypto.createHash('sha256').update(wav).digest('hex');
    const result: TtsJobResult = {
      provider: SNAPSHOT.name,
      model: SNAPSHOT.model,
      providerVersion: SNAPSHOT.providerVersion,
      providerCommit: SNAPSHOT.providerCommit,
      settings: {
        voiceProfileId: VOICE.id,
        voiceProfileRevision: VOICE.revision,
        useRandom: false,
        referenceSha256: REFERENCE_SHA,
      },
      audio: {codec: 'pcm_s16le', sampleRate: 48000, channels: 1},
    };
    const payload = {
      schemaVersion: '1.0',
      narrationPlanArtifactId: 'legacy-source-plan',
      narrationPlanArtifactVersion: 1,
      scriptV2Version: 1,
      compilerVersion: '1.0',
      unitId: unit.id,
      unitText: unit.spokenText,
      referenceAudioSha256: REFERENCE_SHA,
    };
    getDb().prepare(
      `INSERT INTO tts_jobs (
        id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
        provider, voice_profile_id, voice_profile_revision, status, payload_json,
        output_path, duration_ms, audio_sha256, result_json, queued_at, finished_at,
        attempt, max_attempts
      ) VALUES (?, ?, 'legacy-source-plan', 1, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, 1, 2)`,
    ).run(
      id, fixture.projectId, unit.id, SNAPSHOT.name, VOICE.id, VOICE.revision,
      JSON.stringify(payload), rel, durationMs, sha, JSON.stringify(result), now, now,
    );
    ids.set(unit.id, id);
  }
  return ids;
}

function requestFor(fixture: ReturnType<typeof projectWithPlan>): FinalizeNarrationAudioV2Input {
  return {
    projectId: fixture.projectId,
    narrationPlanV2ArtifactId: fixture.artifact.id,
    narrationPlanV2ArtifactVersion: fixture.artifact.version,
    provider: SNAPSHOT,
    voiceProfile: VOICE,
    referenceSha256: REFERENCE_SHA,
  };
}

async function main(): Promise<void> {
  fs.rmSync(getDataDir(), {recursive: true, force: true});
  const voiceRoot = path.join(getDataDir(), 'voices');
  const registryPath = path.join(getDataDir(), 'voice-registry.json');
  fs.mkdirSync(voiceRoot, {recursive: true});
  fs.writeFileSync(path.join(voiceRoot, 'xlbnas.wav'), REFERENCE_BYTES);
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: '1.1',
    voices: [{
      voiceProfile: VOICE.id,
      voiceRevision: VOICE.revision,
      referenceAssetPath: '/voices/xlbnas.wav',
      referenceSha256: REFERENCE_SHA,
    }],
  }));
  process.env.ZHIYING_ACTIVE_REGISTRY_PATH = registryPath;
  process.env.ZHIYING_LEGACY_VOICE_ROOT_DIR = voiceRoot;
  const fixture = projectWithPlan('audio-v2-finalizer');
  const sourceIds = insertSucceededSources(fixture);
  const request = requestFor(fixture);
  const beforeJobs = (getDb().prepare('SELECT COUNT(*) AS count FROM tts_jobs WHERE project_id = ?').get(fixture.projectId) as {count: number}).count;

  const first = await tryFinalizeNarrationAudioV2(request);
  ok(fixture.plan.units.filter((unit) => unit.kind === 'speech').length === 25, '[A1] fixture/exact plan 有 25 个 speech units');
  ok(first.resolvedSources === 25 && first.decisions.every((decision) => decision.decision === 'reuse'), '[A2] exact 25/25 resolved source set → finalize PASS');
  ok(first.active === 0 && first.decisions.filter((decision) => decision.decision === 'rebuild').length === 0, '[A3] rebuild=0 active=0');
  const n012Manifest = first.manifest.units.find((unit) => unit.unitId === 'N012');
  ok(n012Manifest?.kind === 'speech' && n012Manifest.ttsJobId === sourceIds.get('N012'), '[A4] corrected N012 exact source included');
  const afterJobs = (getDb().prepare('SELECT COUNT(*) AS count FROM tts_jobs WHERE project_id = ?').get(fixture.projectId) as {count: number}).count;
  ok(beforeJobs === afterJobs, '[A5] FINALIZE_ONLY_ENQUEUED_JOBS=0');
  const n001Result = JSON.parse((getDb().prepare('SELECT result_json FROM tts_jobs WHERE id = ?').get(sourceIds.get('N001')) as {result_json: string}).result_json) as {settings: {referenceSha256?: string}};
  ok(n001Result.settings.referenceSha256 === REFERENCE_SHA, '[A6] exact reference SHA remains provable through persisted source job');
  ok(first.manifest.master.durationMs > 0 && first.manifest.master.sampleRate === 48000 && first.manifest.master.channels === 1, '[A7] master facts from physical probe');

  const second = await tryFinalizeNarrationAudioV2(request);
  ok(second.reused && second.artifact.id === first.artifact.id && second.manifest.master.filePath === first.manifest.master.filePath, '[A8] second exact finalize reuses same artifact/master');
  const exactRead = await getExactNarrationAudioV2Artifact(fixture.projectId, {artifactId: first.artifact.id, version: first.artifact.version});
  ok(exactRead?.manifest.master.sha256 === first.manifest.master.sha256, '[A9] exact Audio V2 read validates artifact/media');

  await expectCode('NARRATION_PLAN_V2_NOT_FOUND', () => tryFinalizeNarrationAudioV2({...request, narrationPlanV2ArtifactId: crypto.randomUUID()}), '[A10a] wrong plan id fail closed');
  await expectCode('NARRATION_PLAN_V2_NOT_FOUND', () => tryFinalizeNarrationAudioV2({...request, narrationPlanV2ArtifactVersion: request.narrationPlanV2ArtifactVersion + 1}), '[A10] wrong plan version fail closed');
  const other = projectWithPlan('cross-project');
  await expectCode('NARRATION_PLAN_V2_NOT_FOUND', () => tryFinalizeNarrationAudioV2({...request, projectId: other.projectId}), '[A11] cross-project plan fail closed');
  await expectCode('V2_SOURCE_SET_INCOMPLETE', () => tryFinalizeNarrationAudioV2({...request, voiceProfile: {id: 'wrong', revision: '1'}}), '[A12] wrong voice/revision fail closed');
  await expectCode('V2_SOURCE_INVALID', () => tryFinalizeNarrationAudioV2({...request, referenceSha256: '5'.repeat(64)}), '[A13] wrong reference SHA fail closed');

  const n001 = sourceIds.get('N001')!;
  const originalPayload = (getDb().prepare('SELECT payload_json FROM tts_jobs WHERE id = ?').get(n001) as {payload_json: string}).payload_json;
  const badFingerprintPayload = {
    schemaVersion: 'tts-payload@1.1',
    narrationPlanArtifactId: fixture.artifact.id,
    narrationPlanArtifactVersion: fixture.artifact.version,
    scriptV2Version: fixture.plan.source.scriptV2Version,
    compilerVersion: '2.0',
    unitId: 'N001',
    spokenText: (fixture.plan.units[0] as {spokenText: string}).spokenText,
    delivery: 'normal',
    ttsInputFingerprint: `sha256:${'0'.repeat(64)}`,
    referenceAudioSha256: REFERENCE_SHA,
  };
  getDb().prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(badFingerprintPayload), n001);
  await expectCode('V2_SOURCE_SET_INCOMPLETE', () => tryFinalizeNarrationAudioV2(request), '[A14] fingerprint mismatch fail closed');
  getDb().prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run(originalPayload, n001);

  const n002 = sourceIds.get('N002')!;
  const n002Row = getDb().prepare('SELECT output_path, audio_sha256, result_json FROM tts_jobs WHERE id = ?').get(n002) as {output_path: string; audio_sha256: string; result_json: string};
  const n002Abs = path.join(getDataDir(), n002Row.output_path);
  fs.renameSync(n002Abs, `${n002Abs}.missing`);
  await expectCode('V2_SOURCE_INVALID', () => tryFinalizeNarrationAudioV2(request), '[A15] WAV missing fail closed');
  fs.renameSync(`${n002Abs}.missing`, n002Abs);
  getDb().prepare('UPDATE tts_jobs SET audio_sha256 = ? WHERE id = ?').run('0'.repeat(64), n002);
  await expectCode('V2_SOURCE_INVALID', () => tryFinalizeNarrationAudioV2(request), '[A16] WAV SHA mismatch fail closed');
  getDb().prepare('UPDATE tts_jobs SET audio_sha256 = ? WHERE id = ?').run(n002Row.audio_sha256, n002);
  getDb().prepare('UPDATE tts_jobs SET result_json = ? WHERE id = ?').run('{bad', n002);
  await expectCode('V2_SOURCE_INVALID', () => tryFinalizeNarrationAudioV2(request), '[A17] invalid result_json fail closed');
  getDb().prepare('UPDATE tts_jobs SET result_json = ? WHERE id = ?').run(n002Row.result_json, n002);
  const n003 = sourceIds.get('N003')!;
  const n003Payload = (getDb().prepare('SELECT payload_json FROM tts_jobs WHERE id = ?').get(n003) as {payload_json: string}).payload_json;
  getDb().prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run('{bad', n003);
  await expectCode('V2_SOURCE_SET_INCOMPLETE', () => tryFinalizeNarrationAudioV2(request), '[A17b] invalid payload_json fail closed');
  getDb().prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run(n003Payload, n003);

  const activeId = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO tts_jobs (
      id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
      provider, voice_profile_id, voice_profile_revision, status, payload_json,
      queued_at, attempt, max_attempts
    ) VALUES (?, ?, ?, ?, 'N001', ?, ?, ?, 'queued', ?, ?, 0, 2)`,
  ).run(activeId, fixture.projectId, fixture.artifact.id, fixture.artifact.version, SNAPSHOT.name, VOICE.id, VOICE.revision, originalPayload, new Date().toISOString());
  await expectCode('V2_SOURCE_ACTIVE', () => tryFinalizeNarrationAudioV2(request), '[A18] active > 0 fail closed');
  getDb().prepare('DELETE FROM tts_jobs WHERE id = ?').run(activeId);

  const n025 = sourceIds.get('N025')!;
  const n025Payload = (getDb().prepare('SELECT payload_json FROM tts_jobs WHERE id = ?').get(n025) as {payload_json: string}).payload_json;
  const changed = {...JSON.parse(n025Payload), unitText: '不匹配文本。'};
  getDb().prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(changed), n025);
  const jobsBeforeIncomplete = (getDb().prepare('SELECT COUNT(*) AS count FROM tts_jobs').get() as {count: number}).count;
  await expectCode('V2_SOURCE_SET_INCOMPLETE', () => tryFinalizeNarrationAudioV2(request), '[A19] rebuildCount > 0 fail closed');
  const jobsAfterIncomplete = (getDb().prepare('SELECT COUNT(*) AS count FROM tts_jobs').get() as {count: number}).count;
  ok(jobsBeforeIncomplete === jobsAfterIncomplete, '[A20] incomplete source set creates zero jobs');
  getDb().prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run(n025Payload, n025);

  const silenceFixture = projectWithPlan('audio-v2-silence', `# Script V2

## 第 1 章 T（00:00–01:00）

第一句。

@pause 500ms

第二句。
`);
  insertSucceededSources(silenceFixture);
  const silenceAudio = await tryFinalizeNarrationAudioV2(requestFor(silenceFixture));
  const silenceUnit = silenceAudio.manifest.units.find((unit) => unit.kind === 'silence');
  const speechDuration = silenceAudio.manifest.units
    .filter((unit) => unit.kind === 'speech')
    .reduce((sum, unit) => sum + unit.durationMs, 0);
  ok(silenceUnit?.durationMs === 500 && silenceUnit.reason === 'pause' && !('ttsJobId' in silenceUnit), '[A21] silence uses exact plan duration/reason and no fake TTS job');
  ok(Math.abs(silenceAudio.manifest.master.durationMs - (speechDuration + 500)) <= 100, '[A22] silence participates in deterministic master timeline');

  const subtitle1 = await buildSubtitleTimingV2({
    projectId: fixture.projectId,
    narrationAudioV2ArtifactId: first.artifact.id,
    narrationAudioV2ArtifactVersion: first.artifact.version,
  });
  ok(subtitle1.timing.source.narrationAudioV2ArtifactId === first.artifact.id && subtitle1.timing.source.narrationAudioV2ArtifactVersion === first.artifact.version, '[S1] subtitle exact source audio id/version');
  ok(subtitle1.timing.source.narrationPlanV2ArtifactId === fixture.artifact.id && subtitle1.timing.source.narrationPlanV2ArtifactVersion === fixture.artifact.version, '[S2] subtitle exact source plan id/version');
  ok(subtitle1.timing.source.masterSha256 === first.manifest.master.sha256 && subtitle1.timing.source.masterDurationMs === first.manifest.master.durationMs, '[S3] subtitle copies exact master SHA/duration');
  const subtitle2 = await buildSubtitleTimingV2({projectId: fixture.projectId, narrationAudioV2ArtifactId: first.artifact.id, narrationAudioV2ArtifactVersion: first.artifact.version});
  ok(subtitle2.reused && subtitle2.artifact.id === subtitle1.artifact.id, '[S4] second exact compile reuses same subtitle artifact');
  ok(getExactSubtitleTimingV2Artifact(
    fixture.projectId,
    {artifactId: subtitle1.artifact.id, version: subtitle1.artifact.version},
    first,
  )?.artifact.id === subtitle1.artifact.id, '[S5] exact Subtitle V2 read validates source chain');

  await expectCode('NARRATION_AUDIO_V2_INVALID', () => buildSubtitleTimingV2({projectId: fixture.projectId, narrationAudioV2ArtifactId: first.artifact.id, narrationAudioV2ArtifactVersion: first.artifact.version + 1}), '[S6] wrong audio version fail closed');
  await expectCode('NARRATION_AUDIO_V2_INVALID', () => buildSubtitleTimingV2({projectId: other.projectId, narrationAudioV2ArtifactId: first.artifact.id, narrationAudioV2ArtifactVersion: first.artifact.version}), '[S7] cross-project audio fail closed');
  await expectCode('NARRATION_AUDIO_V2_INVALID', () => buildSubtitleTimingV2({projectId: fixture.projectId, narrationAudioV2ArtifactId: fixture.artifact.id, narrationAudioV2ArtifactVersion: fixture.artifact.version}), '[S8] wrong audio kind fail closed');

  const tamperedId = crypto.randomUUID();
  const tampered = JSON.parse(JSON.stringify(first.manifest)) as {source: {narrationPlanV2ArtifactId: string}};
  tampered.source.narrationPlanV2ArtifactId = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO artifacts (id, project_id, kind, version, content_json, created_at)
     VALUES (?, ?, ?, 999, ?, ?)`,
  ).run(tamperedId, fixture.projectId, NARRATION_AUDIO_V2_ARTIFACT_KIND, JSON.stringify(tampered), new Date().toISOString());
  await expectCode('NARRATION_AUDIO_V2_INVALID', () => buildSubtitleTimingV2({projectId: fixture.projectId, narrationAudioV2ArtifactId: tamperedId, narrationAudioV2ArtifactVersion: 999}), '[S9] audio manifest ↔ plan mismatch fail closed');

  const runCli = (args: string[]) => spawnSync(
    process.execPath,
    ['--import', 'tsx', path.resolve('src/cli/zhiying.ts'), ...args],
    {cwd: path.resolve('.'), env: {...process.env}, encoding: 'utf8'},
  );
  const jobsBeforeCli = (getDb().prepare('SELECT COUNT(*) AS count FROM tts_jobs').get() as {count: number}).count;
  const noFinalizeFlag = runCli(['tts', '--project', fixture.projectId, '--plan', `${fixture.artifact.id}@${fixture.artifact.version}`, '--voice', 'xlbnas@1']);
  ok(noFinalizeFlag.status !== 0 && JSON.parse(noFinalizeFlag.stdout).error.code === 'FINALIZE_ONLY_REQUIRED', '[C1] V2 CLI requires explicit --finalize-only');
  const cliAudio = runCli(['tts', '--project', fixture.projectId, '--plan', `${fixture.artifact.id}@${fixture.artifact.version}`, '--voice', 'xlbnas@1', '--finalize-only']);
  const cliAudioJson = JSON.parse(cliAudio.stdout) as {schemaVersion?: string; enqueue?: {enqueued?: number}; resolvedSources?: number; result?: {audio?: {artifact?: {id?: string}}}};
  ok(cliAudio.status === 0 && cliAudioJson.schemaVersion === 'narration-audio@2.0' && cliAudioJson.enqueue?.enqueued === 0 && cliAudioJson.resolvedSources === 25 && cliAudioJson.result?.audio?.artifact?.id === first.artifact.id, '[C2] V2 CLI finalize-only routes exact plan and enqueues zero');
  const jobsAfterCli = (getDb().prepare('SELECT COUNT(*) AS count FROM tts_jobs').get() as {count: number}).count;
  ok(jobsAfterCli === jobsBeforeCli, '[C3] V2 CLI finalize-only preserves total TTS job count');
  const cliSubtitle = runCli(['subtitles', '--project', fixture.projectId, '--audio', `${first.artifact.id}@${first.artifact.version}`]);
  const cliSubtitleJson = JSON.parse(cliSubtitle.stdout) as {schemaVersion?: string; artifact?: {id?: string}; timing?: {source?: {narrationAudioV2ArtifactId?: string}}};
  ok(cliSubtitle.status === 0 && cliSubtitleJson.schemaVersion === 'subtitle-timing@2.0' && cliSubtitleJson.artifact?.id === subtitle1.artifact.id && cliSubtitleJson.timing?.source?.narrationAudioV2ArtifactId === first.artifact.id, '[C4] subtitles CLI routes exact Audio V2 and reuses exact Subtitle V2 artifact');

  const exportA = path.join(getDataDir(), 'sidecars-a');
  const exportB = path.join(getDataDir(), 'sidecars-b');
  const cliExportA = runCli(['subtitles', '--project', fixture.projectId, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--artifact', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`, '--export-dir', exportA]);
  const cliExportB = runCli(['subtitles', '--project', fixture.projectId, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--artifact', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`, '--export-dir', exportB]);
  const cliExportJson = JSON.parse(cliExportA.stdout) as {mode?: string; source?: {subtitles?: {id?: string}}; master?: {sha256?: string; durationMs?: number}};
  const expectedSidecars = buildSubtitleTimingV2Sidecars(subtitle1.timing);
  const sidecarNames = Object.keys(expectedSidecars) as Array<keyof typeof expectedSidecars>;
  ok(cliExportA.status === 0 && cliExportB.status === 0 && cliExportJson.mode === 'v2-exact-export' && cliExportJson.source?.subtitles?.id === subtitle1.artifact.id, '[C4a] sidecar CLI consumes explicit exact subtitle identity');
  ok(sidecarNames.every((name) => fs.readFileSync(path.join(exportA, name), 'utf8') === expectedSidecars[name]), '[C4b] SRT/VTT/ASS/JSON text and timing derive from exact artifact');
  ok(sidecarNames.every((name) => fs.readFileSync(path.join(exportA, name)).equals(fs.readFileSync(path.join(exportB, name)))), '[C4c] repeated sidecar export is byte-identical');
  ok(cliExportJson.master?.sha256 === first.manifest.master.sha256 && cliExportJson.master?.durationMs === first.manifest.master.durationMs, '[C4d] sidecar response preserves exact master SHA/duration');
  const wrongSubtitleId = runCli(['subtitles', '--project', fixture.projectId, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--artifact', `${crypto.randomUUID()}@1`, '--export-dir', path.join(getDataDir(), 'wrong-id')]);
  const wrongSubtitleVersion = runCli(['subtitles', '--project', fixture.projectId, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--artifact', `${subtitle1.artifact.id}@${subtitle1.artifact.version + 1}`, '--export-dir', path.join(getDataDir(), 'wrong-version')]);
  const wrongSubtitleProject = runCli(['subtitles', '--project', other.projectId, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--artifact', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`, '--export-dir', path.join(getDataDir(), 'wrong-project')]);
  ok(wrongSubtitleId.status !== 0 && JSON.parse(wrongSubtitleId.stdout).error.code === 'ARTIFACT_NOT_FOUND', '[C4e] sidecar wrong artifact id fails closed');
  ok(wrongSubtitleVersion.status !== 0 && JSON.parse(wrongSubtitleVersion.stdout).error.code === 'VERSION_MISMATCH', '[C4f] sidecar wrong artifact version fails closed');
  ok(wrongSubtitleProject.status !== 0 && JSON.parse(wrongSubtitleProject.stdout).error.code === 'PROJECT_MISMATCH', '[C4g] sidecar cross-project source fails closed');

  const designDuration = 250;
  const design = {
    chapterTiming: [{chapter: 1, title: 'T', start: 0, end: designDuration}],
    scenes: fixture.plan.units.filter((unit) => unit.kind === 'speech').map((unit, index) => ({
      id: `S${String(index + 1).padStart(3, '0')}`,
      chapter: 1,
      chapterTitle: 'T',
      start: index * 10,
      end: (index + 1) * 10,
      duration: 10,
      startFrame: index * 300,
      durationInFrames: 300,
      category: 'Minimal',
      visualType: 'Minimal',
      template: null,
      sourceTemplate: null,
      assetRequirements: [],
      narrationSummary: unit.spokenText,
      description: `scene ${unit.id}`,
      notes: '',
      assetIds: [],
      licenseStatus: 'not-applicable',
      subtitlePosition: 'bottom' as const,
      transitionIn: index === 0 ? 'fade' : 'cut',
      transitionOut: index === 24 ? 'fade-out' : 'cut',
    })),
  };
  const designRow = generateVersion({
    projectId: fixture.projectId,
    stage: 'scenes',
    content: JSON.stringify(design),
    contentType: 'json',
    source: 'manual_edit',
  });
  const visual1 = await buildVisualSourceV2({
    projectId: fixture.projectId,
    designScenes: {id: designRow.id, version: designRow.version},
    narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
    narrationAudioV2: first.artifact,
    subtitleTimingV2: subtitle1.artifact,
  });
  ok(visual1.visual.data.scenes.length === 25 && visual1.visual.unitMappings.length === 25, '[V1] exact V2 visual source maps 25 scenes to 25 units');
  ok(visual1.visual.source.masterSha256 === first.manifest.master.sha256 && visual1.visual.source.masterDurationMs === first.manifest.master.durationMs, '[V2] visual source preserves exact master SHA/duration');
  ok(visual1.visual.data.scenes.at(-1)?.end === first.manifest.master.durationMs / 1000, '[V3] visual timeline ends at exact V2 master duration');
  const visual2 = await buildVisualSourceV2({
    projectId: fixture.projectId,
    designScenes: {id: designRow.id, version: designRow.version},
    narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
    narrationAudioV2: first.artifact,
    subtitleTimingV2: subtitle1.artifact,
  });
  ok(visual2.reused && visual2.artifact.id === visual1.artifact.id, '[V4] exact visual source idempotency');
  ok((await getExactVisualSourceV2Artifact(fixture.projectId, {artifactId: visual1.artifact.id, version: visual1.artifact.version}))?.artifact.id === visual1.artifact.id, '[V5] exact visual source read validates all V2 parents');
  ok(await getExactVisualSourceV2Artifact(fixture.projectId, {artifactId: visual1.artifact.id, version: visual1.artifact.version + 1}) === null, '[V6] wrong visual version fails closed');
  const visualR2 = await buildVisualSourceV2({
    projectId: fixture.projectId,
    designScenes: {id: designRow.id, version: designRow.version},
    narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
    narrationAudioV2: first.artifact,
    subtitleTimingV2: subtitle1.artifact,
    choreography: V2_VISUAL_R2_CHOREOGRAPHY,
  });
  ok(!visualR2.reused && visualR2.artifact.id !== visual1.artifact.id && visualR2.visual.choreography?.beatCount === 44, '[V7] exact choreography creates a distinct visual source');
  ok(visualR2.visual.data.scenes.every((scene) => (scene.templateProps?.v2VisualR2 as {version?: unknown} | undefined)?.version === V2_VISUAL_R2_RENDERER_VERSION), '[V8] exact choreography marker propagates to all scenes');
  ok((await getExactVisualSourceV2Artifact(fixture.projectId, {artifactId: visualR2.artifact.id, version: visualR2.artifact.version}))?.artifact.id === visualR2.artifact.id, '[V9] exact R2 visual source recomputes and validates choreography');
  const visualR2Again = await buildVisualSourceV2({
    projectId: fixture.projectId,
    designScenes: {id: designRow.id, version: designRow.version},
    narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
    narrationAudioV2: first.artifact,
    subtitleTimingV2: subtitle1.artifact,
    choreography: V2_VISUAL_R2_CHOREOGRAPHY,
  });
  ok(visualR2Again.reused && visualR2Again.artifact.id === visualR2.artifact.id, '[V10] exact choreography visual source is idempotent');
  const visualDark = await buildVisualSourceV2({
    projectId: fixture.projectId,
    designScenes: {id: designRow.id, version: designRow.version},
    narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
    narrationAudioV2: first.artifact,
    subtitleTimingV2: subtitle1.artifact,
    choreography: DARK_EDITORIAL_V1_CHOREOGRAPHY,
  });
  ok(!visualDark.reused && visualDark.visual.data.scenes.every((scene) => (scene.templateProps?.v2VisualR2 as {version?: unknown} | undefined)?.version === DARK_EDITORIAL_V1_RENDERER_VERSION), '[V10a] exact dark editorial marker propagates to all scenes');
  ok(Object.values(visualDark.visual.assetMap).flat().length === 7 && visualDark.visual.assetMap.S007?.[0]?.sourceUrl.includes('gutenberg.org') === true, '[V10b] dark editorial exact archive manifest resolves seven provenance-backed assets');
  ok((await getExactVisualSourceV2Artifact(fixture.projectId, {artifactId: visualDark.artifact.id, version: visualDark.artifact.version}))?.artifact.id === visualDark.artifact.id, '[V10c] exact dark editorial visual source recomputes and validates assets');
  const visualDarkAgain = await buildVisualSourceV2({
    projectId: fixture.projectId,
    designScenes: {id: designRow.id, version: designRow.version},
    narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
    narrationAudioV2: first.artifact,
    subtitleTimingV2: subtitle1.artifact,
    choreography: DARK_EDITORIAL_V1_CHOREOGRAPHY,
  });
  ok(visualDarkAgain.reused && visualDarkAgain.artifact.id === visualDark.artifact.id, '[V10d] exact dark editorial visual source is idempotent');
  const darkS007Asset = visualDark.visual.assetMap.S007![0]!;
  getDb().prepare('UPDATE assets SET source_provider = ? WHERE id = ?').run('tampered', darkS007Asset.assetId);
  ok(await getExactVisualSourceV2Artifact(fixture.projectId, {artifactId: visualDark.artifact.id, version: visualDark.artifact.version}) === null, '[V10e] dark editorial archive provenance mutation fails closed');
  getDb().prepare('UPDATE assets SET source_provider = ? WHERE id = ?').run('project_gutenberg', darkS007Asset.assetId);
  try {
    await buildVisualSourceV2({
      projectId: fixture.projectId,
      designScenes: {id: designRow.id, version: designRow.version},
      narrationPlanV2: {id: fixture.artifact.id, version: fixture.artifact.version},
      narrationAudioV2: first.artifact,
      subtitleTimingV2: subtitle1.artifact,
      choreography: {id: 'v2-visual-r2', version: 3},
    });
    ok(false, '[V11] unsupported choreography version fails closed');
  } catch (error) {
    ok(error instanceof VisualSourceV2Error && error.code === 'CHOREOGRAPHY_INVALID', '[V11] unsupported choreography version fails closed');
  }

  const rec1 = buildTimingReconciliationV2(fixture.projectId, {visual: visual1, audio: first, subtitle: subtitle1});
  ok(rec1.reconciliation.source.scenesVersionId === visual1.artifact.id && rec1.reconciliation.source.narrationAudioArtifactId === first.artifact.id && rec1.reconciliation.source.subtitleTimingArtifactId === subtitle1.artifact.id, '[R1] reconciliation persists exact V2 identities');
  ok(rec1.reconciliation.target.totalFrames === Math.round(first.manifest.master.durationMs * 30 / 1000) && rec1.reconciliation.unresolvedNarrationUnitIds.length === 0, '[R2] reconciliation exact duration and unresolved=0');
  ok(getExactTimingReconciliationV2(fixture.projectId, {artifactId: rec1.artifact.id, version: rec1.artifact.version}, {visual: visual1, audio: first, subtitle: subtitle1})?.artifact.id === rec1.artifact.id, '[R3] exact V2 reconciliation read');

  const finalSources = {visual: visual1, audio: first, subtitle: subtitle1, reconciliation: rec1};
  const cleanProps = buildFinalRenderPropsV2({projectId: fixture.projectId, title: 'clean', templateVersion: 'test', src: finalSources, subtitleMode: 'none'});
  const burnedProps = buildFinalRenderPropsV2({projectId: fixture.projectId, title: 'burned', templateVersion: 'test', src: finalSources, subtitleMode: 'burned'});
  const legacyCompatibleProps = buildFinalRenderPropsV2({projectId: fixture.projectId, title: 'legacy', templateVersion: 'test', src: finalSources});
  ok(cleanProps.showSubtitles === false && cleanProps.subtitles.length === subtitle1.timing.cues.length, '[F0a] clean profile hides subtitle track without discarding exact cues');
  ok(burnedProps.showSubtitles === true, '[F0b] burned review profile shows subtitles');
  ok(legacyCompatibleProps.showSubtitles === true, '[F0c] omitted subtitle mode preserves legacy burned behavior');

  const final = enqueueFinalRenderV2(fixture.projectId, finalSources);
  const payload = zhiyingFullCutPropsSchema.parse(JSON.parse(final.job.payload_json));
  ok(payload.audio.narration === `runtime-audio/${fixture.projectId}/${first.artifact.id}.wav` && payload.data.project.durationInFrames === rec1.reconciliation.target.totalFrames, '[F1] frozen final props use exact V2 audio and reconciled frames');
  ok(payload.data.scenes.length === 25 && payload.subtitles.length === subtitle1.timing.cues.length && payload.renderMode === 'final', '[F2] frozen props carry exact visual/subtitle content');
  const fakeBundle = path.join(getDataDir(), 'fake-v2-bundle');
  fs.mkdirSync(fakeBundle, {recursive: true});
  const staged = stageRuntimeNarrationAudio(final.job, payload, fakeBundle);
  ok(staged?.sha256 === first.manifest.master.sha256 && fs.existsSync(staged.stagedPath), '[F3] Worker stages exact narration_audio_manifest_v2 without V1 alias');
  const renderJobs = (getDb().prepare('SELECT COUNT(*) AS count FROM render_jobs WHERE project_id = ?').get(fixture.projectId) as {count: number}).count;
  ok(renderJobs === 1, '[F4] exactly one V2 render job enqueued');

  const cliVisual = runCli(['visuals', '--project', fixture.projectId, '--design', `${designRow.id}@${designRow.version}`, '--plan', `${fixture.artifact.id}@${fixture.artifact.version}`, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--subtitles', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`]);
  const cliVisualJson = JSON.parse(cliVisual.stdout) as {artifact?: {id?: string}; reused?: boolean};
  ok(cliVisual.status === 0 && cliVisualJson.artifact?.id === visual1.artifact.id && cliVisualJson.reused === true, '[C5] visuals CLI routes exact identities and reuses artifact');
  const cliVisualR2 = runCli(['visuals', '--project', fixture.projectId, '--design', `${designRow.id}@${designRow.version}`, '--plan', `${fixture.artifact.id}@${fixture.artifact.version}`, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--subtitles', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`, '--choreography', 'v2-visual-r2@2']);
  const cliVisualR2Json = JSON.parse(cliVisualR2.stdout) as {artifact?: {id?: string}; reused?: boolean; sources?: {choreography?: {id?: string; version?: number}}};
  ok(cliVisualR2.status === 0 && cliVisualR2Json.artifact?.id === visualR2.artifact.id && cliVisualR2Json.reused === true && cliVisualR2Json.sources?.choreography?.version === 2, '[C5-R2] visuals CLI routes explicit exact choreography');
  const cliVisualDark = runCli(['visuals', '--project', fixture.projectId, '--design', `${designRow.id}@${designRow.version}`, '--plan', `${fixture.artifact.id}@${fixture.artifact.version}`, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--subtitles', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`, '--choreography', 'dark-editorial-v1@1']);
  const cliVisualDarkJson = JSON.parse(cliVisualDark.stdout) as {artifact?: {id?: string}; reused?: boolean; sources?: {choreography?: {id?: string; version?: number}}};
  ok(cliVisualDark.status === 0 && cliVisualDarkJson.artifact?.id === visualDark.artifact.id && cliVisualDarkJson.reused === true && cliVisualDarkJson.sources?.choreography?.id === 'dark-editorial-v1', '[C5-R3] visuals CLI routes explicit exact dark editorial profile');
  const cliReconcile = runCli(['reconcile', '--project', fixture.projectId, '--scenes', `${visual1.artifact.id}@${visual1.artifact.version}`, '--audio', `${first.artifact.id}@${first.artifact.version}`, '--subtitles', `${subtitle1.artifact.id}@${subtitle1.artifact.version}`]);
  const cliRecJson = JSON.parse(cliReconcile.stdout) as {mode?: string; artifact?: {id?: string}};
  ok(cliReconcile.status === 0 && cliRecJson.mode === 'v2-exact' && cliRecJson.artifact?.id === rec1.artifact.id, '[C6] reconcile CLI routes exact V2 chain');

  closeDb();
  fs.rmSync(getDataDir(), {recursive: true, force: true});
  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

void main();

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn, spawnSync} from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiying-cli-v1-'));
const cliPath = path.resolve('src/cli/zhiying.ts');
const env = {...process.env, ZHIYING_DATA_DIR: dataDir, TTS_PROVIDER: 'mock', LLM_PROVIDER: 'mock'};
process.env.ZHIYING_DATA_DIR = dataDir;
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';
let passed = 0;

function ok(condition: boolean, message: string, detail?: unknown): void {
  if (!condition) {
    console.error(`FAIL ${message}`, detail ?? '');
    process.exitCode = 1;
    return;
  }
  passed++;
  console.log(`PASS ${message}`);
}

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
}

function runAsync(args: string[]): Promise<{status: number | null; stdout: string; stderr: string}> {
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: path.resolve('.'), env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({status, stdout, stderr}));
  });
}

function jsonOf(result: {stdout: string}): Record<string, any> {
  return JSON.parse(result.stdout.trim()) as Record<string, any>;
}

function waitForDb(condition: () => boolean, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (condition()) return true;
    Atomics.wait(signal, 0, 0, 20);
  }
  return condition();
}

function startRenderWait(
  db: import('better-sqlite3').Database,
  projectId: string,
  renderArgs: string[],
  timeoutSeconds: string,
): {jobId: string; completion: Promise<{status: number | null; stdout: string; stderr: string}>} {
  const priorIds = new Set(
    (db.prepare('SELECT id FROM render_jobs WHERE project_id = ?').all(projectId) as Array<{id: string}>)
      .map((row) => row.id),
  );
  const completion = runAsync([...renderArgs, '--wait', '--timeout-seconds', timeoutSeconds]);
  let jobId: string | null = null;
  const enqueued = waitForDb(() => {
    const rows = db.prepare("SELECT id FROM render_jobs WHERE project_id = ? AND status = 'queued'")
      .all(projectId) as Array<{id: string}>;
    jobId = rows.find((row) => !priorIds.has(row.id))?.id ?? null;
    return jobId !== null;
  });
  if (!enqueued || jobId === null) throw new Error('render --wait did not enqueue an exact job');
  return {jobId, completion};
}

function insertLockedVersion(
  db: import('better-sqlite3').Database,
  projectId: string,
  stage: string,
  version: number,
  content: string,
  contentType: 'markdown' | 'json',
): string {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_versions
       (id, project_id, stage, version, content, content_type, source, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual_edit', NULL, ?)`,
  ).run(id, projectId, stage, version, content, contentType, at);
  db.prepare(
    `UPDATE project_stages
     SET status = 'locked', active_version = ?, locked_version = ?, updated_at = ?
     WHERE project_id = ? AND stage = ?`,
  ).run(version, version, at, projectId, stage);
  return id;
}

function counts(db: import('better-sqlite3').Database, projectId: string) {
  const scalar = (sql: string): number =>
    (db.prepare(sql).get(projectId) as {c: number}).c;
  return {
    reconciliation: scalar("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'timing_reconciliation'"),
    finalSource: scalar("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'final_render_source'"),
    finalAttempt: scalar("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'final_render_attempt'"),
    renderJobs: scalar('SELECT COUNT(*) AS c FROM render_jobs WHERE project_id = ?'),
  };
}

const SCRIPT_A = `# Script V2

## 第 1 章 开场

这是第一句。`;

const SCRIPT_B = `# Script V2

## 第 1 章 开场

这是第二句。`;

async function main(): Promise<void> {
  try {
    const {getDb} = await import('../src/lib/db');
    const {initProjectStages} = await import('../src/lib/workflow/stages');
    const {createProjectWithWorkflow} = await import('../src/lib/projects');
    const {buildNarrationPlan} = await import('../src/lib/narration/plan');
    const {getCurrentNarrationAudioArtifact, tryFinalizeNarrationAudio} = await import('../src/lib/narration/audio');
    const {getCurrentSubtitleTiming} = await import('../src/lib/subtitles/timing');
    const {getCurrentTimingReconciliation} = await import('../src/lib/reconciliation/timing');
    const {MOCK_FIXTURES} = await import('../src/lib/prompts/fixtures');
    const {claimNextAnyJob} = await import('../src/lib/scheduler');
    const {runTtsJob} = await import('../src/worker/tts-executor');
    const {releaseResourceLeaseForJob} = await import('../src/lib/resources/leases');
    const {resetTtsProviderForTest} = await import('../src/lib/tts');
    const {persistRenderArtifact, probeRenderOutput, sha256File} = await import('../src/lib/render/artifact');
    const db = getDb();
    resetTtsProviderForTest();

    db.prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id, current_stage, created_at, updated_at)
       VALUES (?, ?, 'rigorous', '1.0', 'test-v1', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    ).run('cli-project', 'CLI test project', new Date().toISOString(), new Date().toISOString());
    initProjectStages('cli-project');
    db.prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('cli-artifact', 'cli-project', 'test_artifact', 2, JSON.stringify({source: 'fixture'}), new Date().toISOString());

    const valid = run(['inspect', '--project', 'cli-project', '--artifact', 'cli-artifact@2']);
    ok(valid.status === 0 && jsonOf(valid).artifact.id === 'cli-artifact', 'inspect exact artifact returns JSON');
    const wrongVersion = run(['inspect', '--project', 'cli-project', '--artifact', 'cli-artifact@1']);
    ok(wrongVersion.status !== 0 && jsonOf(wrongVersion).error.code === 'VERSION_MISMATCH', 'inspect wrong version fails closed');
    const missingProject = run(['inspect']);
    ok(missingProject.status !== 0 && jsonOf(missingProject).error.code === 'MISSING_ARGUMENT', 'inspect missing project is rejected');
    const invalidVoice = run(['tts', '--project', 'cli-project', '--plan', 'cli-artifact@2', '--voice', 'custom']);
    ok(invalidVoice.status !== 0 && jsonOf(invalidVoice).error.code === 'VOICE_NOT_READY', 'invalid TTS voice fails closed');
    const mismatch = run(['inspect', '--project', 'other-project', '--artifact', 'cli-artifact@2']);
    ok(mismatch.status !== 0 && jsonOf(mismatch).error.code === 'PROJECT_NOT_FOUND', 'inspect mismatched project fails closed');

    const projectId = createProjectWithWorkflow({topic: 'CLI contract', coreQuestion: 'Exact identity?'}).project.id;
    insertLockedVersion(db, projectId, 'script_v2', 1, SCRIPT_A, 'markdown');
    const planA = buildNarrationPlan(projectId).artifact;

    const waiting = runAsync([
      'tts', '--project', projectId, '--plan', `${planA.id}@${planA.version}`,
      '--wait', '--timeout-seconds', '3',
    ]);
    const enqueuedA = waitForDb(() => {
      const row = db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ? AND narration_plan_artifact_id = ?')
        .get(projectId, planA.id) as {c: number};
      return row.c > 0;
    });
    ok(enqueuedA, 'tts exact plan accepted and jobs enqueued through existing queue');

    insertLockedVersion(db, projectId, 'script_v2', 2, SCRIPT_B, 'markdown');
    const planB = buildNarrationPlan(projectId).artifact;
    let finalizeMismatchCode: string | null = null;
    try {
      tryFinalizeNarrationAudio(projectId, {expectedPlan: {artifactId: planA.id, version: planA.version}});
    } catch (error) {
      finalizeMismatchCode = (error as {code?: string}).code ?? null;
    }
    ok(
      finalizeMismatchCode === 'NARRATION_PLAN_SOURCE_MISMATCH',
      'TTS finalize expected-plan precondition rejects the new current plan',
    );
    const staleWait = await waiting;
    ok(
      staleWait.status !== 0 && jsonOf(staleWait).error.code === 'NARRATION_PLAN_SOURCE_MISMATCH',
      'tts --wait fails when expected plan stops being current', staleWait,
    );
    const audioAfterStaleWait = db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'narration_audio_manifest'")
      .get(projectId) as {c: number};
    ok(audioAfterStaleWait.c === 0, 'stale TTS waiter does not finalize another plan');

    const jobsBefore = (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c;
    const stalePlan = run(['tts', '--project', projectId, '--plan', `${planA.id}@${planA.version}`]);
    const jobsAfter = (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c;
    ok(
      stalePlan.status !== 0 && jsonOf(stalePlan).error.code === 'NARRATION_PLAN_SOURCE_MISMATCH' && jobsAfter === jobsBefore,
      'stale plan is rejected inside enqueue fence before side effects',
    );

    const enqueueB = run(['tts', '--project', projectId, '--plan', `${planB.id}@${planB.version}`]);
    ok(enqueueB.status === 0 && jsonOf(enqueueB).enqueue.enqueued > 0, 'tts current exact plan enqueues via M6 V1');
    const reuseB = run(['tts', '--project', projectId, '--plan', `${planB.id}@${planB.version}`]);
    ok(reuseB.status === 0 && jsonOf(reuseB).enqueue.active > 0, 'tts repeated enqueue reuses active exact jobs');

    const CTX = {isShuttingDown: () => false, log: () => {}};
    for (;;) {
      const claimed = claimNextAnyJob('w-cli-v1');
      if (!claimed) break;
      if (claimed.type !== 'tts') throw new Error(`unexpected job type: ${claimed.type}`);
      try {
        await runTtsJob(claimed.job, CTX);
      } finally {
        releaseResourceLeaseForJob('production_gpu', 'tts', claimed.job.id);
      }
    }
    const readyB = run([
      'tts', '--project', projectId, '--plan', `${planB.id}@${planB.version}`,
      '--wait', '--timeout-seconds', '3',
    ]);
    const readyBJson = jsonOf(readyB);
    ok(
      readyB.status === 0 && readyBJson.result.status === 'ready' &&
        readyBJson.result.audio.manifest.source.narrationPlanArtifactId === planB.id,
      'tts wait returns exact narration-audio@1.0 artifact',
    );
    const audio = getCurrentNarrationAudioArtifact(projectId)!;

    const subtitles = run(['subtitles', '--project', projectId, '--audio', `${audio.artifact.id}@${audio.artifact.version}`]);
    const subtitlesJson = jsonOf(subtitles);
    ok(
      subtitles.status === 0 && subtitlesJson.timing.source.narrationAudioArtifactId === audio.artifact.id,
      'subtitles accepts exact audio and preserves source refs',
    );
    const subtitle = getCurrentSubtitleTiming(projectId)!;
    const wrongAudio = run(['subtitles', '--project', projectId, '--audio', `${planB.id}@${planB.version}`]);
    ok(wrongAudio.status !== 0 && jsonOf(wrongAudio).error.code === 'AUDIO_SOURCE_MISMATCH', 'subtitles rejects mismatched audio');

    const scenesReady = JSON.parse(MOCK_FIXTURES.scenes) as {scenes: Array<Record<string, unknown>>};
    Object.assign(scenesReady.scenes[0]!, {
      category: 'Minimal', visualType: 'Minimal', template: null, sourceTemplate: null,
      assetIds: [], assetRequirements: [], licenseStatus: 'not-applicable',
    });
    const scenesV1Id = insertLockedVersion(db, projectId, 'scenes', 1, JSON.stringify(scenesReady), 'json');
    const reconcileArgs = [
      'reconcile', '--project', projectId, '--scenes', `${scenesV1Id}@1`,
      '--audio', `${audio.artifact.id}@${audio.artifact.version}`,
      '--subtitles', `${subtitle.artifact.id}@${subtitle.artifact.version}`,
    ];
    const reconcile = run(reconcileArgs);
    const reconcileJson = jsonOf(reconcile);
    ok(
      reconcile.status === 0 && reconcileJson.reconciliation.source.scenesVersionId === scenesV1Id &&
        reconcileJson.reconciliation.source.narrationAudioArtifactId === audio.artifact.id &&
        reconcileJson.reconciliation.source.subtitleTimingArtifactId === subtitle.artifact.id,
      'reconcile exact sources produce exact output refs',
    );
    const reconciliation = getCurrentTimingReconciliation(projectId)!;
    const recCount = counts(db, projectId).reconciliation;
    const reconcileMismatch = run(reconcileArgs.map((value) => value === `${scenesV1Id}@1` ? `${scenesV1Id}@2` : value));
    ok(
      reconcileMismatch.status !== 0 && jsonOf(reconcileMismatch).error.code === 'SOURCE_MISMATCH' &&
        counts(db, projectId).reconciliation === recCount,
      'reconcile mismatch fails inside source fence without artifact side effect',
    );

    const renderArgs = [
      'render', '--project', projectId, '--scenes', `${scenesV1Id}@1`,
      '--audio', `${audio.artifact.id}@${audio.artifact.version}`,
      '--subtitles', `${subtitle.artifact.id}@${subtitle.artifact.version}`,
      '--reconciliation', `${reconciliation.artifact.id}@${reconciliation.artifact.version}`,
    ];
    const render = run(renderArgs);
    const renderJson = jsonOf(render);
    ok(
      render.status === 0 && renderJson.result.job.id && renderJson.result.attempt.content.jobId === renderJson.result.job.id,
      'render exact sources reach existing enqueue and exact job/attempt',
    );
    const renderJobId = renderJson.result.job.id as string;
    db.prepare("UPDATE render_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), renderJobId);

    const priorRenderIds = new Set(
      (db.prepare('SELECT id FROM render_jobs WHERE project_id = ?').all(projectId) as Array<{id: string}>).map((row) => row.id),
    );
    const renderWait = runAsync([...renderArgs, '--wait', '--timeout-seconds', '3']);
    let waitedJobId: string | null = null;
    const renderWaitEnqueued = waitForDb(() => {
      const rows = db.prepare("SELECT id FROM render_jobs WHERE project_id = ? AND status = 'queued'")
        .all(projectId) as Array<{id: string}>;
      waitedJobId = rows.find((row) => !priorRenderIds.has(row.id))?.id ?? null;
      return waitedJobId !== null;
    });
    ok(renderWaitEnqueued && waitedJobId !== null, 'render --wait enqueues one new exact job');
    const relOutput = path.posix.join('projects', projectId, 'renders', 'cli-wait-success.mp4');
    const absOutput = path.join(dataDir, relOutput);
    fs.mkdirSync(path.dirname(absOutput), {recursive: true});
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x240:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', absOutput,
    ]);
    const probed = await probeRenderOutput(absOutput);
    persistRenderArtifact({
      job_id: waitedJobId!, project_id: projectId, output_path: relOutput,
      output_sha256: await sha256File(absOutput), output_size: fs.statSync(absOutput).size,
      duration_sec: probed.durationSec, frame_count: null, encoder: probed.codec,
      payload_sha256: null, bundle_key: null,
    });
    db.prepare("UPDATE render_jobs SET status = 'succeeded', progress = 100, output_path = ?, finished_at = ? WHERE id = ?")
      .run(relOutput, new Date().toISOString(), waitedJobId);
    const renderWaitResult = await renderWait;
    const renderWaitJson = jsonOf(renderWaitResult);
    ok(
      renderWaitResult.status === 0 && renderWaitJson.result.job.id === waitedJobId &&
        renderWaitJson.result.manifest.job_id === waitedJobId && renderWaitJson.result.media.path === relOutput,
      'render --wait resolves only its exact successful job and manifest',
    );

    const otherSucceededJobId = waitedJobId;

    const cancelledWait = startRenderWait(db, projectId, renderArgs, '3');
    db.prepare("UPDATE render_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), cancelledWait.jobId);
    const cancelledResult = await cancelledWait.completion;
    const cancelledJson = jsonOf(cancelledResult);
    ok(
      cancelledResult.status !== 0 && cancelledJson.ok !== true &&
        cancelledJson.error.code === 'RENDER_TERMINAL_FAILURE' &&
        cancelledWait.jobId !== otherSucceededJobId && cancelledJson.result === undefined,
      'render --wait cancelled exact job fails without fallback',
    );

    const missingWait = startRenderWait(db, projectId, renderArgs, '3');
    db.prepare("UPDATE render_jobs SET status = 'succeeded', progress = 100, output_path = NULL, finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), missingWait.jobId);
    const missingResult = await missingWait.completion;
    const missingJson = jsonOf(missingResult);
    ok(
      missingResult.status !== 0 && missingJson.ok !== true &&
        missingJson.error.code === 'ARTIFACT_UNVALIDATED' && missingJson.result === undefined,
      'render --wait succeeded exact job without result fails closed',
    );

    const mismatchWait = startRenderWait(db, projectId, renderArgs, '3');
    const mismatchRelOutput = path.posix.join('projects', projectId, 'renders', 'cli-wait-sha-mismatch.mp4');
    const mismatchAbsOutput = path.join(dataDir, mismatchRelOutput);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x240:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mismatchAbsOutput,
    ]);
    const mismatchProbe = await probeRenderOutput(mismatchAbsOutput);
    persistRenderArtifact({
      job_id: mismatchWait.jobId, project_id: projectId, output_path: mismatchRelOutput,
      output_sha256: '0'.repeat(64), output_size: fs.statSync(mismatchAbsOutput).size,
      duration_sec: mismatchProbe.durationSec, frame_count: null, encoder: mismatchProbe.codec,
      payload_sha256: null, bundle_key: null,
    });
    db.prepare("UPDATE render_jobs SET status = 'succeeded', progress = 100, output_path = ?, finished_at = ? WHERE id = ?")
      .run(mismatchRelOutput, new Date().toISOString(), mismatchWait.jobId);
    const mismatchResult = await mismatchWait.completion;
    const mismatchJson = jsonOf(mismatchResult);
    ok(
      mismatchResult.status !== 0 && mismatchJson.ok !== true &&
        mismatchJson.error.code === 'MEDIA_MANIFEST_MISMATCH' && mismatchJson.result === undefined,
      'render --wait rejects exact result with manifest/media SHA mismatch',
    );

    const timeoutStartedAt = Date.now();
    const timeoutWait = startRenderWait(db, projectId, renderArgs, '1');
    const timeoutResult = await timeoutWait.completion;
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    const timeoutJson = jsonOf(timeoutResult);
    const timeoutJob = db.prepare('SELECT status FROM render_jobs WHERE id = ?').get(timeoutWait.jobId) as {status: string};
    ok(
      timeoutResult.status !== 0 && timeoutJson.ok !== true && timeoutJson.error.code === 'TIMEOUT' &&
        timeoutElapsedMs < 5000 && timeoutJob.status === 'queued' && timeoutJson.result === undefined,
      'render --wait times out quickly while exact job remains non-terminal',
    );
    db.prepare("UPDATE render_jobs SET status = 'cancelled', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), timeoutWait.jobId);

    const otherSucceededJob = db.prepare('SELECT status FROM render_jobs WHERE id = ?').get(otherSucceededJobId) as {status: string};
    ok(
      otherSucceededJob.status === 'succeeded' &&
        [cancelledJson, missingJson, mismatchJson, timeoutJson].every((value) => value.ok !== true && value.result === undefined),
      'render wait failures never fallback to another succeeded job',
    );

    const beforeRenderMismatch = counts(db, projectId);
    const renderMismatch = run(renderArgs.map((value) => value === `${scenesV1Id}@1` ? `${scenesV1Id}@2` : value));
    ok(
      renderMismatch.status !== 0 && jsonOf(renderMismatch).error.code === 'SOURCE_MISMATCH' &&
        JSON.stringify(counts(db, projectId)) === JSON.stringify(beforeRenderMismatch),
      'render mismatch fails before source/job/attempt side effects',
    );

    const scenesBlocked = JSON.parse(MOCK_FIXTURES.scenes) as {scenes: Array<Record<string, unknown>>};
    const scenesV2Id = insertLockedVersion(db, projectId, 'scenes', 2, JSON.stringify(scenesBlocked), 'json');
    const recBlocked = run([
      'reconcile', '--project', projectId, '--scenes', `${scenesV2Id}@2`,
      '--audio', `${audio.artifact.id}@${audio.artifact.version}`,
      '--subtitles', `${subtitle.artifact.id}@${subtitle.artifact.version}`,
    ]);
    const recBlockedJson = jsonOf(recBlocked);
    ok(recBlocked.status === 0, 'reconcile remains independent of asset acquisition');
    const beforeAssetBlock = counts(db, projectId);
    const assetBlocked = run([
      'render', '--project', projectId, '--scenes', `${scenesV2Id}@2`,
      '--audio', `${audio.artifact.id}@${audio.artifact.version}`,
      '--subtitles', `${subtitle.artifact.id}@${subtitle.artifact.version}`,
      '--reconciliation', `${recBlockedJson.artifact.id}@${recBlockedJson.artifact.version}`,
    ]);
    ok(
      assetBlocked.status !== 0 && jsonOf(assetBlocked).error.code === 'VISUAL_READINESS_FAILED' &&
        JSON.stringify(counts(db, projectId)) === JSON.stringify(beforeAssetBlock),
      'render preserves asset readiness gate with zero enqueue side effects',
    );

    const inspectJob = run(['inspect', '--project', projectId, '--job', renderJobId]);
    ok(inspectJob.status === 0 && jsonOf(inspectJob).job.row.id === renderJobId, 'inspect resolves exact job without fallback');
    const missingJob = run(['inspect', '--project', projectId, '--job', 'missing-job']);
    ok(missingJob.status !== 0 && jsonOf(missingJob).error.code === 'JOB_NOT_FOUND', 'inspect missing exact job fails closed');

    const malformedCases: Array<[string, string[]]> = [
      ['tts', ['tts', '--project', projectId, '--plan', 'bad']],
      ['subtitles', ['subtitles', '--project', projectId, '--audio', 'bad']],
      ['reconcile', ['reconcile', '--project', projectId, '--scenes', 'bad', '--audio', `${audio.artifact.id}@${audio.artifact.version}`, '--subtitles', `${subtitle.artifact.id}@${subtitle.artifact.version}`]],
      ['render', ['render', '--project', projectId, '--scenes', 'bad', '--audio', `${audio.artifact.id}@${audio.artifact.version}`, '--subtitles', `${subtitle.artifact.id}@${subtitle.artifact.version}`, '--reconciliation', `${reconciliation.artifact.id}@${reconciliation.artifact.version}`]],
    ];
    for (const [command, args] of malformedCases) {
      const result = run(args);
      ok(result.status !== 0 && jsonOf(result).error.code === 'MALFORMED_IDENTITY', `${command} malformed identity is rejected`);
    }

    const failedProject = createProjectWithWorkflow({topic: 'CLI failure', coreQuestion: 'Terminal?'}).project.id;
    insertLockedVersion(db, failedProject, 'script_v2', 1, SCRIPT_A, 'markdown');
    const failedPlan = buildNarrationPlan(failedProject).artifact;
    const initialFailed = run(['tts', '--project', failedProject, '--plan', `${failedPlan.id}@${failedPlan.version}`]);
    ok(initialFailed.status === 0, 'terminal failure fixture enqueued');
    db.prepare("UPDATE tts_jobs SET status = 'failed', error_message = 'fixture failure', finished_at = ? WHERE project_id = ?")
      .run(new Date().toISOString(), failedProject);
    const terminalFailure = run(['tts', '--project', failedProject, '--plan', `${failedPlan.id}@${failedPlan.version}`]);
    ok(
      terminalFailure.status !== 0 && jsonOf(terminalFailure).error.code === 'TTS_TERMINAL_FAILURE',
      'TTS terminal failure exits non-zero',
    );

    console.log(`CLI V1 tests: ${passed} PASS`);
  } finally {
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
}

void main().then(() => {
  if (process.exitCode) process.exit(process.exitCode);
});

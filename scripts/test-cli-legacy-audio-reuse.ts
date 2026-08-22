import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiying-cli-legacy-audio-'));
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
  return spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli/zhiying.ts'), ...args], {
    cwd: path.resolve('.'), env, encoding: 'utf8',
  });
}

function jsonOf(result: {stdout: string}): Record<string, any> {
  return JSON.parse(result.stdout.trim()) as Record<string, any>;
}

function insertLockedVersion(
  db: import('better-sqlite3').Database,
  projectId: string,
  version: number,
  content: string,
): string {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO project_versions
       (id, project_id, stage, version, content, content_type, source, prompt_version, created_at)
     VALUES (?, ?, 'script_v2', ?, ?, 'markdown', 'manual_edit', NULL, ?)`,
  ).run(id, projectId, version, content, at);
  db.prepare(
    `UPDATE project_stages
     SET status = 'locked', active_version = ?, locked_version = ?, updated_at = ?
     WHERE project_id = ? AND stage = 'script_v2'`,
  ).run(version, version, at, projectId);
  return id;
}

async function main(): Promise<void> {
  try {
    const {getDb} = await import('../src/lib/db');
    const {createProjectWithWorkflow} = await import('../src/lib/projects');
    const {buildNarrationPlan} = await import('../src/lib/narration/plan');
    const {enqueueNarrationAudioJobs, tryFinalizeNarrationAudio} = await import('../src/lib/narration/audio');
    const {claimNextAnyJob} = await import('../src/lib/scheduler');
    const {runTtsJob} = await import('../src/worker/tts-executor');
    const {releaseResourceLeaseForJob} = await import('../src/lib/resources/leases');
    const {resetTtsProviderForTest} = await import('../src/lib/tts');

    resetTtsProviderForTest();
    const db = getDb();
    const projectId = createProjectWithWorkflow({topic: 'legacy exact audio', coreQuestion: 'reuse?'}).project.id;
    insertLockedVersion(db, projectId, 1, '# Script V2\n\n## 第 1 章 测试\n\n这是历史旁白。');
    const plan = buildNarrationPlan(projectId).artifact;
    enqueueNarrationAudioJobs(projectId, {expectedPlan: {artifactId: plan.id, version: plan.version}});

    const claimed = claimNextAnyJob('legacy-audio-test');
    if (!claimed || claimed.type !== 'tts') throw new Error('legacy fixture did not claim TTS job');
    try {
      await runTtsJob(claimed.job, {isShuttingDown: () => false, log: () => {}});
    } finally {
      releaseResourceLeaseForJob('production_gpu', 'tts', claimed.job.id);
    }

    const planContent = JSON.parse(
      (db.prepare('SELECT content_json FROM artifacts WHERE id = ?').get(plan.id) as {content_json: string}).content_json,
    ) as {units: Array<{id: string; text: string}>};
    const markerText = '*【脚本结束】*';
    planContent.units[0]!.text = markerText;
    db.prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(planContent), plan.id);
    const job = db.prepare('SELECT id, payload_json FROM tts_jobs WHERE project_id = ? AND narration_plan_artifact_id = ?')
      .get(projectId, plan.id) as {id: string; payload_json: string};
    const payload = JSON.parse(job.payload_json) as {unitText?: string};
    payload.unitText = markerText;
    db.prepare('UPDATE tts_jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), job.id);

    const historicalManifest = tryFinalizeNarrationAudio(projectId, {
      expectedPlan: {artifactId: plan.id, version: plan.version},
    });
    if (!historicalManifest) throw new Error('legacy fixture did not finalize audio');

    const jobsBeforeReuse = (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c;
    const artifactsBeforeReuse = (db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'narration_audio_manifest'").get(projectId) as {c: number}).c;
    const reused = run(['tts', '--project', projectId, '--plan', `${plan.id}@${plan.version}`, '--wait']);
    const reusedJson = jsonOf(reused);
    const jobsAfterReuse = (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c;
    const artifactsAfterReuse = (db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE project_id = ? AND kind = 'narration_audio_manifest'").get(projectId) as {c: number}).c;
    ok(
      reused.status === 0 && reusedJson.result.status === 'ready' && reusedJson.result.reusedExistingAudio === true &&
        reusedJson.result.audio.manifest.source.narrationPlanArtifactId === plan.id &&
        jobsAfterReuse === jobsBeforeReuse && artifactsAfterReuse === artifactsBeforeReuse && reusedJson.enqueue.enqueued === 0,
      'contaminated speech with exact complete audio reuses existing artifact with zero side effects',
      reused,
    );

    const audioRow = db.prepare("SELECT id, content_json FROM artifacts WHERE project_id = ? AND kind = 'narration_audio_manifest'").get(projectId) as {id: string; content_json: string};
    const audioJson = JSON.parse(audioRow.content_json) as {master: {filePath: string; sha256: string}; source: {narrationPlanArtifactId: string; narrationPlanArtifactVersion: number}};
    const masterPath = path.join(dataDir, audioJson.master.filePath);
    const originalManifest = audioRow.content_json;

    const wrongSource = {...audioJson, source: {...audioJson.source, narrationPlanArtifactId: 'wrong-plan-id'}};
    db.prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(wrongSource), audioRow.id);
    const jobsBeforeWrongSource = jobsAfterReuse;
    const wrongSourceResult = run(['tts', '--project', projectId, '--plan', `${plan.id}@${plan.version}`]);
    ok(
      wrongSourceResult.status !== 0 && jsonOf(wrongSourceResult).error.code === 'NARRATION_PLAN_CONTAMINATED' &&
        (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c === jobsBeforeWrongSource,
      'wrong-source audio is not reused and contaminated synthesis remains blocked',
    );

    db.prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(originalManifest, audioRow.id);
    const originalBytes = fs.readFileSync(masterPath);
    const damagedBytes = Buffer.from(originalBytes);
    damagedBytes[damagedBytes.length - 1] ^= 1;
    fs.writeFileSync(masterPath, damagedBytes);
    const jobsBeforeIntegrity = jobsBeforeWrongSource;
    const integrityResult = run(['tts', '--project', projectId, '--plan', `${plan.id}@${plan.version}`]);
    ok(
      integrityResult.status !== 0 && jsonOf(integrityResult).error.code === 'NARRATION_PLAN_CONTAMINATED' &&
        (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c === jobsBeforeIntegrity,
      'master integrity mismatch is not reused and contaminated synthesis remains blocked',
    );

    db.prepare('DELETE FROM artifacts WHERE id = ?').run(audioRow.id);
    fs.writeFileSync(masterPath, originalBytes);
    const jobsBeforeMissing = jobsBeforeIntegrity;
    const missingResult = run(['tts', '--project', projectId, '--plan', `${plan.id}@${plan.version}`, '--wait']);
    ok(
      missingResult.status !== 0 && jsonOf(missingResult).error.code === 'NARRATION_PLAN_CONTAMINATED' &&
        (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id = ?').get(projectId) as {c: number}).c === jobsBeforeMissing,
      'contaminated speech without complete existing audio fails closed before new jobs',
    );

    const cleanProject = createProjectWithWorkflow({topic: 'clean synthesis', coreQuestion: 'enqueue?'}).project.id;
    insertLockedVersion(db, cleanProject, 1, '# Script V2\n\n## 第 1 章 测试\n\n这是新的旁白。');
    const cleanPlan = buildNarrationPlan(cleanProject).artifact;
    const cleanResult = run(['tts', '--project', cleanProject, '--plan', `${cleanPlan.id}@${cleanPlan.version}`]);
    const cleanJson = jsonOf(cleanResult);
    ok(cleanResult.status === 0 && cleanJson.enqueue.enqueued === 1, 'clean plan still enters normal synthesis admission');

    console.log(`Legacy audio reuse CLI tests: ${passed} PASS`);
  } finally {
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
}

void main().then(() => {
  if (process.exitCode) process.exit(process.exitCode);
});

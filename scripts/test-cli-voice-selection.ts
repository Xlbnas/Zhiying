import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhiying-cli-voice-selection-'));
const voiceRoot = path.join(dataDir, 'voices');
const registryDir = path.join(dataDir, 'registry');
const registryPath = path.join(registryDir, 'voice-registry.json');
fs.mkdirSync(voiceRoot, {recursive: true});
fs.mkdirSync(registryDir, {recursive: true});

process.env.ZHIYING_DATA_DIR = dataDir;
process.env.ZHIYING_ACTIVE_REGISTRY_PATH = registryPath;
process.env.ZHIYING_LEGACY_VOICE_ROOT_DIR = voiceRoot;
process.env.TTS_PROVIDER = 'mock';
process.env.LLM_PROVIDER = 'mock';

function makeWav(durationMs: number, frequency = 440): Buffer {
  const sampleRate = 48000;
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * frequency) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const reference = makeWav(1500, 660);
const referencePath = path.join(voiceRoot, 'xlbnas-v1.wav');
fs.writeFileSync(referencePath, reference);
const referenceSha256 = crypto.createHash('sha256').update(reference).digest('hex');
fs.writeFileSync(
  registryPath,
  `${JSON.stringify({
    schemaVersion: '1.0',
    voices: [
      {
        voiceProfile: 'default',
        voiceRevision: '1',
        speakerName: 'test-default',
        referenceAssetPath: '/voices/default-v1.wav',
        referenceSha256: '0'.repeat(64),
      },
      {
        voiceProfile: 'xlbnas',
        voiceRevision: '1',
        speakerName: 'test-xlbnas-1',
        referenceAssetPath: '/voices/xlbnas-v1.wav',
        referenceSha256,
      },
    ],
  }, null, 2)}\n`,
);

function ok(condition: boolean, message: string, detail?: unknown): void {
  if (!condition) {
    console.error(`FAIL ${message}`, detail ?? '');
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${message}`);
}

function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli/zhiying.ts'), ...args], {
    cwd: path.resolve('.'),
    env: process.env,
    encoding: 'utf8',
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
): void {
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
}

async function main(): Promise<void> {
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

  const project = createProjectWithWorkflow({topic: 'voice selection', coreQuestion: 'exact voice?'}).project;
  insertLockedVersion(db, project.id, 1, '# Script V2\n\n## 第 1 章 测试\n\n这是测试旁白。');
  const plan = buildNarrationPlan(project.id).artifact;

  // Default path: seed and finalize historical default@1 audio, then CLI must reuse it.
  enqueueNarrationAudioJobs(project.id, {expectedPlan: {artifactId: plan.id, version: plan.version}});
  const defaultClaim = claimNextAnyJob('voice-selection-default');
  if (!defaultClaim || defaultClaim.type !== 'tts') throw new Error('default fixture did not claim TTS job');
  try {
    await runTtsJob(defaultClaim.job, {isShuttingDown: () => false, log: () => {}});
  } finally {
    releaseResourceLeaseForJob('production_gpu', 'tts', defaultClaim.job.id);
  }
  if (!tryFinalizeNarrationAudio(project.id, {expectedPlan: {artifactId: plan.id, version: plan.version}})) {
    throw new Error('default fixture did not finalize');
  }
  const defaultReuse = run(['tts', '--project', project.id, '--plan', `${plan.id}@${plan.version}`, '--wait']);
  const defaultJson = jsonOf(defaultReuse);
  ok(defaultReuse.status === 0 && defaultJson.result?.reusedExistingAudio === true, 'default no --voice remains backward-compatible and reuses');

  // Explicit voice must not reuse the default manifest and must snapshot exact identity + reference SHA.
  const explicit = run(['tts', '--project', project.id, '--plan', `${plan.id}@${plan.version}`, '--voice', 'xlbnas@1']);
  const explicitJson = jsonOf(explicit);
  const explicitJob = db.prepare(
    `SELECT * FROM tts_jobs WHERE project_id=? AND voice_profile_id='xlbnas' AND voice_profile_revision='1' LIMIT 1`,
  ).get(project.id) as {payload_json: string} | undefined;
  const explicitPayload = explicitJob ? JSON.parse(explicitJob.payload_json) as Record<string, unknown> : null;
  ok(explicit.status === 0 && explicitJson.result?.reusedExistingAudio !== true && explicitJson.enqueue?.enqueued === 1, 'valid --voice enqueues instead of cross-voice reuse');
  ok(explicitPayload?.referenceAudioSha256 === referenceSha256, 'explicit job snapshots reference SHA');

  const explicitClaim = claimNextAnyJob('voice-selection-explicit');
  if (!explicitClaim || explicitClaim.type !== 'tts') throw new Error('explicit fixture did not claim TTS job');
  try {
    await runTtsJob(explicitClaim.job, {isShuttingDown: () => false, log: () => {}});
  } finally {
    releaseResourceLeaseForJob('production_gpu', 'tts', explicitClaim.job.id);
  }
  if (!tryFinalizeNarrationAudio(project.id, {
    expectedPlan: {artifactId: plan.id, version: plan.version},
    voiceProfile: {id: 'xlbnas', revision: '1'},
    referenceSha256,
  })) throw new Error('explicit fixture did not finalize');
  const sameVoice = run(['tts', '--project', project.id, '--plan', `${plan.id}@${plan.version}`, '--voice', 'xlbnas@1']);
  const sameVoiceJson = jsonOf(sameVoice);
  ok(sameVoice.status === 0 && sameVoiceJson.result?.reusedExistingAudio === true, 'same voice exact reuse remains allowed');

  const invalidProject = createProjectWithWorkflow({topic: 'invalid voice', coreQuestion: 'fail closed?'}).project;
  insertLockedVersion(db, invalidProject.id, 1, '# Script V2\n\n## 第 1 章 测试\n\n这是测试旁白。');
  const invalidPlan = buildNarrationPlan(invalidProject.id).artifact;
  const invalid = run(['tts', '--project', invalidProject.id, '--plan', `${invalidPlan.id}@${invalidPlan.version}`, '--voice', 'missing@99']);
  const invalidCount = (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id=?').get(invalidProject.id) as {c: number}).c;
  ok(invalid.status !== 0 && jsonOf(invalid).error?.code === 'VOICE_NOT_READY' && invalidCount === 0, 'invalid voice fails closed before creating jobs');

  const contaminatedProject = createProjectWithWorkflow({topic: 'contaminated voice', coreQuestion: 'gate?'}).project;
  insertLockedVersion(db, contaminatedProject.id, 1, '# Script V2\n\n## 第 1 章 测试\n\n这是测试旁白。');
  const contaminatedPlan = buildNarrationPlan(contaminatedProject.id).artifact;
  const content = JSON.parse(
    (db.prepare('SELECT content_json FROM artifacts WHERE id=?').get(contaminatedPlan.id) as {content_json: string}).content_json,
  ) as {units: Array<{text: string}>};
  content.units[0]!.text = '【脚本结束】';
  db.prepare('UPDATE artifacts SET content_json=? WHERE id=?').run(JSON.stringify(content), contaminatedPlan.id);
  const contaminated = run(['tts', '--project', contaminatedProject.id, '--plan', `${contaminatedPlan.id}@${contaminatedPlan.version}`, '--voice', 'xlbnas@1']);
  const contaminatedCount = (db.prepare('SELECT COUNT(*) AS c FROM tts_jobs WHERE project_id=?').get(contaminatedProject.id) as {c: number}).c;
  ok(contaminated.status !== 0 && jsonOf(contaminated).error?.code === 'NARRATION_PLAN_CONTAMINATED' && contaminatedCount === 0, 'explicit voice does not bypass contamination gate');

  console.log(`Voice selection CLI tests: ${process.exitCode ? 'FAIL' : 'PASS'}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

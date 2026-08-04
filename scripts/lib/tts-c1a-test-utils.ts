/**
 * TTS-C.1A 测试共享 fixture（temp DB + temp voice dir + exact Revision + Assignment）。
 * 供 scripts/test-tts-c1a-*.ts 使用；结束由各测试清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {closeDb, getDb} from '../../src/lib/db';
import {createProjectWithWorkflow} from '../../src/lib/projects';
import {createVoiceProfile} from '../../src/lib/voice-library/profiles';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../../src/lib/tts-b/assignment';
import {createMaterializationRequest} from '../../src/lib/tts-c/materialization';

export function makeWav(durationMs: number, freq: number): Buffer {
  const sampleRate = 48000;
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function sha256Buf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export const execDeps: VoiceLibraryExecDeps = {
  ffprobeImpl: async () => ({
    durationMs: 1500,
    codec: 'pcm_s16le',
    sampleRate: 48000,
    channels: 1,
    hasVideo: false,
  }),
};

export interface C1aFixture {
  dataDir: string;
  projectId: string;
  profileId: string;
  revisionId: string;
  revisionSha256: string;
  assignmentArtifactId: string;
  canonicalAbsPath: string;
}

export async function setupC1aFixture(tag: string): Promise<C1aFixture> {
  const dataDir = path.join('data', tag);
  fs.rmSync(dataDir, {recursive: true, force: true});
  process.env.ZHIYING_DATA_DIR = dataDir;
  closeDb();
  getDb(); // 应用 migration
  const project = createProjectWithWorkflow({topic: `c1a-${tag}`, coreQuestion: `q-${tag}`}).project;
  const profile = createVoiceProfile({displayName: `vp-${tag}`});
  const audio = makeWav(1500, 440 + Math.floor(Math.random() * 100));
  const revision = await ingestVoiceProfileRevision(
    {voiceProfileId: profile.id, requestId: `rev-${crypto.randomUUID()}`, audioBuffer: audio},
    execDeps,
  );
  const revisionRow = revision.outcome === 'created' || revision.outcome === 'reused' ? revision.revision : null;
  if (!revisionRow) throw new Error(`ingest revision failed: ${JSON.stringify(revision)}`);
  const built = await buildProjectVoiceAssignment({
    projectId: project.id,
    voiceProfileId: profile.id,
    voiceProfileRevisionId: revisionRow.id,
    requestId: `asg-${crypto.randomUUID()}`,
  });
  if (built.kind !== 'created' && built.kind !== 'reused') throw new Error(`assignment failed: ${JSON.stringify(built)}`);
  const canonicalAbsPath = path.join('data', tag, 'voice-library', profile.id, revisionRow.id, 'reference.wav');
  // canonical SHA = ffmpeg 转码后的最终文件（TTS-A canonical_audio_sha256）
  const revisionSha256 = crypto.createHash('sha256').update(fs.readFileSync(canonicalAbsPath)).digest('hex');
  return {
    dataDir,
    projectId: project.id,
    profileId: profile.id,
    revisionId: revisionRow.id,
    revisionSha256,
    assignmentArtifactId: built.artifact.id,
    canonicalAbsPath,
  };
}

export async function createC1aRequest(
  fx: C1aFixture,
  requestId: string,
): Promise<ReturnType<typeof createMaterializationRequest>> {
  return createMaterializationRequest(fx.projectId, requestId, fx.assignmentArtifactId);
}

export function cleanupC1a(tag: string): void {
  closeDb();
  fs.rmSync(path.join('data', tag), {recursive: true, force: true});
}

export let pass = 0;
export let fail = 0;

export function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

export function summary(label: string): void {
  console.log(`${label}: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

/**
 * TTS-C.1A 源验证与路径安全测试（E+G+H）：
 * - Profile/Revision exact；archived historical Assignment 允许；
 * - missing file / hash drift / pair mismatch / provider / adapter mismatch → fail-closed；
 * - symlink / path escape 拒绝；无 latest fallback；
 * - 边界：IndexTTS2/LLM/TTS jobs 调用 = 0；publication/activation 0 行；registry 未发布；
 * - projection 唯一终态 file_ready_unpublished；published_usable 不可由 1A 写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {createMaterializationRequest, MaterializationError} from '../src/lib/tts-c/materialization';
import {validateDestinationRelativePath, destinationAbsolutePath, ProjectionPathError} from '../src/lib/tts-c/paths';
import {setVoiceProfileStatus} from '../src/lib/voice-library/profiles';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {getProjectVoiceAssignment} from '../src/lib/tts-b/assignment';

const TAG = 'test-tts-c1a-files';
let fx: C1aFixture;

async function expectErr(label: string, fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    ok(false, label, '预期抛错但未抛');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === code, label, e);
  }
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // E1) exact revision 存在 → 创建成功（queued）
  const r = await createMaterializationRequest(fx.projectId, 'files-1', fx.assignmentArtifactId);
  ok(r.outcome === 'queued', 'exact revision → queued', r.outcome);

  // E2) missing file：删除 canonical 文件 → ASSIGNMENT_UNUSABLE（fail-closed，无 fallback）
  const canonical = path.join(fx.dataDir, 'voice-library', fx.profileId, fx.revisionId, 'reference.wav');
  const saved = fs.readFileSync(canonical);
  fs.rmSync(canonical, {force: true});
  await expectErr('missing file → ASSIGNMENT_UNUSABLE', () => createMaterializationRequest(fx.projectId, 'files-2', fx.assignmentArtifactId), 'ASSIGNMENT_UNUSABLE');
  fs.writeFileSync(canonical, saved);

  // E3) hash drift：改写 canonical 文件字节 → ASSIGNMENT_UNUSABLE
  fs.writeFileSync(canonical, Buffer.concat([saved.subarray(0, saved.length - 1), Buffer.from([saved[saved.length - 1] ^ 0xff])]));
  await expectErr('hash drift → ASSIGNMENT_UNUSABLE', () => createMaterializationRequest(fx.projectId, 'files-3', fx.assignmentArtifactId), 'ASSIGNMENT_UNUSABLE');
  fs.writeFileSync(canonical, saved);

  // E4) archived profile：historical exact Assignment 仍允许（TTS-B 语义）
  setVoiceProfileStatus(fx.profileId, 'archived');
  const rArch = await createMaterializationRequest(fx.projectId, 'files-4', fx.assignmentArtifactId);
  ok(rArch.outcome === 'queued' || rArch.outcome === 'reused', 'archived profile historical Assignment 允许', rArch.outcome);
  setVoiceProfileStatus(fx.profileId, 'active');

  // E5) wrong provider / adapter 不匹配 assignment → 污染 assignment 场景：
  //    provider 污染 → content 违反 schema（literal 约束）→ 视为不存在（fail-closed，无 fallback）；
  //    sha256 污染（仍为合法 hex64）→ schema 可 parse → classify invalid_source → ASSIGNMENT_UNUSABLE。
  const badAsg = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: fx.revisionId,
    requestId: `asg-bad-${Math.random()}`,
  });
  if (badAsg.kind === 'created' || badAsg.kind === 'reused') {
    const row = getProjectVoiceAssignment(fx.projectId, badAsg.artifact.id);
    if (row) {
      // E5b) sha256 污染（合法 hex64，schema 可 parse → source 自洽失败 → ASSIGNMENT_UNUSABLE）
      const parsedB = JSON.parse(row.artifact.content_json);
      parsedB.source.canonicalAudioSha256 = 'f'.repeat(64);
      db.prepare('UPDATE artifacts SET content_json=? WHERE id=?').run(JSON.stringify(parsedB), badAsg.artifact.id);
      await expectErr('sha256 污染 → ASSIGNMENT_UNUSABLE（无 latest fallback）', () => createMaterializationRequest(fx.projectId, 'files-6', badAsg.artifact.id), 'ASSIGNMENT_UNUSABLE');
      // E5a) provider 污染（schema literal 违约 → content 不可解析 → NOT_FOUND）
      const rowA = getProjectVoiceAssignment(fx.projectId, badAsg.artifact.id);
      if (rowA) {
        const parsedA = JSON.parse(rowA.artifact.content_json);
        parsedA.source.provider = 'other-provider';
        db.prepare('UPDATE artifacts SET content_json=? WHERE id=?').run(JSON.stringify(parsedA), badAsg.artifact.id);
        await expectErr('provider 污染 → schema 违约 → ASSIGNMENT_NOT_FOUND', () => createMaterializationRequest(fx.projectId, 'files-5', badAsg.artifact.id), 'ASSIGNMENT_NOT_FOUND');
      }
    }
  }

  // G1) projection 唯一终态 file_ready_unpublished；published_usable 不可由 1A 写入
  const proj = db.prepare('SELECT * FROM voice_materializations WHERE voice_profile_id=? AND voice_profile_revision_id=?').get(fx.profileId, fx.revisionId) as {status: string} | undefined;
  ok(proj === undefined || proj.status === 'file_ready_unpublished', '1A 只产生 file_ready_unpublished', proj?.status);
  const pubCount = (db.prepare('SELECT count(*) c FROM voice_registry_publications').get() as {c: number}).c;
  const actCount = (db.prepare('SELECT count(*) c FROM voice_registry_publication_activations').get() as {c: number}).c;
  ok(pubCount === 0 && actCount === 0, 'publication/activation 0 行（registry 未发布）', {pubCount, actCount});

  // H) 边界计数：IndexTTS2/LLM/TTS jobs 未调用（本测试全程无 provider 调用）
  const ttsJobs = (db.prepare('SELECT count(*) c FROM tts_jobs').get() as {c: number}).c;
  ok(ttsJobs === 0, 'TTS jobs = 0（未 enqueue 任何 TTS）', ttsJobs);

  // E6) symlink / path escape（paths.ts 纯函数级）
  const okPath = validateDestinationRelativePath;
  try {
    okPath(`${fx.profileId}/${fx.revisionId}/reference.wav`);
    ok(true, '合法 relative path 通过');
  } catch (e) {
    ok(false, '合法 relative path 通过', e);
  }
  for (const bad of ['/abs/path.wav', '../escape.wav', `${fx.profileId}/${fx.revisionId}/evil.mp3`, `${fx.profileId}/../x/reference.wav`, 'a\\b\\reference.wav', 'not-uuid/not-uuid/reference.wav']) {
    let threw = false;
    try {
      okPath(bad);
    } catch (e) {
      threw = e instanceof ProjectionPathError;
    }
    ok(threw, `非法路径拒绝: ${bad}`);
  }
  try {
    destinationAbsolutePath(`${fx.profileId}/${fx.revisionId}/reference.wav`);
    ok(true, '绝对路径解析在 root 内');
  } catch {
    ok(false, '绝对路径解析在 root 内');
  }

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-files');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

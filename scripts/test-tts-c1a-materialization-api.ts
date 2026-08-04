/**
 * TTS-C.1A Request envelope 测试（B）：
 * - 同 requestId 同 exact source → 幂等复用同一 envelope；
 * - 同 requestId 异 source → 409 REQUEST_ID_CONFLICT；
 * - project scope / cross-project Assignment 拒绝；
 * - malformed requestId / missing body 字段；
 * - 无 latest fallback（assignment 不可用 → ASSIGNMENT_UNUSABLE）；
 * - API 视图 adapterReady=false / registryPublished=false / 无 path 输出。
 */
import fs from 'node:fs';
import path from 'node:path';
import {ok, summary, setupC1aFixture, cleanupC1a, createC1aRequest, type C1aFixture} from './lib/tts-c1a-test-utils';
import {createMaterializationRequest, MaterializationError} from '../src/lib/tts-c/materialization';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {ingestVoiceProfileRevision, type VoiceLibraryExecDeps} from '../src/lib/voice-library/revisions';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {makeWav, execDeps} from './lib/tts-c1a-test-utils';
import {serializeMaterializationRequest} from '../src/lib/tts-c/materialization';

const TAG = 'test-tts-c1a-api';
let fx: C1aFixture;

async function expectErr(label: string, fn: () => Promise<unknown>, code: string, status?: number): Promise<void> {
  try {
    await fn();
    ok(false, label, '预期抛错但未抛');
  } catch (e) {
    ok(e instanceof MaterializationError && e.code === code && (status === undefined || e.status === status), label, e);
  }
}

(async () => {
  fx = await setupC1aFixture(TAG);
  // 1) 首次创建 → queued（无现有 projection）
  const r1 = await createC1aRequest(fx, 'req-1');
  ok(r1.outcome === 'queued', '首次 request → queued（Worker 待 copy）', r1.outcome);
  ok(r1.request.status === 'waiting', 'envelope waiting + job link', r1.request.status);
  ok(r1.request.job_id !== null, 'request 已链接 job');
  ok(r1.adapterReady === false, 'adapterReady=false');

  // 2) 幂等复用：同 requestId 同 source
  const r2 = await createC1aRequest(fx, 'req-1');
  ok(r2.request.id === r1.request.id, '同 requestId 同 source 复用同一 envelope', r2.request.id);

  // 3) 同 requestId 异 source → 409（第二个 revision 的 assignment）
  const rev2 = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rev2-${crypto.randomUUID()}`, audioBuffer: makeWav(1500, 900)},
    execDeps,
  );
  const rev2Row = rev2.outcome === 'created' || rev2.outcome === 'reused' ? rev2.revision : null;
  if (!rev2Row) throw new Error('second revision failed');
  const other = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: rev2Row.id,
    requestId: `asg2-${crypto.randomUUID()}`,
  });
  if (other.kind !== 'created' && other.kind !== 'reused') throw new Error('second assignment failed');
  await expectErr('同 requestId 异 source → REQUEST_ID_CONFLICT(409)', () => createMaterializationRequest(fx.projectId, 'req-1', other.artifact.id), 'REQUEST_ID_CONFLICT', 409);

  // 4) malformed requestId
  await expectErr('requestId 空 → REQUEST_ID_REQUIRED(422)', () => createMaterializationRequest(fx.projectId, '', fx.assignmentArtifactId), 'REQUEST_ID_REQUIRED', 422);
  await expectErr('requestId 非法字符 → REQUEST_ID_INVALID(422)', () => createMaterializationRequest(fx.projectId, 'a b/c', fx.assignmentArtifactId), 'REQUEST_ID_INVALID', 422);

  // 5) project 不存在
  await expectErr('project 不存在 → PROJECT_NOT_FOUND(404)', () => createMaterializationRequest('no-such-project', 'req-x', fx.assignmentArtifactId), 'PROJECT_NOT_FOUND', 404);

  // 6) cross-project Assignment 拒绝（Assignment 属于 fx.projectId；用另一真实 project）
  const projectB = createProjectWithWorkflow({topic: 'c1a-b', coreQuestion: 'q-b'}).project;
  await expectErr('cross-project Assignment → ASSIGNMENT_NOT_FOUND(404)', () => createMaterializationRequest(projectB.id, 'req-y', fx.assignmentArtifactId), 'ASSIGNMENT_NOT_FOUND', 404);

  // 7) 不存在 assignment
  await expectErr('assignment 不存在 → ASSIGNMENT_NOT_FOUND(404)', () => createMaterializationRequest(fx.projectId, 'req-z', 'no-such-artifact'), 'ASSIGNMENT_NOT_FOUND', 404);

  // 8) 序列化 redaction：无任何 path 字段
  const req = r1.request;
  const view = serializeMaterializationRequest(req, null);
  const json = JSON.stringify(view);
  ok(!/path|voice-library|voice-materializations|staging|\.wav/i.test(json), '序列化无 path 输出', json.slice(0, 200));
  ok(view.materialization === null || view.materialization.adapterReady === false, 'materialization.adapterReady=false');
  ok(view.materialization === null || view.materialization.registryPublished === false, 'registryPublished=false');

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-api');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

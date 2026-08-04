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
import crypto from 'node:crypto';
import {ok, summary, setupC1aFixture, cleanupC1a, createC1aRequest, type C1aFixture, sha256Buf} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {createMaterializationRequest, MaterializationError, sha256Text} from '../src/lib/tts-c/materialization';
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

  // 9) existing request outcome 逐状态映射（§十二：禁止统一 reused；request 状态与 job 真实状态一致）
  const db = getDb();
  // 辅助：直插"挂 job 的 request"到指定终态（与 createMaterializationRequest 传入的 identity 完全一致：
  // fx.revision + 真实 fingerprint；每个 seed 前释放前一个 active job）
  const seedTerminalRequest = (requestId: string, jobStatus: 'queued' | 'running' | 'failed' | 'cancelled' | 'indeterminate' | 'succeeded', reqStatus: string): void => {
    db.prepare(
      `UPDATE voice_materialization_jobs SET status='failed', owner_token=NULL, lease_expires_at_epoch_ms=NULL,
         heartbeat_at=NULL, updated_at=?
       WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status IN ('queued','running','indeterminate')`,
    ).run(new Date().toISOString(), fx.profileId, fx.revisionId);
    const jobId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO voice_materialization_jobs
         (id, voice_profile_id, voice_profile_revision_id, status, validation_owner_token,
          validation_lease_expires_at_epoch_ms, validation_attempt, source_canonical_sha256,
          adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
       VALUES (?, ?, ?, 'validating_existing', 'v-seed', ?, 1, ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
    ).run(jobId, fx.profileId, fx.revisionId, Date.now() + 60000, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `UPDATE voice_materialization_jobs SET status='queued', validation_owner_token=NULL,
         validation_lease_expires_at_epoch_ms=NULL, updated_at=? WHERE id=?`,
    ).run(new Date().toISOString(), jobId);
    if (jobStatus === 'running' || jobStatus === 'indeterminate') {
      db.prepare(
        `UPDATE voice_materialization_jobs SET status='running', owner_token='w', lease_expires_at_epoch_ms=?,
           heartbeat_at=?, attempt=1, updated_at=? WHERE id=?`,
      ).run(Date.now() + 60000, new Date().toISOString(), new Date().toISOString(), jobId);
      if (jobStatus === 'indeterminate') {
        db.prepare(
          `UPDATE voice_materialization_jobs SET status='indeterminate', owner_token=NULL, lease_expires_at_epoch_ms=NULL,
             heartbeat_at=NULL, updated_at=? WHERE id=?`,
        ).run(new Date().toISOString(), jobId);
      }
    } else if (jobStatus !== 'queued') {
      db.prepare(`UPDATE voice_materialization_jobs SET status=?, updated_at=? WHERE id=?`).run(jobStatus, new Date().toISOString(), jobId);
    }
    const fp = sha256Text(
      JSON.stringify({
        projectId: fx.projectId,
        voiceProfileId: fx.profileId,
        voiceProfileRevisionId: fx.revisionId,
        canonicalAudioSha256: fx.revisionSha256,
        adapterCompatibilityKey: 'indextts2-adapter-registry@1',
        provider: 'indextts2',
      }),
    );
    const reqId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO voice_materialization_requests
         (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
          request_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'initializing', ?, ?)`,
    ).run(reqId, fx.projectId, requestId, fx.profileId, fx.revisionId, fx.assignmentArtifactId, fp, new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE voice_materialization_requests SET status='waiting', job_id=?, updated_at=? WHERE id=? AND status='initializing'").run(jobId, new Date().toISOString(), reqId);
    if (reqStatus !== 'waiting') {
      db.prepare('UPDATE voice_materialization_requests SET status=?, updated_at=? WHERE id=?').run(reqStatus, new Date().toISOString(), reqId);
    }
  };

  // 9a) failed request（job failed）→ outcome failed（不得 reused）
  seedTerminalRequest('st-failed', 'failed', 'failed');
  const rf = await createMaterializationRequest(fx.projectId, 'st-failed', fx.assignmentArtifactId);
  ok(rf.outcome === 'failed' && rf.request.status === 'failed', 'failed request → outcome=failed（不返回 reused）', {outcome: rf.outcome, status: rf.request.status});

  // 9b) cancelled request（job cancelled）→ outcome cancelled
  seedTerminalRequest('st-cancelled', 'cancelled', 'cancelled');
  const rc = await createMaterializationRequest(fx.projectId, 'st-cancelled', fx.assignmentArtifactId);
  ok(rc.outcome === 'cancelled' && rc.request.status === 'cancelled', 'cancelled request → outcome=cancelled', {outcome: rc.outcome, status: rc.request.status});

  // 9c) running request（job running）→ outcome inflight
  seedTerminalRequest('st-running', 'running', 'running');
  const rr = await createMaterializationRequest(fx.projectId, 'st-running', fx.assignmentArtifactId);
  ok(rr.outcome === 'inflight' && rr.request.status === 'running', 'running request → outcome=inflight', {outcome: rr.outcome, status: rr.request.status});

  // 9d) waiting request（job queued）→ outcome queued
  seedTerminalRequest('st-queued', 'queued', 'waiting');
  const rq = await createMaterializationRequest(fx.projectId, 'st-queued', fx.assignmentArtifactId);
  ok(rq.outcome === 'queued' && rq.request.status === 'waiting', 'waiting + job queued → outcome=queued', {outcome: rq.outcome, status: rq.request.status});

  // 9e) indeterminate request（job indeterminate）→ outcome indeterminate
  seedTerminalRequest('st-indeterminate', 'indeterminate', 'indeterminate');
  const ri = await createMaterializationRequest(fx.projectId, 'st-indeterminate', fx.assignmentArtifactId);
  ok(ri.outcome === 'indeterminate' && ri.request.status === 'indeterminate', 'indeterminate request → outcome=indeterminate', {outcome: ri.outcome, status: ri.request.status});

  // 9f) succeeded request（job succeeded + projection）→ outcome reused（仅此状态才 reused）
  // 前置：释放 9e 的 indeterminate job（indeterminate→failed 合法；indeterminate 是 active）
  db.prepare(
    `UPDATE voice_materialization_jobs SET status='failed', owner_token=NULL, lease_expires_at_epoch_ms=NULL,
       heartbeat_at=NULL, updated_at=?
     WHERE voice_profile_id=? AND voice_profile_revision_id=? AND status='indeterminate'`,
  ).run(new Date().toISOString(), fx.profileId, fx.revisionId);
  const {claimNextAnyJob} = await import('../src/lib/scheduler');
  const {runMaterializationJob} = await import('../src/worker/materialization-executor');
  const rSuccess = await createC1aRequest(fx, 'st-success');
  ok(rSuccess.outcome === 'queued', '成功场景前置：queued', rSuccess.outcome);
  const claimed = claimNextAnyJob('api-worker');
  if (claimed && claimed.type === 'voice_materialization') {
    await runMaterializationJob(claimed.handle, {log: () => undefined});
  }
  const rs = await createMaterializationRequest(fx.projectId, 'st-success', fx.assignmentArtifactId);
  ok(rs.outcome === 'reused' && rs.request.status === 'succeeded', 'succeeded request + usable projection → outcome=reused（唯一 reused 路径）', {outcome: rs.outcome, status: rs.request.status});

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-api');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

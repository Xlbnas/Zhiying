/**
 * TTS-C.1A Schema 测试（frozen contract 结构级）：
 * - 初始状态直插拒绝（INIT 语义：vmr/vmjob/vmat initial state）；
 * - vmr/vmjob/vmat 关键 CHECK / trigger 行为（非法状态组合 ABORT）；
 * - publication/legacy 表 0 行不变量由 migration 测试覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';

const TAG = 'test-tts-c1a-schema';
let fx: C1aFixture;

function expectSqlError(label: string, fn: () => void, needle: string): void {
  try {
    fn();
    ok(false, label, '预期 SQL 错误但未抛');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(needle), label, msg.slice(0, 120));
  }
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();
  const now = new Date().toISOString();

  // 1) vmr 初始状态必须 initializing（直接 waiting 拒绝）
  expectSqlError(
    'vmr 直插 waiting → initial state ABORT',
    () => db.prepare(
      `INSERT INTO voice_materialization_requests
         (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
          request_fingerprint, status, created_at, updated_at)
       VALUES ('vmr-x', ?, 'x', ?, ?, ?, 'fp', 'waiting', ?, ?)`,
    ).run(fx.projectId, fx.profileId, fx.revisionId, fx.assignmentArtifactId, now, now),
    'initial state initializing required',
  );

  // 2) vmjob 初始状态必须 validating_existing
  expectSqlError(
    'vmjob 直插 queued → initial state ABORT',
    () => db.prepare(
      `INSERT INTO voice_materialization_jobs
         (id, voice_profile_id, voice_profile_revision_id, status, source_canonical_sha256,
          adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
       VALUES ('vmj-x', ?, ?, 'queued', ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
    ).run(fx.profileId, fx.revisionId, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, now, now),
    'initial state validating_existing required',
  );

  // 3) vmat 初始状态必须 file_ready_unpublished
  expectSqlError(
    'vmat 直插 published_usable → initial state ABORT',
    () => db.prepare(
      `INSERT INTO voice_materializations
         (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
          adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
       VALUES ('vmat-x', ?, ?, ?, 'indextts2-adapter-registry@1', ?, 'published_usable', ?, ?)`,
    ).run(fx.profileId, fx.revisionId, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, now, now),
    'initial state file_ready_unpublished required',
  );

  // 4) vmat 合法直插 file_ready_unpublished 通过
  db.prepare(
    `INSERT INTO voice_materializations
       (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
        adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
     VALUES ('vmat-ok', ?, ?, ?, 'indextts2-adapter-registry@1', ?, 'file_ready_unpublished', ?, ?)`,
  ).run(fx.profileId, fx.revisionId, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, now, now);
  ok(true, 'vmat 合法初始直插通过');

  // 5) published_usable 无法被 1A 写入（激活必须 activation command——直接 UPDATE 拒绝）
  expectSqlError(
    'file_ready→published_usable 直接 UPDATE → publication link mismatch ABORT',
    () => db.prepare(
      `UPDATE voice_materializations SET status='published_usable',
         published_registry_generation=1, published_registry_sha256=?, published_by_publication_id='PUB-X'
       WHERE id='vmat-ok'`,
    ).run('d'.repeat(64)),
    'publication link mismatch',
  );

  // 6) vmr 非法状态组合 CHECK（waiting 无 job）
  db.prepare(
    `INSERT INTO voice_materialization_requests
       (id, project_id, request_id, voice_profile_id, voice_profile_revision_id, assignment_artifact_id,
        request_fingerprint, status, created_at, updated_at)
     VALUES ('vmr-ok', ?, 'schema-ok', ?, ?, ?, 'fp', 'initializing', ?, ?)`,
  ).run(fx.projectId, fx.profileId, fx.revisionId, fx.assignmentArtifactId, now, now);
  expectSqlError(
    'initializing→waiting 无 job → waiting requires job link ABORT',
    () => db.prepare("UPDATE voice_materialization_requests SET status='waiting', updated_at=? WHERE id='vmr-ok'").run(now),
    'waiting requires job link',
  );

  // 7) vmjob 非法状态组合 CHECK（validating_existing 缺 validation owner）
  expectSqlError(
    'validating_existing 无 validation owner → CHECK ABORT',
    () => db.prepare(
      `INSERT INTO voice_materialization_jobs
         (id, voice_profile_id, voice_profile_revision_id, status, source_canonical_sha256,
          adapter_compatibility_key, destination_voice_root_relative_path, created_at, updated_at)
       VALUES ('vmj-bad', ?, ?, 'validating_existing', ?, 'indextts2-adapter-registry@1', ?, ?, ?)`,
    ).run(fx.profileId, fx.revisionId, fx.revisionSha256, `${fx.profileId}/${fx.revisionId}/reference.wav`, now, now),
    'CHECK constraint failed',
  );

  // 8) vmat 路径 CHECK：destination 必须精确 <profile>/<revision>/reference.wav
  expectSqlError(
    'vmat destination 路径非法 → destination path mismatch ABORT',
    () => db.prepare(
      `INSERT INTO voice_materializations
         (id, voice_profile_id, voice_profile_revision_id, source_canonical_sha256,
          adapter_compatibility_key, destination_voice_root_relative_path, status, created_at, updated_at)
       VALUES ('vmat-bad', ?, ?, ?, 'indextts2-adapter-registry@1', 'wrong/path/x.wav', 'file_ready_unpublished', ?, ?)`,
    ).run(fx.profileId, fx.revisionId, fx.revisionSha256, now, now),
    'destination path mismatch',
  );

  cleanupC1a(TAG);
  summary('TTS-C.1A materialization-schema');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * TTS-C.1A.R1 requestId durable idempotency（P1）——真实双进程并发：
 * - RID-01 same requestId + same source 并发 → 恰好一个 INSERT；两调用均成功（同一 request row/job）；
 *   无 500（无 UNEXPECTED）；
 * - RID-02 same requestId + different source 并发 → 一个成功；另一个 409 REQUEST_ID_CONFLICT；
 *   持久 source 不被覆盖（request row fingerprint 不变）；
 * - RID-03 不同 project 相同 requestId → 互不冲突（各自成功）。
 */
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ok, summary, setupC1aFixture, cleanupC1a, type C1aFixture, makeWav, execDeps} from './lib/tts-c1a-test-utils';
import {getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {ingestVoiceProfileRevision} from '../src/lib/voice-library/revisions';
import {buildProjectVoiceAssignment} from '../src/lib/tts-b/assignment';
import {createMaterializationRequest} from '../src/lib/tts-c/materialization';

const execFileP = promisify(execFile);
const TAG = 'test-tts-c1a-request-concurrency';
let fx: C1aFixture;

interface ChildResult {
  ok: boolean;
  outcome?: string;
  code?: string;
  message?: string;
  requestStatus?: string;
  jobId?: string;
}

async function runChild(projectId: string, requestId: string, assignmentArtifactId: string): Promise<ChildResult> {
  const childPath = path.join(process.cwd(), 'scripts/lib/tts-c1a-request-child.ts');
  const {stdout} = await execFileP(
    process.execPath,
    ['--import', 'tsx', childPath, fx.dataDir, projectId, requestId, assignmentArtifactId],
    {env: {...process.env, ZHIYING_DATA_DIR: fx.dataDir}},
  );
  return JSON.parse(stdout.trim()) as ChildResult;
}

(async () => {
  fx = await setupC1aFixture(TAG);
  const db = getDb();

  // ── RID-01：same requestId + same source 并发 → 恰好一个 INSERT + 两调用成功 ──
  const [ra, rb] = await Promise.all([
    runChild(fx.projectId, 'rid-same', fx.assignmentArtifactId),
    runChild(fx.projectId, 'rid-same', fx.assignmentArtifactId),
  ]);
  ok(ra.ok && rb.ok, 'RID-01 两调用均成功（无 500/UNEXPECTED）', {a: ra.code, b: rb.code});
  const rows1 = db.prepare("SELECT count(*) c FROM voice_materialization_requests WHERE project_id=? AND request_id='rid-same'").get(fx.projectId) as {c: number};
  ok(rows1.c === 1, 'RID-01 恰好一个 request row（UNIQUE 裁决，不逃逸 500）', rows1.c);
  ok(ra.jobId === rb.jobId && ra.jobId !== undefined, 'RID-01 两调用同一 job（envelope-first fan-in）', ra.jobId);

  // ── RID-02：same requestId + different source 并发 → 一个成功 + 一个 409 ──
  const rev2 = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rid-rev2-${Math.random()}`, audioBuffer: makeWav(1500, 550)},
    execDeps,
  );
  const rev2Row = rev2.outcome === 'created' || rev2.outcome === 'reused' ? rev2.revision : null;
  if (!rev2Row) throw new Error('rev2 ingest failed');
  const asg2 = await buildProjectVoiceAssignment({
    projectId: fx.projectId,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: rev2Row.id,
    requestId: `rid-asg2-${Math.random()}`,
  });
  if (asg2.kind !== 'created' && asg2.kind !== 'reused') throw new Error('asg2 failed');
  const [ra2, rb2] = await Promise.all([
    runChild(fx.projectId, 'rid-diff', fx.assignmentArtifactId),
    runChild(fx.projectId, 'rid-diff', asg2.artifact.id),
  ]);
  const okCount = [ra2, rb2].filter((r) => r.ok).length;
  const conflictCount = [ra2, rb2].filter((r) => !r.ok && r.code === 'REQUEST_ID_CONFLICT').length;
  ok(okCount === 1 && conflictCount === 1, 'RID-02 一个成功 + 一个 409 REQUEST_ID_CONFLICT', {ok: okCount, conflict: conflictCount});
  const row2 = db.prepare("SELECT request_fingerprint, assignment_artifact_id FROM voice_materialization_requests WHERE project_id=? AND request_id='rid-diff'").get(fx.projectId) as {request_fingerprint: string; assignment_artifact_id: string} | undefined;
  ok(row2?.assignment_artifact_id === (ra2.ok ? fx.assignmentArtifactId : asg2.artifact.id), 'RID-02 持久 source 不被覆盖（先到者胜）', row2?.assignment_artifact_id.slice(0, 8));
  ok(row2?.request_fingerprint.length === 64, 'RID-02 fingerprint 持久', row2?.request_fingerprint.length);

  // ── RID-03：不同 project 相同 requestId → 互不冲突 ──
  const p2 = createProjectWithWorkflow({topic: 'rid-p2', coreQuestion: 'q-p2'}).project;
  const revP2 = await ingestVoiceProfileRevision(
    {voiceProfileId: fx.profileId, requestId: `rid-revp2-${Math.random()}`, audioBuffer: makeWav(1500, 560)},
    execDeps,
  );
  const revP2Row = revP2.outcome === 'created' || revP2.outcome === 'reused' ? revP2.revision : null;
  if (!revP2Row) throw new Error('revp2 ingest failed');
  const asgP2 = await buildProjectVoiceAssignment({
    projectId: p2.id,
    voiceProfileId: fx.profileId,
    voiceProfileRevisionId: revP2Row.id,
    requestId: `rid-asgp2-${Math.random()}`,
  });
  if (asgP2.kind !== 'created' && asgP2.kind !== 'reused') throw new Error('asgp2 failed');
  const [rp2a, rp2b] = await Promise.all([
    runChild(p2.id, 'rid-shared', asgP2.artifact.id),
    runChild(fx.projectId, 'rid-shared', fx.assignmentArtifactId),
  ]);
  ok(rp2a.ok && rp2b.ok, 'RID-03 两 project 同 requestId 均成功（互不冲突）', {a: rp2a.code, b: rp2b.code});
  const rows3a = db.prepare("SELECT count(*) c FROM voice_materialization_requests WHERE project_id=? AND request_id='rid-shared'").get(p2.id) as {c: number};
  const rows3b = db.prepare("SELECT count(*) c FROM voice_materialization_requests WHERE project_id=? AND request_id='rid-shared'").get(fx.projectId) as {c: number};
  ok(rows3a.c === 1 && rows3b.c === 1, 'RID-03 各自恰好一行（project 隔离）', {p2: rows3a.c, p1: rows3b.c});

  cleanupC1a(TAG);
  summary('TTS-C.1A request-concurrency');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

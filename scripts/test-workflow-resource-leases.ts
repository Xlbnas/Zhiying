/**
 * M7.3A.2 Durable GPU Resource Lease 测试。
 *
 * 用法：npx tsx scripts/test-workflow-resource-leases.ts
 * 使用临时数据目录（data/test-workflow-resource-leases），结束后清理。
 *
 * 覆盖：
 * - 两个 Worker 的 production_gpu 互斥；
 * - lease heartbeat 续约；
 * - 任务释放/显式释放；
 * - 过期 lease 回收；
 * - LLM API 任务与 TTS GPU 任务可并行；
 * - GPU 组内任务（TTS / Render / local_image）互斥。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-workflow-resource-leases');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {
  claimResourceLease,
  getActiveLease,
  heartbeatResourceLease,
  releaseExpiredLeases,
  releaseResourceLease,
  releaseResourceLeaseForJob,
} from '../src/lib/resources/leases';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function insertLlmJob(projectId: string, queuedAt: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO llm_jobs (id, project_id, stage, status, payload_json, queued_at)
     VALUES (?, ?, 'research', 'queued', ?, ?)`,
  ).run(id, projectId, '{}', queuedAt);
  return id;
}

function insertTtsJob(projectId: string, queuedAt: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO tts_jobs (
       id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
       provider, voice_profile_id, voice_profile_revision, status, payload_json, queued_at
     ) VALUES (?, ?, ?, 1, 'N001', 'mock', 'default', '1', 'queued', ?, ?)`,
  ).run(id, projectId, crypto.randomUUID(), JSON.stringify({text: 'test'}), queuedAt);
  return id;
}

function insertRenderJob(projectId: string, queuedAt: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO render_jobs (
       id, project_id, kind, status, progress, payload_json, queued_at,
       attempt, max_attempts, cancel_requested
     ) VALUES (?, ?, 'fullcut', 'queued', 0, ?, ?, 0, 2, 0)`,
  ).run(id, projectId, '{}', queuedAt);
  return id;
}

function insertAssetGenerationJob(projectId: string, queuedAt: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO asset_generation_jobs (
       id, project_id, scene_id, requirement_id, request_id,
       prompt, provider, model, status, created_at, updated_at
     ) VALUES (?, ?, 'S001', 'S001-R01', ?, 'prompt', 'apiyi', 'mock', 'queued', ?, ?)`,
  ).run(id, projectId, `req-${id}`, queuedAt, queuedAt);
  return id;
}

function insertLocalImageGenerationJob(projectId: string, queuedAt: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO asset_generation_jobs (
       id, project_id, scene_id, requirement_id, request_id,
       prompt, provider, model, resource_class, resource_group, status, created_at, updated_at
     ) VALUES (?, ?, 'S001', 'S001-R01', ?, 'prompt', 'comfyui', 'sd3', 'local_image_gpu', 'production_gpu', 'queued', ?, ?)`,
  ).run(id, projectId, `req-${id}`, queuedAt, queuedAt);
  return id;
}

function jobStatus(table: 'llm_jobs' | 'tts_jobs' | 'render_jobs' | 'asset_generation_jobs', id: string): string | undefined {
  const row = getDb().prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as {status: string} | undefined;
  return row?.status;
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-resource-leases'), {recursive: true, force: true});
  const projectId = createProjectWithWorkflow({topic: 'resource-lease', coreQuestion: 'q'}).project.id;

  // ============ L1：直接 lease API —— claim / heartbeat / release ============
  {
    const a = claimResourceLease('production_gpu', 'tts', 'job-a', 'worker-a', 2000);
    ok(a.ok && a.ownerToken !== null, '[L1a] worker-a 首次 claim production_gpu 成功');

    const leaseBefore = getActiveLease('production_gpu');
    ok(leaseBefore?.owner_worker_id === 'worker-a', '[L1b] lease 记录归属 worker-a');

    await sleep(10);
    const extended = heartbeatResourceLease('production_gpu', a.ownerToken!, 5000);
    ok(extended, '[L1c] heartbeat 续约成功');
    const leaseAfter = getActiveLease('production_gpu');
    ok(
      leaseAfter !== null && Date.parse(leaseAfter.lease_expires_at) > Date.parse(leaseBefore!.lease_expires_at),
      '[L1d] heartbeat 后 lease_expires_at 延后',
    );

    const b = claimResourceLease('production_gpu', 'render', 'job-b', 'worker-b', 2000);
    ok(!b.ok, '[L1e] worker-b 在 worker-a 持有 lease 时 claim 失败');

    const released = releaseResourceLease('production_gpu', a.ownerToken!);
    ok(released, '[L1f] worker-a 显式释放 lease');
    ok(getActiveLease('production_gpu') === null, '[L1g] 释放后无有效 lease');

    const c = claimResourceLease('production_gpu', 'render', 'job-b', 'worker-b', 2000);
    ok(c.ok, '[L1h] worker-a 释放后 worker-b 可 claim');
    releaseResourceLease('production_gpu', c.ownerToken!);
  }

  // ============ L2：过期 lease 回收 ============
  {
    const token = claimResourceLease('production_gpu', 'tts', 'stale-job', 'worker-stale', 50)!.ownerToken!;
    ok(getActiveLease('production_gpu') !== null, '[L2a] 刚创建的 lease 有效');
    await sleep(60);
    const cleaned = releaseExpiredLeases(0);
    ok(cleaned === 1, '[L2b] 过期 lease 被回收', {cleaned});
    ok(getActiveLease('production_gpu') === null, '[L2c] 回收后无有效 lease');
  }

  // ============ L3：调度器 —— LLM 与 TTS 可并行 ============
  {
    const now = new Date().toISOString();
    const llmId = insertLlmJob(projectId, now);
    const ttsId = insertTtsJob(projectId, new Date(Date.now() + 1000).toISOString());

    const claimedA = claimNextAnyJob('worker-llm');
    ok(claimedA?.type === 'llm' && claimedA.job.id === llmId, '[L3a] worker 先 claim LLM 任务', claimedA);
    ok(jobStatus('llm_jobs', llmId) === 'running', '[L3b] LLM job 已 running');
    ok(getActiveLease('production_gpu') === null, '[L3c] LLM 不占用 production_gpu');

    const claimedB = claimNextAnyJob('worker-tts');
    ok(claimedB?.type === 'tts' && claimedB.job.id === ttsId, '[L3d] 第二个 worker 同时 claim TTS 任务', claimedB);
    ok(jobStatus('tts_jobs', ttsId) === 'running', '[L3e] TTS job 已 running');
    ok(getActiveLease('production_gpu')?.owner_job_type === 'tts', '[L3f] TTS 占用 production_gpu lease');

    // 释放：LLM 任务完成 + TTS 任务完成
    getDb().prepare(`UPDATE llm_jobs SET status='succeeded' WHERE id=?`).run(llmId);
    getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId);
    releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);
    ok(getActiveLease('production_gpu') === null, '[L3g] 双任务结束后 production_gpu lease 释放');
  }

  // ============ L4：调度器 —— GPU 组内 TTS 与 Render 互斥 ============
  {
    const now = new Date().toISOString();
    const ttsId = insertTtsJob(projectId, now);
    const renderId = insertRenderJob(projectId, new Date(Date.now() + 1000).toISOString());

    const claimedA = claimNextAnyJob('worker-gpu-a');
    ok(claimedA?.type === 'tts' && claimedA.job.id === ttsId, '[L4a] worker-a claim TTS（占 GPU）', claimedA);
    ok(getActiveLease('production_gpu')?.owner_job_type === 'tts', '[L4b] production_gpu 被 TTS 占用');

    const claimedB = claimNextAnyJob('worker-gpu-b');
    ok(claimedB === null, '[L4c] worker-b 在 GPU 被占时无任务可 claim（render 被跳过）', claimedB);
    ok(jobStatus('render_jobs', renderId) === 'queued', '[L4d] render job 仍 queued');

    // TTS 完成释放
    getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId);
    releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);
    ok(getActiveLease('production_gpu') === null, '[L4e] TTS 释放后 GPU lease 空');

    const claimedC = claimNextAnyJob('worker-gpu-b');
    ok(claimedC?.type === 'render' && claimedC.job.id === renderId, '[L4f] TTS 释放后 render 可被 claim', claimedC);
    getDb().prepare(`UPDATE render_jobs SET status='succeeded' WHERE id=?`).run(renderId);
    releaseResourceLeaseForJob('production_gpu', 'render', renderId);
  }

  // ============ L5：remote_image_api（APIYi）与 TTS 可同时 running ============
  {
    const now = new Date().toISOString();
    const ttsId = insertTtsJob(projectId, now);
    const remoteImgId = insertAssetGenerationJob(projectId, new Date(Date.now() + 1000).toISOString());

    const claimedA = claimNextAnyJob('worker-img-a');
    ok(claimedA?.type === 'tts' && claimedA.job.id === ttsId, '[L5a] worker-a claim TTS（占 GPU）', claimedA);
    ok(getActiveLease('production_gpu')?.owner_job_type === 'tts', '[L5b] production_gpu 被 TTS 占用');

    // APIYi → remote_image_api → 不需要 production_gpu → 可与 TTS 同时 claim
    const claimedB = claimNextAnyJob('worker-img-b');
    ok(claimedB?.type === 'asset_generation' && claimedB.job.id === remoteImgId, '[L5c] APIYi (remote) 无需 GPU，可与 TTS 同时 running');
    ok(claimedB?.resourceClass === 'remote_image_api', '[L5d] APIYi job resourceClass = remote_image_api');

    getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId);
    releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);
    getDb().prepare(`UPDATE asset_generation_jobs SET status='succeeded' WHERE id=?`).run(remoteImgId);
  }

  // ============ L6：local_image_gpu（ComfyUI/local）与 TTS 互斥 ============
  {
    const now = new Date().toISOString();
    const ttsId = insertTtsJob(projectId, now);
    const localImgId = insertLocalImageGenerationJob(projectId, new Date(Date.now() + 1000).toISOString());

    const claimedA = claimNextAnyJob('worker-local-a');
    ok(claimedA?.type === 'tts' && claimedA.job.id === ttsId, '[L6a] worker-a claim TTS（占 GPU）', claimedA);

    const claimedB = claimNextAnyJob('worker-local-b');
    ok(claimedB === null, '[L6b] local_image_gpu 与 TTS 同属 GPU 组，被互斥');
    ok(jobStatus('asset_generation_jobs', localImgId) === 'queued', '[L6c] local image job 仍 queued');

    getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId);
    releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);

    const claimedC = claimNextAnyJob('worker-local-b');
    ok(claimedC?.type === 'asset_generation' && claimedC.job.id === localImgId, '[L6d] TTS 释放后 local image 可被 claim', claimedC);
    ok(claimedC?.resourceClass === 'local_image_gpu', '[L6e] local image job resourceClass = local_image_gpu');
    getDb().prepare(`UPDATE asset_generation_jobs SET status='succeeded' WHERE id=?`).run(localImgId);
    releaseResourceLeaseForJob('production_gpu', 'asset_generation', localImgId);
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-resource-leases'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] Workflow Resource Leases 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] Workflow Resource Leases 测试全部通过 ✅');
}

void main();

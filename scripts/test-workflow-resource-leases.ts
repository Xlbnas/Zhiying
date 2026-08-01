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
// 短租约：验证长时间任务期间的 heartbeat 续约（L7/L8）
process.env.ZHIYING_RESOURCE_LEASE_MS = '400';
// 短心跳间隔：与短 TTL 匹配（生产默认 2s 不变）
process.env.ZHIYING_ASSET_HEARTBEAT_MS = '100';
// 供 L7b 的 asset executor 使用（mock provider，零真实调用）
process.env.APIYI_API_KEY = 'test-key';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {MockTtsProvider} from '../src/lib/tts/mock';
import {createResourceLeaseHeartbeat} from '../src/lib/resources/lease-heartbeat';
import type {GeneratedImageProvider} from '../src/lib/assets/providers/generated';
import {runTtsJob} from '../src/worker/tts-executor';
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

/** L7a 专用：payload 满足 anyTtsJobPayloadSchema v1.0（可被 executor 实际执行）。 */
function insertTtsJobV1(projectId: string, queuedAt: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO tts_jobs (
       id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
       provider, voice_profile_id, voice_profile_revision, status, payload_json, queued_at
     ) VALUES (?, ?, ?, 1, 'N001', 'mock', 'default', '1', 'queued', ?, ?)`,
  ).run(
    id, projectId, crypto.randomUUID(),
    JSON.stringify({
      schemaVersion: '1.0',
      narrationPlanArtifactId: crypto.randomUUID(),
      narrationPlanArtifactVersion: 1,
      scriptV2Version: 1,
      compilerVersion: '1.0',
      unitId: 'N001',
      unitText: 'long running lease test',
    }),
    queuedAt,
  );
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
     ) VALUES (?, ?, 'S001', 'S001-R01', ?, 'prompt', 'apiyi', 'sd3', 'local_image_gpu', 'production_gpu', 'queued', ?, ?)`,
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
  // M7.3A.3.1：executor 的 Fence A / 原子 commit 需要 active scenes source
  const {generateVersion} = await import('../src/lib/workflow/operations');
  generateVersion({
    projectId,
    stage: 'scenes',
    contentType: 'json',
    source: 'manual_edit',
    content: JSON.stringify({
      chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
      scenes: [{
        id: 'S001', chapter: 1, chapterTitle: '测试章', start: 0, end: 10, duration: 10,
        startFrame: 0, durationInFrames: 300, category: 'B-roll', visualType: 'Asset',
        template: null, sourceTemplate: null, narrationSummary: '摘要', description: '测试画面',
        notes: '', assetIds: [], licenseStatus: 'not-applicable', subtitlePosition: 'bottom',
        transitionIn: 'none', transitionOut: 'none',
        assetRequirements: [{kind: 'image', subject: '测试主体', query: 'test subject', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed', requirementId: 'S001-R01'}],
      }],
    }),
  });

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

  // ============ L7：长时间运行任务期间的 lease 心跳续约（真实 executor 路径） ============
  // 租约 TTL=400ms（env 覆盖）；任务运行 ~1.2s > TTL，靠 heartbeat 续约保住 lease。
  {
    // L7a：长 TTS 任务（MockTtsProvider delayMs=1200 + heartbeatMs=100）
    const now = new Date().toISOString();
    const ttsId = insertTtsJobV1(projectId, now);
    const localImgId = insertLocalImageGenerationJob(projectId, new Date(Date.now() + 1000).toISOString());

    const claimedA = claimNextAnyJob('worker-long-tts');
    ok(claimedA?.type === 'tts' && claimedA.job.id === ttsId, '[L7a] 长 TTS 任务 claim 成功（持有 lease）', claimedA);
    if (!claimedA || claimedA.type !== 'tts' || claimedA.job.id !== ttsId) {
      throw new Error('L7a: 未能 claim 长 TTS 任务');
    }
    ok(getActiveLease('production_gpu')?.owner_job_id === ttsId, '[L7b] TTS claim 后持有 production_gpu lease');

    const runningA = runTtsJob(
      claimedA.job,
      {
        isShuttingDown: () => false,
        log: () => {},
        resourceLease: claimedA.resourceLease
          ? {group: claimedA.resourceLease.group, ownerToken: claimedA.resourceLease.ownerToken}
          : undefined,
      },
      {providers: {mock: new MockTtsProvider({delayMs: 1200})}, heartbeatMs: 100},
    );

    // 原始 TTL(400ms) 已过；heartbeat(100ms) 应已多次续约
    await sleep(600);
    const leaseMid = getActiveLease('production_gpu');
    ok(leaseMid !== null && leaseMid.owner_job_id === ttsId, '[L7c] 超过原始 TTL 后 lease 仍有效（heartbeat 续约）', leaseMid);

    const competitor = claimNextAnyJob('worker-competitor');
    ok(competitor === null, '[L7d] 长 TTS 运行期间竞争者无法抢占 GPU（local image 被 lease 挡住）', competitor);
    ok(jobStatus('asset_generation_jobs', localImgId) === 'queued', '[L7e] local image job 在长 TTS 期间保持 queued');

    await runningA;
    ok(jobStatus('tts_jobs', ttsId) === 'succeeded', '[L7f] 长 TTS 任务 succeeded');
    // M7.3A.3：executor 不再执行 normal release —— 测试显式模拟 runner finally 释放
    if (claimedA.resourceLease) {
      releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);
    }
    ok(getActiveLease('production_gpu') === null, '[L7g] 长 TTS 结束后 lease 释放');

    const claimedB = claimNextAnyJob('worker-competitor');
    ok(claimedB?.type === 'asset_generation' && claimedB.job.id === localImgId, '[L7h] TTS 结束后竞争者可 claim local image', claimedB);
    if (!claimedB || claimedB.type !== 'asset_generation') {
      throw new Error('L7h: TTS 结束后未能 claim local image');
    }
    getDb().prepare(`UPDATE asset_generation_jobs SET status='succeeded' WHERE id=?`).run(localImgId);
    releaseResourceLeaseForJob('production_gpu', 'asset_generation', localImgId);
  }

  // ============ L8：长 local_image_gpu 任务期间的 lease 心跳续约（真实 executor 路径） ============
  {
    const {runAssetGenerationJob} = await import('../src/worker/asset-generation-executor');
    const {getGeneratedImageProvider} = await import('../src/lib/assets/providers/generated');
    const provider = getGeneratedImageProvider();
    (provider as GeneratedImageProvider & {configured: boolean}).configured = true;
    provider.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
    provider.generate = async () => {
      await sleep(1200);
      return [{
        candidateId: 'mock-long',
        mimeType: 'image/png',
        data: Buffer.from('fake-png-data', 'utf8'),
        width: 1920,
        height: 1080,
        provider: provider.name,
        model: 'mock',
        prompt: 'long-run',
        metadata: {providerRequestId: 'req-long'},
      }];
    };

    const now = new Date().toISOString();
    // local image 先入队（先 claim）；TTS 后入队作为被 lease 挡住的竞争者
    const localImgId2 = insertLocalImageGenerationJob(projectId, now);

    const claimedImg = claimNextAnyJob('worker-long-img');
    ok(claimedImg?.type === 'asset_generation' && claimedImg.job.id === localImgId2, '[L8a] 长 local image 任务 claim 成功', claimedImg);
    if (!claimedImg || claimedImg.type !== 'asset_generation' || claimedImg.job.id !== localImgId2) {
      throw new Error('L8a: 未能 claim 长 local image 任务');
    }
    const ttsId2 = insertTtsJob(projectId, new Date(Date.now() + 1000).toISOString());

    const runningB = runAssetGenerationJob(
      claimedImg.job,
      {isShuttingDown: () => false, log: () => {}, shutdownSignal: new AbortController().signal},
      claimedImg.resourceLease
        ? {group: claimedImg.resourceLease.group, ownerToken: claimedImg.resourceLease.ownerToken}
        : undefined,
    );

    await sleep(600);
    const leaseMid2 = getActiveLease('production_gpu');
    ok(leaseMid2 !== null && leaseMid2.owner_job_id === localImgId2, '[L8b] 超过原始 TTL 后 lease 仍有效（生成中 heartbeat）', leaseMid2);

    const competitor2 = claimNextAnyJob('worker-competitor');
    ok(competitor2 === null, '[L8c] 长 image 生成期间竞争者无法抢占 GPU（TTS 被挡）', competitor2);
    ok(jobStatus('tts_jobs', ttsId2) === 'queued', '[L8d] TTS job 在长 image 生成期间保持 queued');

    await runningB;
    ok(jobStatus('asset_generation_jobs', localImgId2) === 'succeeded', '[L8e] 长 image 任务 succeeded');
    // M7.3A.3：executor 不再执行 normal release —— 测试显式模拟 runner finally 释放
    if (claimedImg.resourceLease) {
      releaseResourceLeaseForJob('production_gpu', 'asset_generation', localImgId2);
    }
    ok(getActiveLease('production_gpu') === null, '[L8f] 长 image 结束后 lease 释放');

    const claimedTts = claimNextAnyJob('worker-competitor');
    ok(claimedTts?.type === 'tts' && claimedTts.job.id === ttsId2, '[L8g] image 结束后竞争者可 claim TTS', claimedTts);
    if (!claimedTts || claimedTts.type !== 'tts') {
      throw new Error('L8g: image 结束后未能 claim TTS');
    }
    getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId2);
    releaseResourceLeaseForJob('production_gpu', 'tts', ttsId2);
  }

  // ============ L9：lease lost → abort + fail-closed（不得提交 success） ============
  {
    const now = new Date().toISOString();
    const ttsId = insertTtsJobV1(projectId, now);

    const claimedA = claimNextAnyJob('worker-lease-lost');
    ok(claimedA?.type === 'tts' && claimedA.job.id === ttsId, '[L9a] 长 TTS 任务 claim 成功', claimedA);
    if (!claimedA || claimedA.type !== 'tts' || claimedA.job.id !== ttsId) {
      throw new Error('L9a: 未能 claim TTS 任务');
    }

    const running = runTtsJob(
      claimedA.job,
      {
        isShuttingDown: () => false,
        log: () => {},
        resourceLease: claimedA.resourceLease
          ? {group: claimedA.resourceLease.group, ownerToken: claimedA.resourceLease.ownerToken}
          : undefined,
      },
      {providers: {mock: new MockTtsProvider({delayMs: 1200})}, heartbeatMs: 100},
    );

    await sleep(150); // 任务已运行、lease 已心跳
    ok(getActiveLease('production_gpu') !== null, '[L9b] 执行中持有 lease');
    // 测试线程删除 lease row（模拟其他 worker 回收/抢占）→ 下一次 heartbeat 返回 false → lost → abort
    getDb().prepare(`DELETE FROM resource_group_leases WHERE resource_group='production_gpu'`).run();
    await running;

    ok(jobStatus('tts_jobs', ttsId) === 'queued', '[L9c] lease lost → requeue（不提交 success、不标记 cancelled）', jobStatus('tts_jobs', ttsId));
    ok(getActiveLease('production_gpu') === null, '[L9d] lease lost 后无有效 lease');
    // 另一个 worker 可立即取得 lease 并 claim GPU 任务（无双 GPU 成功执行窗口）
    const competitor = claimNextAnyJob('worker-competitor');
    ok(
      competitor?.type === 'tts' && competitor.job.id === ttsId && competitor.resourceLease !== undefined,
      '[L9e] 竞争者可取得 lease 并 claim requeued TTS 任务',
      competitor?.type,
    );
    if (competitor?.type === 'tts') {
      getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId);
      releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);
    }
  }

  // ============ L10：render bundle 阶段 lease 保活（M7.3A.3.1） ============
  // 模拟 runRenderJob 生命周期：claim → heartbeat 启动（bundle 前）→ bundle(400ms)
  // → 释放。bundle 超过 lease TTL(100ms) 时靠 heartbeat(25ms) 保活；
  // lease 被删 → lost 标志（bundle 后检查 → 不进 renderMedia）。
  {
    const now = new Date().toISOString();
    const renderId = insertRenderJob(projectId, now);
    const ttsId = insertTtsJob(projectId, new Date(Date.now() + 1000).toISOString());

    const claimed = claimNextAnyJob('worker-render-bundle');
    ok(claimed?.type === 'render' && claimed.job.id === renderId, '[L10a] render claim 成功（持有 lease）', claimed);
    if (!claimed || claimed.type !== 'render' || !claimed.resourceLease) {
      throw new Error('L10a: 未能 claim render');
    }

    // bundle 前启动 heartbeat（与 runRenderJob 一致）
    let lost = false;
    const hb = createResourceLeaseHeartbeat({
      group: 'production_gpu',
      ownerToken: claimed.resourceLease.ownerToken,
      intervalMs: 25,
      leaseMs: 100,
      onLost: () => { lost = true; },
    });

    await sleep(150); // 150ms > 原始 TTL(100ms)
    ok(getActiveLease('production_gpu')?.owner_job_id === renderId, '[L10b] 150ms：bundle 期间 lease 存活（heartbeat 保活）');
    ok(claimNextAnyJob('worker-competitor') === null, '[L10c] 150ms：第二 Worker 不能 claim TTS');
    ok(jobStatus('tts_jobs', ttsId) === 'queued', '[L10d] TTS 保持 queued');

    await sleep(100); // 250ms
    ok(!lost && getActiveLease('production_gpu') !== null, '[L10e] 250ms：仍存活');
    ok(claimNextAnyJob('worker-competitor') === null, '[L10f] 250ms：第二 Worker 仍被挡');

    await sleep(100); // 350ms
    ok(getActiveLease('production_gpu') !== null && !lost, '[L10g] 350ms：仍存活');

    await sleep(60); // 410ms：bundle 完成
    ok(!lost, '[L10h] bundle 结束（>4×TTL）：lease 未丢失');
    hb.dispose();
    // 模拟 runner finally 释放
    releaseResourceLeaseForJob('production_gpu', 'render', renderId);
    const c2 = claimNextAnyJob('worker-competitor');
    ok(c2?.type === 'tts' && c2.job.id === ttsId, '[L10i] 释放后第二 Worker 可 claim TTS');
    if (c2?.type === 'tts') {
      getDb().prepare(`UPDATE tts_jobs SET status='succeeded' WHERE id=?`).run(ttsId);
      releaseResourceLeaseForJob('production_gpu', 'tts', ttsId);
    }

    // 场景 c：bundle 期间 lease 被删 → lost 标志 → 不得继续（模拟不进 renderMedia）
    const now2 = new Date().toISOString();
    const renderId2 = insertRenderJob(projectId, now2);
    const claimed2 = claimNextAnyJob('worker-render-bundle-2');
    if (!claimed2 || claimed2.type !== 'render' || !claimed2.resourceLease) {
      throw new Error('L10j: 未能 claim render 2');
    }
    let lost2: boolean = false;
    const hb2 = createResourceLeaseHeartbeat({
      group: 'production_gpu',
      ownerToken: claimed2.resourceLease.ownerToken,
      intervalMs: 25,
      leaseMs: 100,
      onLost: () => { lost2 = true; },
    });
    await sleep(60);
    getDb().prepare(`DELETE FROM resource_group_leases WHERE resource_group='production_gpu'`).run();
    await sleep(60); // 下一次 heartbeat → false → lost
    ok(lost2, '[L10j] bundle 期间 lease 被删 → lost 标志（bundle 后检查将拒绝进入 renderMedia）');
    hb2.dispose();
    releaseResourceLeaseForJob('production_gpu', 'render', renderId2);
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-workflow-resource-leases'), {recursive: true, force: true});
  fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] Workflow Resource Leases 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] Workflow Resource Leases 测试全部通过 ✅');
}

void main();

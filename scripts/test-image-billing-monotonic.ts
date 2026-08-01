/**
 * M7.3A.3.2 image billing 单调性测试（零真实 API 费用）。
 *
 * 用法：npx tsx scripts/test-image-billing-monotonic.ts
 * 使用临时数据目录（data/test-image-billing-monotonic），结束后清理。
 *
 * 覆盖：
 * 1. provider 成功 + 文件写入失败 → job failed RESULT_PERSIST_FAILED、
 *    billing confirmed_charged、usage cost 保留、无 asset row；
 * 2. provider 成功 + asset INSERT 失败（触发器强制）→ 同上；
 * 3. provider 成功 + JOB_STATE_INVALID → 不覆盖原 job 终态、usage 仍 charged、
 *    executor 正常返回（主循环不崩）；
 * 4. confirmed_charged 后再 finalize unknown → 仍 confirmed_charged（单调保护）；
 * 5. timeout 无 candidate → unknown_billing；
 * 6. auth/config 调用前失败 → confirmed_zero。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-image-billing-monotonic');
process.env.LLM_PROVIDER = 'gemini-3.1-flash-image';
process.env.TTS_PROVIDER = 'gemini-3.1-flash-image';
process.env.APIYI_API_KEY = 'test-key';
process.env.ZHIYING_ASSET_HEARTBEAT_MS = '100';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {computeRequirementSnapshotHash} from '../src/lib/assets/requirements';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {releaseResourceLeaseForJob} from '../src/lib/resources/leases';

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 400));
  }
}

function makeScene(): Record<string, unknown> {
  return {
    id: 'S001',
    chapter: 1,
    chapterTitle: '测试章',
    start: 0,
    end: 10,
    duration: 10,
    startFrame: 0,
    durationInFrames: 300,
    category: 'B-roll',
    visualType: 'Asset',
    template: null,
    sourceTemplate: null,
    narrationSummary: '摘要',
    description: '测试画面',
    notes: '',
    assetIds: [],
    licenseStatus: 'not-applicable',
    subtitlePosition: 'bottom',
    transitionIn: 'none',
    transitionOut: 'none',
    assetRequirements: [
      {
        kind: 'image',
        subject: '测试主体',
        query: 'test subject',
        usage: 'primary',
        policy: 'generated',
        authenticity: 'synthetic_allowed',
        requirementId: 'S001-R01',
      },
    ],
  };
}

function seedProject(projectId: string): void {
  generateVersion({
    projectId,
    stage: 'scenes',
    content: JSON.stringify({
      chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
      scenes: [makeScene()],
    }),
    contentType: 'json',
    source: 'manual_edit',
  });
}

function usageRow(requestId: string): {cost_cny: number | null; metadata: string} | undefined {
  return getDb().prepare(`SELECT cost_cny, metadata FROM project_usage_events WHERE id = ?`).get(requestId) as
    | {cost_cny: number | null; metadata: string}
    | undefined;
}

function usageStatus(requestId: string): string | undefined {
  const row = usageRow(requestId);
  return row ? (JSON.parse(row.metadata) as {status?: string}).status : undefined;
}

function insertQueuedJob(projectId: string, requestId: string): string {
  const jobId = crypto.randomUUID();
  // source_requirement_hash 用真实 snapshot hash（Fence A 校验必须通过）
  const goodHash = computeRequirementSnapshotHash(JSON.stringify({
    requirementId: 'S001-R01',
    kind: 'image',
    subject: '测试主体',
    query: 'test subject',
    usage: 'primary',
    policy: 'generated',
    authenticity: 'synthetic_allowed',
  }));
  getDb().prepare(
    `INSERT INTO asset_generation_jobs (
       id, project_id, scene_id, requirement_id, request_id, prompt, provider, model,
       resource_class, resource_group, source_scenes_version_id, source_requirement_hash,
       requirement_json, request_fingerprint, status,
       image_size, aspect_ratio, provider_config_version, created_at, updated_at
     ) VALUES (?, ?, 'S001', 'S001-R01', ?, 'p', 'apiyi', 'gemini-3.1-flash-image', 'remote_image_api', NULL,
       '1', ?, '{}', 'fp', 'queued', '1K', '16:9', 'apiyi:1', ?, ?)`,
  ).run(jobId, projectId, requestId, goodHash, new Date().toISOString(), new Date().toISOString());
  return jobId;
}

async function runAssetJob(requestId: string): Promise<void> {
  const claimed = claimNextAnyJob('worker-billing');
  if (!claimed || claimed.type !== 'asset_generation') throw new Error(`claim 失败: ${claimed?.type}`);
  try {
    const {runAssetGenerationJob} = await import('../src/worker/asset-generation-executor');
    await runAssetGenerationJob(claimed.job, {
      isShuttingDown: () => false,
      log: () => {},
      shutdownSignal: new AbortController().signal,
    }, claimed.resourceLease
      ? {group: claimed.resourceLease.group, ownerToken: claimed.resourceLease.ownerToken}
      : undefined);
  } finally {
    if (claimed.resourceLease) {
      releaseResourceLeaseForJob('production_gpu', 'asset_generation', claimed.job.id);
    }
  }
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-image-billing-monotonic'), {recursive: true, force: true});

  const {getGeneratedImageProvider, ImageGenerationError} = await import('../src/lib/assets/providers/generated');
  const {finalizeImageGenerationUsage} = await import('../src/lib/usage-events');
  const provider = getGeneratedImageProvider();
  (provider as GeneratedImageProvider & {configured: boolean}).configured = true;
  provider.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};

  function installOkProvider(): void {
    provider.generate = async () => [{
      candidateId: 'mock-billing',
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data', 'utf8'),
      width: 1920,
      height: 1080,
      provider: 'apiyi',
      model: 'gemini-3.1-flash-image',
      prompt: 'p',
      metadata: {providerRequestId: 'prov-billing'},
    }];
  }

  // ============ B1：provider 成功 + 文件写入失败 → RESULT_PERSIST_FAILED + charged ============
  {
    const projectId = createProjectWithWorkflow({topic: 'billing-1', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    insertQueuedJob(projectId, 'bill-1');
    installOkProvider();
    // 把 public/assets/<pid> 预置为普通文件 → mkdirSync 抛 ENOTDIR（文件写入失败）
    const blockPath = path.resolve(process.cwd(), 'public', 'assets', projectId);
    fs.mkdirSync(path.dirname(blockPath), {recursive: true});
    fs.writeFileSync(blockPath, 'block file');

    await runAssetJob('bill-1');
    const job = getDb().prepare(`SELECT status, failure_phase, billing_status FROM asset_generation_jobs WHERE request_id='bill-1'`).get() as
      {status: string; failure_phase: string | null; billing_status: string};
    ok(job.status === 'failed' && job.failure_phase === 'RESULT_PERSIST_FAILED', '[B1a] 文件写入失败 → failed + RESULT_PERSIST_FAILED', job);
    ok(job.billing_status === 'confirmed_charged', '[B1b] billing 保持 confirmed_charged（不降级）', job.billing_status);
    ok(usageStatus('bill-1') === 'confirmed_charged', '[B1c] usage status confirmed_charged');
    ok((usageRow('bill-1')?.cost_cny ?? 0) > 0, '[B1d] usage cost 保留（>0）');
    const assets = getDb().prepare(`SELECT count(*) AS c FROM assets WHERE project_id=?`).get(projectId) as {c: number};
    ok(assets.c === 0, '[B1e] 无 asset row（文件未落库）');
    fs.rmSync(blockPath, {force: true});
  }

  // ============ B2：provider 成功 + asset INSERT 失败（触发器）→ 同上 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'billing-2', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    insertQueuedJob(projectId, 'bill-2');
    installOkProvider();
    getDb().prepare(
      `CREATE TRIGGER force_asset_insert_fail BEFORE INSERT ON assets
       BEGIN SELECT RAISE(ABORT, 'forced asset insert failure'); END`,
    ).run();

    await runAssetJob('bill-2');
    const job = getDb().prepare(`SELECT status, failure_phase, billing_status FROM asset_generation_jobs WHERE request_id='bill-2'`).get() as
      {status: string; failure_phase: string | null; billing_status: string};
    ok(job.status === 'failed' && job.failure_phase === 'RESULT_PERSIST_FAILED', '[B2a] asset INSERT 失败 → failed + RESULT_PERSIST_FAILED', job);
    ok(job.billing_status === 'confirmed_charged', '[B2b] billing 保持 confirmed_charged', job.billing_status);
    ok(usageStatus('bill-2') === 'confirmed_charged', '[B2c] usage status confirmed_charged');
    getDb().prepare(`DROP TRIGGER force_asset_insert_fail`).run();
    fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});
  }

  // ============ B3：provider 成功 + JOB_STATE_INVALID → 不覆盖原 job 终态 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'billing-3', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    insertQueuedJob(projectId, 'bill-3');
    installOkProvider();
    // 在 claim 后、commit 前把 job 置回 queued（owner 清空）——通过 provider gate 控制时序：
    // 让 provider 阻塞，claim 后手动 requeue，再放行 provider → commit 时 JOB_STATE_INVALID
    let releaseProvider!: () => void;
    const gate = new Promise<void>((r) => { releaseProvider = r; });
    provider.generate = async () => {
      await gate;
      return [{
        candidateId: 'mock-b3',
        mimeType: 'image/png',
        data: Buffer.from('fake-png-data', 'utf8'),
        width: 1920,
        height: 1080,
        provider: 'apiyi',
        model: 'gemini-3.1-flash-image',
        prompt: 'p',
        metadata: {providerRequestId: 'prov-b3'},
      }];
    };
    const running = (async () => {
      const claimed = claimNextAnyJob('worker-billing-3');
      if (!claimed || claimed.type !== 'asset_generation') throw new Error('claim 失败');
      try {
        const {runAssetGenerationJob} = await import('../src/worker/asset-generation-executor');
        await runAssetGenerationJob(claimed.job, {
          isShuttingDown: () => false,
          log: () => {},
          shutdownSignal: new AbortController().signal,
        }, claimed.resourceLease
          ? {group: claimed.resourceLease.group, ownerToken: claimed.resourceLease.ownerToken}
          : undefined);
      } finally {
        if (claimed.resourceLease) {
          releaseResourceLeaseForJob('production_gpu', 'asset_generation', claimed.job.id);
        }
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    // 并发 requeue（模拟 recover/竞争）：status→queued + owner 清空
    getDb().prepare(`UPDATE asset_generation_jobs SET status='queued', owner_token=NULL WHERE request_id='bill-3'`).run();
    releaseProvider();
    await running; // executor 正常返回（主循环不崩）

    const job = getDb().prepare(`SELECT status FROM asset_generation_jobs WHERE request_id='bill-3'`).get() as {status: string};
    ok(job.status === 'queued', '[B3a] 原 job 终态不被覆盖（保持 queued）', job.status);
    ok(usageStatus('bill-3') === 'confirmed_charged', '[B3b] usage 仍 confirmed_charged');
    fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ B4：confirmed_charged 后再 finalize unknown → 仍 charged（单调保护） ============
  {
    const projectId = createProjectWithWorkflow({topic: 'billing-4', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    finalizeImageGenerationUsage({
      attemptId: 'bill-4',
      projectId,
      sceneId: 'S001',
      requirementId: 'S001-R01',
      provider: 'apiyi',
      model: 'gemini-3.1-flash-image',
      requestedSize: '1K',
      aspectRatio: '16:9',
      imageCount: 1,
      status: 'confirmed_charged',
      providerRequestId: 'prov-4',
    });
    // 后续 unknown finalize（例如延迟的失败事件）不得降级
    finalizeImageGenerationUsage({
      attemptId: 'bill-4',
      projectId,
      sceneId: 'S001',
      requirementId: 'S001-R01',
      provider: 'apiyi',
      model: 'gemini-3.1-flash-image',
      requestedSize: '1K',
      aspectRatio: '16:9',
      imageCount: 1,
      status: 'unknown_billing',
    });
    ok(usageStatus('bill-4') === 'confirmed_charged', '[B4a] charged 后 finalize unknown → 仍 charged');
    const row = usageRow('bill-4')!;
    ok((row.cost_cny ?? 0) > 0, '[B4b] cost 不被清空');
    const meta = JSON.parse(row.metadata) as {rejectedFinalize?: string; costSource?: string};
    ok(meta.rejectedFinalize === 'unknown_billing', '[B4c] 记录 rejectedFinalize（不覆盖收费结论）', meta);
    // confirmed_zero 后 unknown → 仍 zero
    finalizeImageGenerationUsage({
      attemptId: 'bill-4z',
      projectId,
      sceneId: 'S001',
      requirementId: 'S001-R01',
      provider: 'apiyi',
      model: 'gemini-3.1-flash-image',
      requestedSize: '1K',
      aspectRatio: '16:9',
      imageCount: 0,
      status: 'confirmed_zero',
    });
    finalizeImageGenerationUsage({
      attemptId: 'bill-4z',
      projectId,
      sceneId: 'S001',
      requirementId: 'S001-R01',
      provider: 'apiyi',
      model: 'gemini-3.1-flash-image',
      requestedSize: '1K',
      aspectRatio: '16:9',
      imageCount: 0,
      status: 'unknown_billing',
    });
    ok(usageStatus('bill-4z') === 'confirmed_zero', '[B4d] zero 后 finalize unknown → 仍 zero');
  }

  // ============ B5：timeout 无 candidate → unknown_billing ============
  {
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE status='queued'`).run();
    const projectId = createProjectWithWorkflow({topic: 'billing-5', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    insertQueuedJob(projectId, 'bill-5');
    provider.generate = async () => {
      throw new ImageGenerationError('PROVIDER_RESPONSE_TIMEOUT', 'timeout', undefined, {model: 'gemini-3.1-flash-image', size: '1K', aspectRatio: '16:9'});
    };
    await runAssetJob('bill-5');
    const job = getDb().prepare(`SELECT status, billing_status FROM asset_generation_jobs WHERE request_id='bill-5'`).get() as
      {status: string; billing_status: string};
    ok(job.status === 'indeterminate' && job.billing_status === 'unknown_billing', '[B5a] timeout 无 candidate → indeterminate + unknown_billing', job);
  }

  // ============ B6：config 调用前失败 → confirmed_zero ============
  {
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE status='queued'`).run();
    const projectId = createProjectWithWorkflow({topic: 'billing-6', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    insertQueuedJob(projectId, 'bill-6');
    // provider 未配置（configured=false）→ provider_unavailable → confirmed_zero
    (provider as GeneratedImageProvider & {configured: boolean}).configured = false;
    provider.health = {healthy: false, available: false, reason: 'not_configured', checkedAt: Date.now()};
    await runAssetJob('bill-6');
    const job = getDb().prepare(`SELECT status, billing_status FROM asset_generation_jobs WHERE request_id='bill-6'`).get() as
      {status: string; billing_status: string};
    ok(job.status === 'failed' && job.billing_status === 'confirmed_zero', '[B6a] 调用前失败 → failed + confirmed_zero', job);
    (provider as GeneratedImageProvider & {configured: boolean}).configured = true;
    provider.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
  }

  // 清理
  const assetProjectIds = (getDb().prepare('SELECT DISTINCT project_id FROM assets').all() as Array<{project_id: string}>).map((r) => r.project_id);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-image-billing-monotonic'), {recursive: true, force: true});
  for (const pid of assetProjectIds) {
    fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', pid), {recursive: true, force: true});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

import type {GeneratedImageProvider} from '../src/lib/assets/providers/generated';

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

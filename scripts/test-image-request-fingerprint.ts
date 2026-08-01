/**
 * M7.3A.3 Strict Request Idempotency 测试（零真实 API 费用）。
 *
 * 用法：npx tsx scripts/test-image-request-fingerprint.ts
 * 使用临时数据目录（data/test-image-request-fingerprint），结束后清理。
 *
 * 覆盖：
 * - 相同 requestId + 相同请求（prompt/provider/model/resourceClass/source version/hash）→ reuse；
 * - 相同 requestId + 改变 prompt → REQUEST_ID_CONFLICT (409)；
 * - 相同 requestId + 改变 model → 409；
 * - 相同 requestId + 改变 scenes version → 409；
 * - 相同 requestId + 改变 requirement hash → 409；
 * - 空白/换行规范化后语义相同 → reuse；
 * - 409 时零 provider call、旧 job 不被修改。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-image-request-fingerprint');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.APIYI_API_KEY = 'test-key';
process.env.APIYI_IMAGE_MODEL = 'gemini-3.1-flash-image';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {releaseResourceLeaseForJob} from '../src/lib/resources/leases';
import {runAssetGenerationJob} from '../src/worker/asset-generation-executor';

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

function makeScene(query: string): Record<string, unknown> {
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
        query,
        usage: 'primary',
        policy: 'generated',
        authenticity: 'synthetic_allowed',
      },
    ],
  };
}

function seedProject(projectId: string, query = 'test subject'): void {
  const scenesJson = JSON.stringify({
    chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
    scenes: [makeScene(query)],
  });
  generateVersion({
    projectId,
    stage: 'scenes',
    content: scenesJson,
    contentType: 'json',
    source: 'manual_edit',
  });
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-image-request-fingerprint'), {recursive: true, force: true});

  const {POST} = await import('../src/app/api/projects/[id]/assets/generate/route');
  const {getGeneratedImageProvider} = await import('../src/lib/assets/providers/generated');

  const provider = getGeneratedImageProvider();
  (provider as GeneratedImageProvider & {configured: boolean}).configured = true;
  provider.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
  let providerCalls = 0;
  provider.generate = async () => {
    providerCalls++;
    return [{
      candidateId: `mock-${providerCalls}`,
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data', 'utf8'),
      width: 1920,
      height: 1080,
      provider: provider.name,
      model: process.env.APIYI_IMAGE_MODEL || 'mock',
      prompt: 'x',
      metadata: {providerRequestId: `req-${providerCalls}`},
    }];
  };

  function postGenerate(projectId: string, requestId: string, prompt = 'hello world'): Promise<Response> {
    return POST(new Request('http://test', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sceneId: 'S001', requirementId: 'S001-R01', requestId, prompt}),
    }), {params: Promise.resolve({id: projectId})});
  }

  // ============ F1：相同 requestId + 相同请求 → reuse（幂等） ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-1', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-1-001';
    const r1 = await postGenerate(projectId, requestId);
    const j1 = (await r1.json()) as {reused: boolean};
    ok(r1.status === 202 && j1.reused === false, '[F1a] 首次 enqueue 202 且非 reused');
    const r2 = await postGenerate(projectId, requestId);
    const j2 = (await r2.json()) as {reused: boolean};
    ok(r2.status === 202 && j2.reused === true, '[F1b] 相同 requestId + 相同请求 → reused');
    const count = (getDb().prepare(
      `SELECT COUNT(*) AS c FROM asset_generation_jobs WHERE project_id = ? AND request_id = ?`,
    ).get(projectId, requestId) as {c: number}).c;
    ok(count === 1, '[F1c] 只产生一个 job');
    ok(providerCalls === 0, '[F1d] enqueue 阶段零 provider call');
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F2：相同 requestId + 改变 prompt → 409 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-2', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-2-001';
    await postGenerate(projectId, requestId, 'prompt A');
    const r2 = await postGenerate(projectId, requestId, 'prompt B');
    const body = (await r2.json()) as {error?: string};
    ok(r2.status === 409 && body.error === 'REQUEST_ID_CONFLICT', '[F2a] 改变 prompt → 409 REQUEST_ID_CONFLICT', body);
    ok(providerCalls === 0, '[F2b] 409 零 provider call');
    const row = getDb().prepare(
      `SELECT prompt FROM asset_generation_jobs WHERE project_id = ? AND request_id = ?`,
    ).get(projectId, requestId) as {prompt: string};
    ok(row.prompt === 'prompt A', '[F2c] 旧 job 不被修改');
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F3：相同 requestId + 改变 model → 409 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-3', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-3-001';
    await postGenerate(projectId, requestId);
    process.env.APIYI_IMAGE_MODEL = 'gemini-other-model';
    const r2 = await postGenerate(projectId, requestId);
    const body = (await r2.json()) as {error?: string; message?: string};
    ok(r2.status === 409 && body.error === 'REQUEST_ID_CONFLICT', '[F3a] 改变 model → 409', body.message);
    process.env.APIYI_IMAGE_MODEL = 'gemini-3.1-flash-image';
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F4：相同 requestId + 改变 scenes version → 409 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-4', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-4-001';
    await postGenerate(projectId, requestId);
    // 重新生成 scenes（version 2，同 query）
    seedProject(projectId);
    const r2 = await postGenerate(projectId, requestId);
    const body = (await r2.json()) as {error?: string; message?: string};
    ok(r2.status === 409 && body.error === 'REQUEST_ID_CONFLICT', '[F4a] 改变 scenes version → 409', body.message);
    ok(JSON.stringify(body.message ?? '').includes('sourceScenesVersionId'), '[F4b] 差异字段列出 sourceScenesVersionId');
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F5：相同 requestId + 改变 requirement hash → 409 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-5', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-5-001';
    await postGenerate(projectId, requestId);
    // 同 version 但 requirement query 变化 → requirement hash 变化
    seedProject(projectId, 'different query text');
    const r2 = await postGenerate(projectId, requestId);
    const body = (await r2.json()) as {error?: string; message?: string};
    ok(r2.status === 409 && body.error === 'REQUEST_ID_CONFLICT', '[F5a] 改变 requirement hash → 409', body.message);
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F6：空白/换行规范化后相同 → reuse ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-6', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-6-001';
    const r1 = await postGenerate(projectId, requestId, '  line one  \r\nline two\n');
    const j1 = (await r1.json()) as {reused: boolean};
    ok(r1.status === 202 && j1.reused === false, '[F6a] 首次 enqueue 成功');
    const r2 = await postGenerate(projectId, requestId, 'line one\nline two');
    const j2 = (await r2.json()) as {reused: boolean};
    ok(r2.status === 202 && j2.reused === true, '[F6b] 规范化后语义相同 → reuse（trim/CRLF/行尾空白）');
    const count = (getDb().prepare(
      `SELECT COUNT(*) AS c FROM asset_generation_jobs WHERE project_id = ? AND request_id = ?`,
    ).get(projectId, requestId) as {c: number}).c;
    ok(count === 1, '[F6c] 仍只有一个 job');
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F7：历史 job（无 fingerprint 列值）字段一致 → 兼容 reuse ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-7', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-7-001';
    // 真实 enqueue（获得正确 fingerprint）
    const r0 = await postGenerate(projectId, requestId, 'hello world');
    ok(r0.status === 202, '[F7a] 初始 enqueue 成功');
    // 模拟 backfill 前的历史行：清空 fingerprint（其余字段保留）
    getDb().prepare(`UPDATE asset_generation_jobs SET request_fingerprint = NULL WHERE project_id = ? AND request_id = ?`)
      .run(projectId, requestId);

    // 字段一致 → 兼容 reuse（并确定性回填 fingerprint）
    const r = await postGenerate(projectId, requestId, 'hello world');
    const j = (await r.json()) as {reused?: boolean; error?: string};
    ok(r.status === 202 && j.reused === true, '[F7b] 历史无 fingerprint 行 + 字段一致 → reused（兼容）', j);
    const fp = (getDb().prepare(`SELECT request_fingerprint FROM asset_generation_jobs WHERE project_id = ? AND request_id = ?`)
      .get(projectId, requestId) as {request_fingerprint: string | null}).request_fingerprint;
    ok(fp !== null && fp.length === 64, '[F7c] reused 时确定性回填 fingerprint', fp?.slice(0, 12));
    // 字段不一致 → 409
    const r2 = await postGenerate(projectId, requestId, 'totally different');
    const j2 = (await r2.json()) as {error?: string};
    ok(r2.status === 409 && j2.error === 'REQUEST_ID_CONFLICT', '[F7d] 历史无 fingerprint 行 + 字段不一致 → 409', j2);
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F8：相同 requestId + 改变 imageSize → 409 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-8', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-8-001';
    await postGenerate(projectId, requestId);
    process.env.APIYI_IMAGE_SIZE = '2K';
    const r2 = await postGenerate(projectId, requestId);
    const body = (await r2.json()) as {error?: string; message?: string};
    ok(r2.status === 409 && body.error === 'REQUEST_ID_CONFLICT', '[F8a] 改变 imageSize → 409', body.message);
    process.env.APIYI_IMAGE_SIZE = '1K';
    // 终态化本块 job，避免污染后续 FIFO claim
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F9：相同 requestId + 改变 aspectRatio → 409 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-9', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-9-001';
    await postGenerate(projectId, requestId);
    process.env.APIYI_IMAGE_ASPECT_RATIO = '4:3';
    const r2 = await postGenerate(projectId, requestId);
    const body = (await r2.json()) as {error?: string; message?: string};
    ok(r2.status === 409 && body.error === 'REQUEST_ID_CONFLICT', '[F9a] 改变 aspectRatio → 409', body.message);
    process.env.APIYI_IMAGE_ASPECT_RATIO = '16:9';
    getDb().prepare(`UPDATE asset_generation_jobs SET status='cancelled' WHERE project_id=?`).run(projectId);
  }

  // ============ F10：enqueue 后修改 env，Worker 仍使用 job 冻结快照 ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-10', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'fp-10-001';
    await postGenerate(projectId, requestId);
    // 执行前修改 env（模拟运行时配置漂移）
    process.env.APIYI_IMAGE_SIZE = '2K';
    process.env.APIYI_IMAGE_ASPECT_RATIO = '4:3';

    let capturedSize: string | undefined;
    let capturedRatio: string | undefined;
    provider.generate = async (input) => {
      capturedSize = input.size;
      capturedRatio = input.aspectRatio;
      providerCalls++;
      return [{
        candidateId: 'mock-f10',
        mimeType: 'image/png',
        data: Buffer.from('fake-png-data', 'utf8'),
        width: 1920,
        height: 1080,
        provider: provider.name,
        model: 'mock',
        prompt: 'x',
        metadata: {providerRequestId: 'req-f10-provider'},
      }];
    };

    const claimed = claimNextAnyJob('worker-f10');
    if (!claimed || claimed.type !== 'asset_generation') throw new Error('F10: claim 失败');
    try {
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
    ok(capturedSize === '1K' && capturedRatio === '16:9', '[F10a] Worker 使用 job 冻结快照（1K/16:9），不读运行时 env', {capturedSize, capturedRatio});

    const usage = getDb().prepare(`SELECT metadata FROM project_usage_events WHERE id = ?`).get(requestId) as {metadata: string} | undefined;
    const meta = usage ? (JSON.parse(usage.metadata) as {requestedSize?: string; aspectRatio?: string}) : {};
    ok(meta.requestedSize === '1K' && meta.aspectRatio === '16:9', '[F10b] usage metadata 与 job 快照一致', meta);
    process.env.APIYI_IMAGE_SIZE = '1K';
    process.env.APIYI_IMAGE_ASPECT_RATIO = '16:9';
  }

  // ============ F11：provider mismatch → CONFIG_ERROR，零 provider call ============
  {
    const projectId = createProjectWithWorkflow({topic: 'fp-11', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    // 直接插一个 provider='comfyui' 的 job（本地 provider 语义）
    const jobId = crypto.randomUUID();
    getDb().prepare(
      `INSERT INTO asset_generation_jobs (
         id, project_id, scene_id, requirement_id, request_id, prompt, provider, model,
         resource_class, resource_group, source_scenes_version_id, source_requirement_hash,
         requirement_json, request_fingerprint, status,
         image_size, aspect_ratio, provider_config_version, created_at, updated_at
       ) VALUES (?, ?, 'S001', 'S001-R01', 'req-f11-001', 'p', 'comfyui', 'sd3',
         'local_image_gpu', 'production_gpu', '1', 'aaaa000000000001', '{}', 'fp',
         'queued', '1K', '16:9', 'local:1', ?, ?)`,
    ).run(jobId, projectId, new Date().toISOString(), new Date().toISOString());

    const before = providerCalls;
    const claimed = claimNextAnyJob('worker-f11');
    if (!claimed || claimed.type !== 'asset_generation') throw new Error('F11: claim 失败');
    try {
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
    ok(providerCalls === before, '[F11a] provider mismatch → 零 provider call');
    const job = getDb().prepare(`SELECT status, failure_phase FROM asset_generation_jobs WHERE id=?`).get(jobId) as {status: string; failure_phase: string | null};
    ok(job.status === 'failed' && job.failure_phase === 'CONFIG_ERROR', '[F11b] provider mismatch → failed + CONFIG_ERROR', job);
  }

  // 清理
  const assetProjectIds = (getDb().prepare('SELECT DISTINCT project_id FROM assets').all() as Array<{project_id: string}>).map((r) => r.project_id);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-image-request-fingerprint'), {recursive: true, force: true});
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

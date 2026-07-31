/**
 * M7.3A.2 Asset Generation Durability 测试（零真实 API 费用）。
 *
 * 用法：npx tsx scripts/test-asset-generation-durability.ts
 * 使用临时数据目录（data/test-asset-generation-durability），结束后清理。
 *
 * 覆盖：
 * - 同步 provider 生成超过 30 秒不会被误判为 connect timeout；
 * - 真正 connect timeout / response timeout / indeterminate billing；
 * - 同 requestId 并发/跨 POST 只产生一个 job，provider 只调用一次；
 * - 同 requestId 终态后不重新调用 provider；
 * - 新 requestId 显式 retry 产生新 candidate；
 * - provider request id 持久化到 job；
 * - asset candidate append-only；
 * - production_gpu lease 在任务结束后释放。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-asset-generation-durability');
process.env.APIYI_API_KEY = 'test-key';
process.env.APIYI_CONNECT_TIMEOUT_MS = '50';
process.env.APIYI_RESPONSE_TIMEOUT_MS = '200';
process.env.APIYI_IMAGE_SIZE = '1K';
process.env.APIYI_IMAGE_ASPECT_RATIO = '16:9';
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import type {GeneratedImageCandidate, GeneratedImageProvider} from '../src/lib/assets/providers/generated';
import {ImageGenerationError} from '../src/lib/assets/providers/generated';

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
      },
    ],
  };
}

function seedProject(projectId: string): void {
  const scenesJson = JSON.stringify({
    chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
    scenes: [makeScene()],
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
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-generation-durability'), {recursive: true, force: true});

  // 动态导入 provider / route / worker，使上面的 env 在模块初始化时生效
  const [{GET, POST}, {getGeneratedImageProvider, ImageGenerationError: ProvErr}, {ApiYiImageProvider}, {claimNextAnyJob}, {runAssetGenerationJob}, {getActiveLease}] = await Promise.all([
    import('../src/app/api/projects/[id]/assets/generate/route'),
    import('../src/lib/assets/providers/generated'),
    import('../src/lib/assets/providers/generated/apiyi'),
    import('../src/lib/scheduler'),
    import('../src/worker/asset-generation-executor'),
    import('../src/lib/resources/leases'),
  ]);

  const provider = getGeneratedImageProvider();
  provider.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
  (provider as GeneratedImageProvider & {configured: boolean}).configured = true;
  provider.checkHealth = async () => ({healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()});

  let providerCalls = 0;
  let nextResult: GeneratedImageCandidate[] | ImageGenerationError | null = null;
  provider.generate = async (input) => {
    providerCalls++;
    if (nextResult instanceof ImageGenerationError) throw nextResult;
    if (nextResult !== null) return nextResult;
    return [{
      candidateId: `mock-${providerCalls}`,
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data', 'utf8'),
      width: 1920,
      height: 1080,
      provider: provider.name,
      model: input.model || 'mock',
      prompt: input.prompt,
      metadata: {providerRequestId: `req-${providerCalls}`},
    }];
  };

  function setNextResult(result: GeneratedImageCandidate[] | ImageGenerationError | null): void {
    nextResult = result;
  }

  function resetProvider(): void {
    providerCalls = 0;
    nextResult = null;
  }

  function postGenerate(projectId: string, requestId: string): Promise<Response> {
    return POST(new Request('http://test', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sceneId: 'S001', requirementId: 'S001-R01', requestId}),
    }), {params: Promise.resolve({id: projectId})});
  }

  async function runNextAssetJob(): Promise<void> {
    const claimed = claimNextAnyJob('worker-test');
    if (!claimed || claimed.type !== 'asset_generation') {
      throw new Error(`expected asset_generation job, got ${claimed?.type ?? 'null'}`);
    }
    await runAssetGenerationJob(claimed.job, {
      isShuttingDown: () => false,
      log: () => {},
      shutdownSignal: new AbortController().signal,
    });
  }

  function jobRow(projectId: string, requestId: string) {
    return getDb()
      .prepare(`SELECT * FROM asset_generation_jobs WHERE project_id = ? AND request_id = ?`)
      .get(projectId, requestId) as
      | {
          id: string;
          status: string;
          provider_request_id: string | null;
          result_asset_id: string | null;
          billing_status: string | null;
          failure_phase: string | null;
          requirement_json: string | null;
          source_requirement_hash: string | null;
          source_scenes_version_id: string | null;
        }
      | undefined;
  }

  function assetCount(projectId: string): number {
    return (getDb().prepare(`SELECT COUNT(*) AS c FROM assets WHERE project_id = ?`).get(projectId) as {c: number}).c;
  }

  // ============ T1：同 requestId 并发 POST 只产生一个 job，provider 只调用一次 ============
  {
    resetProvider();
    const projectId = createProjectWithWorkflow({topic: 'asset-durability-1', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'req-t1-001';
    const [r1, r2] = await Promise.all([postGenerate(projectId, requestId), postGenerate(projectId, requestId)]);
    ok(r1.status === 202 && r2.status === 202, '[T1a] 并发双 POST 均 202');
    const j1 = (await r1.json()) as {jobId: string; reused: boolean};
    const j2 = (await r2.json()) as {jobId: string; reused: boolean};
    ok(j1.jobId === j2.jobId, '[T1b] 并发双 POST 同一 jobId', {j1, j2});
    const count = (getDb().prepare(`SELECT COUNT(*) AS c FROM asset_generation_jobs WHERE project_id = ? AND request_id = ?`).get(projectId, requestId) as {c: number}).c;
    ok(count === 1, '[T1c] 同 requestId 只产生一个 job', {count});
    ok(providerCalls === 0, '[T1d] Web POST 不直接调用 provider');

    await runNextAssetJob();
    ok(providerCalls === 1, '[T1e] Worker 执行后 provider 恰好调用 1 次');
    const job = jobRow(projectId, requestId)!;
    ok(job.status === 'succeeded' && job.result_asset_id !== null && job.provider_request_id === 'req-1',
      '[T1f] job succeeded，provider request id 持久化', job);
    ok(assetCount(projectId) === 1, '[T1g] 成功生成 1 个 candidate asset');

    // 终态后再次 POST 同 requestId → reused，零新 job / 零 provider 调用
    const r3 = await postGenerate(projectId, requestId);
    ok(r3.status === 202, '[T1h] 终态后同 requestId POST 仍 202（reused）');
    const j3 = (await r3.json()) as {reused: boolean; status: string};
    ok(j3.reused === true && j3.status === 'succeeded', '[T1i] 响应 reused=true', j3);
    ok(providerCalls === 1, '[T1j] 终态后同 requestId 不重新调用 provider');
    ok(assetCount(projectId) === 1, '[T1k] asset 保持 append-only，无新 candidate');
    ok(getActiveLease('production_gpu') === null, '[T1l] 任务结束后 production_gpu lease 已释放');
  }

  // ============ T2：新 requestId 显式 retry 产生新 candidate ============
  {
    resetProvider();
    const projectId = createProjectWithWorkflow({topic: 'asset-durability-2', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId1 = 'req-t2-001';
    const requestId2 = 'req-t2-002';
    await postGenerate(projectId, requestId1);
    await runNextAssetJob();
    await postGenerate(projectId, requestId2);
    await runNextAssetJob();
    ok(providerCalls === 2, '[T2a] 新 requestId 触发第二次 provider 调用');
    ok(assetCount(projectId) === 2, '[T2b] 两次生成产生 2 个 append-only candidate assets');
  }

  // ============ T3：response timeout → indeterminate + unknown_billing ============
  {
    resetProvider();
    setNextResult(new ProvErr('PROVIDER_RESPONSE_TIMEOUT', 'response timeout'));
    const projectId = createProjectWithWorkflow({topic: 'asset-durability-3', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'req-t3-001';
    await postGenerate(projectId, requestId);
    await runNextAssetJob();
    const job = jobRow(projectId, requestId)!;
    ok(job.status === 'indeterminate', '[T3a] response timeout → job indeterminate', job);
    ok(job.billing_status === 'unknown_billing', '[T3b] response timeout → billing unknown', job);
    ok(job.failure_phase === 'PROVIDER_RESPONSE_TIMEOUT', '[T3c] failure phase 记录为 response timeout', job);
    ok(assetCount(projectId) === 0, '[T3d] response timeout 不产生 asset');
  }

  // ============ T4：connect timeout / terminal failure → failed，billing 按语义 ============
  {
    resetProvider();
    setNextResult(new ProvErr('PROVIDER_CONNECT_TIMEOUT', 'connect timeout'));
    const projectId = createProjectWithWorkflow({topic: 'asset-durability-4', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'req-t4-001';
    await postGenerate(projectId, requestId);
    await runNextAssetJob();
    const job = jobRow(projectId, requestId)!;
    ok(job.status === 'failed', '[T4a] connect timeout → job failed', job);
    ok(job.failure_phase === 'PROVIDER_CONNECT_TIMEOUT', '[T4b] failure phase 记录为 connect timeout', job);
    ok(job.billing_status === 'unknown_billing', '[T4c] connect timeout → billing unknown', job);
  }

  // ============ T5：provider 返回空 candidate → failed，billing unknown ============
  {
    resetProvider();
    setNextResult([]);
    const projectId = createProjectWithWorkflow({topic: 'asset-durability-5', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'req-t5-001';
    await postGenerate(projectId, requestId);
    await runNextAssetJob();
    const job = jobRow(projectId, requestId)!;
    ok(job.status === 'failed', '[T5a] 空 candidate → job failed', job);
    ok(job.failure_phase === 'IMAGE_DECODE_FAILED', '[T5b] 空 candidate failure phase 为 IMAGE_DECODE_FAILED', job);
  }

  // ============ T6：ApiYiImageProvider 真实 timeout 语义（连接层 vs 响应层） ============
  {
    // 6a：连接层 timeout（黑地址 + 50ms connect timeout；response deadline 需更长，避免先于 connect）
    process.env.APIYI_BASE_URL = 'http://198.51.100.1:12345';
    process.env.APIYI_RESPONSE_TIMEOUT_MS = '5000';
    const apiConnect = new ApiYiImageProvider();
    (apiConnect as GeneratedImageProvider & {configured: boolean}).configured = true;
    apiConnect.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
    try {
      await apiConnect.generate({prompt: 'connect timeout test'});
      ok(false, '[T6a] 黑地址应触发 connect timeout');
    } catch (err) {
      ok(
        err instanceof ProvErr && err.code === 'PROVIDER_CONNECT_TIMEOUT',
        '[T6a] 黑地址 → PROVIDER_CONNECT_TIMEOUT',
        err instanceof ProvErr ? err.code : err,
      );
    }

    // 6b：响应层 timeout（server 快速回响应头，body 故意延迟）
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {'Content-Type': 'application/json'});
      setTimeout(() => res.end(JSON.stringify({candidates: []})), 500);
    });
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as {port: number}).port);
    }));
    process.env.APIYI_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.APIYI_RESPONSE_TIMEOUT_MS = '200';
    const apiResponse = new ApiYiImageProvider();
    (apiResponse as GeneratedImageProvider & {configured: boolean}).configured = true;
    apiResponse.health = {healthy: true, available: true, reason: 'healthy', checkedAt: Date.now()};
    try {
      await apiResponse.generate({prompt: 'response timeout test'});
      ok(false, '[T6b] 慢 body 应触发 response timeout');
    } catch (err) {
      ok(
        err instanceof ProvErr && err.code === 'PROVIDER_RESPONSE_TIMEOUT',
        '[T6b] 慢 body → PROVIDER_RESPONSE_TIMEOUT（非 connect timeout）',
        err instanceof ProvErr ? err.code : err,
      );
    } finally {
      server.close();
    }
  }

  // ============ T7：generated candidate exact requirement provenance ============
  {
    resetProvider();
    const projectId = createProjectWithWorkflow({topic: 'asset-durability-7', coreQuestion: 'q'}).project.id;
    seedProject(projectId);
    const requestId = 'req-t7-001';
    await postGenerate(projectId, requestId);
    await runNextAssetJob();

    const job = jobRow(projectId, requestId)!;
    ok(job.status === 'succeeded', '[T7a] provenance job succeeded');
    ok(job.requirement_json !== null, '[T7b] enqueue 冻结 requirement_json');
    const requirementJson = JSON.parse(job.requirement_json!);
    const expectedHash = crypto.createHash('sha256').update(job.requirement_json!).digest('hex').slice(0, 16);
    ok(job.source_requirement_hash === expectedHash, '[T7c] source_requirement_hash = sha256(requirement_json)[:16]', {
      actual: job.source_requirement_hash,
      expected: expectedHash,
    });
    ok(
      requirementJson.requirementId === 'S001-R01' &&
        requirementJson.query === 'test subject' &&
        requirementJson.policy === 'generated' &&
        requirementJson.authenticity === 'synthetic_allowed',
      '[T7d] requirement snapshot 冻结 exact requirement 字段（id/query/policy/authenticity）',
      requirementJson,
    );
    ok(job.source_scenes_version_id !== null && job.source_scenes_version_id !== '0', '[T7e] source scenes version 已冻结');

    const assetRow = getDb()
      .prepare(`SELECT requirement_json FROM assets WHERE id = ?`)
      .get(job.result_asset_id!) as {requirement_json: string | null} | undefined;
    ok(assetRow !== undefined, '[T7f] result asset 存在');
    ok(assetRow!.requirement_json === job.requirement_json, '[T7g] asset.requirement_json 与 job 冻结快照完全一致', {
      asset: assetRow?.requirement_json,
      job: job.requirement_json,
    });
    const assetReq = JSON.parse(assetRow!.requirement_json!);
    ok(
      assetReq.requirementId === 'S001-R01' && assetReq.policy === 'generated' && assetReq.authenticity === 'synthetic_allowed',
      '[T7h] candidate 携带 exact requirement provenance',
      assetReq,
    );
  }

  // ============ T8：requestId UI 生命周期纯逻辑（双击复用 / 终态后新 id） ============
  {
    const {acquireRequestId, releaseRequestId} = await import('../src/components/workflow/asset-request-id');
    const map = new Map<string, string>();
    const a = acquireRequestId(map, 'S001:S001-R01');
    const b = acquireRequestId(map, 'S001:S001-R01');
    ok(a === b, '[T8a] 同一 key 生命周期内复用同一 requestId（双击幂等）');
    releaseRequestId(map, 'S001:S001-R01');
    const c = acquireRequestId(map, 'S001:S001-R01');
    ok(c !== a, '[T8b] 终态 release 后重新生成得到新 requestId');
    const d = acquireRequestId(map, 'S002:S001-R01');
    ok(d !== c, '[T8c] 不同 requirement 的 requestId 互相独立');
    ok(map.size === 2, '[T8d] map 只保留活跃 requestId', {size: map.size});
    releaseRequestId(map, 'S001:S001-R01');
    releaseRequestId(map, 'S002:S001-R01');
    ok(map.size === 0, '[T8e] 全部 release 后 map 清空');
  }

  // 清理
  const assetProjectIds = (getDb().prepare('SELECT DISTINCT project_id FROM assets').all() as Array<{project_id: string}>).map((r) => r.project_id);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-generation-durability'), {recursive: true, force: true});
  for (const pid of assetProjectIds) {
    fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', pid), {recursive: true, force: true});
  }

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] Asset Generation Durability 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] Asset Generation Durability 测试全部通过 ✅');
}

void main();

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

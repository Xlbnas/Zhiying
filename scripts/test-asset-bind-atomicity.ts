/**
 * M7.3A.3.2 bind 原子性与 malformed provenance 测试（零真实 API 费用）。
 *
 * 用法：npx tsx scripts/test-asset-bind-atomicity.ts
 * 使用临时数据目录（data/test-asset-bind-atomicity），结束后清理。
 *
 * 覆盖：
 * - current strict candidate → success（原子事务）；
 * - malformed JSON → 409 CANDIDATE_PROVENANCE_INVALID；
 * - relevance 非法 → 409；
 * - 缺 sourceScenesVersionId / sourceRequirementHash / assetGenerationJobId / requestId → 409；
 * - job status 非 succeeded → 409；
 * - job requestId mismatch → 409；
 * - bind 需要排他写锁（第二个连接持锁期间 bind 抛 SQLITE_BUSY → 原子性证明）；
 * - bind 事务内读取 active source（预先切 v2 → bind 拒绝 CANDIDATE_SOURCE_STALE）；
 * - legacy NULL provenance → 兼容 success。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-asset-bind-atomicity');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.APIYI_API_KEY = 'test-key';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {insertAsset} from '../src/lib/assets/model';
import {bindGeneratedCandidate} from '../src/lib/assets/bind';
import {computeRequirementSnapshotHash} from '../src/lib/assets/requirements';

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

function makeScene(query: string, requirementId = 'S001-R01'): Record<string, unknown> {
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
        subject: query,
        query,
        usage: 'primary',
        policy: 'generated',
        authenticity: 'synthetic_allowed',
        requirementId,
      },
    ],
  };
}

function seedProject(projectId: string, query = 'test subject'): void {
  generateVersion({
    projectId,
    stage: 'scenes',
    content: JSON.stringify({
      chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
      scenes: [makeScene(query)],
    }),
    contentType: 'json',
    source: 'manual_edit',
  });
}

function snapshotHash(requirementId: string, query: string): string {
  return computeRequirementSnapshotHash(JSON.stringify({
    requirementId,
    kind: 'image',
    subject: query,
    query,
    usage: 'primary',
    policy: 'generated',
    authenticity: 'synthetic_allowed',
  }));
}

function currentVersion(projectId: string): string {
  return String((getDb().prepare(
    `SELECT version FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as {version: number}).version);
}

function insertGeneratedAssetWithProvenance(input: {
  projectId: string;
  provenanceJson: string | null;
  requirementId?: string;
  query?: string;
}): string {
  // 先以 null 插入，再直接写 provenance_json（允许 malformed 字符串注入）
  const id = insertAsset({
    projectId: input.projectId,
    sceneId: 'S001',
    mediaType: 'image',
    sourceType: 'generated',
    sourceProvider: 'apiyi',
    sourceUrl: null,
    localPath: `assets/${input.projectId}/mock-${crypto.randomUUID()}.png`,
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    licenseStatus: 'generated',
    licenseNote: 'AI 生成 · mock (待确认)',
    attribution: 'API易 / mock',
    description: input.query ?? 'test subject',
    requirement: {
      requirementId: input.requirementId ?? 'S001-R01',
      kind: 'image',
      subject: input.query ?? 'test subject',
      query: input.query ?? 'test subject',
      usage: 'primary',
      policy: 'generated',
      authenticity: 'synthetic_allowed',
    },
    provenance: null,
  }).id;
  getDb().prepare('UPDATE assets SET provenance_json = ? WHERE id = ?').run(input.provenanceJson, id);
  return id;
}

function insertJob(input: {
  projectId: string;
  requestId: string;
  status: string;
  resultAssetId: string | null;
  resultRelevance: string | null;
  sourceScenesVersionId: string;
}): string {
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO asset_generation_jobs (
       id, project_id, scene_id, requirement_id, request_id, prompt, provider, model,
       resource_class, resource_group, source_scenes_version_id, source_requirement_hash,
       requirement_json, request_fingerprint, status, result_relevance, result_asset_id,
       billing_status, image_size, aspect_ratio, provider_config_version,
       created_at, updated_at
     ) VALUES (?, ?, 'S001', 'S001-R01', ?, 'p', 'apiyi', 'mock', 'remote_image_api', NULL,
       ?, 'aaaa000000000001', '{}', 'fp', ?, ?, ?, 'confirmed_charged', '1K', '16:9', 'apiyi:1', ?, ?)`,
  ).run(
    id, input.projectId, input.requestId,
    input.sourceScenesVersionId,
    input.status,
    input.resultRelevance,
    input.resultAssetId,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return id;
}

/** 构造「current strict candidate」：job + asset（provenance 完整匹配）。 */
function seedCurrentCandidate(projectId: string, requestId: string): {assetId: string; jobId: string} {
  const curVer = currentVersion(projectId);
  const goodHash = snapshotHash('S001-R01', 'test subject');
  const jobId = insertJob({
    projectId, requestId, status: 'succeeded',
    resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: curVer,
  });
  const assetId = insertGeneratedAssetWithProvenance({
    projectId,
    provenanceJson: JSON.stringify({
      sourceScenesVersionId: curVer,
      sourceRequirementHash: goodHash,
      assetGenerationJobId: jobId,
      requestId,
      relevance: 'current',
      staleReason: null,
    }),
  });
  getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobId);
  return {assetId, jobId};
}

function expectBindError(projectId: string, assetId: string, expectedCode: string, label: string): void {
  try {
    bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R01'});
    ok(false, `${label}（应抛 ${expectedCode}）`);
  } catch (err) {
    const e = err as {code?: string; httpStatus?: number};
    ok(e.code === expectedCode && e.httpStatus === 409, label, {code: e.code, status: e.httpStatus});
  }
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-bind-atomicity'), {recursive: true, force: true});

  const projectId = createProjectWithWorkflow({topic: 'bind-atomicity', coreQuestion: 'q'}).project.id;
  seedProject(projectId);

  // ============ B1：current strict candidate → 原子 success ============
  {
    const {assetId} = seedCurrentCandidate(projectId, 'req-a1');
    const r = bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R01'});
    ok(r.binding.active === 1 && r.legacyProvenance === false, '[A1a] current strict candidate → bind success');
    const bindings = getDb().prepare(`SELECT count(*) AS c FROM asset_bindings WHERE project_id=? AND active=1`).get(projectId) as {c: number};
    ok(bindings.c === 1, '[A1b] 恰好 1 条 active binding');
  }

  // ============ B2：malformed provenance → 409 CANDIDATE_PROVENANCE_INVALID ============
  {
    const badJson = insertGeneratedAssetWithProvenance({projectId, provenanceJson: '{not-json'});
    expectBindError(projectId, badJson, 'CANDIDATE_PROVENANCE_INVALID', '[A2a] JSON 无法解析 → 409');
  }

  // ============ B3：relevance 非法 → 409 ============
  {
    const assetId = insertGeneratedAssetWithProvenance({
      projectId,
      provenanceJson: JSON.stringify({
        sourceScenesVersionId: currentVersion(projectId),
        sourceRequirementHash: snapshotHash('S001-R01', 'test subject'),
        assetGenerationJobId: 'job-x',
        requestId: 'req-x',
        relevance: 'weird',
        staleReason: null,
      }),
    });
    expectBindError(projectId, assetId, 'CANDIDATE_PROVENANCE_INVALID', '[A3a] relevance 非法 → 409');
  }

  // ============ B4：必填字段缺失 → 409 ============
  {
    const base = {
      sourceScenesVersionId: currentVersion(projectId),
      sourceRequirementHash: snapshotHash('S001-R01', 'test subject'),
      assetGenerationJobId: 'job-x',
      requestId: 'req-x',
      relevance: 'current',
      staleReason: null,
    };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['sourceScenesVersionId', {...base, sourceScenesVersionId: undefined}],
      ['sourceRequirementHash', {...base, sourceRequirementHash: undefined}],
      ['assetGenerationJobId', {...base, assetGenerationJobId: undefined}],
      ['requestId', {...base, requestId: undefined}],
      ['assetGenerationJobId null', {...base, assetGenerationJobId: null}],
      ['requestId null', {...base, requestId: null}],
    ];
    for (const [label, obj] of cases) {
      const assetId = insertGeneratedAssetWithProvenance({projectId, provenanceJson: JSON.stringify(obj)});
      expectBindError(projectId, assetId, 'CANDIDATE_PROVENANCE_INVALID', `[A4] 缺 ${label} → 409`);
    }
  }

  // ============ B5：job status 非 succeeded → 409 ============
  {
    const curVer = currentVersion(projectId);
    const jobId = insertJob({
      projectId, requestId: 'req-a5', status: 'queued',
      resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: curVer,
    });
    const assetId = insertGeneratedAssetWithProvenance({
      projectId,
      provenanceJson: JSON.stringify({
        sourceScenesVersionId: curVer,
        sourceRequirementHash: snapshotHash('S001-R01', 'test subject'),
        assetGenerationJobId: jobId,
        requestId: 'req-a5',
        relevance: 'current',
        staleReason: null,
      }),
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobId);
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[A5a] job.status=queued → 409');
  }

  // ============ B6：job requestId mismatch → 409 ============
  {
    const curVer = currentVersion(projectId);
    const jobId = insertJob({
      projectId, requestId: 'req-a6-job', status: 'succeeded',
      resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: curVer,
    });
    const assetId = insertGeneratedAssetWithProvenance({
      projectId,
      provenanceJson: JSON.stringify({
        sourceScenesVersionId: curVer,
        sourceRequirementHash: snapshotHash('S001-R01', 'test subject'),
        assetGenerationJobId: jobId,
        requestId: 'req-a6-asset', // 与 job 不一致
        relevance: 'current',
        staleReason: null,
      }),
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobId);
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[A6a] job.requestId 与 provenance 不一致 → 409');
  }

  // ============ B7：bind 需要排他写锁（原子性证明） ============
  {
    const {assetId} = seedCurrentCandidate(projectId, 'req-a7');
    // 第二连接（同一 DB 文件）先占排他写锁
    const dbPath = path.join(path.resolve(process.cwd(), 'data', 'test-asset-bind-atomicity'), 'zhiying.db');
    const db2 = new Database(dbPath);
    db2.prepare('BEGIN IMMEDIATE').run();
    let busyRejected = false;
    try {
      bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R01'});
    } catch (err) {
      busyRejected = String((err as {message?: string}).message ?? '').includes('database is locked');
    }
    ok(busyRejected, '[A7a] 他连接持写锁期间 bind 被阻塞/拒绝（SQLITE_BUSY）→ 绑定是排他写事务');
    db2.prepare('COMMIT').run();
    db2.close();
    // 锁释放后 bind 成功
    const r = bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R01'});
    ok(r.binding.active === 1, '[A7b] 写锁释放后 bind 成功');
  }

  // ============ B8：bind 事务内读取 active source（预先切 v2 → 拒绝） ============
  {
    seedProject(projectId, 'changed subject'); // v2（hash 变化）
    const {assetId} = seedCurrentCandidate(projectId, 'req-a8'); // provenance 冻结 v2 hash
    // 再切 v3：bind 读取到最新 active source → 拒绝（不产生「旧检查通过、新 source 写入」）
    seedProject(projectId, 'another subject'); // v3
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[A8a] source 在 bind 前漂移 → 事务内读取新 source 后拒绝');
  }

  // ============ B9：legacy NULL provenance → 兼容 success ============
  {
    const legacyId = insertGeneratedAssetWithProvenance({projectId, provenanceJson: null});
    const r = bindGeneratedCandidate({projectId, candidateId: legacyId, sceneId: 'S001', requirementId: 'S001-R01'});
    ok(r.binding.active === 1 && r.legacyProvenance === true, '[A9a] legacy NULL provenance → 兼容 success + legacyProvenance=true');
  }

  // 清理
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-bind-atomicity'), {recursive: true, force: true});
  fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

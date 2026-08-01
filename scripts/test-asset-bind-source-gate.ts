/**
 * M7.3A.3.1 服务端 stale candidate 绑定门禁测试（零真实 API 费用）。
 *
 * 用法：npx tsx scripts/test-asset-bind-source-gate.ts
 * 使用临时数据目录（data/test-asset-bind-source-gate），结束后清理。
 *
 * 覆盖：
 * - current candidate → bind success（legacyProvenance=false）；
 * - provenance.relevance=stale → 409 CANDIDATE_STALE；
 * - source version mismatch → 409 CANDIDATE_SOURCE_STALE；
 * - source requirement hash mismatch → 409 CANDIDATE_SOURCE_STALE；
 * - job.result_relevance=stale → 409 CANDIDATE_SOURCE_STALE；
 * - job 缺失/结果不匹配 → 409；
 * - cross project / scene / requirement 仍拒绝；
 * - 历史 legacy candidate（无 provenance）→ 兼容 bind + legacyProvenance=true。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-asset-bind-source-gate');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.APIYI_API_KEY = 'test-key';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {insertAsset, type AssetProvenance} from '../src/lib/assets/model';
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

function insertGeneratedAsset(input: {
  projectId: string;
  sceneId: string;
  requirementId: string;
  query: string;
  provenance: AssetProvenance | null;
}): string {
  const row = insertAsset({
    projectId: input.projectId,
    sceneId: input.sceneId,
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
    description: input.query,
    requirement: {
      requirementId: input.requirementId,
      kind: 'image',
      subject: input.query,
      query: input.query,
      usage: 'primary',
      policy: 'generated',
      authenticity: 'synthetic_allowed',
    },
    provenance: input.provenance,
  });
  return row.id;
}

function insertJob(input: {
  projectId: string;
  sceneId: string;
  requirementId: string;
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
     ) VALUES (?, ?, ?, ?, ?, 'p', 'apiyi', 'mock', 'remote_image_api', NULL,
       ?, 'aaaa000000000001', '{}', 'fp', ?, ?, ?, 'confirmed_charged', '1K', '16:9', 'apiyi:1', ?, ?)`,
  ).run(
    id, input.projectId, input.sceneId, input.requirementId, input.requestId,
    input.sourceScenesVersionId,
    input.status,
    input.resultRelevance,
    input.resultAssetId,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  return id;
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
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-bind-source-gate'), {recursive: true, force: true});

  const projectId = createProjectWithWorkflow({topic: 'bind-gate', coreQuestion: 'q'}).project.id;
  seedProject(projectId);
  const curVer = currentVersion(projectId);
  const goodHash = snapshotHash('S001-R01', 'test subject');

  // ============ B1：current candidate → bind success ============
  {
    const jobId = insertJob({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', requestId: 'req-b1',
      status: 'succeeded', resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: curVer,
    });
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: goodHash,
        assetGenerationJobId: jobId, requestId: 'req-b1', relevance: 'current', staleReason: null,
      },
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobId);
    const r = bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R01'});
    ok(r.binding.active === 1 && r.legacyProvenance === false, '[B1a] current candidate → bind success（legacyProvenance=false）');
    const after = getDb().prepare('SELECT license_status FROM assets WHERE id = ?').get(assetId) as {license_status: string};
    ok(after.license_status === 'generated', '[B1b] 绑定后 license=generated');
  }

  // ============ B2：relevance=stale → 409 CANDIDATE_STALE ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: goodHash,
        assetGenerationJobId: 'job-b2', requestId: 'req-b2', relevance: 'stale', staleReason: 'lease_lost',
      },
    });
    expectBindError(projectId, assetId, 'CANDIDATE_STALE', '[B2a] relevance=stale → 409 CANDIDATE_STALE');
  }

  // ============ B3：source version mismatch → 409 ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: '999', sourceRequirementHash: goodHash,
        assetGenerationJobId: 'job-b3', requestId: 'req-b3', relevance: 'current', staleReason: null,
      },
    });
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[B3a] source version mismatch → 409 CANDIDATE_SOURCE_STALE');
  }

  // ============ B4：requirement hash mismatch → 409 ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: 'deadbeefdeadbeef',
        assetGenerationJobId: 'job-b4', requestId: 'req-b4', relevance: 'current', staleReason: null,
      },
    });
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[B4a] requirement hash mismatch → 409 CANDIDATE_SOURCE_STALE');
  }

  // ============ B5：job.result_relevance=stale → 409 ============
  {
    const jobId = insertJob({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', requestId: 'req-b5',
      status: 'succeeded', resultAssetId: '__PENDING__', resultRelevance: 'stale', sourceScenesVersionId: curVer,
    });
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: goodHash,
        assetGenerationJobId: jobId, requestId: 'req-b5', relevance: 'current', staleReason: null,
      },
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobId);
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[B5a] job.result_relevance=stale → 409');
  }

  // ============ B6：job 缺失 / result 不匹配 → 409 ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: goodHash,
        assetGenerationJobId: 'job-does-not-exist', requestId: 'req-b6', relevance: 'current', staleReason: null,
      },
    });
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[B6a] job 缺失 → 409');
    // job 存在但 result_asset_id 指向其他 asset
    const jobB6b = insertJob({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', requestId: 'req-b6b',
      status: 'succeeded', resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: curVer,
    });
    const otherAsset = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: goodHash,
        assetGenerationJobId: jobB6b, requestId: 'req-b6b', relevance: 'current', staleReason: null,
      },
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(otherAsset, jobB6b);
    expectBindError(projectId, assetId, 'CANDIDATE_SOURCE_STALE', '[B6b] job.result_asset_id 不匹配 → 409');
  }

  // ============ B7：cross project / scene / requirement 仍拒绝 ============
  {
    const jobB7 = insertJob({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', requestId: 'req-b7',
      status: 'succeeded', resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: curVer,
    });
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: goodHash,
        assetGenerationJobId: jobB7, requestId: 'req-b7', relevance: 'current', staleReason: null,
      },
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobB7);
    let rejected = false;
    try {
      bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R99'});
    } catch (err) {
      rejected = (err as {code?: string}).code === 'requirement_mismatch';
    }
    ok(rejected, '[B7a] cross requirement 绑定拒绝');
    const otherProject = createProjectWithWorkflow({topic: 'bind-gate-other', coreQuestion: 'q'}).project.id;
    seedProject(otherProject);
    try {
      bindGeneratedCandidate({projectId: otherProject, candidateId: assetId, sceneId: 'S001', requirementId: 'S001-R01'});
      ok(false, '[B7b] cross project 绑定拒绝');
    } catch (err) {
      ok((err as {code?: string}).code === 'candidate_not_found', '[B7b] cross project 绑定拒绝（candidate_not_found）');
    }
  }

  // ============ B8：legacy candidate（无 provenance）→ 兼容 bind + legacyProvenance=true ============
  {
    const legacyId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: 'S001-R01', query: 'test subject',
      provenance: null,
    });
    const r = bindGeneratedCandidate({projectId, candidateId: legacyId, sceneId: 'S001', requirementId: 'S001-R01'});
    ok(r.binding.active === 1 && r.legacyProvenance === true, '[B8a] legacy candidate → bind success + legacyProvenance=true');
  }

  // 清理
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-bind-source-gate'), {recursive: true, force: true});
  fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

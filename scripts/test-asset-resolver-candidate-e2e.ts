/**
 * M7.3A.3 Resolver / Bind E2E 测试（零真实 API 费用）。
 *
 * 用法：npx tsx scripts/test-asset-resolver-candidate-e2e.ts
 * 使用临时数据目录（data/test-asset-resolver-candidate-e2e），结束后清理。
 *
 * 覆盖：
 * - 生成成功 → job succeeded → asset provenance → buildProjectResolution →
 *   candidate_waiting → generatedCandidates[0].assetId → bind → ready；
 * - candidate 不串 requirement / 不串 scene；
 * - stale source candidate 不作为 current（Fence B 产物）；
 * - 历史 candidate append-only 保留；
 * - latest attempt 选择：failed old + queued/running new → generating（显示 new）；
 *   succeeded old + failed new → candidate 仍显示 + latestGenerationAttempt 显示 new。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-asset-resolver-candidate-e2e');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.APIYI_API_KEY = 'test-key';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {generateVersion} from '../src/lib/workflow/operations';
import {insertAsset, type AssetProvenance} from '../src/lib/assets/model';
import {bindGeneratedCandidate} from '../src/lib/assets/bind';
import {computeRequirementSnapshotHash} from '../src/lib/assets/requirements';
import {buildProjectResolution} from '../src/lib/assets/resolver';
let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
    if (detail !== undefined) console.log('      ', JSON.stringify(detail)?.slice(0, 500));
  }
}

function makeScene(
  sceneId: string,
  requirements: Array<{id: string; query: string}>,
): Record<string, unknown> {
  return {
    id: sceneId,
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
    assetRequirements: requirements.map((r) => ({
      kind: 'image',
      subject: r.query,
      query: r.query,
      usage: 'primary',
      policy: 'generated',
      authenticity: 'synthetic_allowed',
      // 显式 requirementId（requirementIdOf 显式值优先）
      requirementId: r.id,
    })),
  };
}

function seedProject(projectId: string, scenes: Array<Record<string, unknown>>): void {
  const scenesJson = JSON.stringify({
    chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
    scenes,
  });
  generateVersion({
    projectId,
    stage: 'scenes',
    content: scenesJson,
    contentType: 'json',
    source: 'manual_edit',
  });
}

/** 与 buildRequirementSnapshot 字段顺序一致的确定性 snapshot hash。 */
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

function insertGeneratedAsset(input: {
  projectId: string;
  sceneId: string;
  requirementId: string;
  query: string;
  provenance: AssetProvenance;
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
  resultAssetId?: string | null;
  resultRelevance?: string | null;
  sourceScenesVersionId?: string;
  failurePhase?: string | null;
  createdAt?: string;
}): string {
  const id = crypto.randomUUID();
  const scenesVer = (getDb().prepare(
    `SELECT version FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(input.projectId) as {version: number}).version;
  getDb().prepare(
    `INSERT INTO asset_generation_jobs (
       id, project_id, scene_id, requirement_id, request_id, prompt, provider, model,
       resource_class, resource_group, source_scenes_version_id, source_requirement_hash,
       requirement_json, request_fingerprint, status, result_relevance, result_asset_id,
       failure_phase, billing_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'p', 'apiyi', 'mock', 'remote_image_api', NULL,
       ?, 'aaaa000000000001', '{}', 'fp', ?, ?, ?, ?, 'confirmed_charged', ?, ?)`,
  ).run(
    id, input.projectId, input.sceneId, input.requirementId, input.requestId,
    input.sourceScenesVersionId ?? String(scenesVer),
    input.status,
    input.resultRelevance ?? null,
    input.resultAssetId ?? null,
    input.failurePhase ?? null,
    input.createdAt ?? new Date().toISOString(),
    input.createdAt ?? new Date().toISOString(),
  );
  return id;
}

function resolutionOf(projectId: string, sceneId: string, requirementId: string) {
  const scenesJson = (getDb().prepare(
    `SELECT content FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as {content: string}).content;
  const parsed = JSON.parse(scenesJson) as {scenes: Array<Record<string, unknown>>};
  const res = buildProjectResolution(projectId, parsed.scenes as never);
  const scene = res.find((s) => s.sceneId === sceneId);
  return scene?.requirements.find((r) => r.requirementId === requirementId);
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-resolver-candidate-e2e'), {recursive: true, force: true});

  const projectId = createProjectWithWorkflow({topic: 'resolver-e2e', coreQuestion: 'q'}).project.id;
  seedProject(projectId, [
    makeScene('S001', [
      {id: 'S001-R01', query: 'red apple'},
      {id: 'S001-R02', query: 'blue sky'},
    ]),
    makeScene('S002', [
      {id: 'S002-R01', query: 'green tree'},
    ]),
  ]);
  const reqR01 = 'S001-R01';
  const reqR02 = 'S001-R02';
  const reqS2 = 'S002-R01';

  // ============ E1：生成成功 → candidate_waiting → bind → ready ============
  {
    const jobIdE1 = insertJob({
      projectId, sceneId: 'S001', requirementId: reqR01, requestId: 'req-e1',
      status: 'succeeded', resultAssetId: '__PENDING__', resultRelevance: 'current', sourceScenesVersionId: '1',
    });
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: reqR01, query: 'red apple',
      provenance: {
        sourceScenesVersionId: '1', sourceRequirementHash: snapshotHash(reqR01, 'red apple'),
        assetGenerationJobId: jobIdE1, requestId: 'req-e1', relevance: 'current', staleReason: null,
      },
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(assetId, jobIdE1);
    const res = resolutionOf(projectId, 'S001', reqR01)!;
    ok(res.status === 'candidate_waiting', '[E1a] 未绑定候选 → candidate_waiting', res.status);
    ok(res.generatedCandidates.length === 1 && res.generatedCandidates[0]!.assetId === assetId, '[E1b] generatedCandidates 精确命中 candidate');
    ok(res.latestGenerationAttempt?.status === 'succeeded', '[E1c] latestGenerationAttempt 显示 succeeded');
    ok(res.availableActions.includes('select_candidate'), '[E1d] 提供 select_candidate 动作');

    const {binding, asset} = bindGeneratedCandidate({
      projectId, candidateId: assetId, sceneId: 'S001', requirementId: reqR01,
    });
    ok(binding.scene_id === 'S001' && binding.requirement_id === reqR01 && binding.active === 1, '[E1e] active binding exact');
    ok(asset.license_status === 'generated', '[E1f] 绑定后 license=generated');
    const after = resolutionOf(projectId, 'S001', reqR01)!;
    ok(after.status === 'ready' && after.boundAssetId === assetId, '[E1g] 绑定后 status=ready');
  }

  // ============ E2：candidate 不串 requirement ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: reqR01, query: 'red apple',
      provenance: {
        sourceScenesVersionId: '1', sourceRequirementHash: snapshotHash(reqR01, 'red apple'),
        assetGenerationJobId: 'job-e2', requestId: 'req-e2', relevance: 'current', staleReason: null,
      },
    });
    const r1 = resolutionOf(projectId, 'S001', reqR01)!;
    ok(r1.generatedCandidates.some((c) => c.assetId === assetId), '[E2a] 候选出现在 R01');
    const r2 = resolutionOf(projectId, 'S001', reqR02)!;
    ok(!r2.generatedCandidates.some((c) => c.assetId === assetId), '[E2b] 候选不串到 R02');
    // 跨 requirement 绑定拒绝
    let rejected = false;
    try {
      bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S001', requirementId: reqR02});
    } catch {
      rejected = true;
    }
    ok(rejected, '[E2c] 跨 requirement 绑定被拒绝');
  }

  // ============ E3：candidate 不串 scene ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: reqR01, query: 'red apple',
      provenance: {
        sourceScenesVersionId: '1', sourceRequirementHash: snapshotHash(reqR01, 'red apple'),
        assetGenerationJobId: 'job-e3', requestId: 'req-e3', relevance: 'current', staleReason: null,
      },
    });
    const s2 = resolutionOf(projectId, 'S002', reqS2)!;
    ok(!s2.generatedCandidates.some((c) => c.assetId === assetId), '[E3a] 候选不串到 S002');
    let rejected = false;
    try {
      bindGeneratedCandidate({projectId, candidateId: assetId, sceneId: 'S002', requirementId: reqS2});
    } catch {
      rejected = true;
    }
    ok(rejected, '[E3b] 跨 scene 绑定被拒绝');
  }

  // ============ E4：stale source candidate 不作为 current ============
  {
    const assetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: reqR01, query: 'red apple',
      provenance: {
        sourceScenesVersionId: '1', sourceRequirementHash: snapshotHash(reqR01, 'red apple'),
        assetGenerationJobId: 'job-e4', requestId: 'req-e4', relevance: 'stale', staleReason: 'source_drift',
      },
    });
    insertJob({
      projectId, sceneId: 'S001', requirementId: reqR01, requestId: 'req-e4',
      status: 'succeeded', resultAssetId: assetId, resultRelevance: 'stale', sourceScenesVersionId: '1',
    });
    const res = resolutionOf(projectId, 'S001', reqR01)!;
    ok(!res.generatedCandidates.some((c) => c.assetId === assetId), '[E4a] stale candidate 不作为 current（不在 generatedCandidates）', res.generatedCandidates.map((c) => c.assetId));
    ok(res.staleGeneratedCandidates.some((c) => c.assetId === assetId), '[E4b] stale 候选保留审计展示');
    ok(res.latestGenerationAttempt?.resultRelevance === 'stale', '[E4c] latest attempt relevance=stale');
    ok(res.status !== 'candidate_waiting', '[E4d] stale 不触发 candidate_waiting', res.status);
  }

  // ============ E5：历史 candidate append-only（旧版本 candidate 转 stale，新 candidate current） ============
  {
    // v1 生成成功（provenance v1）
    const oldAssetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: reqR02, query: 'blue sky',
      provenance: {
        sourceScenesVersionId: '1', sourceRequirementHash: snapshotHash(reqR01, 'red apple'),
        assetGenerationJobId: 'job-e5a', requestId: 'req-e5a', relevance: 'current', staleReason: null,
      },
    });
    // 切换到 version 2
    seedProject(projectId, [
      makeScene('S001', [
        {id: 'S001-R01', query: 'red apple'},
        {id: 'S001-R02', query: 'blue sky'},
      ]),
      makeScene('S002', [
        {id: 'S002-R01', query: 'green tree'},
      ]),
    ]);
    const v2 = (getDb().prepare(
      `SELECT version FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
    ).get(projectId) as {version: number}).version;
    const newAssetId = insertGeneratedAsset({
      projectId, sceneId: 'S001', requirementId: reqR02, query: 'blue sky',
      provenance: {
        sourceScenesVersionId: String(v2), sourceRequirementHash: snapshotHash(reqR02, 'blue sky'),
        assetGenerationJobId: 'job-e5b', requestId: 'req-e5b', relevance: 'current', staleReason: null,
      },
    });
    const res = resolutionOf(projectId, 'S001', reqR02)!;
    ok(res.generatedCandidates.length === 1 && res.generatedCandidates[0]!.assetId === newAssetId,
      '[E5a] 当前 candidate 为 v2 的资产（v1 资产转 stale）', res.generatedCandidates.map((c) => c.assetId));
    ok(res.staleGeneratedCandidates.some((c) => c.assetId === oldAssetId), '[E5b] v1 资产 append-only 保留（stale 审计）');
  }

  // ============ E6：latest attempt 选择（failed old + queued/running new → generating） ============
  {
    // old failed
    insertJob({
      projectId, sceneId: 'S002', requirementId: reqS2, requestId: 'req-e6a',
      status: 'failed', failurePhase: 'PROVIDER_CONNECT_TIMEOUT', sourceScenesVersionId: '1',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    // new queued
    insertJob({
      projectId, sceneId: 'S002', requirementId: reqS2, requestId: 'req-e6b',
      status: 'queued', sourceScenesVersionId: '2',
      createdAt: '2026-07-01T00:01:00.000Z',
    });
    const res = resolutionOf(projectId, 'S002', reqS2)!;
    ok(res.status === 'generating', '[E6a] failed old + queued new → generating', res.status);
    ok(res.latestGenerationAttempt?.status === 'queued' && res.latestGenerationAttempt?.requestId === 'req-e6b',
      '[E6b] latest attempt 显示 new（queued）', res.latestGenerationAttempt);
    // new running
    getDb().prepare(`UPDATE asset_generation_jobs SET status='running' WHERE request_id='req-e6b'`).run();
    const res2 = resolutionOf(projectId, 'S002', reqS2)!;
    ok(res2.status === 'generating', '[E6c] failed old + running new → generating');
    ok(res2.latestGenerationAttempt?.status === 'running', '[E6d] latest attempt 显示 new（running）');
  }

  // ============ E7：latest attempt 选择（succeeded old + failed new → candidate + 最新失败审计） ============
  {
    const curVer = String((getDb().prepare(
      `SELECT version FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
    ).get(projectId) as {version: number}).version);
    const oldAssetId = insertGeneratedAsset({
      projectId, sceneId: 'S002', requirementId: reqS2, query: 'green tree',
      provenance: {
        sourceScenesVersionId: curVer, sourceRequirementHash: snapshotHash(reqS2, 'green tree'),
        assetGenerationJobId: 'job-e7a', requestId: 'req-e7a', relevance: 'current', staleReason: null,
      },
    });
    insertJob({
      projectId, sceneId: 'S002', requirementId: reqS2, requestId: 'req-e7a',
      status: 'succeeded', resultAssetId: oldAssetId, resultRelevance: 'current', sourceScenesVersionId: curVer,
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    // new failed（succeeded old 之后）
    insertJob({
      projectId, sceneId: 'S002', requirementId: reqS2, requestId: 'req-e7b',
      status: 'failed', failurePhase: 'PROVIDER_RESPONSE_TIMEOUT', sourceScenesVersionId: curVer,
      createdAt: '2026-07-01T00:02:00.000Z',
    });
    const res = resolutionOf(projectId, 'S002', reqS2)!;
    ok(res.generatedCandidates.some((c) => c.assetId === oldAssetId), '[E7a] 历史 candidate 仍可显示');
    ok(res.status === 'candidate_waiting', '[E7b] candidate availability → candidate_waiting', res.status);
    ok(res.latestGenerationAttempt?.status === 'failed'
      && res.latestGenerationAttempt?.failurePhase === 'PROVIDER_RESPONSE_TIMEOUT'
      && res.latestGenerationAttempt?.requestId === 'req-e7b',
      '[E7c] latest attempt 审计显示 new 的失败（不被历史 candidate 掩盖）', res.latestGenerationAttempt);
  }

  // 清理
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-asset-resolver-candidate-e2e'), {recursive: true, force: true});
  fs.rmSync(path.resolve(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

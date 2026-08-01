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

function makeScene(query: string, requirementId = 'S001-R01', sceneId = 'S001'): Record<string, unknown> {
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

  // ============ B10：legacy + requirement_json NULL → 409 ============
  {
    const assetId = insertAsset({
      projectId, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
      sourceProvider: 'apiyi', sourceUrl: null,
      localPath: `assets/${projectId}/mock-legacy-null.png`, mimeType: 'image/png',
      width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成',
      attribution: 'x', description: 'd', requirement: null, provenance: null,
    }).id;
    expectBindError(projectId, assetId, 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', '[B10a] legacy + requirement_json NULL → 409');
  }

  // ============ B11：legacy + malformed requirement_json → 409 ============
  {
    const assetId = insertAsset({
      projectId, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
      sourceProvider: 'apiyi', sourceUrl: null,
      localPath: `assets/${projectId}/mock-legacy-bad.png`, mimeType: 'image/png',
      width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成',
      attribution: 'x', description: 'd', requirement: null, provenance: null,
    }).id;
    getDb().prepare('UPDATE assets SET requirement_json = ? WHERE id = ?').run('{not-json', assetId);
    expectBindError(projectId, assetId, 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', '[B11a] legacy + malformed requirement_json → 409');
  }

  // ============ B12：legacy + requirementId missing → 409 ============
  {
    const assetId = insertAsset({
      projectId, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
      sourceProvider: 'apiyi', sourceUrl: null,
      localPath: `assets/${projectId}/mock-legacy-noreq.png`, mimeType: 'image/png',
      width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成',
      attribution: 'x', description: 'd', requirement: null, provenance: null,
    }).id;
    getDb().prepare('UPDATE assets SET requirement_json = ? WHERE id = ?')
      .run(JSON.stringify({kind: 'image', query: 'x'}), assetId); // 无 requirementId
    expectBindError(projectId, assetId, 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', '[B12a] legacy + requirementId missing → 409');
  }

  // ============ B13：legacy + requirement 已从 active scenes 删除 → 409 ============
  {
    const legacyId = insertAsset({
      projectId, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
      sourceProvider: 'apiyi', sourceUrl: null,
      localPath: `assets/${projectId}/mock-legacy-del.png`, mimeType: 'image/png',
      width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成',
      attribution: 'x', description: 'd',
      requirement: {requirementId: 'S001-R01', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
      provenance: null,
    }).id;
    // 切 scenes：S001 不再包含 R01（只有 R99）
    generateVersion({
      projectId, stage: 'scenes',
      content: JSON.stringify({
        chapterTiming: [{chapter: 1, title: '测试章', start: 0, end: 10}],
        scenes: [makeScene('other', 'S001-R99')],
      }),
      contentType: 'json', source: 'manual_edit',
    });
    try {
      bindGeneratedCandidate({projectId, candidateId: legacyId, sceneId: 'S001', requirementId: 'S001-R01'});
      ok(false, '[B13a] legacy + requirement 已删除应 409');
    } catch (err) {
      const e = err as {code?: string; httpStatus?: number};
      ok(e.httpStatus === 409 && e.code === 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE',
        '[B13a] legacy + requirement 已删除 → 409 + LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', e);
    }
    // 切回（后续测试需要 R01 存在）
    seedProject(projectId);
  }

  // ============ B14：legacy + scene_id NULL → 409 ============
  {
    const assetId = insertAsset({
      projectId, sceneId: null, mediaType: 'image', sourceType: 'generated',
      sourceProvider: 'apiyi', sourceUrl: null,
      localPath: `assets/${projectId}/mock-legacy-nullscene.png`, mimeType: 'image/png',
      width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成',
      attribution: 'x', description: 'd',
      requirement: {requirementId: 'S001-R01', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
      provenance: null,
    }).id;
    expectBindError(projectId, assetId, 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', '[B14a] legacy + scene_id NULL → 409');
  }

  // ============ B15：bind 失败完整 rollback（旧 binding/license/resolution state 不变） ============
  {
    // 独立 project（避免与 A9 的 active binding 撞 UNIQUE）
    const p15 = createProjectWithWorkflow({topic: 'bind-rollback', coreQuestion: 'q'}).project.id;
    seedProject(p15);
    // 预置：已有 active binding（另一 asset）→ 尝试绑 stale candidate（失败）
    // → 旧 binding 仍 active、license 不变、resolution state 保留
    const curVer = currentVersion(p15);
    const jobId = insertJob({
      projectId: p15, requestId: 'req-b15', status: 'succeeded',
      resultAssetId: '__PENDING__', resultRelevance: 'stale', sourceScenesVersionId: curVer,
    });
    const staleAssetId = insertGeneratedAssetWithProvenance({
      projectId: p15,
      provenanceJson: JSON.stringify({
        sourceScenesVersionId: curVer,
        sourceRequirementHash: snapshotHash('S001-R01', 'test subject'),
        assetGenerationJobId: jobId,
        requestId: 'req-b15',
        relevance: 'stale',
        staleReason: 'source_drift',
      }),
    });
    getDb().prepare(`UPDATE asset_generation_jobs SET result_asset_id=? WHERE id=?`).run(staleAssetId, jobId);
    // 旧 binding + license + resolution state
    const oldAssetId = insertGeneratedAssetWithProvenance({
      projectId: p15,
      provenanceJson: JSON.stringify({
        sourceScenesVersionId: curVer,
        sourceRequirementHash: snapshotHash('S001-R01', 'test subject'),
        assetGenerationJobId: 'job-old-b15',
        requestId: 'req-old-b15',
        relevance: 'current',
        staleReason: null,
      }),
    });
    getDb().prepare(
      `INSERT INTO asset_bindings (id, project_id, scene_id, requirement_id, asset_id, active, created_at)
       VALUES (?, ?, 'S001', 'S001-R01', ?, 1, ?)`,
    ).run(crypto.randomUUID(), p15, oldAssetId, new Date().toISOString());
    getDb().prepare(`UPDATE assets SET license_status='usable' WHERE id=?`).run(oldAssetId);
    getDb().prepare(
      `INSERT INTO asset_resolution_state (project_id, scene_id, requirement_id, status, reason, queries_tried, provider, metadata, updated_at)
       VALUES (?, 'S001', 'S001-R01', 'no_result', '保留', '[]', 'apiyi', '{}', ?)`,
    ).run(p15, new Date().toISOString());

    try {
      bindGeneratedCandidate({projectId: p15, candidateId: staleAssetId, sceneId: 'S001', requirementId: 'S001-R01'});
      ok(false, '[B15a] stale candidate 绑定应失败');
    } catch {
      ok(true, '[B15a] stale candidate 绑定失败（触发 rollback 检查）');
    }
    const oldBinding = getDb().prepare(`SELECT active FROM asset_bindings WHERE asset_id=? AND active=1`).get(oldAssetId) as {active: number} | undefined;
    ok(oldBinding?.active === 1, '[B15b] 旧 active binding 未被 deactivate');
    const license = getDb().prepare(`SELECT license_status FROM assets WHERE id=?`).get(oldAssetId) as {license_status: string};
    ok(license.license_status === 'usable', '[B15c] 旧 asset license 不变');
    const state = getDb().prepare(`SELECT count(*) AS c FROM asset_resolution_state WHERE project_id=? AND requirement_id=?`).get(p15, 'S001-R01') as {c: number};
    ok(state.c === 1, '[B15d] resolution state 未被清除');
    const bindings = getDb().prepare(`SELECT count(*) AS c FROM asset_bindings WHERE project_id=? AND active=1`).get(p15) as {c: number};
    ok(bindings.c === 1, '[B15e] 失败后 active binding 总数不变（事务整体 rollback）');
  }

  // ============ B16：legacy 错误契约精确断言（code + httpStatus） ============
  {
    const p16 = createProjectWithWorkflow({topic: 'bind-legacy-contract', coreQuestion: 'q'}).project.id;
    seedProject(p16);
    const mkLegacy = (overrides: {sceneId?: string | null; requirementJson?: string | null} = {}): string => {
      const id = insertAsset({
        projectId: p16, sceneId: overrides.sceneId !== undefined ? overrides.sceneId : 'S001',
        mediaType: 'image', sourceType: 'generated', sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${p16}/mock-legacy-${crypto.randomUUID()}.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: null, provenance: null,
      }).id;
      if (overrides.requirementJson !== undefined) {
        getDb().prepare('UPDATE assets SET requirement_json = ? WHERE id = ?').run(overrides.requirementJson, id);
      }
      return id;
    };
    const expectLegacy = (assetId: string, label: string, sceneId = 'S001', requirementId = 'S001-R01', pid = p16): void => {
      try {
        bindGeneratedCandidate({projectId: pid, candidateId: assetId, sceneId, requirementId});
        ok(false, `${label}（应抛 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE）`);
      } catch (err) {
        const e = err as {code?: string; httpStatus?: number};
        ok(e.httpStatus === 409 && e.code === 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', label, e);
      }
    };
    const goodReq = JSON.stringify({requirementId: 'S001-R01', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'});

    // 1 scene_id NULL；2 scene_id 空字符串；3 scene mismatch
    expectLegacy(mkLegacy({sceneId: null}), '[B16a] legacy scene_id NULL → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    expectLegacy(mkLegacy({sceneId: ''}), '[B16b] legacy scene_id 空字符串 → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    expectLegacy(mkLegacy({sceneId: 'S999'}), '[B16c] legacy scene mismatch → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    // 4 requirement_json NULL；5 malformed
    expectLegacy(mkLegacy({requirementJson: null}), '[B16d] legacy requirement_json NULL → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    expectLegacy(mkLegacy({requirementJson: '{bad'}), '[B16e] legacy requirement_json malformed → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    // 6 requirementId missing；7 empty；8 wrong type；9 mismatch
    expectLegacy(mkLegacy({requirementJson: '{}'}), '[B16f] legacy requirementId missing → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    expectLegacy(mkLegacy({requirementJson: JSON.stringify({requirementId: ''})}), '[B16g] legacy requirementId empty → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    expectLegacy(mkLegacy({requirementJson: JSON.stringify({requirementId: 42})}), '[B16h] legacy requirementId wrong type → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    expectLegacy(mkLegacy({requirementJson: JSON.stringify({requirementId: 'S001-R99'})}), '[B16i] legacy requirement mismatch → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
    // 10 active scenes artifact missing（project 无 scenes stage）
    {
      const pNoScenes = createProjectWithWorkflow({topic: 'bind-no-scenes', coreQuestion: 'q'}).project.id;
      // 不 seed scenes → 无 active_version
      const legacyId = insertAsset({
        projectId: pNoScenes, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
        sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${pNoScenes}/mock-legacy-noscenes.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: {requirementId: 'S001-R01', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
        provenance: null,
      }).id;
      expectLegacy(legacyId, '[B16j] legacy + active scenes 缺失 → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', 'S001', 'S001-R01', pNoScenes);
    }
    // 11 active scene 已删除（scenes 真实只含 S002，不含 S001）
    {
      const pDel = createProjectWithWorkflow({topic: 'bind-scene-del', coreQuestion: 'q'}).project.id;
      generateVersion({
        projectId: pDel, stage: 'scenes', contentType: 'json', source: 'manual_edit',
        content: JSON.stringify({chapterTiming: [{chapter: 1, title: 't', start: 0, end: 10}], scenes: [makeScene('x', 'S002-R01', 'S002')]}),
      });
      // 先断言 active scenes：S001 不存在、S002 存在
      const {loadActiveScenesSource} = await import('../src/lib/assets/requirements');
      const src = loadActiveScenesSource(pDel);
      ok(src !== null && src.plans.some((pl) => pl.sceneId === 'S002') && !src.plans.some((pl) => pl.sceneId === 'S001'),
        '[B16k-pre] active scenes 含 S002 且不含 S001（fixture 前提）');
      const legacyId = insertAsset({
        projectId: pDel, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
        sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${pDel}/mock-legacy-scene-del.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: {requirementId: 'S001-R01', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
        provenance: null,
      }).id;
      expectLegacy(legacyId, '[B16k] legacy + active scene 已删除 → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', 'S001', 'S001-R01', pDel);
    }
    // 12 active requirement 已删除（已有 B13 精确断言）——补一个独立 project 的精确版
    {
      const pDelReq = createProjectWithWorkflow({topic: 'bind-req-del', coreQuestion: 'q'}).project.id;
      seedProject(pDelReq);
      const legacyId = insertAsset({
        projectId: pDelReq, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
        sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${pDelReq}/mock-legacy-req-del.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: {requirementId: 'S001-R01', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
        provenance: null,
      }).id;
      generateVersion({
        projectId: pDelReq, stage: 'scenes', contentType: 'json', source: 'manual_edit',
        content: JSON.stringify({chapterTiming: [{chapter: 1, title: 't', start: 0, end: 10}], scenes: [makeScene('x', 'S001-R99')]}),
      });
      expectLegacy(legacyId, '[B16l] legacy + active requirement 已删除 → 409 LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', 'S001', 'S001-R01', pDelReq);
    }
    // 13 legacy exact success（独立 project）
    {
      const pOk = createProjectWithWorkflow({topic: 'bind-legacy-ok', coreQuestion: 'q'}).project.id;
      seedProject(pOk);
      const legacyId = insertAsset({
        projectId: pOk, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
        sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${pOk}/mock-legacy-ok.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: {requirementId: 'S001-R01', kind: 'image', subject: '测试主体', query: 'test subject', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
        provenance: null,
      }).id;
      const r = bindGeneratedCandidate({projectId: pOk, candidateId: legacyId, sceneId: 'S001', requirementId: 'S001-R01'});
      ok(r.binding.active === 1 && r.legacyProvenance === true, '[B16m] legacy exact target → bind success + legacyProvenance=true');
    }
    // 14 legacy 失败不修改状态（old binding/license/resolution state/binding count）
    {
      const pRb = createProjectWithWorkflow({topic: 'bind-legacy-rollback', coreQuestion: 'q'}).project.id;
      seedProject(pRb);
      // 旧 active binding
      const oldAssetId = insertAsset({
        projectId: pRb, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
        sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${pRb}/mock-legacy-old.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'usable', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: {requirementId: 'S001-R01', kind: 'image', subject: '测试主体', query: 'test subject', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
        provenance: null,
      }).id;
      getDb().prepare(
        `INSERT INTO asset_bindings (id, project_id, scene_id, requirement_id, asset_id, active, created_at)
         VALUES (?, ?, 'S001', 'S001-R01', ?, 1, ?)`,
      ).run(crypto.randomUUID(), pRb, oldAssetId, new Date().toISOString());
      getDb().prepare(
        `INSERT INTO asset_resolution_state (project_id, scene_id, requirement_id, status, reason, queries_tried, provider, metadata, updated_at)
         VALUES (?, 'S001', 'S001-R01', 'no_result', '保留', '[]', 'apiyi', '{}', ?)`,
      ).run(pRb, new Date().toISOString());
      // 失败的 legacy candidate（requirement 不匹配）
      const badLegacy = insertAsset({
        projectId: pRb, sceneId: 'S001', mediaType: 'image', sourceType: 'generated',
        sourceProvider: 'apiyi', sourceUrl: null,
        localPath: `assets/${pRb}/mock-legacy-bad2.png`, mimeType: 'image/png',
        width: 1, height: 1, licenseStatus: 'generated', licenseNote: 'AI 生成', attribution: 'x', description: 'd',
        requirement: {requirementId: 'S001-R99', kind: 'image', subject: 's', query: 'q', usage: 'primary', policy: 'generated', authenticity: 'synthetic_allowed'},
        provenance: null,
      }).id;
      try {
        bindGeneratedCandidate({projectId: pRb, candidateId: badLegacy, sceneId: 'S001', requirementId: 'S001-R01'});
        ok(false, '[B16n] legacy requirement mismatch 应失败');
      } catch (err) {
        ok((err as {code?: string}).code === 'LEGACY_CANDIDATE_TARGET_UNVERIFIABLE', '[B16n] legacy requirement mismatch → LEGACY_CANDIDATE_TARGET_UNVERIFIABLE');
      }
      const oldBinding = getDb().prepare(`SELECT active FROM asset_bindings WHERE asset_id=? AND active=1`).get(oldAssetId) as {active: number} | undefined;
      ok(oldBinding?.active === 1, '[B16o] legacy 失败不修改 old active binding');
      const license = getDb().prepare(`SELECT license_status FROM assets WHERE id=?`).get(oldAssetId) as {license_status: string};
      ok(license.license_status === 'usable', '[B16p] legacy 失败不修改 candidate license');
      const state = getDb().prepare(`SELECT count(*) AS c FROM asset_resolution_state WHERE project_id=? AND requirement_id=?`).get(pRb, 'S001-R01') as {c: number};
      ok(state.c === 1, '[B16q] legacy 失败不清除 resolution state');
      const bindings = getDb().prepare(`SELECT count(*) AS c FROM asset_bindings WHERE project_id=? AND active=1`).get(pRb) as {c: number};
      ok(bindings.c === 1, '[B16r] legacy 失败 binding count 不变（事务 rollback）');
    }
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

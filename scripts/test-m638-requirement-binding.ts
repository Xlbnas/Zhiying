/**
 * M6.3.8 Stable Requirement Identity + Explicit Binding 测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m638-requirement-binding.ts
 *
 * 覆盖（对应验收清单）：
 *   A. 1 scene + 2 requirements：bind R01 → R01 READY / R02 PENDING；bind R02 → 全 READY
 *   B. asset DB 顺序反转 / 随机打乱 → resolver 结果不变（不依赖 ordering）
 *   C. candidate R01 不能 bind R02；candidate S01 不能 bind S02（exact 校验 reject）
 *   D. manual upload 必须 exact requirement（错配 scene/requirement → reject）
 *   E. Manual Replace：替换 R01 → sibling R02 不变、旧 asset/provenance 保留、READY 数不变
 *   F. legacy migration：exact 快照匹配 / 单需求 auto / 多需求 ambiguous 保持 pending
 *   G. unbound candidate → PENDING（generate ≠ bind）
 *   H. active generated / manual / wikimedia binding → READY
 *   I. readiness requirement 粒度（2 需求 1 绑定 → scene not ready；needAssets = 需求数）
 *   J. compiler requirementId 注入：fill-if-missing + 幂等 + 显式 id 保留
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m638-binding');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {bindGeneratedCandidate, BindError} from '../src/lib/assets/bind';
import {
  bindAssetToRequirement,
  deactivateBindingForRequirement,
  getActiveBinding,
  getAssetById,
  insertAsset,
  listActiveBindingsForProject,
  listAssetsForProject,
  listBindingsForProject,
  type AssetRow,
} from '../src/lib/assets/model';
import {applyBindingMigration, planBindingMigration} from '../src/lib/assets/migrate-bindings';
import {evaluateVisualReadiness} from '../src/lib/assets/readiness';
import {buildProjectResolution, resolveSceneAssets} from '../src/lib/assets/resolver';
import {compileAssetPlans} from '../src/lib/assets/requirements';
import {requirementIdOf, type AssetRequirement, type Scene} from '../src/lib/scene-schema';
import {compileScenesAiOutput} from '../src/lib/scenes/compiler';
import {scenesAiOutputSchema} from '../src/lib/prompts/scenes';
import {POST as uploadPOST} from '../src/app/api/projects/[id]/assets/upload/route';
import {POST as bindPOST} from '../src/app/api/projects/[id]/assets/generated/[candidateId]/bind/route';

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

// ---------- fixture helpers ----------

const P1 = 'test-p1-binding';
const P2 = 'test-p2-migration';

const REQ_S01_R01: AssetRequirement = {kind: 'image', subject: '弗洛伊德肖像', query: 'Freud portrait', usage: 'primary', policy: 'public_domain'};
const REQ_S01_R02: AssetRequirement = {kind: 'image', subject: '维也纳街景', query: 'Vienna street', usage: 'primary', policy: 'public_domain'};
const REQ_S02_R01: AssetRequirement = {kind: 'image', subject: '梦的解析封面', query: 'Interpretation of Dreams cover', usage: 'primary', policy: 'public_domain'};

function scene(partial: Partial<Scene> & Pick<Scene, 'id'>): Scene {
  return {
    chapter: 1,
    chapterTitle: '第一章',
    start: 0,
    end: 10,
    duration: 10,
    startFrame: 0,
    durationInFrames: 300,
    category: 'Archive',
    visualType: 'Archive',
    template: null,
    sourceTemplate: null,
    assetRequirements: [],
    narrationSummary: '摘要',
    description: '画面描述',
    notes: '',
    assetIds: [],
    licenseStatus: 'not-applicable',
    subtitlePosition: 'bottom',
    transitionIn: 'none',
    transitionOut: 'cut',
    ...partial,
  } as Scene;
}

function scenesArtifact(): string {
  return JSON.stringify({
    chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 20}],
    scenes: [
      scene({id: 'S01', assetRequirements: [REQ_S01_R01, REQ_S01_R02]}),
      scene({id: 'S02', start: 10, end: 20, assetRequirements: [REQ_S02_R01]}),
    ],
  });
}

function seedProject(projectId: string): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(projectId, `测试项目 ${projectId}`, now, now);
  getDb().prepare(
    `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, created_at)
     VALUES (?, ?, 'scenes', 1, ?, 'json', 'repair', ?)`,
  ).run(`${projectId}-scenes-v1`, projectId, scenesArtifact(), now);
}

function scenesOf(projectId: string): Scene[] {
  const row = getDb().prepare(
    `SELECT content FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as {content: string};
  return (JSON.parse(row.content) as {scenes: Scene[]}).scenes;
}

/** 插入 asset 行并创建真实文件（readiness 检查文件存在）。 */
function seedAsset(input: Parameters<typeof insertAsset>[0]): AssetRow {
  const row = insertAsset(input);
  const abs = path.join(process.cwd(), 'public', row.local_path);
  fs.mkdirSync(path.dirname(abs), {recursive: true});
  fs.writeFileSync(abs, Buffer.from(`fake-image-${row.id}`));
  return row;
}

function cleanupFiles(projectId: string): void {
  fs.rmSync(path.join(process.cwd(), 'public', 'assets', projectId), {recursive: true, force: true});
}

function wikimediaAsset(projectId: string, sceneId: string, requirement: AssetRequirement): Parameters<typeof insertAsset>[0] {
  return {
    projectId, sceneId, mediaType: 'image', sourceType: 'archive', sourceProvider: 'wikimedia',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:x.jpg', localPath: `assets/${projectId}/${crypto.randomUUID()}.jpg`,
    mimeType: 'image/jpeg', licenseStatus: 'usable', licenseNote: 'Public domain', attribution: 'Wikimedia',
    description: requirement.subject, requirement,
  };
}

function generatedCandidate(projectId: string, sceneId: string, requirement: AssetRequirement & {requirementId?: string}): Parameters<typeof insertAsset>[0] {
  return {
    projectId, sceneId, mediaType: 'image', sourceType: 'generated', sourceProvider: 'apiyi',
    sourceUrl: null, localPath: `assets/${projectId}/${crypto.randomUUID()}.jpg`,
    mimeType: 'image/jpeg', licenseStatus: 'generated', licenseNote: 'AI 生成 (待确认)',
    attribution: 'API易 / test-model', description: requirement.subject, requirement,
  };
}

// ---------- main ----------

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m638-binding'), {recursive: true, force: true});
  getDb();

  // ============ J. requirementId 推导与 compiler 注入 ============
  {
    ok(requirementIdOf('S012', REQ_S01_R01, 0) === 'S012-R01', '[J01] 无显式 id 时 deterministic 推导');
    ok(requirementIdOf('S012', {...REQ_S01_R01, requirementId: 'custom-id'}, 0) === 'custom-id', '[J02] 显式 id 优先');
    const parsed = scenesAiOutputSchema.parse(JSON.parse(scenesArtifact()));
    const once = compileScenesAiOutput(JSON.parse(JSON.stringify(parsed)));
    const twice = compileScenesAiOutput(JSON.parse(JSON.stringify(once.output)));
    const s01reqs = (once.output.scenes[0] as unknown as {assetRequirements: Array<{requirementId?: string}>}).assetRequirements;
    ok(s01reqs[0]?.requirementId === 'S01-R01' && s01reqs[1]?.requirementId === 'S01-R02', '[J03] compiler 注入稳定 requirementId', s01reqs);
    ok(JSON.stringify(once.output) === JSON.stringify(twice.output), '[J04] compiler 注入幂等');
    const withExplicit = scenesAiOutputSchema.parse({
      chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 20}],
      scenes: [scene({id: 'S01', assetRequirements: [{...REQ_S01_R01, requirementId: 'keep-me'}]})],
    });
    const outExplicit = compileScenesAiOutput(JSON.parse(JSON.stringify(withExplicit)));
    const kept = (outExplicit.output.scenes[0] as unknown as {assetRequirements: Array<{requirementId?: string}>}).assetRequirements[0];
    ok(kept?.requirementId === 'keep-me', '[J05] 显式 requirementId 不被覆盖');
  }

  // ============ P1：binding / resolver / readiness / routes ============
  seedProject(P1);
  const scenes = scenesOf(P1);
  const s01 = scenes.find((s) => s.id === 'S01')!;
  const plans = compileAssetPlans(scenesArtifact());
  const p1ReqIds = plans.find((p) => p.sceneId === 'S01')!.requirements.map((r) => r.requirementId);

  // ---------- A/G/H：两需求 scene 的 exact binding 语义 ----------
  {
    // 初始：无 binding → 全 pending
    const r0 = buildProjectResolution(P1, scenes);
    const s01r0 = r0.find((x) => x.sceneId === 'S01')!;
    ok(s01r0.totalRequired === 2 && s01r0.ready === 0, '[A01] 初始 0/2 pending');
    ok(s01r0.requirements.every((q) => q.status === 'pending'), '[A02] 两个需求均 pending');

    // bind R01（wikimedia 路径）
    const a1 = seedAsset(wikimediaAsset(P1, 'S01', REQ_S01_R01));
    bindAssetToRequirement({projectId: P1, sceneId: 'S01', requirementId: p1ReqIds[0]!, assetId: a1.id});
    const r1 = buildProjectResolution(P1, scenes);
    const s01r1 = r1.find((x) => x.sceneId === 'S01')!;
    ok(s01r1.requirements.find((q) => q.requirementId === p1ReqIds[0])?.status === 'ready', '[A03] bind R01 → R01 READY');
    ok(s01r1.requirements.find((q) => q.requirementId === p1ReqIds[1])?.status === 'pending', '[A04] bind R01 → R02 仍 PENDING（sibling 不受影响）');
    ok(s01r1.ready === 1 && s01r1.totalRequired === 2, '[A05] 1/2 计数正确');

    // bind R02（manual upload 路径模拟：user_provided license）
    const a2 = seedAsset({
      projectId: P1, sceneId: 'S01', mediaType: 'image', sourceType: 'upload', sourceProvider: 'user_upload',
      sourceUrl: null, localPath: `assets/${P1}/${crypto.randomUUID()}.jpg`, mimeType: 'image/jpeg',
      licenseStatus: 'user_provided', licenseNote: '用户上传', attribution: 'b.jpg',
      description: REQ_S01_R02.subject, requirement: REQ_S01_R02,
    });
    bindAssetToRequirement({projectId: P1, sceneId: 'S01', requirementId: p1ReqIds[1]!, assetId: a2.id});
    const r2 = buildProjectResolution(P1, scenes);
    const s01r2 = r2.find((x) => x.sceneId === 'S01')!;
    ok(s01r2.ready === 2 && s01r2.overallStatus === 'ready', '[A06] bind R02 → 两个需求全 READY');

    // readiness：requirement 粒度（S01 全 ready；S02 无绑定 → not ready；needAssets=3）
    const v1 = evaluateVisualReadiness(P1, scenes);
    ok(v1.needAssets === 3, '[I01] needAssets = 需求总数 3（非场景数 2）');
    ok(v1.readyRequirements === 2 && v1.pendingAssets === 1, '[I02] ready/pending requirement 计数 2/1');
    ok(!v1.ready && v1.missing.some((m) => m.sceneId === 'S02' && m.requirementId === 'S02-R01'), '[I03] S02 需求未绑定 → overall not ready 且 missing 带 requirementId');

    // S02 也绑定（generated 路径直接 binding）→ 全 ready
    const a3 = seedAsset(generatedCandidate(P1, 'S02', {...REQ_S02_R01, requirementId: 'S02-R01'}));
    bindAssetToRequirement({projectId: P1, sceneId: 'S02', requirementId: 'S02-R01', assetId: a3.id});
    const v2 = evaluateVisualReadiness(P1, scenes);
    ok(v2.ready && v2.readyRequirements === 3 && v2.pendingAssets === 0, '[H01] 三类来源 active binding 全部 READY（3/3）');
  }

  // ---------- B：resolver 不依赖 asset 返回顺序 ----------
  {
    const all = listAssetsForProject(P1);
    const bindings = listActiveBindingsForProject(P1);
    const forward = resolveSceneAssets(P1, s01, all, bindings);
    const reversed = resolveSceneAssets(P1, s01, [...all].reverse(), bindings);
    const shuffled = resolveSceneAssets(P1, s01, [all[2]!, all[0]!, all[1]!], bindings);
    const norm = (x: typeof forward) => JSON.stringify(x.requirements.map((q) => [q.requirementId, q.status, q.boundAssetId]));
    ok(norm(forward) === norm(reversed), '[B01] 反转 asset 顺序 → resolver 结果不变');
    ok(norm(forward) === norm(shuffled), '[B02] 随机 asset 顺序 → resolver 结果不变');
  }

  // ---------- C/G：candidate-first 与跨目标 bind 拒绝 ----------
  {
    const cand = seedAsset(generatedCandidate(P1, 'S01', {...REQ_S01_R01, requirementId: p1ReqIds[0]!}));
    // 未绑定候选：不影响 readiness，且出现在 generatedCandidates
    const before = buildProjectResolution(P1, scenes).find((x) => x.sceneId === 'S01')!;
    ok(before.ready === 2, '[G01] unbound candidate 不影响 READY 计数');
    const vC = evaluateVisualReadiness(P1, scenes);
    ok(vC.readyRequirements === 3, '[G02] unbound candidate 不计入 readiness');
    // 解绑 R01 后候选可见
    deactivateBindingForRequirement(P1, 'S01', p1ReqIds[0]!);
    const withCand = buildProjectResolution(P1, scenes).find((x) => x.sceneId === 'S01')!;
    const req01 = withCand.requirements.find((q) => q.requirementId === p1ReqIds[0])!;
    ok(req01.status === 'pending', '[G03] 解绑后 R01 回 pending');
    ok(req01.generatedCandidates.some((c) => c.assetId === cand.id), '[G04] candidate 出现在该需求的候选列表');
    ok(req01.availableActions.includes('select_candidate'), '[G05] 候选提供 select_candidate 动作');

    // candidate R01 → R02：reject
    let err1: BindError | null = null;
    try {
      bindGeneratedCandidate({projectId: P1, candidateId: cand.id, sceneId: 'S01', requirementId: p1ReqIds[1]!});
    } catch (e) { err1 = e as BindError; }
    ok(err1?.code === 'requirement_mismatch', '[C01] candidate R01 → R02 = reject', err1?.message);

    // candidate S01 → S02：reject
    let err2: BindError | null = null;
    try {
      bindGeneratedCandidate({projectId: P1, candidateId: cand.id, sceneId: 'S02', requirementId: 'S02-R01'});
    } catch (e) { err2 = e as BindError; }
    ok(err2?.code === 'scene_mismatch', '[C02] candidate S01 → S02 = reject', err2?.message);

    // 不存在的 requirement：候选 intended 校验先行 → requirement_mismatch（同为 reject）；
    // 无 intended 快照的候选 → requirement_not_found
    let err3: BindError | null = null;
    try {
      bindGeneratedCandidate({projectId: P1, candidateId: cand.id, sceneId: 'S01', requirementId: 'S01-R99'});
    } catch (e) { err3 = e as BindError; }
    ok(err3 instanceof BindError, '[C03a] 不存在的 requirementId = reject', err3?.code);
    const candNoTarget = seedAsset(generatedCandidate(P1, 'S01', {...REQ_S01_R01}));
    // 快照无 requirementId（旧格式 candidate）
    getDb().prepare('UPDATE assets SET requirement_json = ? WHERE id = ?')
      .run(JSON.stringify({kind: 'image', subject: 'x', query: 'x', usage: 'primary', policy: 'generated'}), candNoTarget.id);
    let err4: BindError | null = null;
    try {
      bindGeneratedCandidate({projectId: P1, candidateId: candNoTarget.id, sceneId: 'S01', requirementId: 'S01-R99'});
    } catch (e) { err4 = e as BindError; }
    ok(err4?.code === 'requirement_not_found', '[C03b] 无 intended 候选 + 不存在 requirement = requirement_not_found', err4?.message);

    // 正确目标：bind 成功 → R01 ready（generated binding → READY）
    const {binding} = bindGeneratedCandidate({projectId: P1, candidateId: cand.id, sceneId: 'S01', requirementId: p1ReqIds[0]!});
    ok(binding.requirement_id === p1ReqIds[0] && binding.asset_id === cand.id, '[C04] exact bind 成功');
    const after = buildProjectResolution(P1, scenes).find((x) => x.sceneId === 'S01')!;
    ok(after.requirements.find((q) => q.requirementId === p1ReqIds[0])?.status === 'ready', '[C05] bind 后 R01 READY');
    ok(getAssetById(cand.id)?.license_status === 'generated', '[C06] bind 后 license=generated（provenance 明确）');
  }

  // ---------- D：manual upload exact requirement（HTTP route 级） ----------
  {
    // 缺 requirementId → 400
    const form1 = new FormData();
    form1.append('file', new File([Buffer.from('x')], 'a.jpg', {type: 'image/jpeg'}));
    form1.append('sceneId', 'S01');
    const res1 = await uploadPOST(
      new Request('http://test/upload', {method: 'POST', body: form1}),
      {params: Promise.resolve({id: P1})},
    );
    ok(res1.status === 400, '[D01] upload 缺 requirementId = 400');

    // scene/requirement 错配（S01 + S02 的需求）→ 400
    const form2 = new FormData();
    form2.append('file', new File([Buffer.from('x')], 'a.jpg', {type: 'image/jpeg'}));
    form2.append('sceneId', 'S01');
    form2.append('requirementId', 'S02-R01');
    const res2 = await uploadPOST(
      new Request('http://test/upload', {method: 'POST', body: form2}),
      {params: Promise.resolve({id: P1})},
    );
    ok(res2.status === 400 && ((await res2.json()) as {error: string}).error === 'requirement_not_found', '[D02] upload scene/requirement 错配 = reject');

    // bind route 缺 requirementId → 400
    const resB = await bindPOST(
      new Request('http://test/bind', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({sceneId: 'S01'})}),
      {params: Promise.resolve({id: P1, candidateId: 'whatever'})},
    );
    ok(resB.status === 400, '[D03] bind 缺 requirementId = 400');
  }

  // ---------- E：Manual Replace（route 级） ----------
  {
    const readyBefore = evaluateVisualReadiness(P1, scenes).readyRequirements;
    const s02ReqId = 'S02-R01';
    const oldBinding = getActiveBinding(P1, 'S02', s02ReqId)!;
    const oldAssetId = oldBinding.asset_id;

    const form = new FormData();
    form.append('file', new File([Buffer.from('new-image-bytes')], 'new.jpg', {type: 'image/jpeg'}));
    form.append('sceneId', 'S02');
    form.append('requirementId', s02ReqId);
    const res = await uploadPOST(
      new Request('http://test/upload', {method: 'POST', body: form}),
      {params: Promise.resolve({id: P1})},
    );
    const payload = (await res.json()) as {assetId: string; replaced: boolean; previousAssetId: string | null};
    ok(res.status === 201 && payload.replaced === true && payload.previousAssetId === oldAssetId, '[E01] replace 响应：replaced + previousAssetId 正确', payload);

    const newBinding = getActiveBinding(P1, 'S02', s02ReqId)!;
    ok(newBinding.asset_id === payload.assetId && newBinding.asset_id !== oldAssetId, '[E02] 新 binding active 指向新 asset');
    const allBindings = listBindingsForProject(P1).filter((b) => b.scene_id === 'S02' && b.requirement_id === s02ReqId);
    ok(allBindings.length === 2 && allBindings.filter((b) => b.active === 1).length === 1, '[E03] 旧 binding 转历史（active=0），仅 1 个 active');
    ok(getAssetById(oldAssetId) !== undefined, '[E04] 旧 asset 行保留（provenance 不丢）');
    ok(fs.existsSync(path.join(process.cwd(), 'public', getAssetById(oldAssetId)!.local_path)), '[E05] 旧物理文件保留');

    const readyAfter = evaluateVisualReadiness(P1, scenes).readyRequirements;
    ok(readyBefore === readyAfter, '[E06] replace 后 READY 数不变');
    const s01after = buildProjectResolution(P1, scenes).find((x) => x.sceneId === 'S01')!;
    ok(s01after.ready === 2 && s01after.overallStatus === 'ready', '[E07] sibling scene 需求不受 replace 影响');
    const v3 = evaluateVisualReadiness(P1, scenes);
    ok(v3.ready, '[E08] replace 后整体仍 ready（新文件存在）');
  }

  // ============ P2：legacy migration ============
  seedProject(P2);
  const scenes2 = scenesOf(P2);
  {
    // legacy assets：scene_id 设置、无 binding
    const l1 = seedAsset(wikimediaAsset(P2, 'S01', REQ_S01_R02)); // 快照精确匹配 R02
    const l2 = seedAsset({...wikimediaAsset(P2, 'S02', REQ_S02_R01), requirement: null}); // 单需求无快照
    const l3 = seedAsset({...wikimediaAsset(P2, 'S01', REQ_S01_R01), requirement: {kind: 'image', subject: '无关图', query: 'irrelevant', usage: 'primary', policy: 'public_domain'}}); // 多需求无匹配

    const assets = [l1, l2, l3];
    const decisions = planBindingMigration(P2, compileAssetPlans(scenesArtifact()), assets, []);
    const d1 = decisions.find((d) => d.assetId === l1.id)!;
    const d2 = decisions.find((d) => d.assetId === l2.id)!;
    const d3 = decisions.find((d) => d.assetId === l3.id)!;
    ok(d1.action === 'bind_exact' && d1.requirementId === 'S01-R02', '[F01] exact 快照 → bind_exact（R02，非顺序的 R01）', d1);
    ok(d2.action === 'bind_single' && d2.requirementId === 'S02-R01', '[F02] 单需求场景 → bind_single');
    ok(d3.action === 'ambiguous_unbound' && d3.requirementId === null, '[F03] 多需求无证据 → ambiguous_unbound（禁止顺序猜测）');

    const applied = applyBindingMigration(P2, decisions);
    ok(applied === 2, '[F04] 仅写入 2 个明确绑定');

    const res = buildProjectResolution(P2, scenes2);
    const s01res = res.find((x) => x.sceneId === 'S01')!;
    ok(s01res.requirements.find((q) => q.requirementId === 'S01-R02')?.status === 'ready', '[F05] 迁移后 R02 READY');
    ok(s01res.requirements.find((q) => q.requirementId === 'S01-R01')?.status === 'pending', '[F06] R01 仍 PENDING（ambiguous 不强行 READY）');
    ok(res.find((x) => x.sceneId === 'S02')?.requirements[0]?.status === 'ready', '[F07] 单需求迁移后 READY');

    // 幂等：二次迁移 skip_already_bound
    const decisions2 = planBindingMigration(P2, compileAssetPlans(scenesArtifact()), assets, listBindingsForProject(P2));
    ok(decisions2.filter((d) => d.action === 'skip_already_bound').length === 2, '[F08] 二次迁移幂等（skip_already_bound）');
    ok(applyBindingMigration(P2, decisions2) === 0, '[F09] 二次迁移零写入');
  }

  // ---------- 收尾 ----------
  cleanupFiles(P1);
  cleanupFiles(P2);
  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m638-binding'), {recursive: true, force: true});

  console.log(`\n${pass} PASS / ${fail} FAIL / ${pass + fail} TOTAL`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();

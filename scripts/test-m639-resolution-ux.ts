/**
 * M6.3.9 Asset Resolution UX + AI Fallback Policy 测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m639-resolution-ux.ts
 *
 * 覆盖（对应验收清单）：
 *   A. 构造型 B-roll：public_domain preferred + synthetic_allowed + no_result
 *      → generate AVAILABLE 且 RECOMMENDED
 *   B. 真实历史照片（Archive → authentic_required）+ no_result
 *      → generate NOT available / NOT recommended，hint 解释需要真实素材
 *   C. generated-native → generate AVAILABLE 且 RECOMMENDED（pending + generation_failed）
 *   D. provider unhealthy → generate disabled（capability truthfulness）
 *   E. authentic_preferred + no_result → generate 次级 fallback，recommended 仍为 search
 *   F. 用户态 status mapping：no_result / download_failed / candidate_waiting / ready / pending
 *   G. resolution_state 持久化生命周期 + exact requirement 隔离
 *   H. candidate-first 不变量：未绑定 candidate 不改变 READY；readiness 不受 state 行影响
 *   I. authenticityOf 推导 + schema 零迁移兼容 + canGenerateFallback 语义
 *   J. 默认生成 prompt 质量（subject + 16:9 + 无字幕/水印）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m639-resolution-ux');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {
  bindAssetToRequirement,
  clearResolutionState,
  insertAsset,
  listResolutionStatesForProject,
  upsertResolutionState,
  type AssetRow,
} from '../src/lib/assets/model';
import {evaluateVisualReadiness} from '../src/lib/assets/readiness';
import {authenticityOf} from '../src/lib/assets/requirements';
import {buildProjectResolution, canGenerateFallback} from '../src/lib/assets/resolver';
import {defaultGeneratePrompt} from '../src/lib/assets/generate-prompt';
import {assetRequirementSchema, type AssetRequirement, type Scene} from '../src/lib/scene-schema';

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

const P_BROLL = 'test-p-broll';
const P_ARCHIVE = 'test-p-archive';
const P_GEN = 'test-p-gen';
const P_PREF = 'test-p-pref';

const REQ_BROLL: AssetRequirement = {
  kind: 'image',
  subject: '书桌台灯特写，时钟显示22:00，深夜，桌上摊开未完成的文档',
  query: 'desk lamp night clock',
  usage: 'primary',
  policy: 'public_domain',
};
const REQ_HIST: AssetRequirement = {kind: 'image', subject: '弗洛伊德肖像', query: 'Freud portrait', usage: 'primary', policy: 'public_domain'};
const REQ_GEN: AssetRequirement = {kind: 'image', subject: '潜意识概念画面', query: 'subconscious concept', usage: 'primary', policy: 'generated'};
const REQ_PREF: AssetRequirement = {...REQ_HIST, authenticity: 'authentic_preferred'};

function scene(partial: Partial<Scene> & Pick<Scene, 'id'>): Scene {
  return {
    chapter: 1,
    chapterTitle: '第一章',
    start: 0,
    end: 10,
    duration: 10,
    startFrame: 0,
    durationInFrames: 300,
    category: 'B-roll',
    visualType: 'B-roll',
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

function artifactOf(scenes: Scene[]): string {
  return JSON.stringify({chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 20}], scenes});
}

function seedProject(projectId: string, scenes: Scene[]): void {
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(projectId, `测试项目 ${projectId}`, now, now);
  getDb().prepare(
    `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, created_at)
     VALUES (?, ?, 'scenes', 1, ?, 'json', 'repair', ?)`,
  ).run(`${projectId}-scenes-v1`, projectId, artifactOf(scenes), now);
}

function scenesOf(projectId: string): Scene[] {
  const row = getDb().prepare(
    `SELECT content FROM project_versions WHERE project_id = ? AND stage = 'scenes' ORDER BY version DESC LIMIT 1`,
  ).get(projectId) as {content: string};
  return (JSON.parse(row.content) as {scenes: Scene[]}).scenes;
}

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

// ---------- main ----------

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m639-resolution-ux'), {recursive: true, force: true});
  getDb();

  // ============ I. authenticity 推导 / schema 兼容 / 语义闸门 ============
  {
    ok(authenticityOf('B-roll', REQ_BROLL) === 'synthetic_allowed', '[I01] B-roll + public_domain → synthetic_allowed');
    ok(authenticityOf('Archive', REQ_HIST) === 'authentic_required', '[I02] Archive + public_domain → authentic_required（历史 guardrail 默认）');
    ok(authenticityOf('B-roll', REQ_GEN) === 'synthetic_allowed', '[I03] policy=generated → synthetic_allowed');
    ok(authenticityOf('Archive', REQ_PREF) === 'authentic_preferred', '[I04] 显式 authenticity 优先于推导');
    const parsed = assetRequirementSchema.parse({subject: 'x', query: 'y'});
    ok(parsed.authenticity === undefined && parsed.policy === 'public_domain', '[I05] 旧 artifact 无 authenticity 零迁移兼容');
    const withAuth = assetRequirementSchema.parse({subject: 'x', query: 'y', authenticity: 'authentic_required'});
    ok(withAuth.authenticity === 'authentic_required', '[I06] schema 接受显式 authenticity');
    const g1 = canGenerateFallback('synthetic_allowed');
    const g2 = canGenerateFallback('authentic_preferred');
    const g3 = canGenerateFallback('authentic_required');
    ok(g1.eligible && !g1.secondary, '[I07] synthetic_allowed → eligible 非次级');
    ok(g2.eligible && g2.secondary, '[I08] authentic_preferred → eligible 次级');
    ok(!g3.eligible && (g3.reason ?? '').includes('真实历史素材'), '[I09] authentic_required → 禁止且解释');
  }

  // ============ J. 默认生成 prompt ============
  {
    const p = defaultGeneratePrompt(REQ_BROLL);
    ok(p.includes('书桌台灯特写') && p.includes('时钟显示22:00'), '[J01] prompt 含完整 subject 内容', p);
    ok(p.includes('16:9'), '[J02] prompt 含画幅约束');
    ok(p.includes('无字幕') && p.includes('无水印'), '[J03] prompt 含洁净度约束');
  }

  // ============ A. 构造型 B-roll + no_result → generate AVAILABLE + RECOMMENDED ============
  seedProject(P_BROLL, [scene({id: 'S001', assetRequirements: [REQ_BROLL]})]);
  const brollScenes = scenesOf(P_BROLL);
  {
    // 初始：从未尝试 → pending，推荐搜索
    const r0 = buildProjectResolution(P_BROLL, brollScenes);
    const q0 = r0[0]!.requirements[0]!;
    ok(q0.status === 'pending' && q0.friendlyStatus === '等待准备', '[A01] 未尝试 → 等待准备');
    ok(q0.recommendedAction === 'search', '[A02] pending + public_domain → 推荐搜索');
    ok(q0.availableActions.includes('generate'), '[A03] synthetic_allowed → pending 也有 generate');

    // 自动搜索失败（持久化 no_result）
    upsertResolutionState({
      projectId: P_BROLL, sceneId: 'S001', requirementId: 'S001-R01',
      status: 'no_result', reason: '未找到素材：desk lamp night clock',
      queriesTried: ['desk lamp night clock', 'desk lamp'], provider: 'wikimedia',
    });
    const r1 = buildProjectResolution(P_BROLL, brollScenes);
    const q1 = r1[0]!.requirements[0]!;
    ok(q1.status === 'no_result', '[A04] 持久化 no_result → resolver 反映');
    ok(q1.friendlyStatus === '自动搜索未找到合适素材', '[A05] 用户态文案 = 自动搜索未找到合适素材');
    ok(q1.availableActions.includes('generate'), '[A06] no_result + synthetic_allowed → generate AVAILABLE');
    ok(q1.recommendedAction === 'generate' && q1.availableActions[0] === 'generate', '[A07] generate RECOMMENDED 且排首位');
    ok(q1.availableActions.includes('search') && q1.availableActions.includes('upload'), '[A08] 其他方式含 search/upload');
    ok(q1.generateDisabledReason === null, '[A09] provider 可用 → 无 disabled 原因');
    ok(q1.statusHint.includes('公共素材库') && q1.statusHint.includes('AI 生成'), '[A10] hint 解释发生了什么 + 建议 AI 生成', q1.statusHint);
    ok(q1.failureReason === '未找到素材：desk lamp night clock', '[A11] failureReason 透传');
    ok(q1.queriesTried.length === 2, '[A12] queriesTried 来自持久化记录');
    ok(r1[0]!.overallStatus === 'no_result', '[A13] scene overall = no_result');
  }

  // ============ B. Archive（authentic_required）+ no_result → generate 不可用 ============
  seedProject(P_ARCHIVE, [scene({id: 'S101', category: 'Archive', assetRequirements: [REQ_HIST]})]);
  const archiveScenes = scenesOf(P_ARCHIVE);
  {
    upsertResolutionState({
      projectId: P_ARCHIVE, sceneId: 'S101', requirementId: 'S101-R01',
      status: 'no_result', reason: '未找到素材：Freud portrait', queriesTried: ['Freud portrait'], provider: 'wikimedia',
    });
    const r = buildProjectResolution(P_ARCHIVE, archiveScenes);
    const q = r[0]!.requirements[0]!;
    ok(q.status === 'no_result', '[B01] Archive no_result → resolver 反映');
    ok(q.authenticity === 'authentic_required', '[B02] authenticity 推导 = authentic_required');
    ok(!q.availableActions.includes('generate'), '[B03] authentic_required → generate NOT available');
    ok(q.recommendedAction === 'search', '[B04] recommended = search（禁止 AI 静默替代史料）');
    ok(!q.generateEligible && (q.generateDisabledReason ?? '').includes('真实历史素材'), '[B05] disabled 原因解释真实性要求');
    ok(q.statusHint.includes('真实历史素材'), '[B06] hint 告知用户需要真实素材', q.statusHint);
  }

  // ============ C. generated-native → generate RECOMMENDED ============
  seedProject(P_GEN, [scene({id: 'S201', assetRequirements: [REQ_GEN]})]);
  const genScenes = scenesOf(P_GEN);
  {
    const r0 = buildProjectResolution(P_GEN, genScenes);
    const q0 = r0[0]!.requirements[0]!;
    ok(q0.recommendedAction === 'generate' && q0.availableActions[0] === 'generate', '[C01] generated-native pending → generate RECOMMENDED');
    ok(!q0.availableActions.includes('search'), '[C02] policy=generated → 不提供公共库搜索');

    upsertResolutionState({
      projectId: P_GEN, sceneId: 'S201', requirementId: 'S201-R01',
      status: 'generation_failed', reason: '图像生成超时，请重试', provider: 'apiyi',
    });
    const r1 = buildProjectResolution(P_GEN, genScenes);
    const q1 = r1[0]!.requirements[0]!;
    ok(q1.status === 'generation_failed' && q1.friendlyStatus === 'AI 生成失败', '[C03] generation_failed 用户态映射');
    ok(q1.recommendedAction === 'generate', '[C04] 生成失败 → 推荐重试 generate');
  }

  // ============ D. provider unhealthy → generate disabled（capability truthfulness） ============
  {
    const r = buildProjectResolution(P_BROLL, brollScenes, {generateProviderAvailable: false});
    const q = r[0]!.requirements[0]!;
    ok(!q.availableActions.includes('generate'), '[D01] provider 不可用 → generate 从 actions 移除');
    ok(q.generateEligible && q.generateDisabledReason === 'AI 图像生成服务暂不可用', '[D02] 语义 eligible 但能力 disabled');
    ok(q.recommendedAction === 'search', '[D03] 推荐回退到 search');
  }

  // ============ E. authentic_preferred + no_result → generate 次级 ============
  seedProject(P_PREF, [scene({id: 'S301', category: 'Archive', assetRequirements: [REQ_PREF]})]);
  const prefScenes = scenesOf(P_PREF);
  {
    upsertResolutionState({
      projectId: P_PREF, sceneId: 'S301', requirementId: 'S301-R01',
      status: 'no_result', reason: '未找到素材：Freud portrait', queriesTried: ['Freud portrait'], provider: 'wikimedia',
    });
    const r = buildProjectResolution(P_PREF, prefScenes);
    const q = r[0]!.requirements[0]!;
    ok(q.availableActions.includes('generate') && q.generateSecondary, '[E01] authentic_preferred → generate 次级可用');
    ok(q.recommendedAction === 'search', '[E02] 推荐仍为 search（AI 只是标注过的替代）');
    ok(q.statusHint.includes('替代'), '[E03] hint 明确 AI 生成替代', q.statusHint);
  }

  // ============ F/G. 状态生命周期 + exact 隔离 + download_failed/ready/候选映射 ============
  {
    // download_failed 映射（复用 B-roll 项目，先改状态）
    upsertResolutionState({
      projectId: P_BROLL, sceneId: 'S001', requirementId: 'S001-R01',
      status: 'download_failed', reason: '下载文件过小，校验失败', queriesTried: ['desk lamp night clock'], provider: 'wikimedia',
    });
    const r1 = buildProjectResolution(P_BROLL, brollScenes);
    const q1 = r1[0]!.requirements[0]!;
    ok(q1.status === 'download_failed' && q1.friendlyStatus === '素材下载失败', '[F01] download_failed 用户态映射');
    ok(q1.recommendedAction === 'retry_download' && q1.availableActions[0] === 'retry_download', '[F02] 推荐重新下载');
    ok(q1.availableActions.includes('search') && q1.availableActions.includes('upload'), '[F03] 其他方式含重新搜索/上传');
    ok(listResolutionStatesForProject(P_BROLL).length === 1, '[G01] upsert 幂等（PK 冲突更新而非插重复行）');

    // clear → 回 pending
    clearResolutionState(P_BROLL, 'S001', 'S001-R01');
    const r2 = buildProjectResolution(P_BROLL, brollScenes);
    ok(r2[0]!.requirements[0]!.status === 'pending', '[G02] clear 后回到 pending');
    ok(listResolutionStatesForProject(P_BROLL).length === 0, '[G03] clear 物理清除状态行');

    // candidate-first：未绑定 candidate → candidate_waiting，READY 不变
    clearResolutionState(P_GEN, 'S201', 'S201-R01');
    const candidate = seedAsset({
      projectId: P_GEN, sceneId: 'S201', mediaType: 'image', sourceType: 'generated', sourceProvider: 'apiyi',
      sourceUrl: null, localPath: `assets/${P_GEN}/${crypto.randomUUID()}.jpg`, mimeType: 'image/jpeg',
      licenseStatus: 'generated', licenseNote: 'AI 生成 (待确认)', attribution: 'API易 / test',
      description: '潜意识概念画面', requirement: {...REQ_GEN, requirementId: 'S201-R01'},
    });
    const r3 = buildProjectResolution(P_GEN, genScenes);
    const q3 = r3[0]!.requirements[0]!;
    ok(q3.status === 'candidate_waiting' && q3.friendlyStatus === 'AI 图片已生成，等待确认', '[F04] candidate_waiting 用户态映射');
    ok(r3[0]!.ready === 0, '[H01] 未绑定 candidate → READY 不变（candidate-first 不退化）');
    ok(q3.recommendedAction === 'select_candidate' && q3.availableActions[0] === 'select_candidate', '[F05] 推荐使用这张');
    const readiness3 = evaluateVisualReadiness(P_GEN, genScenes);
    ok(readiness3.readyRequirements === 0 && readiness3.pendingAssets === 1, '[H02] readiness 仍 pending（candidate 不计入）');

    // bind candidate → ready + 状态清除语义（模拟 bind 流程的 clear）
    bindAssetToRequirement({projectId: P_GEN, sceneId: 'S201', requirementId: 'S201-R01', assetId: candidate.id});
    clearResolutionState(P_GEN, 'S201', 'S201-R01');
    const r4 = buildProjectResolution(P_GEN, genScenes);
    const q4 = r4[0]!.requirements[0]!;
    ok(q4.status === 'ready' && q4.friendlyStatus === '素材已准备', '[F06] ready 用户态映射');
    ok(q4.recommendedAction === null && q4.statusHint === '', '[F07] ready → 无推荐动作/无 hint');
    const readiness4 = evaluateVisualReadiness(P_GEN, genScenes);
    ok(readiness4.readyRequirements === 1 && readiness4.ready, '[H03] bind 后 readiness READY');

    // exact requirement 隔离：双需求 scene，R01 状态不污染 R02
    const dual = scene({id: 'S401', assetRequirements: [REQ_BROLL, {...REQ_BROLL, subject: '咖啡杯特写', query: 'coffee cup'}]});
    seedProject('test-p-dual', [dual]);
    const dualScenes = scenesOf('test-p-dual');
    upsertResolutionState({
      projectId: 'test-p-dual', sceneId: 'S401', requirementId: 'S401-R01',
      status: 'no_result', reason: '未找到素材：desk lamp', queriesTried: ['desk lamp'], provider: 'wikimedia',
    });
    const rd = buildProjectResolution('test-p-dual', dualScenes);
    const rdReqs = rd[0]!.requirements;
    ok(rdReqs.find((q) => q.requirementId === 'S401-R01')?.status === 'no_result', '[G04] R01 = no_result');
    ok(rdReqs.find((q) => q.requirementId === 'S401-R02')?.status === 'pending', '[G05] R02 仍 pending（exact 隔离）');

    // readiness 不受 state 行影响（READY 只认 binding）
    const readinessDual = evaluateVisualReadiness('test-p-dual', dualScenes);
    ok(readinessDual.needAssets === 2 && readinessDual.readyRequirements === 0, '[H04] state 行不改变 readiness 判定');
  }

  // ---------- cleanup ----------
  for (const p of [P_BROLL, P_ARCHIVE, P_GEN, P_PREF, 'test-p-dual']) cleanupFiles(p);
  closeDb();

  console.log(`\n========== M6.3.9 测试结果：${pass} PASS / ${fail} FAIL ==========`);
  if (fail > 0) process.exit(1);
}

void main();

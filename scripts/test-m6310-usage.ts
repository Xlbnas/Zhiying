/**
 * M6.3.10 Usage 计费/采集测试（零真实 API 成本）。
 *
 * 用法：npx tsx scripts/test-m6310-usage.ts
 * 使用临时数据目录（data/test-m6310-usage），结束后清理。
 *
 * 覆盖（对应验收清单 Phase 18 / L）：
 *   A. image pricing（已知 key / fail-closed / 快照）
 *   B. image usage event：succeeded/auth_failed/unknown_billing/attemptId 幂等/regeneration
 *   C. summary 聚合：image card 字段、阶段明细、total = LLM + image、image 不进 Token/GPU
 *   D. bind/reject/upload 与 cost 独立（bind 不重复计费、未绑定不丢费、upload 无 event）
 *   E. render/tts wall 幂等回填（含重复运行）
 *   F. compute event：cpu delta / gpu wall 秒 / 幂等 / 状态
 *   G. cgroup 解析（v2/v1/缺失/delta 边界）
 *   H. NVENC 配置与探测（env 解析/真实编码探测注入/缓存/fallback reason）
 *   I. fmtDuration 智能单位
 *   J. LLM usage 回归
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m6310-usage');
process.env.LLM_PROVIDER = 'mock';

import {bindGeneratedCandidate} from '../src/lib/assets/bind';
import {getActiveBinding, insertAsset} from '../src/lib/assets/model';
import {closeDb, getDb} from '../src/lib/db';
import {computeCostCny as computeLlmCostCny} from '../src/lib/llm/pricing';
import {recordLlmUsage} from '../src/lib/llm/usage';
import {probeNvencSupport, resetNvencProbeCache} from '../src/lib/render/nvenc';
import {
  loadRenderPerfConfig,
  resolveNvencBitrate,
  resolveNvencEnabled,
} from '../src/lib/render/render-config';
import type {AssetRequirement, Scene} from '../src/lib/scene-schema';
import {cpuUsageDeltaUsec, readContainerCpuUsageUsec} from '../src/lib/usage/cgroup';
import {recordJobComputeUsage, snapshotComputeStart} from '../src/lib/usage/compute';
import {fmtDuration} from '../src/lib/usage/format';
import {
  computeImageCostCny,
  IMAGE_PRICE_TABLE_VERSION,
  ImagePricingError,
} from '../src/lib/usage/image-pricing';
import {
  getProjectUsageSummary,
  hasImageUsageForAsset,
  imageGenerationErrorStatus,
  linkAssetToImageUsageEvent,
  recordImageGenerationUsage,
  recordUsageEvent,
  syncComputeWallToEvents,
} from '../src/lib/usage-events';

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

// ---------- fixture ----------

const P1 = 'test-m6310-p1';

const REQ_R01: AssetRequirement = {
  requirementId: 'S01-R01', kind: 'image', subject: '图灵肖像', query: 'Turing portrait',
  usage: 'primary', policy: 'generated',
};
const REQ_R02: AssetRequirement = {
  requirementId: 'S01-R02', kind: 'image', subject: '曼彻斯特街景', query: 'Manchester street',
  usage: 'primary', policy: 'public_domain',
};

function seedProject(projectId: string): void {
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(projectId, `测试项目 ${projectId}`, now, now);
  const artifact = JSON.stringify({
    chapterTiming: [{chapter: 1, title: '第一章', start: 0, end: 10}],
    scenes: [{
      id: 'S01', chapter: 1, chapterTitle: '第一章', start: 0, end: 10, duration: 10,
      startFrame: 0, durationInFrames: 300, category: 'Archive', visualType: 'Archive',
      template: null, sourceTemplate: null,
      assetRequirements: [REQ_R01, REQ_R02],
      narrationSummary: '摘要', description: '画面描述', notes: '', assetIds: [],
      licenseStatus: 'not-applicable', subtitlePosition: 'bottom',
      transitionIn: 'none', transitionOut: 'cut',
    } satisfies Scene],
  });
  getDb().prepare(
    `INSERT INTO project_versions (id, project_id, stage, version, content, content_type, source, created_at)
     VALUES (?, ?, 'scenes', 1, ?, 'json', 'repair', ?)`,
  ).run(`${projectId}-scenes-v1`, projectId, artifact, now);
}

function imageEventCount(projectId: string): number {
  return (getDb().prepare(
    `SELECT COUNT(*) c FROM project_usage_events WHERE project_id = ? AND kind = 'image'`,
  ).get(projectId) as {c: number}).c;
}

async function main(): Promise<void> {
  seedProject(P1);

  // ---------- A. image pricing ----------
  {
    const priced = computeImageCostCny({provider: 'apiyi', model: 'gemini-3.1-flash-image', size: '1K', imageCount: 2});
    ok(Math.abs(priced.costCny - 0.36) < 1e-9 && Math.abs(priced.unitPriceCny - 0.18) < 1e-9,
      '[A01] 1K × 2 张 = ¥0.36（单价 ¥0.18）', priced);
    let threw = false;
    try {
      computeImageCostCny({provider: 'apiyi', model: 'unknown-model', size: '1K', imageCount: 1});
    } catch (err) {
      threw = err instanceof ImagePricingError;
    }
    ok(threw, '[A02] 未知模型 fail-closed（拒绝估算）');
    let threw2 = false;
    try {
      computeImageCostCny({provider: 'apiyi', model: 'gemini-3.1-flash-image', size: '4K', imageCount: 1});
    } catch (err) {
      threw2 = err instanceof ImagePricingError;
    }
    ok(threw2, '[A03] 未知 size 档位 fail-closed');
  }

  // ---------- B. image usage event ----------
  const attempt1 = 'attempt-0001';
  {
    const r1 = recordImageGenerationUsage({
      attemptId: attempt1, projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 1, status: 'succeeded', generationId: 'gen-x',
      usageMetadata: {promptTokenCount: 12, totalTokenCount: 1300},
    });
    ok(r1.inserted && Math.abs((r1.costCny ?? 0) - 0.18) < 1e-9 && r1.costSource === 'configured_estimate',
      '[B01] 成功 attempt → event +1，cost=单价，configured_estimate', r1);
    const row = getDb().prepare(`SELECT * FROM project_usage_events WHERE id = ?`).get(attempt1) as {
      kind: string; stage: string; cost_cny: number; metadata: string;
    };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    ok(row.kind === 'image' && row.stage === 'image_generation'
      && meta.attemptId === attempt1 && meta.sceneId === 'S01' && meta.requirementId === 'S01-R01'
      && meta.imageCount === 1 && meta.requestedSize === '1K' && meta.aspectRatio === '16:9'
      && meta.status === 'succeeded' && meta.unitPriceCny === 0.18
      && meta.pricingVersion === IMAGE_PRICE_TABLE_VERSION,
      '[B02] event 字段完整（attempt/scene/requirement/张数/size/单价快照/pricingVersion）');
    ok(typeof row.metadata === 'string' && !row.metadata.includes('APIYI_API_KEY') && !row.metadata.includes('Bearer'),
      '[B03] 不记录 API key');

    // 同一 attempt 重复处理（INSERT OR IGNORE 幂等）
    const r1dup = recordImageGenerationUsage({
      attemptId: attempt1, projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 1, status: 'succeeded',
    });
    ok(!r1dup.inserted && imageEventCount(P1) === 1, '[B04] 同 attemptId 重复处理不重复记账');

    // regeneration = 新 attempt = 第二笔独立费用
    const r2 = recordImageGenerationUsage({
      attemptId: 'attempt-0002', projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 1, status: 'succeeded',
    });
    ok(r2.inserted && imageEventCount(P1) === 2, '[B05] regeneration 独立计第二笔');

    // 一次调用多张图
    const r3 = recordImageGenerationUsage({
      attemptId: 'attempt-0003', projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 2, status: 'succeeded',
    });
    ok(Math.abs((r3.costCny ?? 0) - 0.36) < 1e-9, '[B06] 一次调用 2 张 = 2 × 单价', r3.costCny);

    // auth 401/403 → cost 0
    const r4 = recordImageGenerationUsage({
      attemptId: 'attempt-0004', projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 0, status: 'auth_failed',
    });
    ok(r4.inserted && r4.costCny === 0, '[B07] auth_failed → cost 0');

    // 429/timeout/5xx → unknown_billing，cost 不计入
    const r5 = recordImageGenerationUsage({
      attemptId: 'attempt-0005', projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 0, status: 'unknown_billing',
    });
    ok(r5.inserted && r5.costCny === null, '[B08] unknown_billing → cost null（不计入）');

    ok(imageGenerationErrorStatus('auth_failed') === 'auth_failed'
      && imageGenerationErrorStatus('not_configured') === null
      && imageGenerationErrorStatus('rate_limited') === 'unknown_billing'
      && imageGenerationErrorStatus('timeout') === 'unknown_billing'
      && imageGenerationErrorStatus('unavailable') === 'unknown_billing'
      && imageGenerationErrorStatus('empty_result') === 'unknown_billing',
      '[B09] provider 错误 code → usage 状态映射');
  }

  // ---------- C. summary 聚合 ----------
  {
    // LLM 费用：deepseek-v4-flash，100 万 miss 输入（=¥1）+ 0 输出 → ¥1.00
    const llmUsage = {promptTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000, completionTokens: 0};
    recordLlmUsage(getDb(), {
      projectId: P1, stage: 'research', jobId: 'job-llm-1', requestId: 'req-1',
      provider: 'deepseek', model: 'deepseek-v4-flash', usage: llmUsage, promptVersion: 'test-v1',
    });
    const expectedLlm = computeLlmCostCny('deepseek-v4-flash', llmUsage).costCny;

    const s = getProjectUsageSummary(P1);
    // image: succeeded ×3（1+1+2 张 = ¥0.72），unknown 1，auth 1
    ok(s.image.calls === 3 && s.image.images === 4 && Math.abs(s.image.costCny - 0.72) < 1e-4,
      '[C01] AI 图片卡：calls/images/cost 正确', s.image);
    ok(s.image.unknownBilling === 1 && s.image.authFailed === 1,
      '[C02] unknown_billing/auth_failed 单列且不进 cost');
    ok(s.image.providers.includes('apiyi') && s.image.models.includes('gemini-3.1-flash-image'),
      '[C03] 技术详情 provider/model');
    const expectedTotal = Math.round((expectedLlm + 0.72) * 10000) / 10000;
    ok(s.totalCostCny === expectedTotal,
      '[C04] totalCost = LLM + image（¥1.00 + ¥0.72）', {total: s.totalCostCny, expectedTotal});
    const imgStage = s.byStage.find((x) => x.stage === 'image_generation');
    ok(!!imgStage && Math.abs(imgStage.costCny - 0.72) < 1e-4 && imgStage.tokens === 0,
      '[C05] 阶段明细出现图像生成（费用 ¥0.72，Token=0 不伪装）', imgStage);
    ok(s.totalTokens === 1_000_000 && s.totalGpuHours === 0,
      '[C06] image 不计入 Token / 本地 GPU');
  }

  // ---------- D. bind / reject / upload 与 cost 独立 ----------
  {
    const before = getProjectUsageSummary(P1);
    // candidate（未绑定）：asset 行 + 已记 usage
    const cand = insertAsset({
      projectId: P1, sceneId: 'S01', mediaType: 'image', sourceType: 'generated',
      sourceProvider: 'apiyi', sourceUrl: null, localPath: 'assets/x/cand.jpg',
      mimeType: 'image/jpeg', width: null, height: null,
      licenseStatus: 'generated', licenseNote: 'AI 生成 · gemini-3.1-flash-image (待确认)',
      attribution: 'API易 / gemini-3.1-flash-image', description: 'test',
      requirement: REQ_R01,
    });
    recordImageGenerationUsage({
      attemptId: 'attempt-cand', projectId: P1, sceneId: 'S01', requirementId: 'S01-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 1, status: 'succeeded', assetId: cand.id,
    });
    const mid = getProjectUsageSummary(P1);
    ok(Math.abs(mid.image.costCny - (before.image.costCny + 0.18)) < 1e-4
      && getActiveBinding(P1, 'S01', 'S01-R01') === undefined,
      '[D01] candidate 未绑定：费用已计入，READY 不变');
    // bind → READY +1，费用零变化，event 数零变化
    const eventsBefore = imageEventCount(P1);
    bindGeneratedCandidate({projectId: P1, candidateId: cand.id, sceneId: 'S01', requirementId: 'S01-R01'});
    const after = getProjectUsageSummary(P1);
    ok(!!getActiveBinding(P1, 'S01', 'S01-R01'), '[D02] bind 成功（READY +1）');
    ok(after.image.costCny === mid.image.costCny && after.totalCostCny === mid.totalCostCny
      && imageEventCount(P1) === eventsBefore,
      '[D03] bind 不重复计费（cost/event 零变化）');
    // upload（manual upload 通道只写 asset，不经 image generation）
    insertAsset({
      projectId: P1, sceneId: 'S01', mediaType: 'image', sourceType: 'upload',
      sourceProvider: 'manual', sourceUrl: null, localPath: 'assets/x/up.jpg',
      mimeType: 'image/jpeg', width: null, height: null,
      licenseStatus: 'usable', licenseNote: null, attribution: null, description: 'upload',
      requirement: REQ_R02,
    });
    insertAsset({
      projectId: P1, sceneId: 'S01', mediaType: 'image', sourceType: 'archive',
      sourceProvider: 'wikimedia', sourceUrl: 'https://example.org/x.jpg', localPath: 'assets/x/wm.jpg',
      mimeType: 'image/jpeg', width: null, height: null,
      licenseStatus: 'usable', licenseNote: null, attribution: 'Wikimedia', description: 'wm',
      requirement: REQ_R02,
    });
    ok(imageEventCount(P1) === eventsBefore,
      '[D04] Wikimedia / manual upload 不产生 image_generation event / 费用');
  }

  // ---------- E. render / tts wall 幂等回填 ----------
  {
    const now = Date.now();
    const iso = (t: number): string => new Date(t).toISOString();
    // render job：10 分钟
    getDb().prepare(
      `INSERT INTO render_jobs (id, project_id, kind, status, payload_json, progress,
        queued_at, started_at, finished_at, claimed_by, claimed_at, heartbeat_at, attempt, max_attempts)
       VALUES ('rj-1', ?, 'fullcut', 'succeeded', '{}', 100, ?, ?, ?, 'w', ?, ?, 1, 2)`,
    ).run(P1, iso(now - 3_000_000), iso(now - 3_000_000), iso(now - 2_400_000), iso(now - 3_000_000), iso(now - 2_400_000));
    // tts job：30 秒
    getDb().prepare(
      `INSERT INTO tts_jobs (id, project_id, narration_plan_artifact_id, narration_plan_version,
        unit_id, provider, voice_profile_id, voice_profile_revision, status, payload_json,
        queued_at, started_at, finished_at, attempt, max_attempts)
       VALUES ('tj-1', ?, 'np-1', 1, 'u1', 'mock', 'v', 1, 'succeeded', '{}', ?, ?, ?, 1, 2)`,
    ).run(P1, iso(now - 60_000), iso(now - 60_000), iso(now - 30_000));

    const n1 = syncComputeWallToEvents(P1);
    const s1 = getProjectUsageSummary(P1);
    const expectedWallH = (600_000 + 30_000) / 3_600_000;
    ok(n1 === 2 && Math.abs(s1.totalWallHours - expectedWallH) < 1e-6,
      '[E01] wall 回填：render 10 分钟 + tts 30 秒 → 总耗时 10.5 分钟', {n1, wall: s1.totalWallHours});
    const n2 = syncComputeWallToEvents(P1);
    ok(n2 === 0, '[E02] wall 回填幂等（重复运行零新增）');
    const renderStage = s1.byStage.find((x) => x.stage === 'render');
    const ttsStage = s1.byStage.find((x) => x.stage === 'tts');
    ok(!!renderStage && renderStage.wallHours > 0 && !!ttsStage && ttsStage.wallHours > 0,
      '[E03] 阶段明细 render/tts 耗时正确');
    const ids = getDb().prepare(
      `SELECT id FROM project_usage_events WHERE project_id = ? AND wall_ms IS NOT NULL ORDER BY id`,
    ).all(P1) as Array<{id: string}>;
    ok(ids.some((r) => r.id === 'render-wall-rj-1') && ids.some((r) => r.id === 'tts-wall-tj-1'),
      '[E04] wall event 确定性 id（render-wall-/tts-wall-）');
  }

  // ---------- F. compute event ----------
  {
    recordJobComputeUsage({
      kind: 'render', jobId: 'rj-1', projectId: P1, attempt: 1,
      snapshot: {cpuStartUsec: 1_000_000, wallStartMs: Date.now() - 5000},
      status: 'succeeded', gpuAccelerated: true,
      metadata: {encoder: 'h264_nvenc'},
      readCpu: () => 1_000_000 + 3_600_000, // +3.6s CPU
    });
    const ev = getDb().prepare(`SELECT * FROM project_usage_events WHERE id = 'render-cpu-rj-1-a1'`).get() as {
      cpu_usec: number; gpu_sec: number; wall_ms: number | null; metadata: string;
    };
    ok(ev.cpu_usec === 3_600_000 && ev.gpu_sec > 0 && ev.wall_ms === null,
      '[F01] compute event：cpu delta + gpu wall 秒 + wallMs 留空（两流分离）', {
        cpu: ev.cpu_usec, gpu: ev.gpu_sec, wall: ev.wall_ms,
      });
    const meta = JSON.parse(ev.metadata) as Record<string, unknown>;
    ok(meta.encoder === 'h264_nvenc' && meta.status === 'succeeded' && meta.attempt === 1,
      '[F02] compute event metadata（encoder/status/attempt）');
    // 幂等：同 attempt 重记不双写
    recordJobComputeUsage({
      kind: 'render', jobId: 'rj-1', projectId: P1, attempt: 1,
      snapshot: snapshotComputeStart(), status: 'succeeded', gpuAccelerated: true,
      readCpu: () => null,
    });
    const c = (getDb().prepare(
      `SELECT COUNT(*) c FROM project_usage_events WHERE id = 'render-cpu-rj-1-a1'`,
    ).get() as {c: number}).c;
    ok(c === 1, '[F03] compute event attempt 幂等');
    // CPU-only（libx264 回退）：gpu_sec null
    recordJobComputeUsage({
      kind: 'render', jobId: 'rj-2', projectId: P1, attempt: 1,
      snapshot: {cpuStartUsec: 0, wallStartMs: Date.now() - 1000},
      status: 'failed', metadata: {encoder: 'libx264', fallbackReason: 'probe_failed'},
      readCpu: () => 500_000,
    });
    const ev2 = getDb().prepare(`SELECT * FROM project_usage_events WHERE id = 'render-cpu-rj-2-a1'`).get() as {
      cpu_usec: number; gpu_sec: number | null; metadata: string;
    };
    const meta2 = JSON.parse(ev2.metadata) as Record<string, unknown>;
    ok(ev2.cpu_usec === 500_000 && ev2.gpu_sec === null
      && meta2.encoder === 'libx264' && meta2.fallbackReason === 'probe_failed',
      '[F04] CPU fallback：gpu=0 且 encoder/fallbackReason 落 metadata');
    const s = getProjectUsageSummary(P1);
    ok(s.cpuEvents >= 2 && s.gpuEvents === 1 && s.totalGpuHours > 0,
      '[F05] summary cpu/gpu events 计数正确', {cpu: s.cpuEvents, gpu: s.gpuEvents});
  }

  // ---------- G. cgroup 解析 ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-test-'));
    const v2 = path.join(dir, 'cpu.stat');
    const v1 = path.join(dir, 'cpuacct.usage');
    fs.writeFileSync(v2, 'usage_usec 12345678\nuser_usec 10000000\nsystem_usec 2345678\n');
    ok(readContainerCpuUsageUsec({v2Path: v2, v1Path: path.join(dir, 'missing')}) === 12345678,
      '[G01] cgroup v2 cpu.stat usage_usec 解析');
    fs.rmSync(v2);
    fs.writeFileSync(v1, '12345678000\n');
    ok(readContainerCpuUsageUsec({v2Path: v2, v1Path: v1}) === 12345678,
      '[G02] cgroup v1 cpuacct.usage（ns→µs）');
    ok(readContainerCpuUsageUsec({v2Path: path.join(dir, 'none'), v1Path: path.join(dir, 'none2')}) === null,
      '[G03] 不可读 → null（不伪造）');
    ok(cpuUsageDeltaUsec(100, 460) === 360 && cpuUsageDeltaUsec(null, 1) === null
      && cpuUsageDeltaUsec(5, 4) === null,
      '[G04] delta 计算与边界');
    fs.rmSync(dir, {recursive: true, force: true});
  }

  // ---------- H. NVENC ----------
  {
    ok(resolveNvencEnabled('true') === true && resolveNvencEnabled('false') === false
      && resolveNvencEnabled(undefined) === false && resolveNvencEnabled('1') === false,
      '[H01] REMOTION_NVENC 解析（仅严格 true 开启）');
    ok(resolveNvencBitrate(undefined) === '8M' && resolveNvencBitrate('12M') === '12M'
      && resolveNvencBitrate('  ') === '8M',
      '[H02] REMOTION_NVENC_BITRATE 默认 8M / 可覆盖');
    resetNvencProbeCache();
    const okProbe = await probeNvencSupport((cb) => cb(null));
    ok(okProbe.ok === true && okProbe.encoder === 'h264_nvenc', '[H03] 探测成功 → h264_nvenc');
    // 缓存：失败注入不再生效（已缓存成功）
    const cachedProbe = await probeNvencSupport((cb) => cb(new Error('boom')));
    ok(cachedProbe.ok === true, '[H04] 探测结果进程内缓存');
    resetNvencProbeCache();
    const failProbe = await probeNvencSupport((cb) => cb(new Error('Cannot load libnvidia-encode.so.1')));
    ok(failProbe.ok === false && (failProbe.reason ?? '').includes('libnvidia-encode'),
      '[H05] 探测失败 → reason 供 fallback 记录（绝不静默）', failProbe);
    resetNvencProbeCache();
    process.env.REMOTION_NVENC = 'true';
    const cfg = loadRenderPerfConfig();
    ok(cfg.nvencEnabled === true && cfg.nvencBitrate === '8M', '[H06] RenderPerfConfig 含 NVENC 字段');
    delete process.env.REMOTION_NVENC;
  }

  // ---------- I. fmtDuration ----------
  {
    ok(fmtDuration(0) === '0 秒', '[I01] 0 → "0 秒"');
    ok(fmtDuration(30 / 3600) === '30 秒', '[I02] 30 秒真实用量不显示 0.00h');
    ok(fmtDuration((6.4 * 60) / 3600) === '6.4 分钟', '[I03] 6.4 分钟');
    ok(fmtDuration(1.234) === '1.23 小时', '[I04] 1.23 小时');
    ok(fmtDuration(0.5) === '30.0 分钟', '[I05] 0.5h → 30.0 分钟');
  }

  // ---------- J. LLM usage 回归 ----------
  {
    const s = getProjectUsageSummary(P1);
    ok(s.llmEvents === 1 && s.totalInputTokens === 1_000_000,
      '[J01] LLM usage 同步回归（events/tokens）');
    const researchStage = s.byStage.find((x) => x.stage === 'research');
    ok(!!researchStage && researchStage.costCny > 0, '[J02] LLM 阶段明细回归');
    // 空项目 summary 不炸
    seedProject('test-m6310-empty');
    const empty = getProjectUsageSummary('test-m6310-empty');
    ok(empty.totalCostCny === 0 && empty.image.calls === 0 && empty.totalWallHours === 0,
      '[J03] 空项目 summary 全零');
  }

  // ---------- K. usage↔asset 链接与 backfill 去重 ----------
  {
    // 实时 event 未带 assetId（旧 route 行为）→ 时间窗兜底去重
    recordImageGenerationUsage({
      attemptId: 'attempt-link-1', projectId: P1, sceneId: 'S09', requirementId: 'S09-R01',
      provider: 'apiyi', model: 'gemini-3.1-flash-image', requestedSize: '1K', aspectRatio: '16:9',
      imageCount: 1, status: 'succeeded',
    });
    ok(hasImageUsageForAsset({
      id: 'asset-x1', projectId: P1, sceneId: 'S09', createdAt: new Date().toISOString(),
    }) === true, '[K01] 同 scene 时间窗内实时 event → backfill 跳过（防双记）');
    ok(hasImageUsageForAsset({
      id: 'asset-x2', projectId: P1, sceneId: 'S99', createdAt: new Date().toISOString(),
    }) === false, '[K02] 不同 scene → 不去重');
    ok(hasImageUsageForAsset({
      id: 'asset-x3', projectId: P1, sceneId: 'S09', createdAt: '2020-01-01T00:00:00.000Z',
    }) === false, '[K03] 时间窗外 → 不去重（历史 asset 各自独立）');
    // 回补 assetId → 精确链接
    linkAssetToImageUsageEvent('attempt-link-1', 'asset-x1');
    const row = getDb().prepare(`SELECT metadata FROM project_usage_events WHERE id = 'attempt-link-1'`).get() as {metadata: string};
    ok((JSON.parse(row.metadata) as {assetId?: string}).assetId === 'asset-x1',
      '[K04] linkAssetToImageUsageEvent 回补 metadata.assetId');
    ok(hasImageUsageForAsset({
      id: 'asset-x1', projectId: P1, sceneId: 'S09', createdAt: '2020-01-01T00:00:00.000Z',
    }) === true, '[K05] assetId 精确链接（跨时间窗也去重）');
  }

  // ---------- 汇总 ----------
  console.log(`\n${pass} PASS, ${fail} FAIL`);
  closeDb();
  fs.rmSync(path.join('data', 'test-m6310-usage'), {recursive: true, force: true});
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

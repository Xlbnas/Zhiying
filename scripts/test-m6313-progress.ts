/**
 * M6.3.13 渲染进度单一数据源 + ETA 估算器测试（纯函数，零 DB / 零真实 API）。
 * 用法：npx tsx scripts/test-m6313-progress.ts
 */

import {createEtaEstimator} from '../src/lib/render/eta';
import {
  buildStageDetail,
  detailFromRemotionProgress,
  RENDER_STAGE_LABELS,
  summarizeRenderProgress,
} from '../src/lib/render/progress-detail';

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

function main(): void {
  // ---------- 1. percent 单一数据源 ----------
  {
    const d = detailFromRemotionProgress(
      {renderedFrames: 900, encodedFrames: 856, stitchStage: 'encoding', renderEstimatedTime: 60000, progress: 0.06},
      18013,
    );
    // 856/18013 = 4.752% → 4.8（一位小数）；job.progress=6 是 Remotion 加权值，不再使用
    ok(d.percent === 4.8, '[E01] encoding percent = encodedFrames/totalFrames 一位小数', d.percent);
    ok(d.label.includes('编码视频 856/18013 帧'), '[E02] label 帧数口径保持 encodedFrames', d.label);
  }
  {
    const d = detailFromRemotionProgress(
      {renderedFrames: 18013, encodedFrames: 18013, stitchStage: 'muxing', renderEstimatedTime: null, progress: 0.99},
      18013,
    );
    ok(d.stage === 'mux' && d.percent === 100, '[E03] muxing percent = 100', d.percent);
  }
  ok(
    summarizeRenderProgress(
      6,
      JSON.stringify({stage: 'encode', label: '编码视频 856/18013 帧', percent: 4.8, updatedAt: 'x'}),
    ) === '编码视频 856/18013 帧（4.8%）',
    '[E04] summarize 与 detail.percent 同源（不用加权 progress）',
  );
  ok(RENDER_STAGE_LABELS.finalize === '响度归一化', '[E05] finalize 阶段中文标签');
  ok(
    buildStageDetail('finalize', {percent: 100}).label === '响度归一化',
    '[E06] loudnorm 心跳 detail 标签',
  );

  // ---------- 2. ETA 估算器 ----------
  // 首样本 null（无先验时仅作基线）
  {
    const est = createEtaEstimator();
    ok(
      est.add({frames: 100, totalFrames: 1000, atMs: 0, stage: 'encode'}) === null,
      '[E07] 首样本不可估算（样本不足）',
    );
  }
  // 正常采样序列 → fps / remainingSec / finishAt
  {
    const est = createEtaEstimator();
    est.add({frames: 100, totalFrames: 1100, atMs: 0, stage: 'encode'});
    const e = est.add({frames: 200, totalFrames: 1100, atMs: 10_000, stage: 'encode'});
    // instantFps = 100帧/10s = 10 fps；剩余 900 帧 → 90s → finishAt = 10s + 90s
    ok(e !== null && e.fps === 10, '[E08] 正常采样得出 fps', e);
    ok(e !== null && e.remainingSec === 90, '[E09] remainingSec = 剩余帧/fps', e);
    ok(e !== null && e.finishAt === 100_000, '[E10] finishAt = atMs + remainingSec', e);
  }
  // fps<=0（停滞样本）→ 丢弃，不污染 EMA
  {
    const est = createEtaEstimator();
    est.add({frames: 100, totalFrames: 1100, atMs: 0, stage: 'encode'});
    const good = est.add({frames: 200, totalFrames: 1100, atMs: 10_000, stage: 'encode'});
    const stalled = est.add({frames: 200, totalFrames: 1100, atMs: 12_000, stage: 'encode'});
    ok(stalled === null, '[E11] fps<=0（deltaFrames=0）样本被丢弃', stalled);
    const after = est.add({frames: 300, totalFrames: 1100, atMs: 22_000, stage: 'encode'});
    // 丢弃不停滞基线：instant = 100/(22-10)s ≈ 8.33 < 10，EMA 下移但仍为正
    ok(after !== null && good !== null && after.fps < good.fps && after.fps > 0, '[E12] 丢弃后 EMA 仍有效', after);
  }
  // deltaFrames<0（阶段切换/计数重置）→ 丢弃并重建基线
  {
    const est = createEtaEstimator();
    est.add({frames: 500, totalFrames: 1000, atMs: 0, stage: 'render'});
    est.add({frames: 600, totalFrames: 1000, atMs: 10_000, stage: 'render'});
    const reset = est.add({frames: 10, totalFrames: 1000, atMs: 12_000, stage: 'encode'});
    ok(reset === null, '[E13] deltaFrames<0（重置）样本被丢弃', reset);
    const recovered = est.add({frames: 110, totalFrames: 1000, atMs: 22_000, stage: 'encode'});
    ok(recovered !== null && recovered.fps > 0, '[E14] 重置后以新基线恢复估算', recovered);
  }
  // 非 encode/render stage → null
  {
    const est = createEtaEstimator();
    est.add({frames: 100, totalFrames: 1000, atMs: 0, stage: 'encode'});
    ok(
      est.add({frames: 200, totalFrames: 1000, atMs: 10_000, stage: 'mux'}) === null,
      '[E15] mux 阶段不可估算',
    );
    ok(
      est.add({frames: 200, totalFrames: 1000, atMs: 12_000, stage: 'finalize'}) === null,
      '[E16] finalize 阶段不可估算',
    );
  }
  // EMA 收敛方向：提速样本 → 估值 fps 上移，且介于旧值与新 instant 之间（alpha=0.25）
  {
    const est = createEtaEstimator();
    est.add({frames: 0, totalFrames: 10_000, atMs: 0, stage: 'encode'});
    const e1 = est.add({frames: 100, totalFrames: 10_000, atMs: 10_000, stage: 'encode'}); // instant 10 → EMA 10
    const e2 = est.add({frames: 300, totalFrames: 10_000, atMs: 20_000, stage: 'encode'}); // instant 20 → EMA 12.5
    ok(e1 !== null && e1.fps === 10, '[E17] 匀速采样 EMA = instant', e1);
    ok(
      e2 !== null && e2.fps > e1!.fps && e2.fps < 20 && Math.abs(e2.fps - 12.5) < 1e-9,
      '[E18] EMA 朝新速率收敛（alpha=0.25）',
      e2,
    );
  }
  // bootstrap：服务端 fps 先验 → 首样本即可估值（F5 刷新场景）
  {
    const est = createEtaEstimator({fps: 8});
    const e = est.add({frames: 200, totalFrames: 1000, atMs: 5_000, stage: 'encode'});
    ok(
      e !== null && e.fps === 8 && e.remainingSec === 100,
      '[E19] fps 先验使首样本即可估值',
      e,
    );
    const e2 = est.add({frames: 400, totalFrames: 1000, atMs: 15_000, stage: 'encode'});
    // instant = 200/10s = 20 → EMA = 0.25*20 + 0.75*8 = 11，客户端采样接管
    ok(e2 !== null && Math.abs(e2.fps - 11) < 1e-9, '[E20] 先验随后被客户端 EMA 接管', e2);
  }
  // 非法先验视为无先验
  {
    const est = createEtaEstimator({fps: 0});
    ok(
      est.add({frames: 100, totalFrames: 1000, atMs: 0, stage: 'encode'}) === null,
      '[E21] fps<=0 的先验被忽略',
    );
  }

  console.log(`\nM6.3.13 progress: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();

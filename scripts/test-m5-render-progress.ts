/**
 * M5 渲染步骤进度 + Jobs 项目分组测试（零真实 API）。
 * 用法：npx tsx scripts/test-m5-render-progress.ts
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m5-render-progress');
process.env.LLM_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {heartbeat} from '../src/lib/jobs';
import {
  buildStageDetail,
  detailFromRemotionProgress,
  parseRenderProgressDetail,
  summarizeRenderProgress,
} from '../src/lib/render/progress-detail';
import {groupJobsByProject, type LlmJobItem, type RenderJobItem, type TtsJobItem} from '../src/components/jobs/grouping';

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
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m5-render-progress'), {recursive: true, force: true});
  const db = getDb();

  // ---------- 1. Remotion progress → 阶段明细 ----------
  {
    const d = detailFromRemotionProgress(
      {renderedFrames: 1234, encodedFrames: 0, stitchStage: 'encoding', renderEstimatedTime: 60000, progress: 0.5},
      18013,
    );
    ok(d.stage === 'encode' && d.label.includes('编码视频 0/18013 帧'), '[P01] encoding 阶段 = 编码视频帧计数', d.label);
  }
  {
    const d = detailFromRemotionProgress(
      {renderedFrames: 1234, encodedFrames: 800, stitchStage: 'muxing', renderEstimatedTime: 5000, progress: 0.99},
      18013,
    );
    ok(d.stage === 'mux' && d.label === '封装视频文件', '[P02] muxing 阶段 = 封装');
  }
  {
    const d = detailFromRemotionProgress(
      {renderedFrames: 1234, encodedFrames: 0, stitchStage: 'encoding', renderEstimatedTime: null, progress: 0.07},
      18013,
    );
    // stitchStage=encoding 但 encodedFrames=0 且 renderedFrames<total 时仍属编码起步阶段（Remotion 契约：先 render 后 encode 由 stitchStage 区分）
    ok(d.stage === 'encode', '[P03] stitchStage 决定阶段归属');
  }
  ok(buildStageDetail('bundle').label.includes('打包渲染环境'), '[P04] bundle 阶段中文标签');
  ok(buildStageDetail('prepare').stage === 'prepare', '[P05] buildStageDetail 结构');

  // ---------- 2. parse / summarize ----------
  ok(parseRenderProgressDetail('not json') === null, '[P06] 损坏 JSON → null');
  ok(parseRenderProgressDetail(null) === null, '[P07] null → null');
  ok(
    summarizeRenderProgress(12.3, JSON.stringify({stage: 'render', label: '渲染画面 1234/18013 帧', updatedAt: 'x'})) ===
      '渲染画面 1234/18013 帧（12.3%）',
    '[P08] summarize 带步骤明细',
  );
  ok(summarizeRenderProgress(12.3, null) === '12.3%', '[P09] summarize 无明细回退百分比');

  // ---------- 3. heartbeat 带明细落库 ----------
  {
    db.prepare(
      "INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id, current_stage, created_at, updated_at) VALUES ('p1', '进度测试', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', datetime('now'), datetime('now'))",
    ).run();
    db.prepare(
      "INSERT INTO render_jobs (id, project_id, kind, status, progress, payload_json, queued_at) VALUES ('j1', 'p1', 'fullcut', 'running', 0, '{}', datetime('now'))",
    ).run();
    const detail = JSON.stringify(buildStageDetail('render', {label: '渲染画面 10/100 帧'}));
    heartbeat('j1', 10, detail);
    const row = db.prepare('SELECT progress, progress_detail FROM render_jobs WHERE id = ?').get('j1') as {progress: number; progress_detail: string | null};
    ok(row.progress === 10 && parseRenderProgressDetail(row.progress_detail)?.label === '渲染画面 10/100 帧', '[P10] heartbeat 步骤明细落库并可读回');
    // 无明细的 heartbeat 不清空已有明细（COALESCE）
    heartbeat('j1', 11);
    const row2 = db.prepare('SELECT progress_detail FROM render_jobs WHERE id = ?').get('j1') as {progress_detail: string | null};
    ok(row2.progress_detail !== null, '[P11] 无明细心跳不清空已有明细');
  }

  // ---------- 4. 项目分组 ----------
  {
    const llm = (id: string, projectId: string, status: string, queuedAt: string): LlmJobItem => ({
      id, projectId, stage: 'research', status, attempt: 1, maxAttempts: 2,
      queuedAt, startedAt: null, finishedAt: null, errorCode: null, errorMessage: null, provider: null, model: null,
    });
    const tts = (id: string, projectId: string, status: string, queuedAt: string): TtsJobItem => ({
      id, projectId, unitId: 'u1', provider: 'indextts2', voice: 'default@1', status, attempt: 1, maxAttempts: 2,
      durationMs: null, queuedAt, finishedAt: null, errorCode: null, errorMessage: null,
    });
    const render = (id: string, projectId: string, status: string, progress: number, detail: string | null, queuedAt: string): RenderJobItem => ({
      id, projectId, kind: 'fullcut', status, progress, progressDetail: detail,
      queuedAt, startedAt: null, finishedAt: null, errorMessage: null,
    });

    const groups = groupJobsByProject({
      llmJobs: [llm('l1', 'pa', 'succeeded', '2026-01-01'), llm('l2', 'pb', 'running', '2026-01-03')],
      ttsJobs: [tts('t1', 'pa', 'succeeded', '2026-01-02')],
      renderJobs: [
        render('r1', 'pa', 'succeeded', 100, null, '2026-01-04'),
        render('r2', 'pc', 'running', 12, JSON.stringify({stage: 'render', label: '渲染画面 100/800 帧', updatedAt: 'x'}), '2026-01-01'),
      ],
      projects: [
        {id: 'pa', title: '项目A'},
        {id: 'pb', title: '项目B'},
        {id: 'pc', title: '项目C'},
      ],
      summarizeRender: (job) => summarizeRenderProgress(job.progress, job.progressDetail),
    });

    ok(groups.length === 3, '[G01] 三个项目 = 三个组');
    const first = groups[0]!;
    ok(first.projectId === 'pb', '[G02] 活跃组优先，最近活跃者排最前', groups.map((g) => g.projectId));
    const gc = groups.find((g) => g.projectId === 'pc')!;
    ok(gc.activeSummary === '渲染：渲染画面 100/800 帧（12%）', '[G03] 组头展示步骤级进度摘要', gc.activeSummary);
    const ga = groups.find((g) => g.projectId === 'pa')!;
    ok(
      ga.llmJobs.length === 1 && ga.ttsJobs.length === 1 && ga.renderJobs.length === 1,
      '[G04] 三类任务归入同一项目组',
    );
    ok(first.activeSummary === '生成任务进行中', '[G05] 无渲染摘要时回退生成任务说明');
    ok(ga.activeSummary === null && ga.activeCount === 0, '[G06] 全部完成的组无活跃摘要');
  }

  closeDb();
  console.log(`\nM5 render-progress: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();

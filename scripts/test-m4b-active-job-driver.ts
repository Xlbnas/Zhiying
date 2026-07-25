/**
 * M4-B active-job shutdown 驱动脚本（在 driver 容器内运行，与 worker 容器
 * 共享同一 data volume；本身不启动 worker）。
 *
 * 流程（Mock LLM/TTS，直接 lib 调用）：6 stages → Narration → Master →
 * Subtitle → 4 stages → Reconciliation → enqueueFinalRender，随后轮询
 * render job 状态并打印进度标记，供宿主测试编排 docker stop：
 *
 *   RENDER_ENQUEUED <jobId>
 *   RENDER_RUNNING <jobId>     ← 宿主此时 docker stop --time 60 worker
 *   RENDER_SUCCEEDED <jobId>   ← worker 重启后任务被重新处理（requeue 恢复）
 *
 * 非预期终态（failed/cancelled）→ 打印并以非零退出。
 */

import {execFileSync} from 'node:child_process';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = process.env.ZHIYING_DATA_DIR ?? '/app/data';
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {enqueueFinalRender} from '../src/lib/final-render/bridge';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {
  enqueueNarrationAudioJobs,
  getNarrationAudioOverview,
  tryFinalizeNarrationAudio,
} from '../src/lib/narration/audio';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {buildTimingReconciliation} from '../src/lib/reconciliation/timing';
import {buildSubtitleTiming} from '../src/lib/subtitles/timing';
import {getDb} from '../src/lib/db';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES} from '../src/lib/workflow/types';

const SCRIPT_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–00:30）

你注意到没有。（停顿 1s）有些话听起来很简单。其实藏着别的意思。
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(2000);
  }
  throw new Error(`wait 超时: ${label}`);
}

async function main(): Promise<void> {
  const pid = createProjectWithWorkflow({topic: 'M4B shutdown 测试', coreQuestion: '优雅退出会 requeue 吗？'}).project.id;
  for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
    const job = enqueueWorkflowStageJob(pid, stage);
    await waitFor(`llm ${stage}`, () => getLlmJob(job.id)?.status === 'succeeded', 180_000);
    lockStage(pid, stage);
  }
  editVersion({
    projectId: pid, stage: 'script_v2',
    content: SCRIPT_V2, contentType: 'markdown', source: 'manual_edit',
  }, {confirmStale: true});
  lockStage(pid, 'script_v2');

  buildNarrationPlan(pid);
  enqueueNarrationAudioJobs(pid);
  await waitFor('tts jobs', () => {
    const ov = getNarrationAudioOverview(pid);
    return ov.speechTotal > 0 && ov.speechComplete === ov.speechTotal;
  }, 300_000);
  if (!tryFinalizeNarrationAudio(pid)) throw new Error('master finalize 失败');

  buildSubtitleTiming(pid);
  for (const stage of WORKFLOW_STAGES.slice(6)) {
    const job = enqueueWorkflowStageJob(pid, stage);
    await waitFor(`llm ${stage}`, () => getLlmJob(job.id)?.status === 'succeeded', 180_000);
    lockStage(pid, stage);
  }
  buildTimingReconciliation(pid);

  const {job: renderJob} = enqueueFinalRender(pid);
  console.log(`RENDER_ENQUEUED ${renderJob.id}`);

  const statusOf = (): string => {
    const row = getDb().prepare('SELECT status FROM render_jobs WHERE id = ?').get(renderJob.id) as
      {status: string} | undefined;
    return row?.status ?? 'missing';
  };

  await waitFor('render running', () => {
    if (statusOf() === 'running') {
      console.log(`RENDER_RUNNING ${renderJob.id}`);
      return true;
    }
    return false;
  }, 600_000);

  // worker 将被宿主 docker stop → job requeue → worker 重启后重新处理
  await waitFor('render succeeded after restart', () => statusOf() === 'succeeded', 900_000);
  const finalRow = getDb().prepare('SELECT status, output_path FROM render_jobs WHERE id = ?')
    .get(renderJob.id) as {status: string; output_path: string | null};
  console.log(`RENDER_SUCCEEDED ${renderJob.id} ${finalRow.output_path ?? ''}`);
  const abs = path.join(path.resolve('/app/data'), finalRow.output_path ?? '');
  execFileSync('ffprobe', ['-v', 'error', '-show_format', abs]);
  console.log('DRIVER_DONE');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('DRIVER_FAIL', err);
    process.exit(1);
  },
);

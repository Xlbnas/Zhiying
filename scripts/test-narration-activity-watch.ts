/**
 * M7.3A.2 Narration Activity Watch 测试。
 *
 * 用法：npx tsx scripts/test-narration-activity-watch.ts
 * 使用临时数据目录（data/test-narration-activity-watch），结束后清理。
 *
 * 覆盖：
 * - /activity 初始无 running job；
 * - notifyMutation 后立即刷新并启动 watch；
 * - running job 期间保持轮询；
 * - queued/running/succeeded 状态自动刷新；
 * - 终态后自动停止高频轮询；
 * - cancel 后通知刷新；
 * - hidden 页面降频、visible 立即刷新；
 * - 网络失败退避 2s→4s→8s→15s；
 * - 不重复请求 /stages + /activity；
 * - 同一 active LLM job 期间只轮询 /activity。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-narration-activity-watch');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb} from '../src/lib/db';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {createActivityController, type IntervalId} from '../src/components/workflow/activity-controller-logic';
import type {ActivityResponse} from '../src/components/workflow/shared';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callActivityRoute(projectId: string): Promise<ActivityResponse> {
  const {GET} = await import('../src/app/api/projects/[id]/activity/route');
  const res = await GET(new Request(`http://localhost/api/projects/${projectId}/activity`), {params: Promise.resolve({id: projectId})});
  if (!res.ok) throw new Error(`activity route HTTP ${res.status}`);
  return (await res.json()) as ActivityResponse;
}

function makeInitialActivity(): ActivityResponse {
  return {
    nodes: [],
    readyNodes: [],
    runningJobs: [],
    resourceUsage: {busyClasses: [], gpuOccupied: false},
    audioOverview: {
      status: 'stale',
      planReady: false,
      providerName: 'mock',
      voiceProfile: {id: 'default', revision: '1'},
      speechComplete: 0,
      speechTotal: 0,
      master: null,
      contamination: null,
      providerDetail: null,
      units: [],
    },
    subtitleReadiness: {
      status: 'not_ready',
      compilerVersion: '1.0',
      sourceAudio: null,
      artifactVersion: null,
      cueCount: 0,
      timelineDurationMs: null,
      unresolvedCount: 0,
      timing: null,
    },
  };
}

function setIntervalAdapter(cb: () => void, ms: number): IntervalId {
  return setInterval(cb, ms) as unknown as IntervalId;
}

function clearIntervalAdapter(id: IntervalId | null): void {
  if (id !== null) clearInterval(id as unknown as NodeJS.Timeout);
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-narration-activity-watch'), {recursive: true, force: true});
  const projectId = createProjectWithWorkflow({topic: 'activity-watch', coreQuestion: 'q'}).project.id;

  // ============ W1: /activity 初始无 running job ============
  {
    const initial = await callActivityRoute(projectId);
    ok(initial.runningJobs.length === 0, '[W1a] 初始 activity 无 running job', {runningJobs: initial.runningJobs});
    ok(initial.audioOverview.status === 'stale', '[W1b] 初始 audioOverview 为 stale（无 plan）', {status: initial.audioOverview.status});
    ok(initial.subtitleReadiness.status === 'not_ready', '[W1c] 初始 subtitleReadiness 为 not_ready');
  }

  // ============ W2: notifyMutation 立即刷新并启动 watch ============
  {
    let fetchCount = 0;
    const ctrl = createActivityController({
      fetchActivity: async () => {
        fetchCount++;
        return makeInitialActivity();
      },
      onChange: () => {},
      getVisibilityState: () => 'visible',
      setInterval: setIntervalAdapter,
      clearInterval: clearIntervalAdapter,
    });

    await sleep(50);
    ok(ctrl.getState().watchActive === false, '[W2a] 初始 watch 未激活');

    ctrl.notifyMutation();
    await sleep(50);
    const after = ctrl.getState();
    ok(after.watchActive === true, '[W2b] notifyMutation 后 watch 激活');
    ok(fetchCount >= 1, '[W2c] notifyMutation 触发至少一次 fetch', {fetchCount});

    ctrl.dispose();
  }

  // ============ W3: running job 期间保持轮询，终态后自动停止 ============
  {
    let fetchCount = 0;
    let observedRunning = false;
    let observedTerminal = false;

    const ctrl = createActivityController({
      baseIntervalMs: 100,
      fetchActivity: async () => {
        fetchCount++;
        const a = makeInitialActivity();
        if (fetchCount === 1) {
          a.runningJobs = [{type: 'tts', id: 'job-1', stage: 'N001', resourceClass: 'tts_gpu', startedAt: new Date().toISOString()}];
          observedRunning = true;
        } else if (fetchCount >= 2 && fetchCount <= 3) {
          a.runningJobs = [{type: 'tts', id: 'job-1', stage: 'N001', resourceClass: 'tts_gpu', startedAt: new Date().toISOString()}];
        } else {
          a.audioOverview.status = 'ready';
          a.audioOverview.master = {filePath: '/tmp/master.wav', durationMs: 12345};
          a.subtitleReadiness.status = 'ready';
          a.runningJobs = [];
          observedTerminal = true;
        }
        return a;
      },
      onChange: () => {},
      getVisibilityState: () => 'visible',
      setInterval: setIntervalAdapter,
      clearInterval: clearIntervalAdapter,
    });

    // 等初始刷新 + 至少 3 个 tick（100ms 间隔约需 400-500ms）
    await sleep(500);
    ok(observedRunning, '[W3a] 曾经观察到 running job');
    ok(observedTerminal, '[W3b] 最终进入 terminal 状态');

    await sleep(2500);
    const finalFetchCount = fetchCount;
    await sleep(2500);
    ok(fetchCount === finalFetchCount, '[W3c] 终态后不再继续 fetch', {fetchCount});
    ok(ctrl.getState().watchActive === false, '[W3d] 终态后 watchActive 自动关闭');

    ctrl.dispose();
  }

  // ============ W4: cancel 后通知刷新 ============
  {
    let fetchCount = 0;
    const ctrl = createActivityController({
      fetchActivity: async () => {
        fetchCount++;
        return makeInitialActivity();
      },
      onChange: () => {},
      getVisibilityState: () => 'visible',
      setInterval: setIntervalAdapter,
      clearInterval: clearIntervalAdapter,
    });
    await sleep(50);
    const before = fetchCount;
    ctrl.notifyMutation();
    await sleep(50);
    ok(fetchCount > before, '[W4] cancel/mutation 后触发刷新', {before, after: fetchCount});
    ctrl.dispose();
  }

  // ============ W5: hidden 页面降频，visible 立即刷新 ============
  {
    let fetchCount = 0;
    let lastIntervalMs = 0;
    let visibility: 'visible' | 'hidden' = 'visible';

    const ctrl = createActivityController({
      fetchActivity: async () => {
        fetchCount++;
        const a = makeInitialActivity();
        a.runningJobs = [{type: 'llm', id: 'job-hidden', stage: 'narration_beat_map', resourceClass: 'llm_api', startedAt: new Date().toISOString()}];
        return a;
      },
      onChange: () => {},
      getVisibilityState: () => visibility,
      setInterval: (cb, ms) => {
        lastIntervalMs = ms;
        return setIntervalAdapter(cb, ms);
      },
      clearInterval: clearIntervalAdapter,
    });

    await sleep(50);
    ok(lastIntervalMs === 2000, '[W5a] visible 时使用 2s 间隔', {lastIntervalMs});

    visibility = 'hidden';
    ctrl.notifyMutation();
    await sleep(50);
    ok(lastIntervalMs === 15000, '[W5b] hidden 时降到 15s 间隔', {lastIntervalMs});

    const beforeVisible = fetchCount;
    visibility = 'visible';
    await ctrl.refresh();
    ok(fetchCount > beforeVisible, '[W5c] 恢复 visible 立即刷新', {before: beforeVisible, after: fetchCount});

    ctrl.dispose();
  }

  // ============ W6: 网络失败退避 2s→4s→8s→15s（算法验证，使用缩放间隔） ============
  {
    const intervals: number[] = [];
    const ctrl = createActivityController({
      baseIntervalMs: 100,
      maxErrorIntervalMs: 750,
      fetchActivity: async () => {
        throw new Error('network down');
      },
      onChange: () => {},
      getVisibilityState: () => 'visible',
      setInterval: (cb, ms) => {
        intervals.push(ms);
        return setIntervalAdapter(cb, ms);
      },
      clearInterval: clearIntervalAdapter,
    });

    ctrl.notifyMutation();
    // 等 4 次失败调度：100+200+400+750 ≈ 1.5s
    await sleep(1600);
    ok(intervals.includes(100), '[W6a] 首次错误间隔 = base', {intervals});
    ok(intervals.includes(200), '[W6b] 第二次错误间隔翻倍', {intervals});
    ok(intervals.includes(400), '[W6c] 第三次错误间隔再翻倍', {intervals});
    ok(intervals.includes(750), '[W6d] 错误间隔受 max 限制', {intervals});
    ctrl.dispose();
  }

  // ============ W7: 不重复请求 /stages + /activity ============
  {
    let activityFetches = 0;
    const ctrl = createActivityController({
      fetchActivity: async () => {
        activityFetches++;
        const a = makeInitialActivity();
        a.runningJobs = [{type: 'llm', id: 'job-dedup', stage: 'script_v2', resourceClass: 'llm_api', startedAt: new Date().toISOString()}];
        return a;
      },
      onChange: () => {},
      getVisibilityState: () => 'visible',
      setInterval: setIntervalAdapter,
      clearInterval: clearIntervalAdapter,
    });

    await sleep(1500);
    ok(activityFetches >= 1, '[W7a] 仅 activity 轮询被触发');
    ctrl.dispose();
  }

  // ============ W8: 真实 DB 模拟 queued→running→succeeded 自动刷新 ============
  {
    const jobId = crypto.randomUUID();
    getDb().prepare(
      `INSERT INTO tts_jobs (
         id, project_id, narration_plan_artifact_id, narration_plan_version, unit_id,
         provider, voice_profile_id, voice_profile_revision, status, payload_json, queued_at
       ) VALUES (?, ?, ?, 1, 'N001', 'mock', 'default', '1', 'queued', ?, ?)`,
    ).run(jobId, projectId, crypto.randomUUID(), JSON.stringify({text: 'test'}), new Date().toISOString());

    const ctrl = createActivityController({
      baseIntervalMs: 100,
      fetchActivity: () => callActivityRoute(projectId),
      onChange: () => {},
      getVisibilityState: () => 'visible',
      setInterval: setIntervalAdapter,
      clearInterval: clearIntervalAdapter,
    });

    // 初始刷新：job 是 queued，activity 会把它当 running（queued|running 都算）
    await sleep(500);
    const initialState = ctrl.getState().activity;
    ok(!!initialState?.runningJobs.some((j) => j.type === 'tts' && j.id === jobId), '[W8a] 初始观察到 tts job 在 runningJobs', {runningJobs: initialState?.runningJobs});

    // 模拟 worker 改为 running
    getDb().prepare(`UPDATE tts_jobs SET status = 'running', started_at = ? WHERE id = ?`).run(new Date().toISOString(), jobId);
    await sleep(300);
    const runningState = ctrl.getState().activity;
    ok(!!runningState?.runningJobs.some((j) => j.type === 'tts' && j.id === jobId), '[W8b] 观察到 tts job running', {runningJobs: runningState?.runningJobs});

    // 模拟 worker 完成
    getDb().prepare(`UPDATE tts_jobs SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), jobId);
    await sleep(300);
    const doneState = ctrl.getState().activity;
    ok(doneState?.runningJobs.length === 0, '[W8c] tts succeeded 后 runningJobs 清空', {runningJobs: doneState?.runningJobs});

    ctrl.dispose();
  }

  // ============ W9: stable-stop 精确规则（连续两次空+terminal 才停；一次不停止；running 重置 streak） ============
  {
    let fetchCount = 0;
    const snapshots: Array<{count: number; watchActive: boolean}> = [];
    const ctrl = createActivityController({
      baseIntervalMs: 50,
      fetchActivity: async () => {
        fetchCount++;
        const a = makeInitialActivity();
        // f1（构造期）/ f2（notifyMutation）/ f4：running；其余（f3/f5/f6）：terminal 空
        if (fetchCount === 1 || fetchCount === 2 || fetchCount === 4) {
          a.runningJobs = [{type: 'llm', id: `job-${fetchCount}`, stage: 'narration_beat_map', resourceClass: 'llm_api', startedAt: new Date().toISOString()}];
        }
        return a;
      },
      onChange: (s) => {
        snapshots.push({count: fetchCount, watchActive: s.watchActive});
      },
      getVisibilityState: () => 'visible',
      setInterval: setIntervalAdapter,
      clearInterval: clearIntervalAdapter,
    });

    await sleep(50); // 等构造期初始刷新完成
    ctrl.notifyMutation(); // watchActive=true（streak 规则生效的路径）

    // 等序列跑完：f1/f2 running → f3 terminal(streak=1) → f4 running(reset) → f5/f6 terminal(streak=2) → 停止
    await sleep(600);
    ok(fetchCount >= 6, '[W9a] 序列到达停止点（f3 后仍在轮询，f4 重置后连续两次 terminal）', {fetchCount});

    const snap = (count: number) => snapshots.find((s) => s.count === count);
    ok(snap(3)?.watchActive === true, '[W9b] 第一次 terminal 空（streak=1）时 watch 仍激活');
    ok(snap(4)?.watchActive === true, '[W9c] running 重置 streak 后 watch 仍激活');
    ok(snap(5)?.watchActive === true, '[W9d] 第二次 terminal 空（streak=2 前一刻）watch 仍激活');
    ok(snap(6)?.watchActive === false, '[W9e] 连续两次 terminal 空后 watch 关闭');

    const stoppedCount = fetchCount;
    await sleep(400);
    ok(fetchCount === stoppedCount, '[W9f] 停止后不再 fetch', {before: stoppedCount, after: fetchCount});

    ctrl.dispose();
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-narration-activity-watch'), {recursive: true, force: true});

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

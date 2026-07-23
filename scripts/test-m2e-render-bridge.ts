/**
 * M2-E-C Render Bridge 测试（Mock + 注入式资产检查，零真实 Remotion 依赖）。
 *
 * 用法：npx tsx scripts/test-m2e-render-bridge.ts
 * 使用临时数据目录（data/test-m2e-bridge），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m2e-bridge');
process.env.LLM_PROVIDER = 'mock';

import Database from 'better-sqlite3';
import {closeDb, getDb, getDbPath} from '../src/lib/db';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {MockLLMProvider} from '../src/lib/llm/mock';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {zhiyingFullCutPropsSchema} from '../src/lib/scene-schema';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {runLlmJob, type LlmExecutorDeps} from '../src/worker/llm-executor';
import {
  buildWorkflowRenderProps,
  checkWorkflowRenderReadiness,
  enqueueWorkflowPreviewRender,
  getRenderSourceVersion,
  RenderBridgeError,
} from '../src/lib/workflow/render-bridge';
import {editVersion, generateVersion} from '../src/lib/workflow/operations';
import {getStage, lockStage} from '../src/lib/workflow/stages';
import {getVersion} from '../src/lib/workflow/versions';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';

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

const CTX = {isShuttingDown: () => false, log: () => {}};
const ALL_FILES_EXIST = () => true;
const ALL_FILES_MISSING = () => false;

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

function countRows(sql: string, ...args: unknown[]): number {
  return (getDb().prepare(sql).get(...args) as {c: number}).c;
}

function claimLlm() {
  const claimed = claimNextAnyJob('w-bridge');
  return claimed && claimed.type === 'llm' ? claimed : null;
}

async function runStageOnce(
  pid: string,
  stage: WorkflowStage,
  deps?: LlmExecutorDeps,
  confirmStale = false,
) {
  const job = enqueueWorkflowStageJob(pid, stage, {confirmStale});
  const claimed = claimLlm();
  if (!claimed || claimed.job.id !== job.id) throw new Error(`claim 失败 ${stage}`);
  await runLlmJob(claimed.job, CTX, deps);
  return getLlmJob(job.id)!;
}

async function genAndLock(pid: string, stage: WorkflowStage): Promise<void> {
  const job = await runStageOnce(pid, stage);
  if (job.status !== 'succeeded') throw new Error(`${stage} 未成功`);
  lockStage(pid, stage);
}

async function lockAllTen(pid: string): Promise<void> {
  for (const stage of WORKFLOW_STAGES) {
    await genAndLock(pid, stage);
  }
}

function expectBridgeError(fn: () => unknown, code: RenderBridgeError['code'], label: string): void {
  try {
    fn();
    ok(false, `${label}（未抛错）`);
  } catch (err) {
    ok(
      err instanceof RenderBridgeError && err.code === code,
      `${label}（抛出 ${err instanceof RenderBridgeError ? err.code : String(err)}）`,
    );
  }
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e-bridge'), {recursive: true, force: true});
  const db = getDb();

  // ============ R. Readiness ============
  {
    const r = checkWorkflowRenderReadiness('no-such-project', {fileExists: ALL_FILES_EXIST});
    ok(!r.ready && r.blockers[0]?.code === 'PROJECT_NOT_FOUND', '[R1] 项目不存在 → PROJECT_NOT_FOUND');
  }
  {
    const legacyId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id,
         current_stage, created_at, updated_at)
       VALUES (?, 'legacy', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    ).run(legacyId, at, at);
    const r = checkWorkflowRenderReadiness(legacyId, {fileExists: ALL_FILES_EXIST});
    ok(!r.ready && r.blockers[0]?.code === 'LEGACY_PROJECT', '[R2] Legacy M1 项目 → LEGACY_PROJECT');
  }
  {
    const pid = newProject();
    const r = checkWorkflowRenderReadiness(pid, {fileExists: ALL_FILES_EXIST});
    ok(!r.ready && r.blockers.some((b) => b.code === 'SCENES_NOT_LOCKED'), '[R3] scenes not_started → SCENES_NOT_LOCKED');
    for (const stage of WORKFLOW_STAGES.slice(0, 9)) await genAndLock(pid, stage);
    await runStageOnce(pid, 'scenes'); // generated（未 lock）
    const r2 = checkWorkflowRenderReadiness(pid, {fileExists: ALL_FILES_EXIST});
    ok(!r2.ready && r2.blockers.some((b) => b.code === 'SCENES_NOT_LOCKED'), '[R4] scenes generated → SCENES_NOT_LOCKED');
    lockStage(pid, 'scenes');
    const r3 = checkWorkflowRenderReadiness(pid, {fileExists: ALL_FILES_EXIST});
    ok(r3.ready && r3.scenesVersion === 1, '[R6] scenes locked → ready（scenesVersion=1）', r3.blockers);
    // stale：locked_version 保留但 status 变 stale → 仍禁止
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: '# 改动', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    const r4 = checkWorkflowRenderReadiness(pid, {fileExists: ALL_FILES_EXIST});
    ok(
      !r4.ready && r4.blockers.some((b) => b.code === 'SCENES_NOT_LOCKED') &&
        getStage(pid, 'scenes')!.locked_version === 1,
      '[R5] scenes stale（locked_version 保留）→ 仍 SCENES_NOT_LOCKED',
    );
  }
  {
    // locked 但 version 行缺失
    const pid = newProject();
    await lockAllTen(pid);
    db.prepare('DELETE FROM project_versions WHERE project_id = ? AND stage = ? AND version = 1')
      .run(pid, 'scenes');
    expectBridgeError(
      () => buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST}),
      'SCENES_VERSION_NOT_FOUND',
      '[R7] locked_version 对应版本行缺失 → SCENES_VERSION_NOT_FOUND',
    );
  }
  {
    // 源内容非法（防御性重校验）
    const pid = newProject();
    await lockAllTen(pid);
    db.prepare("UPDATE project_versions SET content = 'not-json{{' WHERE project_id = ? AND stage = 'scenes'").run(pid);
    expectBridgeError(
      () => buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST}),
      'RENDER_SOURCE_INVALID',
      '[R8] locked 内容非法 JSON → RENDER_SOURCE_INVALID',
    );
    // 结构合法但语义非法（S001,S003）
    const {MOCK_FIXTURES} = await import('../src/lib/prompts/fixtures');
    const semanticBad = JSON.parse(MOCK_FIXTURES.scenes) as {scenes: Array<{id: string}>};
    semanticBad.scenes[1]!.id = 'S003';
    db.prepare('UPDATE project_versions SET content = ? WHERE project_id = ? AND stage = ?')
      .run(JSON.stringify(semanticBad), pid, 'scenes');
    expectBridgeError(
      () => buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST}),
      'RENDER_SOURCE_INVALID',
      '[R9] locked 内容语义非法 → RENDER_SOURCE_INVALID（render 边界独立防御）',
    );
  }
  {
    const pid = newProject();
    await lockAllTen(pid);
    db.prepare("UPDATE projects SET template_version = 'evil-1.0' WHERE id = ?").run(pid);
    expectBridgeError(
      () => buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST}),
      'UNSUPPORTED_TEMPLATE',
      '[R10] template_version 不受支持 → UNSUPPORTED_TEMPLATE',
    );
  }

  // ============ M. Metadata + Props Contract ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    const {props, scenesVersion} = buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST});
    ok(scenesVersion === 1, '[M] scenesVersion=1');
    ok(zhiyingFullCutPropsSchema.safeParse(props).success, '[M12] props 通过 zhiyingFullCutPropsSchema');
    ok(
      props.audio.narration === null && props.subtitles.length === 0 && props.showSubtitles === false,
      '[M12] Visual Preview 策略：narration=null / subtitles=[] / showSubtitles=false',
    );
    const meta = props.data;
    ok(
      meta.schemaVersion === '1.0' &&
        meta.templateVersion === 'freud-mg-v1.0' &&
        meta.project.composition === 'ZhiyingFullCut' &&
        meta.project.fps === 30 &&
        meta.project.width === 1920 &&
        meta.project.height === 1080 &&
        meta.project.title === '拖延研究',
      '[M13] system-owned metadata 全部正确（schema/template/composition/fps/尺寸/title）',
    );
    ok(
      meta.project.durationSec === 14.5 && meta.project.durationInFrames === 435,
      '[M14] durationSec=末场 end，durationInFrames=round(14.5×30)=435',
      {sec: meta.project.durationSec, frames: meta.project.durationInFrames},
    );
    const again = buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST});
    ok(
      JSON.stringify(again.props) === JSON.stringify(props),
      '[M16] 同一 builder 两次构建完全一致（Player/Renderer 不漂移）',
    );
  }
  {
    // round-boundary：1.25s → round(37.5)=38（非 floor 37）
    // 用完整链项目替换 locked 内容（bridge 会对替换后内容重新双校验）
    const pid = newProject();
    await lockAllTen(pid);
    const crafted = JSON.stringify({
      chapterTiming: [{chapter: 1, title: 'c', start: 0, end: 1.25}],
      scenes: [{
        id: 'S001', chapter: 1, chapterTitle: 'c', start: 0, end: 1.25, duration: 1.25,
        startFrame: 0, durationInFrames: 38, category: 'Minimal', visualType: 'Minimal',
        template: null, sourceTemplate: null, narrationSummary: 'n', description: 'd',
        notes: '', assetIds: [], licenseStatus: 'not-applicable', subtitlePosition: 'bottom',
        transitionIn: 'none', transitionOut: 'none',
      }],
    });
    db.prepare("UPDATE project_versions SET content = ? WHERE project_id = ? AND stage = 'scenes' AND version = 1")
      .run(crafted, pid);
    const {props} = buildWorkflowRenderProps(pid, {fileExists: ALL_FILES_EXIST});
    ok(
      props.data.project.durationInFrames === 38,
      '[M15] round-boundary：durationSec=1.25 → frames=38（Math.round，非 floor）',
      props.data.project.durationInFrames,
    );
  }

  // ============ A. Asset Preflight ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    // M2-E-D：Workflow Visual Preview 音频全 null（narration/bgm/sfx），
    // 不再硬依赖 Freud 示例音频——本机无音频资产也 ready
    const noFiles = checkWorkflowRenderReadiness(pid, {fileExists: ALL_FILES_MISSING});
    ok(
      noFiles.ready,
      '[A17] preview 音频全 null → 无音频资产也 ready（情况 B：示例遗留不再是硬依赖）',
      noFiles.blockers.map((b) => b.code),
    );
    // freud_1909_loc：Renderer 真实解析的场景素材仍检查
    const v1 = JSON.parse(getVersion(pid, 'scenes', 1)!.content) as {
      scenes: Array<{assetIds: string[]}>;
    };
    v1.scenes[0]!.assetIds = ['freud_1909_loc'];
    db.prepare('UPDATE project_versions SET content = ? WHERE project_id = ? AND stage = ?')
      .run(JSON.stringify(v1), pid, 'scenes');
    const selective = checkWorkflowRenderReadiness(pid, {
      fileExists: (rel) => rel.startsWith('full/audio/'),
    });
    ok(
      !selective.ready &&
        selective.blockers.some((b) => b.code === 'ASSET_FILE_MISSING' && b.message.includes('freud_1909_loc')),
      '[A18] freud_1909_loc 文件缺失 → ASSET_FILE_MISSING（其他 assetId 不阻塞）',
    );
  }

  // ============ S. Snapshot / Stale ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    const {job, scenesVersion} = enqueueWorkflowPreviewRender(pid, {fileExists: ALL_FILES_EXIST});
    ok(
      job.status === 'queued' && job.kind === 'no-subtitles' && scenesVersion === 1,
      '[S19] 入队成功（kind=no-subtitles，scenesVersion=1）',
    );
    const payload = zhiyingFullCutPropsSchema.safeParse(JSON.parse(job.payload_json));
    ok(payload.success, '[S19] render job payload 可被 Worker 的 M1 schema 复验');
    ok(
      getRenderSourceVersion(job.id) === 1,
      '[S19] render_source artifact 记录 scenesVersion=1',
    );
    // 上游变化 → scenes stale：旧 job 仍是 v1 snapshot，新 render 被拒
    editVersion({
      projectId: pid, stage: 'script_v2',
      content: '# 改动', contentType: 'markdown', source: 'manual_edit',
    }, {confirmStale: true});
    expectBridgeError(
      () => enqueueWorkflowPreviewRender(pid, {fileExists: ALL_FILES_EXIST}),
      'SCENES_NOT_LOCKED',
      '[S20] scenes stale 后新 render → SCENES_NOT_LOCKED',
    );
    ok(
      getRenderSourceVersion(job.id) === 1 && getLlmJob(job.id) === undefined &&
        getStage(pid, 'scenes')!.status === 'stale',
      '[S20] 旧 render job 仍绑定 scenes v1（immutable snapshot）',
    );
    // 先终结旧 render job（避免它占据全局 FIFO），再恢复下游链
    db.prepare("UPDATE render_jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
    lockStage(pid, 'script_v2');
    for (const stage of ['narration_beat_map', 'visual_breakdown', 'shot_list', 'scenes'] as const) {
      await genAndLock(pid, stage);
    }
    const second = enqueueWorkflowPreviewRender(pid, {fileExists: ALL_FILES_EXIST});
    ok(
      second.scenesVersion === 2 && getRenderSourceVersion(second.job.id) === 2,
      '[S21] 恢复后 scenes v2 locked → 新 render 绑定 v2',
    );
    db.prepare("UPDATE render_jobs SET status = 'cancelled' WHERE id = ?").run(second.job.id);
  }

  // ============ X. Active Render Fence（顺序 + 双连接） ============
  {
    const pid = newProject();
    await lockAllTen(pid);
    enqueueWorkflowPreviewRender(pid, {fileExists: ALL_FILES_EXIST});
    expectBridgeError(
      () => enqueueWorkflowPreviewRender(pid, {fileExists: ALL_FILES_EXIST}),
      'RENDER_ALREADY_ACTIVE',
      '[X22] 顺序语义：已有 active render → RENDER_ALREADY_ACTIVE',
    );
    // 双连接：B 持 BEGIN IMMEDIATE 写锁期间，A 的原子入队无法进入
    const dbB = new Database(getDbPath());
    dbB.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 150');
    try {
      let busyErr: unknown = null;
      dbB.transaction(() => {
        dbB.prepare('UPDATE render_jobs SET progress = progress WHERE 1 = 0').run();
        try {
          enqueueWorkflowPreviewRender(pid, {fileExists: ALL_FILES_EXIST});
        } catch (err) {
          busyErr = err;
        }
      }).immediate();
      ok(
        busyErr !== null &&
          (String(busyErr).includes('database is locked') ||
            (busyErr as {code?: string}).code === 'SQLITE_BUSY'),
        '[X23] 双连接：对方持写锁时入队被 SQLITE_BUSY 拒绝（fence+enqueue 同事务）',
        String(busyErr),
      );
    } finally {
      db.pragma('busy_timeout = 5000');
      dbB.close();
    }
    db.prepare("UPDATE render_jobs SET status = 'cancelled' WHERE project_id = ?").run(pid);
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), 'data', 'test-m2e-bridge'), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M2-E-C 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M2-E-C Render Bridge 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

/**
 * M3-E Final Render Integration 测试（单元 + 高层 mock 闭环，不含真实 Remotion 渲染——
 * REAL_RENDER 见 scripts/test-m3e-real-render.ts）。
 *
 * 用法：npx tsx scripts/test-m3e-final-render.ts
 * 使用临时数据目录（data/test-m3e），结束后清理。
 * 任一断言失败即非零退出。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3e');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {
  enqueueFinalRender,
  FinalRenderError,
} from '../src/lib/final-render/bridge';
import {
  FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
  FINAL_RENDER_SOURCE_ARTIFACT_KIND,
  computePropsSha256,
  computeSourceKeyForCompilerVersion,
  finalRenderSourceSchema,
  type FinalRenderSource,
} from '../src/lib/final-render/schema';
import {enqueueRenderJob, type RenderJobRow} from '../src/lib/jobs';
import {
  enqueueNarrationAudioJobs,
  getCurrentNarrationAudioArtifact,
  tryFinalizeNarrationAudio,
} from '../src/lib/narration/audio';
import {buildNarrationPlan} from '../src/lib/narration/plan';
import {buildTimingReconciliation} from '../src/lib/reconciliation/timing';
import {zhiyingFullCutPropsSchema, type ZhiyingFullCutProps} from '../src/lib/scene-schema';
import {toRendererSubtitleCues} from '../src/lib/subtitles/renderer';
import {buildSubtitleTiming, getCurrentSubtitleTiming} from '../src/lib/subtitles/timing';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {resetTtsProviderForTest} from '../src/lib/tts';
import type {TtsJobRow} from '../src/lib/tts-jobs';
import {runLlmJob} from '../src/worker/llm-executor';
import {runTtsJob} from '../src/worker/tts-executor';
import {
  resolveBundledPublicRoot,
  RuntimeAudioError,
  stageRuntimeNarrationAudio,
} from '../src/worker/runtime-audio';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
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

const SCRIPT_V2 = `# Script V2

> 与 V1 差异说明：压缩书面语，零新增事实。

## 第 1 章 开场（00:00–02:00）

那条消息你看到了。（停顿 1s）

你没有回。为什么偏偏是这一条？

[画面留白]

## 第 2 章 追问（02:00–05:00）

弗洛伊德怀疑过这种忘记。（放慢）他说，有些遗忘背后藏着不情愿。<!-- E01 -->
`;

const FAKE_BUNDLE = path.join('data', 'test-m3e', 'fake-bundle');

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

async function runStageOnce(pid: string, stage: WorkflowStage): Promise<void> {
  const job = enqueueWorkflowStageJob(pid, stage);
  const claimed = claimNextAnyJob('w-m3e');
  if (!claimed || claimed.type !== 'llm' || claimed.job.id !== job.id) {
    throw new Error(`claim 失败 ${stage}`);
  }
  await runLlmJob(claimed.job, CTX);
  if (getLlmJob(job.id)!.status !== 'succeeded') throw new Error(`${stage} 未成功`);
}

function setScriptV2(pid: string, content: string): void {
  editVersion({
    projectId: pid, stage: 'script_v2',
    content, contentType: 'markdown', source: 'manual_edit',
  }, {confirmStale: true});
  lockStage(pid, 'script_v2');
}

async function runAllTtsJobs(pid: string): Promise<void> {
  for (;;) {
    const claimed = claimNextAnyJob('w-m3e');
    if (!claimed) break;
    if (claimed.type !== 'tts') throw new Error(`意外 job 类型 ${claimed.type}`);
    if ((claimed.job as TtsJobRow).project_id !== pid) throw new Error('意外拿到其他项目 tts job');
    await runTtsJob(claimed.job as TtsJobRow, CTX);
  }
}

async function lockThrough(pid: string, stages: readonly WorkflowStage[]): Promise<void> {
  for (const stage of stages) {
    await runStageOnce(pid, stage);
    lockStage(pid, stage);
  }
}

/** 正式高层链：全 10 阶段 locked + Plan/Audio/Subtitle/Reconciliation ready。 */
async function buildFullChain(pid: string, script: string): Promise<void> {
  await lockThrough(pid, WORKFLOW_STAGES.slice(0, 6));
  setScriptV2(pid, script);
  buildNarrationPlan(pid);
  enqueueNarrationAudioJobs(pid);
  await runAllTtsJobs(pid);
  if (!tryFinalizeNarrationAudio(pid)) throw new Error('audio finalize 失败');
  buildSubtitleTiming(pid);
  await lockThrough(pid, WORKFLOW_STAGES.slice(6));
  buildTimingReconciliation(pid);
}

/** narration 链重建（script 前进后）：plan/audio/subtitle 新版本。 */
async function rebuildNarrationChain(pid: string, script: string): Promise<void> {
  setScriptV2(pid, script);
  buildNarrationPlan(pid);
  enqueueNarrationAudioJobs(pid);
  await runAllTtsJobs(pid);
  if (!tryFinalizeNarrationAudio(pid)) throw new Error('audio finalize 失败');
  buildSubtitleTiming(pid);
}

function artifactsOf(pid: string, kind: string): Array<{id: string; version: number; content_json: string}> {
  return getDb()
    .prepare('SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version ASC')
    .all(pid, kind) as Array<{id: string; version: number; content_json: string}>;
}

function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return (
      (err instanceof FinalRenderError || err instanceof RuntimeAudioError) && err.code === code
    );
  }
}

function parsedPayloadOf(job: RenderJobRow): ZhiyingFullCutProps {
  return zhiyingFullCutPropsSchema.parse(JSON.parse(job.payload_json));
}

function sha256File(abs: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function currentFinalSource(pid: string): {row: {id: string; version: number; content_json: string}; content: FinalRenderSource} {
  const row = artifactsOf(pid, FINAL_RENDER_SOURCE_ARTIFACT_KIND).at(-1)!;
  return {row, content: finalRenderSourceSchema.parse(JSON.parse(row.content_json))};
}

/** 查指定 job 的 attempt 行（T04 会注入额外 attempt，不能靠 at(-1) 取）。 */
function attemptRowForJob(pid: string, jobId: string): {id: string; content_json: string} {
  const row = artifactsOf(pid, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND).find((r) => {
    try {
      return (JSON.parse(r.content_json) as {jobId?: string}).jobId === jobId;
    } catch {
      return false;
    }
  });
  if (!row) throw new Error(`attempt for job ${jobId} not found`);
  return row;
}

function updateArtifact(id: string, content: unknown): void {
  getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?')
    .run(typeof content === 'string' ? content : JSON.stringify(content), id);
}

async function main(): Promise<void> {
  resetTtsProviderForTest();
  fs.mkdirSync(FAKE_BUNDLE, {recursive: true});

  // ===== 高层闭环：项目 A 全链 ready =====
  const pidA = newProject();
  await buildFullChain(pidA, SCRIPT_V2);
  const audioA = getCurrentNarrationAudioArtifact(pidA)!;
  const subtitleA = getCurrentSubtitleTiming(pidA)!;

  // ===== Props =====
  const enq1 = enqueueFinalRender(pidA);
  const props = parsedPayloadOf(enq1.job);
  const recRow = artifactsOf(pidA, 'timing_reconciliation').at(-1)!;
  const recContent = JSON.parse(recRow.content_json) as {target: {totalFrames: number}};
  const targetFrames = recContent.target.totalFrames;

  ok(props.data.project.durationInFrames === targetFrames, 'P01 durationInFrames = reconciliation target');
  ok(props.data.project.durationSec === targetFrames / 30, 'P02 durationSec = frames/fps');
  ok(props.data.project.timingBasis === 'narration_scene_reconciliation', 'P03 timingBasis 正确');
  ok(props.data.project.fps === 30, 'P04 fps=30');
  const totalSceneFrames = props.data.scenes.reduce((s, x) => s + x.durationInFrames, 0);
  ok(
    totalSceneFrames === targetFrames && props.data.scenes[0]!.durationInFrames !== 195,
    'P05 reconciled scenes 进入 props（非 source timing）',
    [totalSceneFrames, targetFrames],
  );
  ok(
    props.data.chapterTiming[0]!.end === props.data.scenes.at(-1)!.end,
    'P06 chapterTiming 使用 reconciled 边界',
  );
  ok(
    props.audio.narration === `runtime-audio/${pidA}/${audioA.artifact.id}.wav` &&
      props.audio.bgm === null && props.audio.sfx === null,
    'P07 narration 逻辑路径 + bgm/sfx=null',
  );
  {
    const expectedSubs = toRendererSubtitleCues(subtitleA.timing);
    ok(
      JSON.stringify(props.subtitles) === JSON.stringify(expectedSubs) &&
        props.subtitles.length > 0 &&
        props.subtitles.every((c) => c.position === 'bottom'),
      'P08 subtitles 来自 M3-C official adapter',
    );
  }
  ok(props.showSubtitles === true, 'P09 showSubtitles=true');
  ok(zhiyingFullCutPropsSchema.safeParse(props).success, 'P10 props schema PASS');

  // source scenes 不可变
  {
    const scenesContent = getDb().prepare(
      "SELECT content FROM project_versions WHERE project_id = ? AND stage = 'scenes' AND version = 1",
    ).get(pidA) as {content: string};
    ok(
      scenesContent.content.includes('"startFrame":195'),
      'P11 source project_versions.scenes 未被修改',
    );
  }

  // byte-stable / 幂等
  const job1Payload = enq1.job.payload_json;
  getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE id=?")
    .run(new Date().toISOString(), enq1.job.id);
  const enq2 = enqueueFinalRender(pidA);
  ok(enq2.sourceReused === true, 'P12 同 source → sourceReused=true');
  ok(enq2.job.payload_json === job1Payload, 'P13 props byte-stable（两次 enqueue payload 全等）');
  ok(
    computePropsSha256(props) === computePropsSha256(parsedPayloadOf(enq2.job)),
    'P14 propsSha256 byte-stable',
  );
  ok(enq2.sourceArtifact.id === enq1.sourceArtifact.id, 'P15 sourceKey 幂等（同 artifact id）');

  // ===== Artifact immutability（§35）=====
  {
    const sources = artifactsOf(pidA, FINAL_RENDER_SOURCE_ARTIFACT_KIND);
    const attempts = artifactsOf(pidA, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND);
    const jobs = getDb().prepare('SELECT * FROM render_jobs WHERE project_id = ?').all(pidA) as RenderJobRow[];
    ok(sources.length === 1, 'A01 两次 Render → final_render_source 仍 = 1');
    ok(attempts.length === 2 && jobs.length === 2, 'A02 attempts=2 / jobs=2（每次新 attempt）');
    const contentBefore = sources[0]!.content_json;
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=?")
      .run(new Date().toISOString(), pidA);
    enqueueFinalRender(pidA);
    const sourcesAfter = artifactsOf(pidA, FINAL_RENDER_SOURCE_ARTIFACT_KIND);
    ok(
      sourcesAfter.length === 1 && sourcesAfter[0]!.content_json === contentBefore,
      'A03 第三次 Render 后 source content_json byte-for-byte 不变（禁 UPDATE）',
    );
    ok(
      artifactsOf(pidA, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND).length === 3,
      'A04 attempts=3（attempt 也只增不改）',
    );
    // 清理第三次 Render 的 queued job，避免污染后续全局 FIFO claim
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=?")
      .run(new Date().toISOString(), pidA);
  }

  // ===== Source gates =====
  ok(throwsCode(() => enqueueFinalRender('no-such-project'), 'PROJECT_NOT_FOUND'), 'G01 project missing → PROJECT_NOT_FOUND');
  {
    const legacyId = crypto.randomUUID();
    getDb().prepare(
      `INSERT INTO projects (id, title, mode, schema_version, template_version, composition_id, current_stage, created_at, updated_at)
       VALUES (?, 'legacy', 'rigorous', '1.0', 'freud-mg-v1.0', 'ZhiyingFullCut', 'scenes', ?, ?)`,
    ).run(legacyId, new Date().toISOString(), new Date().toISOString());
    ok(throwsCode(() => enqueueFinalRender(legacyId), 'LEGACY_PROJECT'), 'G02 legacy → LEGACY_PROJECT');
  }
  {
    const pid = newProject();
    await lockThrough(pid, WORKFLOW_STAGES.slice(0, 6));
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    tryFinalizeNarrationAudio(pid);
    buildSubtitleTiming(pid);
    ok(throwsCode(() => enqueueFinalRender(pid), 'SCENES_NOT_CURRENT'), 'G03 scenes 未 locked → SCENES_NOT_CURRENT');
  }
  {
    const pid = newProject();
    await lockThrough(pid, WORKFLOW_STAGES);
    ok(throwsCode(() => enqueueFinalRender(pid), 'NARRATION_PLAN_NOT_CURRENT'), 'G04 plan missing → NARRATION_PLAN_NOT_CURRENT');
    buildNarrationPlan(pid);
    ok(throwsCode(() => enqueueFinalRender(pid), 'NARRATION_AUDIO_NOT_READY'), 'G05 audio missing → NARRATION_AUDIO_NOT_READY');
  }
  {
    const pid = newProject();
    await lockThrough(pid, WORKFLOW_STAGES.slice(0, 6));
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    tryFinalizeNarrationAudio(pid);
    await lockThrough(pid, WORKFLOW_STAGES.slice(6));
    ok(throwsCode(() => enqueueFinalRender(pid), 'SUBTITLE_TIMING_NOT_READY'), 'G06 subtitle missing → SUBTITLE_TIMING_NOT_READY');
  }
  {
    // reconciliation missing（其余三者 ready）
    const pid = newProject();
    await lockThrough(pid, WORKFLOW_STAGES.slice(0, 6));
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    enqueueNarrationAudioJobs(pid);
    await runAllTtsJobs(pid);
    tryFinalizeNarrationAudio(pid);
    buildSubtitleTiming(pid);
    await lockThrough(pid, WORKFLOW_STAGES.slice(6));
    ok(throwsCode(() => enqueueFinalRender(pid), 'TIMING_RECONCILIATION_NOT_READY'), 'G07 reconciliation missing → TIMING_RECONCILIATION_NOT_READY');
  }
  {
    // cross-generation：audio 前进（B 代）+ scenes 重新 locked，但 reconciliation 仍指 A 代
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    await rebuildNarrationChain(pid, SCRIPT_V2.replace('那条消息你看到了。', '那条消息你看到了。你真的看到了。'));
    await lockThrough(pid, WORKFLOW_STAGES.slice(6)); // scenes v2 locked；不重建 reconciliation
    ok(
      throwsCode(() => enqueueFinalRender(pid), 'TIMING_RECONCILIATION_NOT_READY'),
      'G08 cross-generation（Audio B + Reconciliation A）→ 拒绝',
    );
  }
  {
    // active render fence：先制造 active job，再断言拒绝
    const activeEnq = enqueueFinalRender(pidA);
    ok(
      throwsCode(() => enqueueFinalRender(pidA), 'RENDER_ALREADY_ACTIVE'),
      'G09 active render → RENDER_ALREADY_ACTIVE（无 orphan）',
    );
    ok(
      artifactsOf(pidA, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND).length === 4,
      'G09b active 冲突不产生新 attempt/job',
    );
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE id=?")
      .run(new Date().toISOString(), activeEnq.job.id);
  }

  // ===== Corrupt final source（skip 不 reuse，历史保留）=====
  {
    const cancelJobs = (): void => {
      getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=? AND status IN ('queued','running')")
        .run(new Date().toISOString(), pidA);
    };
    const before = artifactsOf(pidA, FINAL_RENDER_SOURCE_ARTIFACT_KIND).length;
    const {row} = currentFinalSource(pidA);
    const valid = JSON.parse(row.content_json) as FinalRenderSource;

    // bad JSON：直接 UPDATE 当前唯一 source → enqueue 必须新建
    updateArtifact(row.id, 'bad json{{');
    cancelJobs();
    const r1 = enqueueFinalRender(pidA);
    ok(!r1.sourceReused && r1.sourceArtifact.version === before + 1, 'C01 bad JSON → 不 reuse，新建 source');

    // wrong schema
    updateArtifact(r1.sourceArtifact.id, JSON.stringify({schemaVersion: 'wrong'}));
    cancelJobs();
    const r2 = enqueueFinalRender(pidA);
    ok(!r2.sourceReused, 'C02 wrong schema → 不 reuse，新建 source');

    // wrong sourceKey（shape 合法）
    const badKey = JSON.parse(JSON.stringify(valid)) as FinalRenderSource;
    badKey.sourceKey = '0'.repeat(64);
    updateArtifact(r2.sourceArtifact.id, JSON.stringify(badKey));
    cancelJobs();
    const r3 = enqueueFinalRender(pidA);
    ok(!r3.sourceReused, 'C03 wrong sourceKey → 不 reuse');

    // wrong propsSha（shape 合法）
    const badSha = JSON.parse(JSON.stringify(valid)) as FinalRenderSource;
    badSha.propsSha256 = '1'.repeat(64);
    updateArtifact(r3.sourceArtifact.id, JSON.stringify(badSha));
    cancelJobs();
    const r4 = enqueueFinalRender(pidA);
    ok(!r4.sourceReused, 'C04 wrong propsSha → 不 reuse');

    // props semantic tamper（shape 合法，内容不同）
    const badProps = JSON.parse(JSON.stringify(valid)) as FinalRenderSource;
    badProps.props.subtitles[0]!.text = '被篡改的字幕';
    updateArtifact(r4.sourceArtifact.id, JSON.stringify(badProps));
    cancelJobs();
    const r5 = enqueueFinalRender(pidA);
    ok(!r5.sourceReused, 'C05 props semantic tamper → 不 reuse');

    // source refs tamper
    const badRefs = JSON.parse(JSON.stringify(valid)) as FinalRenderSource;
    badRefs.source.masterDurationMs += 1;
    updateArtifact(r5.sourceArtifact.id, JSON.stringify(badRefs));
    cancelJobs();
    const r6 = enqueueFinalRender(pidA);
    ok(!r6.sourceReused, 'C06 source refs tamper → 不 reuse');

    ok(
      artifactsOf(pidA, FINAL_RENDER_SOURCE_ARTIFACT_KIND).length === before + 6,
      'C07 corrupt rows 全部保留（不 DELETE）',
      artifactsOf(pidA, FINAL_RENDER_SOURCE_ARTIFACT_KIND).length,
    );
    ok(
      JSON.parse(artifactsOf(pidA, FINAL_RENDER_SOURCE_ARTIFACT_KIND).at(-1)!.content_json).props.subtitles[0].text !== '被篡改的字幕',
      'C08 新 source 为合法内容',
    );
  }

  // ===== Worker staging：正常路径 =====
  const jobA = (getDb().prepare('SELECT * FROM render_jobs WHERE project_id = ? ORDER BY queued_at DESC LIMIT 1').get(pidA)) as RenderJobRow;
  {
    const staged = stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE);
    const expectedDest = path.join(FAKE_BUNDLE, 'public', 'runtime-audio', pidA, `${audioA.artifact.id}.wav`);
    ok(
      staged !== null && staged.stagedPath === path.resolve(expectedDest) && fs.existsSync(expectedDest),
      'W01 stage → <bundle>/public/runtime-audio/{pid}/{audioArtifactId}.wav',
      staged?.stagedPath,
    );
    ok(
      staged!.sha256 === audioA.manifest.master.sha256 && sha256File(expectedDest) === audioA.manifest.master.sha256,
      'W02 staged sha == master sha == snapshot sha',
    );
    // reuse：sha 命中不重建
    const staged2 = stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE);
    ok(staged2!.sha256 === staged!.sha256, 'W03 destination sha 命中 → reuse');
    // corrupted destination → 重建
    fs.writeFileSync(expectedDest, Buffer.alloc(100, 1));
    const staged3 = stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE);
    ok(staged3!.sha256 === audioA.manifest.master.sha256, 'W04 corrupted destination → 重建且 sha 正确');
    // legacy / preview payload → null（不进入 staging）
    const legacyProps = {...parsedPayloadOf(jobA), audio: {narration: 'full/audio/FullCut_TTS.wav', bgm: null, sfx: null}};
    ok(stageRuntimeNarrationAudio(jobA, legacyProps, FAKE_BUNDLE) === null, 'W05 legacy narration 路径 → null');
    const previewProps = {...parsedPayloadOf(jobA), audio: {narration: null, bgm: null, sfx: null}};
    ok(stageRuntimeNarrationAudio(jobA, previewProps, FAKE_BUNDLE) === null, 'W06 preview narration=null → null');
  }

  // ===== Runtime path safety =====
  {
    const base = parsedPayloadOf(jobA);
    const badPaths = [
      `runtime-audio/${pidA}/../../etc/passwd.wav`,
      `runtime-audio/${pidA}/${audioA.artifact.id}.wav/extra`,
      `runtime-audio/${pidA}/${audioA.artifact.id}.mp3`,
      `runtime-audio/${pidA}/not-a-uuid.wav`,
      `runtime-audio\\${pidA}\\${audioA.artifact.id}.wav`,
      `runtime-audio/${pidA}/${audioA.artifact.id}%2ewav`,
    ];
    const allRejected = badPaths.every((p) =>
      throwsCode(
        () => stageRuntimeNarrationAudio(jobA, {...base, audio: {...base.audio, narration: p}}, FAKE_BUNDLE),
        'RUNTIME_AUDIO_STAGE_ERROR',
      ),
    );
    ok(allRejected, 'R01 非法 runtime 路径形态（../、多 segment、非 wav、非 uuid、反斜杠、编码）全拒');
  }

  // ===== Attempt integrity =====
  {
    // job 无 attempt（手工 enqueue，不经过 Final Bridge）
    const orphanJob = enqueueRenderJob(pidA, 'fullcut', parsedPayloadOf(jobA));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(orphanJob, parsedPayloadOf(orphanJob), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'T01 job 无 attempt → 拒绝',
    );
    getDb().prepare('DELETE FROM render_jobs WHERE id = ?').run(orphanJob.id);

    // attempt 指向不存在的 source
    const attemptRow = artifactsOf(pidA, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND).at(-1)!;
    const attemptContent = JSON.parse(attemptRow.content_json) as {finalRenderSourceArtifactId: string};
    const original = attemptContent.finalRenderSourceArtifactId;
    attemptContent.finalRenderSourceArtifactId = crypto.randomUUID();
    updateArtifact(attemptRow.id, JSON.stringify(attemptContent));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'T02 attempt → 不存在 source → 拒绝',
    );
    attemptContent.finalRenderSourceArtifactId = original;
    updateArtifact(attemptRow.id, JSON.stringify(attemptContent));

    // attempt.sourceKey 与 source 不一致
    const withBadKey = JSON.parse(attemptRow.content_json) as {sourceKey: string};
    withBadKey.sourceKey = '2'.repeat(64);
    updateArtifact(attemptRow.id, JSON.stringify(withBadKey));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'T03 attempt.sourceKey 与 source 不一致 → 拒绝',
    );
    updateArtifact(attemptRow.id, attemptRow.content_json);

    // job payload 与 source.props 不一致
    const tamperedProps = parsedPayloadOf(jobA);
    tamperedProps.subtitles[0]!.text = 'payload 篡改';
    const tamperedJob = enqueueRenderJob(pidA, 'fullcut', tamperedProps);
    getDb().prepare(
      `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(version),0)+1 FROM artifacts WHERE project_id=? AND kind=?), ?, NULL, ?)`,
    ).run(
      crypto.randomUUID(), pidA, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND, pidA, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND,
      JSON.stringify({
        schemaVersion: 'final-render-attempt@1.0',
        jobId: tamperedJob.id,
        finalRenderSourceArtifactId: attemptContent.finalRenderSourceArtifactId,
        finalRenderSourceArtifactVersion: 7,
        sourceKey: '0'.repeat(64),
        propsSha256: '0'.repeat(64),
      }),
      new Date().toISOString(),
    );
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(tamperedJob, parsedPayloadOf(tamperedJob), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'T04 payload≠source.props / key 不一致 → 拒绝',
    );
    getDb().prepare('DELETE FROM render_jobs WHERE id = ?').run(tamperedJob.id);
  }

  // ===== Historical snapshot（§38，M3-E 最关键）=====
  {
    // 清理 pidA 残留 queued render job，避免污染全局 FIFO claim
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=? AND status IN ('queued','running')")
      .run(new Date().toISOString(), pidA);
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    const audioOld = getCurrentNarrationAudioArtifact(pid)!;
    const enq = enqueueFinalRender(pid);
    const job = enq.job;
    // 模拟 worker 已 claim（running）：上游随后前进
    getDb().prepare("UPDATE render_jobs SET status='running', claimed_by='w-m3e', claimed_at=?, heartbeat_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date().toISOString(), job.id);
    // Worker 执行前：上游前进 → current 链 B
    await rebuildNarrationChain(pid, SCRIPT_V2.replace('那条消息你看到了。', '那条消息你看到了。你真的看到了。'));
    await lockThrough(pid, WORKFLOW_STAGES.slice(6));
    buildTimingReconciliation(pid);
    const audioNew = getCurrentNarrationAudioArtifact(pid)!;
    ok(audioNew.artifact.id !== audioOld.artifact.id, 'H01 上游已前进（Audio B current）');
    const staged = stageRuntimeNarrationAudio(job, parsedPayloadOf(job), FAKE_BUNDLE);
    ok(
      staged !== null && staged.sha256 === audioOld.manifest.master.sha256 &&
        staged.sha256 !== audioNew.manifest.master.sha256,
      'H02 上游前进后旧 job 仍 stage historical Audio A（不切 current B）',
    );
    getDb().prepare('DELETE FROM render_jobs WHERE id = ?').run(job.id);
  }

  // ===== Audio integrity =====
  {
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    const enq = enqueueFinalRender(pid);
    const job = enq.job;
    const payload = parsedPayloadOf(job);
    const audioArt = getCurrentNarrationAudioArtifact(pid)!;
    const {content: srcContent} = currentFinalSource(pid);
    const masterAbs = path.join(getDataDir(), audioArt.manifest.master.filePath);
    const masterBackup = fs.readFileSync(masterAbs);

    const stage = (): unknown => stageRuntimeNarrationAudio(job, payload, FAKE_BUNDLE);

    // 篡改 historical manifest master sha（content 层）
    const audioRow = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(audioArt.artifact.id) as {content_json: string};
    const manifestJson = JSON.parse(audioRow.content_json) as {master: {sha256: string; durationMs: number; filePath: string}};
    const origSha = manifestJson.master.sha256;
    manifestJson.master.sha256 = '3'.repeat(64);
    updateArtifact(audioArt.artifact.id, JSON.stringify(manifestJson));
    ok(throwsCode(stage, 'NARRATION_SOURCE_INVALID'), 'I01 manifest masterSha 与 snapshot 不一致 → 拒绝');
    manifestJson.master.sha256 = origSha;

    // duration mismatch
    const origDur = manifestJson.master.durationMs;
    manifestJson.master.durationMs = origDur + 1;
    updateArtifact(audioArt.artifact.id, JSON.stringify(manifestJson));
    ok(throwsCode(stage, 'NARRATION_SOURCE_INVALID'), 'I02 manifest duration 不一致 → 拒绝');
    manifestJson.master.durationMs = origDur;
    updateArtifact(audioArt.artifact.id, JSON.stringify(manifestJson));

    // manifest bad JSON
    updateArtifact(audioArt.artifact.id, 'not json{{');
    ok(throwsCode(stage, 'NARRATION_SOURCE_INVALID'), 'I03 manifest bad JSON → 拒绝');
    // manifest bad schema
    updateArtifact(audioArt.artifact.id, JSON.stringify({schemaVersion: 'wrong'}));
    ok(throwsCode(stage, 'NARRATION_SOURCE_INVALID'), 'I04 manifest bad schema → 拒绝');
    updateArtifact(audioArt.artifact.id, audioRow.content_json);

    // source.narration.masterFilePath 路径穿越
    const srcRow = artifactsOf(pid, FINAL_RENDER_SOURCE_ARTIFACT_KIND).at(-1)!;
    const srcJson = JSON.parse(srcRow.content_json) as FinalRenderSource;
    srcJson.narration.masterFilePath = '../escape.wav';
    updateArtifact(srcRow.id, JSON.stringify(srcJson));
    ok(throwsCode(stage, 'NARRATION_SOURCE_INVALID'), 'I05 masterFilePath 穿越 → 拒绝');
    // master path 与 manifest 不一致
    srcJson.narration.masterFilePath = 'projects/other/master.wav';
    updateArtifact(srcRow.id, JSON.stringify(srcJson));
    ok(throwsCode(stage, 'NARRATION_SOURCE_INVALID'), 'I06 masterFilePath 与 manifest 不一致 → 拒绝');
    updateArtifact(srcRow.id, srcRow.content_json);

    // master file missing
    fs.rmSync(masterAbs);
    ok(throwsCode(stage, 'NARRATION_FILE_MISSING'), 'I07 master 文件缺失 → NARRATION_FILE_MISSING');
    // master <= 44 bytes
    fs.writeFileSync(masterAbs, Buffer.alloc(44));
    ok(throwsCode(stage, 'NARRATION_FILE_MISSING'), 'I08 master ≤44B → NARRATION_FILE_MISSING');
    // 实际 WAV sha 不符
    fs.writeFileSync(masterAbs, Buffer.concat([masterBackup.subarray(0, 100), Buffer.alloc(100, 9)]));
    ok(throwsCode(stage, 'NARRATION_SHA_MISMATCH'), 'I09 实际 WAV sha 不符 → NARRATION_SHA_MISMATCH');
    fs.writeFileSync(masterAbs, masterBackup);
    ok(!throwsCode(stage, 'NARRATION_SHA_MISMATCH'), 'I10 恢复后可正常 stage');

    // historical artifact version 不存在
    const srcJson2 = JSON.parse(srcRow.content_json) as FinalRenderSource;
    srcJson2.source.narrationAudioArtifactVersion = 999;
    updateArtifact(srcRow.id, JSON.stringify(srcJson2));
    // sourceKey/propsSha 与 attempt 不再一致会先触发 FINAL_RENDER_SOURCE_INVALID——改为同步篡改 attempt
    const attemptRow = artifactsOf(pid, FINAL_RENDER_ATTEMPT_ARTIFACT_KIND).at(-1)!;
    const attemptJson = JSON.parse(attemptRow.content_json) as {sourceKey: string; propsSha256: string};
    updateArtifact(attemptRow.id, JSON.stringify({...attemptJson}));
    ok(
      throwsCode(stage, 'FINAL_RENDER_SOURCE_INVALID') || throwsCode(stage, 'NARRATION_SOURCE_INVALID'),
      'I11 historical artifact version 不存在 → 拒绝',
    );
    updateArtifact(srcRow.id, srcRow.content_json);

    getDb().prepare('DELETE FROM render_jobs WHERE id = ?').run(job.id);
    void srcContent;
  }

  // ===== Bundle public root =====
  {
    const fresh = path.join('data', 'test-m3e', 'fake-bundle-2');
    fs.mkdirSync(fresh, {recursive: true});
    const root = resolveBundledPublicRoot(fresh);
    ok(
      root === path.join(path.resolve(fresh), 'public') && fs.existsSync(root),
      'B01 public 不存在时创建 <bundle>/public',
    );
    // symlink escape
    const evil = path.join('data', 'test-m3e', 'fake-bundle-3');
    const outside = path.join('data', 'test-m3e', 'outside');
    fs.mkdirSync(evil, {recursive: true});
    fs.mkdirSync(outside, {recursive: true});
    fs.symlinkSync(path.resolve(outside), path.join(evil, 'public'));
    ok(throwsCode(() => resolveBundledPublicRoot(evil), 'RUNTIME_AUDIO_STAGE_ERROR'), 'B02 public 为外部 symlink → 拒绝');
    // bundleLocation 不存在
    ok(
      throwsCode(() => resolveBundledPublicRoot(path.join('data', 'test-m3e', 'no-such-bundle')), 'RUNTIME_AUDIO_STAGE_ERROR'),
      'B03 bundleLocation 缺失 → 拒绝',
    );
  }

  // ===== Final Snapshot Integrity Hardening =====

  // H1. persisted propsSha stale → 重算拒绝（早于 historical audio lookup）
  {
    const {row} = currentFinalSource(pidA);
    const tampered = JSON.parse(row.content_json) as FinalRenderSource;
    tampered.propsSha256 = '9'.repeat(64);
    updateArtifact(row.id, JSON.stringify(tampered));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'H1 persisted propsSha256 与 props 重算不一致 → FINAL_RENDER_SOURCE_INVALID',
    );
    const tampered2 = JSON.parse(row.content_json) as FinalRenderSource;
    tampered2.props.subtitles[0]!.text = 'persisted props 篡改';
    updateArtifact(row.id, JSON.stringify(tampered2));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'H1b persisted props 被改（sha 未同步）→ FINAL_RENDER_SOURCE_INVALID',
    );
    updateArtifact(row.id, row.content_json);
  }
  // H2. sourceKey stale（metadata 改、key 不改）→ 重算拒绝（不拖到 NARRATION_SOURCE_INVALID）
  {
    const {row} = currentFinalSource(pidA);
    const tampered = JSON.parse(row.content_json) as FinalRenderSource;
    tampered.source.masterDurationMs += 1;
    updateArtifact(row.id, JSON.stringify(tampered));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'H2 source metadata tamper + stale sourceKey → FINAL_RENDER_SOURCE_INVALID（早期拒绝）',
    );
    updateArtifact(row.id, row.content_json);
  }
  // H3. Audio A→B substitution attack：metadata 全换 B 且 sourceKey 自洽，logicalPath 仍 A → 拒绝
  {
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    const audioAA = getCurrentNarrationAudioArtifact(pid)!;
    const enq = enqueueFinalRender(pid);
    const job = enq.job;
    // 模拟 worker 已 claim（running），避免全局 FIFO 先领到 render job
    getDb().prepare("UPDATE render_jobs SET status='running', claimed_by='w-m3e', claimed_at=?, heartbeat_at=? WHERE id=?")
      .run(new Date().toISOString(), new Date().toISOString(), job.id);
    await rebuildNarrationChain(pid, SCRIPT_V2.replace('那条消息你看到了。', '那条消息你看到了。你真的看到了。'));
    const audioB = getCurrentNarrationAudioArtifact(pid)!;
    ok(audioB.artifact.id !== audioAA.artifact.id, 'H3-0 项目内已有 Audio A/B 两代');
    const {row} = currentFinalSource(pid);
    const tampered = JSON.parse(row.content_json) as FinalRenderSource;
    tampered.source.narrationAudioArtifactId = audioB.artifact.id;
    tampered.source.narrationAudioArtifactVersion = audioB.artifact.version;
    tampered.source.masterSha256 = audioB.manifest.master.sha256;
    tampered.source.masterDurationMs = audioB.manifest.master.durationMs;
    tampered.narration.masterFilePath = audioB.manifest.master.filePath;
    // 用 B metadata 重算自洽 sourceKey，并同步 attempt——除 logicalPath 绑定外全部 gate 均能通过
    tampered.sourceKey = computeSourceKeyForCompilerVersion({
      compilerVersion: tampered.compilerVersion,
      projectId: pid,
      source: tampered.source,
      propsSha256: tampered.propsSha256,
    });
    updateArtifact(row.id, JSON.stringify(tampered));
    const attemptRow = attemptRowForJob(pid, job.id);
    const attemptJson = JSON.parse(attemptRow.content_json) as {sourceKey: string};
    attemptJson.sourceKey = tampered.sourceKey;
    updateArtifact(attemptRow.id, JSON.stringify(attemptJson));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(job, parsedPayloadOf(job), FAKE_BUNDLE), 'FINAL_RENDER_SOURCE_INVALID'),
      'H3 Audio A→B substitution（key 自洽、logicalPath 仍 A）→ logicalPath binding 拒绝',
    );
    const aDest = path.join(FAKE_BUNDLE, 'public', 'runtime-audio', pid, `${audioAA.artifact.id}.wav`);
    ok(
      !fs.existsSync(aDest) || sha256File(aDest) === audioAA.manifest.master.sha256,
      'H3b A 逻辑地址未被写入 B 内容',
    );
    getDb().prepare('DELETE FROM render_jobs WHERE id = ?').run(job.id);
  }
  // H4. historical source@1.0（key 按 1.0 正确计算）→ Worker 仍可执行
  {
    const {row} = currentFinalSource(pidA);
    const json = JSON.parse(row.content_json) as FinalRenderSource;
    json.compilerVersion = '1.0';
    json.sourceKey = computeSourceKeyForCompilerVersion({
      compilerVersion: '1.0',
      projectId: pidA,
      source: json.source,
      propsSha256: json.propsSha256,
    });
    updateArtifact(row.id, JSON.stringify(json));
    const attemptRow = attemptRowForJob(pidA, jobA.id);
    const attemptJson = JSON.parse(attemptRow.content_json) as {sourceKey: string};
    attemptJson.sourceKey = json.sourceKey;
    updateArtifact(attemptRow.id, JSON.stringify(attemptJson));
    const staged = stageRuntimeNarrationAudio(jobA, parsedPayloadOf(jobA), FAKE_BUNDLE);
    ok(
      staged !== null && staged.sha256 === audioA.manifest.master.sha256,
      'H4 historical source compiler 1.0 → Worker staging PASS（staged sha == master sha）',
    );
    updateArtifact(row.id, row.content_json);
    updateArtifact(attemptRow.id, attemptRow.content_json);
  }
  // H5. current 1.1 reuse 语义 + 旧 1.0 retention
  {
    const pid = newProject();
    await buildFullChain(pid, SCRIPT_V2);
    const e1 = enqueueFinalRender(pid);
    ok(!e1.sourceReused, 'H5-1 首次 Render → source@1.1 v1');
    // 模拟合法旧 1.0 source（key 按 1.0 重算自洽）
    const {row} = currentFinalSource(pid);
    const json = JSON.parse(row.content_json) as FinalRenderSource;
    json.compilerVersion = '1.0';
    json.sourceKey = computeSourceKeyForCompilerVersion({
      compilerVersion: '1.0',
      projectId: pid,
      source: json.source,
      propsSha256: json.propsSha256,
    });
    updateArtifact(row.id, JSON.stringify(json));
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=?")
      .run(new Date().toISOString(), pid);
    const e2 = enqueueFinalRender(pid);
    ok(!e2.sourceReused && e2.sourceArtifact.version === 2, 'H5-2 旧 1.0 source 不 reuse → 新 source@1.1 v2');
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=?")
      .run(new Date().toISOString(), pid);
    const e3 = enqueueFinalRender(pid);
    ok(e3.sourceReused && e3.sourceArtifact.id === e2.sourceArtifact.id, 'H5-3 同 sources → reuse source@1.1');
    const rows = artifactsOf(pid, FINAL_RENDER_SOURCE_ARTIFACT_KIND);
    const v1 = rows.find((r) => r.version === 1)!;
    ok(
      rows.length === 2 &&
        (JSON.parse(v1.content_json) as FinalRenderSource).compilerVersion === '1.0',
      'H5-4 旧 1.0 source 保留历史（不 DELETE/UPDATE）',
    );
    getDb().prepare("UPDATE render_jobs SET status='cancelled', finished_at=? WHERE project_id=?")
      .run(new Date().toISOString(), pid);
  }

  // ===== Staging symlink 防线 =====
  {
    const payloadA = parsedPayloadOf(jobA);
    // S1. public/runtime-audio → 外部 symlink
    const b1 = path.join('data', 'test-m3e', 'bundle-s1');
    const outside1 = path.join('data', 'test-m3e', 'outside-s1');
    fs.mkdirSync(path.join(b1, 'public'), {recursive: true});
    fs.mkdirSync(outside1, {recursive: true});
    fs.symlinkSync(path.resolve(outside1), path.join(b1, 'public', 'runtime-audio'));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, payloadA, b1), 'RUNTIME_AUDIO_STAGE_ERROR'),
      'S1 runtime-audio parent symlink escape → 拒绝',
    );
    ok(fs.readdirSync(outside1).length === 0, 'S1b 外部目录未产生 WAV');
    // S2. runtime-audio/{pid} → 外部 symlink
    const b2 = path.join('data', 'test-m3e', 'bundle-s2');
    const outside2 = path.join('data', 'test-m3e', 'outside-s2');
    fs.mkdirSync(path.join(b2, 'public', 'runtime-audio'), {recursive: true});
    fs.mkdirSync(outside2, {recursive: true});
    fs.symlinkSync(path.resolve(outside2), path.join(b2, 'public', 'runtime-audio', pidA));
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, payloadA, b2), 'RUNTIME_AUDIO_STAGE_ERROR'),
      'S2 project 目录 symlink escape → 拒绝',
    );
    ok(fs.readdirSync(outside2).length === 0, 'S2b 外部目录未产生 WAV');
    // S3. destination 为外部文件 symlink
    const b3 = path.join('data', 'test-m3e', 'bundle-s3');
    const outsideFile = path.join('data', 'test-m3e', 'outside-s3.wav');
    fs.mkdirSync(path.join(b3, 'public', 'runtime-audio', pidA), {recursive: true});
    fs.writeFileSync(outsideFile, Buffer.alloc(5000, 7));
    const outsideSha = sha256File(outsideFile);
    fs.symlinkSync(
      path.resolve(outsideFile),
      path.join(b3, 'public', 'runtime-audio', pidA, `${audioA.artifact.id}.wav`),
    );
    ok(
      throwsCode(() => stageRuntimeNarrationAudio(jobA, payloadA, b3), 'RUNTIME_AUDIO_STAGE_ERROR'),
      'S3 destination symlink → 拒绝（不读取/覆盖外部目标）',
    );
    ok(sha256File(outsideFile) === outsideSha, 'S3b 外部文件未被读取/覆盖');
    // S4. 正常目录 → PASS
    const b4 = path.join('data', 'test-m3e', 'bundle-s4');
    fs.mkdirSync(b4, {recursive: true});
    const staged = stageRuntimeNarrationAudio(jobA, payloadA, b4);
    ok(
      staged !== null && staged.sha256 === audioA.manifest.master.sha256,
      'S4 正常目录 stage PASS（回归）',
    );
  }

  console.log(`\nM3-E: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('M3-E 测试异常终止:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
    fs.rmSync(path.join('data', 'test-m3e'), {recursive: true, force: true});
  });

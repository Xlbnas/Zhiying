/**
 * M3-C Subtitle Timing 测试（deterministic compiler + artifact 层 + 高层 mock 闭环）。
 *
 * 用法：npx tsx scripts/test-m3c-subtitle-timing.ts
 * 使用临时数据目录（data/test-m3c），结束后清理。
 * 任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

process.env.ZHIYING_DATA_DIR = path.join('data', 'test-m3c');
process.env.LLM_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {
  enqueueNarrationAudioJobs,
  getCurrentNarrationAudioArtifact,
  NARRATION_AUDIO_ARTIFACT_KIND,
  narrationAudioManifestSchema,
  tryFinalizeNarrationAudio,
  type NarrationAudioManifest,
} from '../src/lib/narration/audio';
import {buildNarrationPlan, getCurrentNarrationPlan} from '../src/lib/narration/plan';
import type {NarrationPlan, NarrationUnit} from '../src/lib/narration/schema';
import {subtitleCueSchema} from '../src/lib/scene-schema';
import {
  AUDIO_TIMELINE_TOLERANCE_MS,
  compileSubtitleTiming,
  SubtitleCompileError,
  splitSubtitleSentences,
} from '../src/lib/subtitles/compiler';
import {formatSubtitleTimingAsSrt, toRendererSubtitleCues} from '../src/lib/subtitles/renderer';
import {
  SUBTITLE_COMPILER_VERSION,
  SUBTITLE_TIMING_ARTIFACT_KIND,
  type SubtitleTiming,
} from '../src/lib/subtitles/schema';
import {
  buildSubtitleTiming,
  checkSubtitleTimingReadiness,
  getCurrentSubtitleTiming,
  SubtitleTimingError,
} from '../src/lib/subtitles/timing';
import {enqueueWorkflowStageJob, getLlmJob} from '../src/lib/llm-jobs';
import {createProjectWithWorkflow} from '../src/lib/projects';
import {claimNextAnyJob} from '../src/lib/scheduler';
import {resetTtsProviderForTest} from '../src/lib/tts';
import type {TtsJobRow} from '../src/lib/tts-jobs';
import {runLlmJob} from '../src/worker/llm-executor';
import {runTtsJob} from '../src/worker/tts-executor';
import {editVersion} from '../src/lib/workflow/operations';
import {lockStage} from '../src/lib/workflow/stages';
import {WORKFLOW_STAGES, type WorkflowStage} from '../src/lib/workflow/types';
import {z} from 'zod';

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

function newProject(): string {
  return createProjectWithWorkflow({topic: '拖延研究', coreQuestion: '拖延只是时间管理问题吗？'})
    .project.id;
}

async function runStageOnce(pid: string, stage: WorkflowStage): Promise<void> {
  const job = enqueueWorkflowStageJob(pid, stage);
  const claimed = claimNextAnyJob('w-m3c');
  if (!claimed || claimed.type !== 'llm' || claimed.job.id !== job.id) {
    throw new Error(`claim 失败 ${stage}`);
  }
  await runLlmJob(claimed.job, CTX);
  if (getLlmJob(job.id)!.status !== 'succeeded') throw new Error(`${stage} 未成功`);
}

async function lockThroughScriptV2(pid: string): Promise<void> {
  for (const stage of WORKFLOW_STAGES.slice(0, 6)) {
    await runStageOnce(pid, stage);
    lockStage(pid, stage);
  }
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
    const claimed = claimNextAnyJob('w-m3c');
    if (!claimed) break;
    if (claimed.type !== 'tts') throw new Error(`意外 job 类型 ${claimed.type}`);
    if ((claimed.job as TtsJobRow).project_id !== pid) throw new Error('意外拿到其他项目 tts job');
    await runTtsJob(claimed.job as TtsJobRow, CTX);
  }
}

/** 正式高层链：Workflow → Script V2 locked → Plan → Audio（worker mock）→ finalize。 */
async function buildProjectWithAudio(pid: string, script: string): Promise<void> {
  await lockThroughScriptV2(pid);
  setScriptV2(pid, script);
  buildNarrationPlan(pid);
  enqueueNarrationAudioJobs(pid);
  await runAllTtsJobs(pid);
  const manifest = tryFinalizeNarrationAudio(pid);
  if (!manifest) throw new Error('audio finalize 失败');
}

function subtitleArtifactRows(pid: string): Array<{id: string; version: number; content_json: string}> {
  return getDb()
    .prepare(`SELECT * FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY version DESC`)
    .all(pid, SUBTITLE_TIMING_ARTIFACT_KIND) as Array<{id: string; version: number; content_json: string}>;
}

// ---------- 纯 compiler fixture ----------

const uid = (n: number): string => `N${String(n).padStart(3, '0')}`;

function speechUnit(n: number, text: string, chapter = 1): NarrationUnit {
  return {id: uid(n), chapter, kind: 'speech', text, directive: null, pauseMs: null, evidenceIds: [], sourceText: text};
}
function pauseUnit(n: number, pauseMs: number | null, chapter = 1): NarrationUnit {
  return {id: uid(n), chapter, kind: 'pause', text: null, directive: pauseMs === null ? '停顿' : null, pauseMs, evidenceIds: [], sourceText: ''};
}
function breathUnit(n: number, chapter = 1): NarrationUnit {
  return {id: uid(n), chapter, kind: 'visual_breath', text: null, directive: null, pauseMs: null, evidenceIds: [], sourceText: ''};
}
function prosodyUnit(n: number, chapter = 1): NarrationUnit {
  return {id: uid(n), chapter, kind: 'prosody', text: null, directive: '放慢', pauseMs: null, evidenceIds: [], sourceText: ''};
}

function fakePlan(units: NarrationUnit[]): NarrationPlan {
  return {units} as unknown as NarrationPlan;
}

function fakeManifest(
  units: NarrationUnit[],
  speechDurations: Record<string, number>,
  masterDurationMs: number,
): NarrationAudioManifest {
  return {
    source: {scriptV2Version: 1, compilerVersion: '1.1'},
    units: units.map((unit) => {
      if (unit.kind === 'speech') {
        return {unitId: unit.id, kind: 'speech', text: unit.text, durationMs: speechDurations[unit.id]!};
      }
      if (unit.kind === 'pause') {
        return {unitId: unit.id, kind: 'pause', durationMs: unit.pauseMs, resolved: unit.pauseMs !== null};
      }
      if (unit.kind === 'visual_breath') {
        return {unitId: unit.id, kind: 'visual_breath'};
      }
      return {unitId: unit.id, kind: 'prosody', directive: unit.directive};
    }),
    master: {durationMs: masterDurationMs, sha256: 'fake-sha'},
  } as unknown as NarrationAudioManifest;
}

function compile(
  units: NarrationUnit[],
  speechDurations: Record<string, number>,
  masterDurationMs: number,
): SubtitleTiming {
  return compileSubtitleTiming({
    plan: fakePlan(units),
    manifest: fakeManifest(units, speechDurations, masterDurationMs),
    narrationAudioArtifactId: 'audio-artifact-1',
    narrationAudioArtifactVersion: 1,
    narrationPlanArtifactId: 'plan-artifact-1',
    narrationPlanArtifactVersion: 1,
  });
}

function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return (
      (err instanceof SubtitleCompileError || err instanceof SubtitleTimingError) &&
      err.code === code
    );
  }
}

async function main(): Promise<void> {
  resetTtsProviderForTest();

  // ===== §四十一 Compiler Tests =====

  // 1. 单句 speech → 1 cue
  {
    const t = compile([speechUnit(1, '这是第一句话。')], {N001: 1240}, 1240);
    ok(t.cues.length === 1 && t.cues[0]!.text === '这是第一句话。', '01 单句 speech → 1 cue');
  }
  // 2. 两句 speech → 2 cues
  {
    const t = compile([speechUnit(1, '这是第一句话。这是第二句话？')], {N001: 3000}, 3000);
    ok(t.cues.length === 2, '02 两句 speech → 2 cues');
  }
  // 3. 中文 。！？
  {
    const s = splitSubtitleSentences('甲。乙！丙？');
    ok(s.length === 3 && s[0] === '甲。' && s[1] === '乙！' && s[2] === '丙？', '03 中文 。！？ 切分');
  }
  // 4. ASCII !?
  {
    const s = splitSubtitleSentences('Hello! Really?');
    ok(s.length === 2 && s[0] === 'Hello!' && s[1] === 'Really?', '04 ASCII !? 切分');
  }
  // 5. ；;
  {
    const s = splitSubtitleSentences('甲；乙;丙。');
    ok(s.length === 3 && s[0] === '甲；' && s[1] === '乙;' && s[2] === '丙。', '05 ；; 视为句界');
  }
  // 6. 无终止符 → 单 cue
  {
    const t = compile([speechUnit(1, '没有终止符的句子')], {N001: 2000}, 2000);
    ok(t.cues.length === 1 && t.cues[0]!.text === '没有终止符的句子', '06 无终止符 → 单 cue');
  }
  // 7. 标点保留在前一句
  {
    const t = compile([speechUnit(1, '第一句。第二句。')], {N001: 2000}, 2000);
    ok(t.cues[0]!.text.endsWith('。') && t.cues[1]!.text.endsWith('。'), '07 标点保留在前一句');
  }
  // 8. cue id 1…N 连续
  {
    const t = compile(
      [speechUnit(1, '甲。乙。'), speechUnit(2, '丙。')],
      {N001: 2000, N002: 1000},
      3000,
    );
    ok(t.cues.map((c) => c.id).join(',') === '1,2,3', '08 cue id 1…N 连续');
  }
  // 9. segmentId deterministic
  {
    const t = compile(
      [speechUnit(1, '甲。乙。'), speechUnit(2, '丙。')],
      {N001: 2000, N002: 1000},
      3000,
    );
    ok(
      t.cues.map((c) => c.segmentId).join(',') === 'N001:S01,N001:S02,N002:S01',
      '09 segmentId deterministic（N001:S01…）',
    );
  }
  // 10. repeated compile byte-stable
  {
    const units = [speechUnit(1, '甲。乙。'), pauseUnit(2, 500), speechUnit(3, '丙？')];
    const d = {N001: 2000, N003: 1000};
    const a = JSON.stringify(compile(units, d, 3500));
    const b = JSON.stringify(compile(units, d, 3500));
    ok(a === b, '10 repeated compile byte-stable');
  }

  // ===== §四十二 Allocation Tests =====

  // 11. 单 cue 完整占 unit duration
  {
    const t = compile([speechUnit(1, '唯一句。')], {N001: 1240}, 1240);
    ok(t.cues[0]!.startMs === 0 && t.cues[0]!.endMs === 1240, '11 单 cue 完整占 unit duration');
  }
  // 12. 两 cue 按文本 weight 分配（weight 2:4 = 1:2）
  {
    const t = compile([speechUnit(1, '甲。甲乙丙。')], {N001: 3000}, 3000);
    ok(
      t.cues[0]!.startMs === 0 && t.cues[0]!.endMs === 1000 &&
        t.cues[1]!.startMs === 1000 && t.cues[1]!.endMs === 3000,
      '12 两 cue 按文本 weight 比例分配',
      t.cues.map((c) => [c.startMs, c.endMs]),
    );
  }
  // 13. first start = unit start（非零起点：pause 之后的 speech）
  {
    const t = compile(
      [pauseUnit(1, 1000), speechUnit(2, '甲。乙。')],
      {N002: 2000},
      3000,
    );
    ok(t.cues[0]!.startMs === 1000, '13 first cue start = unit start');
  }
  // 14. last end = unit end
  {
    const t = compile([speechUnit(1, '甲。乙。丙。')], {N001: 1000}, 1000);
    ok(t.cues[t.cues.length - 1]!.endMs === 1000, '14 last cue end = unit end');
  }
  // 15. 无 rounding drift（多句累计时长 == unit duration）
  {
    const t = compile([speechUnit(1, '甲。乙丙。丁戊己。')], {N001: 1000}, 1000);
    const sum = t.cues.reduce((s, c) => s + (c.endMs - c.startMs), 0);
    ok(sum === 1000 && t.cues[0]!.startMs === 0 && t.cues[t.cues.length - 1]!.endMs === 1000, '15 cumulative 分配无 rounding drift');
  }
  // 16. cues 不 overlap / 17. cues monotonic
  {
    const t = compile(
      [speechUnit(1, '甲。乙。'), pauseUnit(2, 500), speechUnit(3, '丙。丁。')],
      {N001: 2000, N003: 2000},
      4500,
    );
    const noOverlap = t.cues.every((c, i) => i === 0 || c.startMs >= t.cues[i - 1]!.endMs);
    const monotonic = t.cues.every((c, i) => i === 0 || c.startMs > t.cues[i - 1]!.startMs);
    ok(noOverlap, '16 cues 不 overlap');
    ok(monotonic, '17 cues monotonic');
  }
  // 18. 极短非法 timing → reject（1ms 两等重句：第二句 end<=start）
  {
    ok(
      throwsCode(() => compile([speechUnit(1, '甲。乙。')], {N001: 1}, 1), 'SUBTITLE_TIMING_INVALID'),
      '18 极短非法 timing → SUBTITLE_TIMING_INVALID（不 silent autofix）',
    );
  }

  // ===== §四十三 Global Timeline Tests =====

  // 19. speech → cursor 前进
  {
    const t = compile(
      [speechUnit(1, '甲。'), speechUnit(2, '乙。')],
      {N001: 1000, N002: 800},
      1800,
    );
    ok(t.cues[1]!.startMs === 1000 && t.cues[1]!.endMs === 1800, '19 speech → cursor 前进');
  }
  // 20. explicit pause → cursor 前进且无 cue
  {
    const t = compile(
      [speechUnit(1, '甲。'), pauseUnit(2, 500), speechUnit(3, '乙。')],
      {N001: 1000, N003: 800},
      2300,
    );
    ok(
      t.cues.length === 2 && t.cues[1]!.startMs === 1500 && !t.unresolvedUnitIds.includes('N002'),
      '20 explicit pause → cursor 前进且无 cue',
    );
  }
  // 21. unresolved pause → cursor 不变 + unresolved
  {
    const t = compile(
      [speechUnit(1, '甲。'), pauseUnit(2, null), speechUnit(3, '乙。')],
      {N001: 1000, N003: 800},
      1800,
    );
    ok(
      t.unresolvedUnitIds.includes('N002') && t.cues[1]!.startMs === 1000,
      '21 unresolved pause → cursor 不变 + unresolvedUnitIds',
    );
  }
  // 22. visual_breath → cursor 不变 + unresolved
  {
    const t = compile(
      [speechUnit(1, '甲。'), breathUnit(2), speechUnit(3, '乙。')],
      {N001: 1000, N003: 800},
      1800,
    );
    ok(
      t.unresolvedUnitIds.includes('N002') && t.cues[1]!.startMs === 1000,
      '22 visual_breath → cursor 不变 + unresolvedUnitIds',
    );
  }
  // 23. prosody → cursor 不变（且不记 unresolved）
  {
    const t = compile(
      [speechUnit(1, '甲。'), prosodyUnit(2), speechUnit(3, '乙。')],
      {N001: 1000, N003: 800},
      1800,
    );
    ok(
      t.cues[1]!.startMs === 1000 && t.unresolvedUnitIds.length === 0,
      '23 prosody → cursor 不变',
    );
  }
  // 24. final cursor ≈ master duration（容差内放行）
  {
    const t = compile([speechUnit(1, '甲。')], {N001: 1240}, 1240 + AUDIO_TIMELINE_TOLERANCE_MS - 10);
    ok(t.cues.length === 1, '24 final cursor ≈ master duration（容差内）');
  }
  // 25. mismatch >100ms → AUDIO_TIMELINE_MISMATCH
  {
    ok(
      throwsCode(
        () => compile([speechUnit(1, '甲。')], {N001: 1240}, 1240 + AUDIO_TIMELINE_TOLERANCE_MS + 100),
        'AUDIO_TIMELINE_MISMATCH',
      ),
      '25 mismatch >100ms → AUDIO_TIMELINE_MISMATCH',
    );
  }

  // ===== Hardening 1：symmetric tolerance contract（schema 与 compiler 同常量）=====

  // H1-1. cursor=1240 / master=1330（+90ms）→ PASS
  {
    const t = compile([speechUnit(1, '甲。')], {N001: 1240}, 1330);
    ok(t.cues.length === 1 && t.cues[0]!.endMs === 1240, 'H1-1 +90ms（cursor<master）→ PASS');
  }
  // H1-2. cursor=1240 / master=1150（-90ms）→ PASS（cue end 允许超 master ≤ tolerance）
  {
    const t = compile([speechUnit(1, '甲。')], {N001: 1240}, 1150);
    ok(
      t.cues.length === 1 && t.cues[0]!.endMs === 1240 && t.source.masterDurationMs === 1150,
      'H1-2 -90ms（cursor>master，cue end 超 master 90ms ≤ tolerance）→ PASS',
    );
  }
  // H1-3. +101ms → AUDIO_TIMELINE_MISMATCH
  {
    ok(
      throwsCode(() => compile([speechUnit(1, '甲。')], {N001: 1240}, 1341), 'AUDIO_TIMELINE_MISMATCH'),
      'H1-3 +101ms → AUDIO_TIMELINE_MISMATCH',
    );
  }
  // H1-4. -101ms → AUDIO_TIMELINE_MISMATCH
  {
    ok(
      throwsCode(() => compile([speechUnit(1, '甲。')], {N001: 1240}, 1139), 'AUDIO_TIMELINE_MISMATCH'),
      'H1-4 -101ms → AUDIO_TIMELINE_MISMATCH',
    );
  }
  // H1-5. exact ±100ms boundary → PASS（含边界）
  {
    const plus = compile([speechUnit(1, '甲。')], {N001: 1240}, 1340);
    const minus = compile([speechUnit(1, '甲。')], {N001: 1240}, 1140);
    ok(
      plus.cues.length === 1 && minus.cues.length === 1,
      'H1-5 exact ±100ms boundary → PASS（含边界）',
    );
  }

  // ===== Hardening 2：Manifest ↔ Plan 语义一致性（schema-valid fixture）=====

  /** 构造 schema-valid manifest（证明测试针对 semantic corruption 而非 Zod shape error）。 */
  function validManifest(
    units: NarrationUnit[],
    speechDurations: Record<string, number>,
    masterDurationMs: number,
  ): NarrationAudioManifest {
    return narrationAudioManifestSchema.parse({
      schemaVersion: 'narration-audio@1.0',
      source: {
        narrationPlanArtifactId: 'plan-artifact-1',
        narrationPlanArtifactVersion: 1,
        scriptV2Version: 1,
        compilerVersion: '1.1',
      },
      provider: {
        name: 'mock',
        model: 'mock-tone-v1',
        providerVersion: null,
        providerCommit: 'mock-deterministic',
        voiceProfile: {id: 'default', revision: '1'},
        useRandom: false,
      },
      units: units.map((unit) => {
        if (unit.kind === 'speech') {
          return {
            unitId: unit.id, kind: 'speech', text: unit.text,
            filePath: 'projects/p/audio/u.wav', durationMs: speechDurations[unit.id]!,
            sampleRate: 48000, channels: 1, sha256: 's', ttsJobId: 'j',
          };
        }
        if (unit.kind === 'pause') {
          return {
            unitId: unit.id, kind: 'pause', directive: unit.directive,
            durationMs: unit.pauseMs, resolved: unit.pauseMs !== null,
          };
        }
        if (unit.kind === 'visual_breath') {
          return {unitId: unit.id, kind: 'visual_breath', durationMs: null, resolved: false};
        }
        return {unitId: unit.id, kind: 'prosody', directive: unit.directive, appliedToTts: false};
      }),
      master: {
        filePath: 'projects/p/audio/master.wav', durationMs: masterDurationMs,
        sha256: 'fake-sha', sampleRate: 48000, channels: 1,
      },
    });
  }

  function compileValid(
    units: NarrationUnit[],
    manifest: NarrationAudioManifest,
  ): SubtitleTiming {
    return compileSubtitleTiming({
      plan: fakePlan(units),
      manifest,
      narrationAudioArtifactId: 'audio-artifact-1',
      narrationAudioArtifactVersion: 1,
      narrationPlanArtifactId: 'plan-artifact-1',
      narrationPlanArtifactVersion: 1,
    });
  }

  // H2-0. 完全匹配（schema-valid）→ 正常通过
  {
    const units = [speechUnit(1, '甲。'), pauseUnit(2, 500), speechUnit(3, '乙。'), prosodyUnit(4), breathUnit(5)];
    const m = validManifest(units, {N001: 1000, N003: 800}, 2300);
    const t = compileValid(units, m);
    ok(
      t.cues.length === 2 && JSON.stringify(t.unresolvedUnitIds) === JSON.stringify(['N005']),
      'H2-0 Manifest↔Plan 完全匹配 → 正常通过',
    );
  }
  // H2-1. speech text mismatch（schema-valid 但语义损坏）→ NARRATION_AUDIO_INVALID
  {
    const units = [speechUnit(1, '甲。')];
    const m = validManifest(units, {N001: 1000}, 1000);
    (m.units[0] as {text: string}).text = '被篡改的文本。';
    narrationAudioManifestSchema.parse(m); // 仍是 schema-valid
    ok(
      throwsCode(() => compileValid(units, m), 'NARRATION_AUDIO_INVALID'),
      'H2-1 speech text mismatch → NARRATION_AUDIO_INVALID',
    );
  }
  // H2-2. explicit pause duration mismatch → NARRATION_AUDIO_INVALID
  {
    const units = [speechUnit(1, '甲。'), pauseUnit(2, 500), speechUnit(3, '乙。')];
    const m = validManifest(units, {N001: 1000, N003: 800}, 2400); // master 与篡改后 cursor 一致，隔离语义错误
    (m.units[1] as {durationMs: number}).durationMs = 600;
    narrationAudioManifestSchema.parse(m);
    ok(
      throwsCode(() => compileValid(units, m), 'NARRATION_AUDIO_INVALID'),
      'H2-2 pause duration mismatch → NARRATION_AUDIO_INVALID',
    );
  }
  // H2-3. pause resolved mismatch（duration 一致但 resolved 标记错）→ NARRATION_AUDIO_INVALID
  {
    const units = [speechUnit(1, '甲。'), pauseUnit(2, 500), speechUnit(3, '乙。')];
    const m = validManifest(units, {N001: 1000, N003: 800}, 2300);
    (m.units[1] as {resolved: boolean}).resolved = false;
    narrationAudioManifestSchema.parse(m);
    ok(
      throwsCode(() => compileValid(units, m), 'NARRATION_AUDIO_INVALID'),
      'H2-3 pause resolved mismatch → NARRATION_AUDIO_INVALID',
    );
  }
  // H2-4. prosody directive mismatch → NARRATION_AUDIO_INVALID
  {
    const units = [speechUnit(1, '甲。'), prosodyUnit(2), speechUnit(3, '乙。')];
    const m = validManifest(units, {N001: 1000, N003: 800}, 1800);
    (m.units[1] as {directive: string}).directive = '加重';
    narrationAudioManifestSchema.parse(m);
    ok(
      throwsCode(() => compileValid(units, m), 'NARRATION_AUDIO_INVALID'),
      'H2-4 prosody directive mismatch → NARRATION_AUDIO_INVALID',
    );
  }

  // ===== Hardening 4：闭引号分句（deterministic，无 NLP）=====

  // H4-1. 中文双引号：终止符后的 ” 跟随前一句
  {
    const s = splitSubtitleSentences('他说：“你好。”然后走了。');
    ok(
      s.length === 2 && s[0] === '他说：“你好。”' && s[1] === '然后走了。',
      'H4-1 中文双引号闭引号跟随前一句',
      s,
    );
  }
  // H4-2. ASCII quote 同理
  {
    const s = splitSubtitleSentences('甲说"你好。"乙。');
    ok(s.length === 2 && s[0] === '甲说"你好。"' && s[1] === '乙。', 'H4-2 ASCII quote 闭引号跟随前一句', s);
  }
  // H4-3. compile 级：引号句 → 2 cues 且文本正确
  {
    const t = compile([speechUnit(1, '他说：“你好。”然后走了。')], {N001: 2000}, 2000);
    ok(
      t.cues.length === 2 && t.cues[0]!.text === '他说：“你好。”' && t.cues[1]!.text === '然后走了。',
      'H4-3 compile 级引号分句 → 2 cues',
    );
  }
  // H4-4. compilerVersion 升级标记（Hardening 语义变化 → 1.1）
  ok(SUBTITLE_COMPILER_VERSION === '1.1', 'H4-4 compilerVersion 升级为 1.1');

  // ===== §四十七 高层 mock 闭环（Workflow → … → Audio ready）=====

  const pidA = newProject();
  await buildProjectWithAudio(pidA, SCRIPT_V2);
  const audioA = getCurrentNarrationAudioArtifact(pidA);
  ok(audioA !== null, 'setup A Narration Audio ready（高层链）');
  if (!audioA) throw new Error('setup 失败');

  // 26. audio missing → NARRATION_AUDIO_NOT_READY
  {
    const pid = newProject();
    await lockThroughScriptV2(pid);
    setScriptV2(pid, SCRIPT_V2);
    buildNarrationPlan(pid);
    ok(
      throwsCode(() => buildSubtitleTiming(pid), 'NARRATION_AUDIO_NOT_READY'),
      '26 audio missing → NARRATION_AUDIO_NOT_READY',
    );
  }
  // 28. master 缺失 → not ready（master 文件真实性防线）
  {
    const pid = newProject();
    await buildProjectWithAudio(pid, SCRIPT_V2);
    const audio = getCurrentNarrationAudioArtifact(pid)!;
    fs.rmSync(path.join(getDataDir(), audio.manifest.master.filePath), {force: true});
    ok(getCurrentNarrationAudioArtifact(pid) === null, '28a master 缺失 → manifest 不再 current');
    ok(
      throwsCode(() => buildSubtitleTiming(pid), 'NARRATION_AUDIO_NOT_READY'),
      '28b master 缺失 → NARRATION_AUDIO_NOT_READY',
    );
  }

  // 33. first build → new artifact
  const buildA1 = buildSubtitleTiming(pidA);
  ok(!buildA1.reused && buildA1.artifact.version === 1, '33 first build → new artifact');

  const timingA = buildA1.timing;

  // 47/48. 高层闭环验收：ready + cue count>0 + timeline==master（容差内）
  {
    const readiness = checkSubtitleTimingReadiness(pidA);
    ok(readiness.status === 'ready' && readiness.cueCount > 0, '47 高层闭环 → Subtitle ready + cue count > 0');
    ok(
      readiness.timelineDurationMs !== null &&
        Math.abs(readiness.timelineDurationMs - audioA.manifest.master.durationMs) <= AUDIO_TIMELINE_TOLERANCE_MS,
      '48 timeline duration == narration master duration（±tolerance）',
    );
  }

  // 29. source artifact id/version 正确
  ok(
    timingA.source.narrationAudioArtifactId === audioA.artifact.id &&
      timingA.source.narrationAudioArtifactVersion === audioA.artifact.version,
    '29 source audio artifact id/version 正确',
  );
  // 30. master sha256 snapshot 正确
  ok(timingA.source.masterSha256 === audioA.manifest.master.sha256, '30 master sha256 snapshot 正确');
  // 31. chapter 从 Narration Plan unit 来（N005 属第 2 章）
  {
    const cue = timingA.cues.find((c) => c.unitId === 'N005');
    ok(cue?.chapter === 2, '31 chapter 取自 Narration Plan unit', cue);
  }
  // 32. Evidence 不泄漏进 cue text
  ok(
    timingA.cues.every((c) => !c.text.includes('E01') && !c.text.includes('<!--')),
    '32 Evidence 不泄漏进 cue text',
  );
  // 附加：unresolved = visual_breath N004；prosody N006 不在内
  ok(
    JSON.stringify(timingA.unresolvedUnitIds) === JSON.stringify(['N004']),
    '附加 高层链 unresolved 仅含 visual_breath（N004）',
    timingA.unresolvedUnitIds,
  );
  // 附加：多句 unit（N003）拆成 2 cues 且覆盖 unit 全时长
  {
    const cues = timingA.cues.filter((c) => c.unitId === 'N003');
    const mUnit = audioA.manifest.units.find((u) => u.unitId === 'N003');
    const dur = mUnit && mUnit.kind === 'speech' ? mUnit.durationMs : -1;
    ok(
      cues.length === 2 && cues[1]!.endMs - cues[0]!.startMs === dur,
      '附加 高层链多句 unit → 2 cues 覆盖实测时长',
    );
  }

  // 34. second same source/compiler → reused
  {
    const build2 = buildSubtitleTiming(pidA);
    ok(build2.reused && build2.artifact.id === buildA1.artifact.id, '34 second build → idempotent reuse');
  }

  // ===== §四十六 Renderer Compatibility Tests =====
  {
    const rendererCues = toRendererSubtitleCues(timingA);
    ok(rendererCues.length === timingA.cues.length, '42 toRendererSubtitleCues 输出数量一致');
    const parsed = z.array(subtitleCueSchema).safeParse(rendererCues);
    ok(parsed.success, '43 全部通过 subtitleCueSchema');
    const first = rendererCues[0]!;
    const firstMs = timingA.cues[0]!;
    ok(
      first.start === firstMs.startMs / 1000 && first.end === firstMs.endMs / 1000,
      '44 start/end 秒值正确（ms/1000）',
    );
    ok(rendererCues.every((c) => c.position === 'bottom'), '45 position=bottom');
    ok(
      rendererCues.every((c) => /^N\d{3}:S\d{2}$/.test(c.segmentId)),
      '46 segmentId 稳定（renderer 侧）',
    );
  }

  // SRT（§三十六 pure 派生，非 truth）
  {
    const srt = formatSubtitleTimingAsSrt(timingA);
    ok(
      srt.includes('-->') && /^\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(srt),
      '附加 SRT 派生格式正确',
    );
  }

  // ===== §四十八 Stale QA：Script V2 前进 → 全链 stale → 重建 =====

  // 27. audio stale → reject（plan 不再 current）
  setScriptV2(pidA, SCRIPT_V2.replace('那条消息你看到了。', '那条消息你看到了。你真的看到了。'));
  ok(getCurrentNarrationPlan(pidA) === null, '49a Script 前进 → Narration Plan stale');
  ok(getCurrentNarrationAudioArtifact(pidA) === null, '49b Script 前进 → Narration Audio 不再 current');
  ok(
    throwsCode(() => buildSubtitleTiming(pidA), 'NARRATION_PLAN_NOT_CURRENT'),
    '27 audio stale（plan not current）→ NARRATION_PLAN_NOT_CURRENT',
  );
  ok(
    checkSubtitleTimingReadiness(pidA).status === 'stale',
    '49c Script 前进 → Subtitle A stale（不显示为 current）',
  );

  // 重建链 B：Plan B → Audio B → Subtitle B
  buildNarrationPlan(pidA);
  enqueueNarrationAudioJobs(pidA);
  await runAllTtsJobs(pidA);
  if (!tryFinalizeNarrationAudio(pidA)) throw new Error('audio B finalize 失败');
  const audioB = getCurrentNarrationAudioArtifact(pidA)!;
  ok(audioB.artifact.id !== audioA.artifact.id, 'setup B 新 audio artifact');

  // 35. audio source 前进 → 旧 subtitles stale（build 前的 readiness）
  ok(
    checkSubtitleTimingReadiness(pidA).status === 'stale' &&
      getCurrentSubtitleTiming(pidA) === null,
    '35 audio source 前进 → old subtitles stale',
  );
  // 36. rebuild → new artifact
  const buildB = buildSubtitleTiming(pidA);
  ok(
    !buildB.reused && buildB.artifact.id !== buildA1.artifact.id,
    '36 rebuild → new artifact',
  );
  // 37. old artifact retained
  {
    const rows = subtitleArtifactRows(pidA);
    ok(
      rows.length === 2 && rows.some((r) => r.id === buildA1.artifact.id),
      '37 old subtitle artifact retained（历史不删除）',
    );
  }
  // 50. Subtitle B ready + A retained
  {
    const readiness = checkSubtitleTimingReadiness(pidA);
    ok(
      readiness.status === 'ready' && readiness.sourceAudio?.artifactId === audioB.artifact.id,
      '50 重建链 → Subtitle B ready（A 保留为历史）',
    );
  }

  // 38. compiler 旧版本 → stale
  {
    const pid = newProject();
    await buildProjectWithAudio(pid, SCRIPT_V2);
    const built = buildSubtitleTiming(pid);
    const row = subtitleArtifactRows(pid)[0]!;
    const json = JSON.parse(row.content_json) as {compilerVersion: string};
    json.compilerVersion = '0.9';
    getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), row.id);
    ok(
      checkSubtitleTimingReadiness(pid).status === 'stale' && getCurrentSubtitleTiming(pid) === null,
      '38 compiler 旧版本 → stale（source 不变也失效）',
    );
    void built;
  }

  // 39/40/41. corrupted / wrong schema / invalid cues → skip，不 crash 不 current
  {
    const pid = newProject();
    await buildProjectWithAudio(pid, SCRIPT_V2);
    const insert = (content: string): void => {
      getDb()
        .prepare(
          `INSERT INTO artifacts (id, project_id, kind, version, content_json, file_path, created_at)
           VALUES (?, ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM artifacts WHERE project_id = ? AND kind = ?), ?, NULL, ?)`,
        )
        .run(crypto.randomUUID(), pid, SUBTITLE_TIMING_ARTIFACT_KIND, pid, SUBTITLE_TIMING_ARTIFACT_KIND, content, new Date().toISOString());
    };
    insert('not json at all');
    insert(JSON.stringify({schemaVersion: 'wrong', cues: []}));
    const good = buildSubtitleTiming(pid);
    const badCues = JSON.parse(JSON.stringify(good.timing)) as SubtitleTiming;
    badCues.cues[0]!.endMs = badCues.cues[0]!.startMs; // endMs <= startMs 非法
    insert(JSON.stringify(badCues));
    const readiness = checkSubtitleTimingReadiness(pid);
    ok(
      readiness.status === 'ready' && readiness.artifactVersion === good.artifact.version,
      '39/40 corrupted JSON + wrong schema 被 skip（good artifact 仍 current）',
    );
    ok(
      getCurrentSubtitleTiming(pid)?.artifact.id === good.artifact.id,
      '41 invalid cue schema 被 skip（不认作 current）',
    );
  }

  // ===== Hardening 3：source snapshot provenance 篡改 → 不认 current / 不复用 =====
  {
    const pid = newProject();
    await buildProjectWithAudio(pid, SCRIPT_V2);
    buildSubtitleTiming(pid); // 初始合法 artifact
    const tampers: Array<[string, (json: {source: Record<string, unknown>}) => void]> = [
      ['narrationPlanArtifactId', (j) => { j.source.narrationPlanArtifactId = 'tampered-plan-id'; }],
      ['narrationPlanArtifactVersion', (j) => { j.source.narrationPlanArtifactVersion = 999; }],
      ['scriptV2Version', (j) => { j.source.scriptV2Version = 999; }],
      ['narrationCompilerVersion', (j) => { j.source.narrationCompilerVersion = '9.9'; }],
      ['masterDurationMs', (j) => { j.source.masterDurationMs = 999999; }],
    ];
    let allNotCurrent = true;
    let allNoReuse = true;
    for (const [field, tamper] of tampers) {
      const row = subtitleArtifactRows(pid)[0]!; // 最新合法 artifact
      const json = JSON.parse(row.content_json) as {source: Record<string, unknown>};
      tamper(json);
      getDb().prepare('UPDATE artifacts SET content_json = ? WHERE id = ?').run(JSON.stringify(json), row.id);
      // schema 仍合法（provenance 损坏而非 shape 损坏），但绝不认 current
      if (getCurrentSubtitleTiming(pid) !== null) allNotCurrent = false;
      const rebuilt = buildSubtitleTiming(pid);
      if (rebuilt.reused || rebuilt.artifact.id === row.id) allNoReuse = false;
    }
    ok(allNotCurrent, 'H3-1 五种 provenance 篡改（schema-valid）→ getCurrentSubtitleTiming 均不认 current');
    ok(allNoReuse, 'H3-2 五种 provenance 篡改 → build 均不 reuse，创建新合法 artifact');
    const rows = subtitleArtifactRows(pid);
    ok(
      rows.length === tampers.length + 1 && getCurrentSubtitleTiming(pid) !== null,
      'H3-3 被篡改 artifact 全部保留为历史（不 DELETE），新 artifact current',
      rows.length,
    );
  }

  console.log(`\nM3-C: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('M3-C 测试异常终止:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
    fs.rmSync(path.join('data', 'test-m3c'), {recursive: true, force: true});
  });

/**
 * M7.1 Subtitle Compiler V2 测试（纯函数，零真实 API 成本，不触数据库）。
 *
 * 用法：npx tsx scripts/test-m71-subtitle.ts
 * 覆盖：cue 唯一来源 subtitleText、null/silence 不产生 cue、
 * 禁止 spokenText/sourceText fallback、manifest↔plan 一致性硬校验、
 * conservation invariant、时间轴容差。任一断言失败即非零退出。
 */

import {
  narrationAudioManifestV2Schema,
  type NarrationAudioManifestV2,
} from '../src/lib/narration/audio-v2-manifest';
import {compileNarrationPlanV2} from '../src/lib/narration/compiler-v2';
import {narrationPlanV2Schema, type NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {compileSubtitleTimingV2, SubtitleV2CompileError} from '../src/lib/subtitles/compiler-v2';
import {subtitleTimingV2Schema} from '../src/lib/subtitles/schema-v2';

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

const DSL = `# Script V2

## 第 1 章 T（00:00–01:00）

@delivery slow
第一句。第二句。
@pause 500ms
第三句。
`;

function compilePlan(): NarrationPlanV2 {
  return compileNarrationPlanV2({
    scriptV2Markdown: DSL,
    scriptV2VersionId: 'version-id-1',
    scriptV2Version: 1,
    scriptV2PromptVersion: 'script-v2@2.0',
    inputMode: 'strict',
  });
}

/** 深拷贝 plan 并改 unit 字段后重新过 schema（保持 fixture 合法）。 */
function mutatePlan(plan: NarrationPlanV2, mutate: (raw: {
  units: Array<Record<string, unknown>>;
}) => void): NarrationPlanV2 {
  const raw = JSON.parse(JSON.stringify(plan)) as {units: Array<Record<string, unknown>>};
  mutate(raw);
  return narrationPlanV2Schema.parse(raw);
}

const SPEECH_DURATION_MS = 2000;

function manifestFor(
  plan: NarrationPlanV2,
  overrides: {
    spokenTextByUnit?: Record<string, string>;
    silenceDurationMs?: number;
    masterDurationMs?: number;
  } = {},
): NarrationAudioManifestV2 {
  const units = plan.units.map((unit) => {
    if (unit.kind === 'speech') {
      return {
        unitId: unit.id,
        kind: 'speech' as const,
        spokenText: overrides.spokenTextByUnit?.[unit.id] ?? unit.spokenText,
        delivery: unit.delivery,
        ttsInputFingerprint: `sha256:${'b'.repeat(64)}`,
        filePath: `${unit.id}.wav`,
        durationMs: SPEECH_DURATION_MS,
        sampleRate: 44100,
        channels: 1,
        sha256: 'audiosha',
        ttsJobId: `job-${unit.id}`,
      };
    }
    return {
      unitId: unit.id,
      kind: 'silence' as const,
      durationMs: overrides.silenceDurationMs ?? unit.durationMs,
      reason: unit.reason,
    };
  });
  const total = units.reduce((sum, u) => sum + u.durationMs, 0);
  return narrationAudioManifestV2Schema.parse({
    schemaVersion: 'narration-audio@2.0',
    source: {
      narrationPlanV2ArtifactId: 'plan-artifact-1',
      narrationPlanV2ArtifactVersion: 1,
      scriptV2VersionId: plan.source.scriptV2VersionId,
      scriptV2Version: plan.source.scriptV2Version,
      narrationCompilerVersion: '2.0',
    },
    provider: {
      name: 'mock',
      model: 'mock-tts',
      providerVersion: null,
      providerCommit: null,
      voiceProfile: {id: 'default', revision: '1'},
      useRandom: false,
    },
    units,
    master: {
      filePath: 'master.wav',
      durationMs: overrides.masterDurationMs ?? total,
      sha256: 'mastersha',
      sampleRate: 44100,
      channels: 1,
    },
  });
}

function compileSubtitles(plan: NarrationPlanV2, manifest: NarrationAudioManifestV2) {
  return compileSubtitleTimingV2({
    plan,
    manifest,
    narrationAudioV2ArtifactId: 'audio-artifact-1',
    narrationAudioV2ArtifactVersion: 1,
    narrationPlanV2ArtifactId: 'plan-artifact-1',
    narrationPlanV2ArtifactVersion: 1,
  });
}

function expectCompileError(
  code: SubtitleV2CompileError['code'],
  plan: NarrationPlanV2,
  manifest: NarrationAudioManifestV2,
  label: string,
): void {
  try {
    compileSubtitles(plan, manifest);
    ok(false, label, '编译意外成功');
  } catch (err) {
    ok(
      err instanceof SubtitleV2CompileError && err.code === code,
      label,
      err instanceof Error ? `${err.name}: ${err.message}` : err,
    );
  }
}

const strip = (s: string): string => s.replace(/\s+/g, '');

function main(): void {
  const plan = compilePlan();
  const speechUnits = plan.units.filter((u) => u.kind === 'speech');
  ok(plan.units.length === 3 && speechUnits.length === 2, '[C0] fixture：2 speech + 1 silence', plan.units.map((u) => [u.id, u.kind]));

  // ============ 基本编译：cue 只来自 subtitleText ============
  const timing = compileSubtitles(plan, manifestFor(plan));
  // N001 subtitleText='第一句。第二句。' → 2 cues；N002 silence → 0；N003 → 1
  ok(timing.cues.length === 3, '[C1] cue 总数=3（silence 不产生 cue）', timing.cues.map((c) => [c.segmentId, c.text]));
  ok(timing.cues.every((c) => c.unitId !== 'N002'), '[C2] silence unit 零 cue');
  ok(
    timing.cues[0]!.startMs === 0 && timing.cues[1]!.endMs === SPEECH_DURATION_MS,
    '[C3] N001 cue 覆盖 [0, 2000ms]',
    timing.cues.slice(0, 2),
  );
  ok(
    timing.cues[2]!.startMs === SPEECH_DURATION_MS + 500 && timing.cues[2]!.endMs === SPEECH_DURATION_MS + 500 + SPEECH_DURATION_MS,
    '[C4] N003 cue 起点包含 silence 时长（cursor 前进）',
    timing.cues[2],
  );

  // ============ conservation invariant（对象=非空 subtitleText 顺序拼接） ============
  const expectedText = strip(
    plan.units
      .filter((u) => u.kind === 'speech' && u.subtitleText !== null)
      .map((u) => (u.kind === 'speech' ? u.subtitleText! : ''))
      .join(''),
  );
  ok(strip(timing.cues.map((c) => c.text).join('')) === expectedText, '[C5] cue 文本拼接守恒（仅 subtitleText）');

  // ============ subtitleText=null → 不产生 cue ============
  const nullPlan = mutatePlan(plan, (raw) => {
    raw.units[0]!.subtitleText = null;
  });
  const nullTiming = compileSubtitles(nullPlan, manifestFor(nullPlan));
  ok(nullTiming.cues.length === 1 && nullTiming.cues[0]!.unitId === 'N003', '[C6] subtitleText=null → 该 unit 零 cue（其余不受影响）', nullTiming.cues);

  // ============ 禁止 fallback：subtitleText ≠ spokenText 时 cue 必须取 subtitleText ============
  const divergedPlan = mutatePlan(plan, (raw) => {
    raw.units[0]!.subtitleText = '完全不同的字幕。';
  });
  const divergedTiming = compileSubtitles(divergedPlan, manifestFor(divergedPlan));
  ok(
    divergedTiming.cues[0]!.text === '完全不同的字幕。',
    '[C7] cue 文本=subtitleText（非 spokenText fallback）',
    divergedTiming.cues[0],
  );

  // ============ manifest↔plan 一致性硬校验 ============
  expectCompileError(
    'NARRATION_AUDIO_INVALID',
    plan,
    manifestFor(plan, {spokenTextByUnit: {N001: '被篡改的口播。'}}),
    '[C8] manifest.spokenText ≠ plan.spokenText → 拒绝（semantic corruption）',
  );
  expectCompileError(
    'NARRATION_AUDIO_INVALID',
    plan,
    manifestFor(plan, {silenceDurationMs: 800}),
    '[C9] silence duration 与 plan 不一致 → 拒绝',
  );
  {
    const short = manifestFor(plan);
    const mUnits = short.units.filter((u) => u.unitId !== 'N003');
    const tampered = narrationAudioManifestV2Schema.parse({...short, units: mUnits, master: {...short.master, durationMs: mUnits.reduce((s, u) => s + u.durationMs, 0)}});
    expectCompileError('NARRATION_AUDIO_INVALID', plan, tampered, '[C10] manifest/plan unit 数量不一致 → 拒绝');
  }
  expectCompileError(
    'AUDIO_TIMELINE_MISMATCH',
    plan,
    manifestFor(plan, {masterDurationMs: 3 * SPEECH_DURATION_MS + 500}),
    '[C11] master 时长与 unit 时间轴偏差 >100ms → 拒绝',
  );

  // ============ deterministic ============
  ok(
    JSON.stringify(compileSubtitles(plan, manifestFor(plan))) === JSON.stringify(timing),
    '[C12] 字幕编译 deterministic',
  );

  // ============ cue schema 层 leakage 防线 ============
  {
    const leaky = JSON.parse(JSON.stringify(timing)) as Record<string, unknown>;
    (leaky.cues as Array<Record<string, unknown>>)[0]!.text = '（停顿 1s）第一句。';
    const result = subtitleTimingV2Schema.safeParse(leaky);
    ok(!result.success, '[C13] cue 文本含指令泄漏 → schema 拒绝');
  }
  // cue 时间序 superRefine
  {
    const overlap = JSON.parse(JSON.stringify(timing)) as Record<string, unknown>;
    (overlap.cues as Array<Record<string, unknown>>)[2]!.startMs = 0;
    const result = subtitleTimingV2Schema.safeParse(overlap);
    ok(!result.success, '[C14] cue 重叠/乱序 → schema 拒绝');
  }

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.1 subtitle 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.1 Subtitle Compiler V2 测试全部通过 ✅');
}

main();

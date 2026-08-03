/**
 * TTS-B — Narration Performance Plan schema + semantic validation 测试（设计文档 §5/§6；D 覆盖）。
 *
 * D. Performance schema：exact speech coverage；silence excluded；gap；duplicate；
 *    order mismatch；non-speech unit；invalid enums；invalid emotion union；
 *    forbidden spokenText/subtitleText/sourceText；forbidden timing/audio/job/path；
 *    unknown field。
 *
 * 用法：npx tsx scripts/test-tts-b-performance-schema.ts
 * 纯函数测试，无 DB（plan fixture 以 cast 提供 NarrationPlanV2 的 units 视图）。
 */

import type {NarrationPlanV2} from '../src/lib/narration/schema-v2';
import {
  performanceItemsProposalSchema,
  performanceItemV1Schema,
  narrationPerformancePlanArtifactV1Schema,
} from '../src/lib/tts-b/performance-schema';
import {validatePerformanceItems} from '../src/lib/tts-b/performance-validate';

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

/** 3 个 speech + 1 个 silence 的 plan fixture（仅 units 视图参与 validate）。 */
function planFixture(): NarrationPlanV2 {
  return {
    units: [
      {id: 'N001', kind: 'speech', chapter: 1, spokenText: '第一句', subtitleText: '第一句', delivery: 'normal', evidenceIds: ['E1'], sourceText: '第一句'},
      {id: 'N002', kind: 'speech', chapter: 1, spokenText: '第二句', subtitleText: '第二句', delivery: 'slow', evidenceIds: ['E2'], sourceText: '第二句'},
      {id: 'N003', kind: 'silence', chapter: 1, durationMs: 500, reason: 'pause', sourceText: ''},
      {id: 'N004', kind: 'speech', chapter: 2, spokenText: '第三句', subtitleText: '第三句', delivery: 'emphasis', evidenceIds: ['E3'], sourceText: '第三句'},
    ],
  } as unknown as NarrationPlanV2;
}

function item(unitId: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    unitId,
    deliveryOverride: null,
    pace: 'normal',
    energy: 'normal',
    emotion: {mode: 'none'},
    ...extra,
  };
}

const VALID_ITEMS = [
  item('N001'),
  item('N002', {deliveryOverride: 'slow', pace: 'fast', energy: 'high', emotion: {mode: 'semantic', label: 'warm'}}),
  item('N004', {deliveryOverride: 'emphasis', emotion: {mode: 'semantic', label: 'urgent'}}),
];

function codes(items: ReturnType<typeof item>[]): string[] {
  const plan = planFixture();
  return validatePerformanceItems(plan, items as never).map((i) => i.code);
}

async function main(): Promise<void> {
  // ---------- schema 层 ----------
  ok(performanceItemV1Schema.safeParse(item('N001')).success, '[D1] 合法 performance item parse 通过');
  ok(performanceItemsProposalSchema.safeParse({items: VALID_ITEMS}).success, '[D2] 合法 items proposal parse 通过');
  for (const [key, val] of [
    ['spokenText', '你好'],
    ['subtitleText', '你好'],
    ['sourceText', '你好'],
    ['evidenceIds', ['E1']],
    ['pauseDurationMs', 500],
    ['startMs', 0],
    ['endMs', 100],
    ['durationMs', 100],
    ['frames', 30],
    ['audioPath', '/x.wav'],
    ['outputPath', '/x.wav'],
    ['ttsJobId', 'job-1'],
    ['providerPayload', {x: 1}],
  ] as const) {
    ok(
      !performanceItemV1Schema.safeParse(item('N001', {[key]: val})).success,
      `[D3] forbidden 字段 ${key} 拒绝（zod strict）`,
    );
  }
  ok(!performanceItemV1Schema.safeParse(item('N001', {bogus: 1})).success, '[D4] unknown field 拒绝');
  ok(!performanceItemV1Schema.safeParse(item('N001', {deliveryOverride: 'urgent'})).success, '[D5] deliveryOverride 非闭集拒绝');
  ok(!performanceItemV1Schema.safeParse(item('N001', {pace: 'urgent'})).success, '[D6] pace 非闭集拒绝');
  ok(!performanceItemV1Schema.safeParse(item('N001', {energy: 'urgent'})).success, '[D7] energy 非闭集拒绝');
  ok(
    !performanceItemV1Schema.safeParse(item('N001', {emotion: {mode: 'semantic', label: 'bogus'}})).success &&
      !performanceItemV1Schema.safeParse(item('N001', {emotion: {mode: 'vector'}})).success &&
      !performanceItemV1Schema.safeParse(item('N001', {emotion: {mode: 'none', label: 'warm'}})).success,
    '[D8] emotion 非 discriminated union / label 非闭集拒绝',
  );
  ok(!performanceItemV1Schema.safeParse(item('X001')).success, '[D9] unitId 非 Nddd 拒绝');
  // proposal 层：LLM 输出不允许 source/hash/artifact id/路径/文本副本
  ok(
    !performanceItemsProposalSchema.safeParse({items: VALID_ITEMS, source: {narrationPlanArtifactId: 'x'}}).success,
    '[D10] proposal 含 source → 拒绝',
  );

  // ---------- 语义层 ----------
  ok(codes(VALID_ITEMS).length === 0, '[D11] 合法 items 无 issue');
  ok(
    codes([item('N001'), item('N004')]).includes('PERFORMANCE_UNIT_COVERAGE_GAP'),
    '[D12] 遗漏 SpeechUnit N002 → coverage gap',
  );
  ok(
    codes([item('N001'), item('N001'), item('N002'), item('N004')]).includes('PERFORMANCE_UNIT_DUPLICATE'),
    '[D13] 重复 unitId → duplicate',
  );
  ok(
    codes([item('N002'), item('N001'), item('N004')]).includes('PERFORMANCE_UNIT_ORDER_MISMATCH'),
    '[D14] 顺序错位 → order mismatch',
  );
  ok(
    codes([item('N001'), item('N003'), item('N002'), item('N004')]).includes('PERFORMANCE_NON_SPEECH_UNIT'),
    '[D15] SilenceUnit N003 出现在 items → non-speech unit',
  );
  ok(
    codes([item('N001'), item('N999'), item('N002'), item('N004')]).includes('PERFORMANCE_UNIT_NOT_FOUND'),
    '[D16] 引用不存在 unit → unit not found',
  );
  // forbidden 字段显式语义检查（对手工对象独立生效）
  const plan = planFixture();
  const forbiddenItem = {...item('N001'), spokenText: '泄露'};
  const semanticCodes = validatePerformanceItems(plan, [forbiddenItem, item('N002'), item('N004')] as never)
    .map((i) => i.code);
  ok(semanticCodes.includes('PERFORMANCE_FORBIDDEN_FIELD'), '[D17] forbidden spokenText 显式语义检查');
  // artifact 层 strict
  const artifactBase = {
    schemaVersion: 'narration-performance-plan@1.0',
    compilerVersion: '1.0',
    promptVersion: 'narration-performance-plan@1.0',
    source: {
      narrationPlanArtifactId: 'plan-1',
      narrationPlanContentHash: 'sha256:' + 'a'.repeat(64),
      narrationPlanSchemaVersion: 'narration-plan@2.0',
      narrationPlanCompilerVersion: '2.0',
      scriptV2VersionId: 'sv-1',
      scriptV2Version: 1,
      scriptV2ContentHash: 'sha256:' + 'b'.repeat(64),
      projectVoiceAssignmentArtifactId: 'assign-1',
      projectVoiceAssignmentContentHash: 'sha256:' + 'c'.repeat(64),
      voiceProfileId: 'vp-1',
      voiceProfileRevisionId: 'vr-1',
      canonicalAudioSha256: 'd'.repeat(64),
      adapterCompatibilityKey: 'indextts2-adapter-registry@1',
    },
    generation: {requestId: 'req-perf-0001', provider: 'mock', model: 'm', attemptCount: 1},
    items: VALID_ITEMS,
  };
  ok(narrationPerformancePlanArtifactV1Schema.safeParse(artifactBase).success, '[D18] 合法 artifact parse 通过');
  ok(
    !narrationPerformancePlanArtifactV1Schema.safeParse({...artifactBase, items: [{...item('N001'), spokenText: 'x'}]}).success,
    '[D19] artifact 内 forbidden 字段拒绝',
  );

  closeAndReport();
}

function closeAndReport(): void {
  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-B performance schema 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-B Narration Performance Plan schema/语义 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

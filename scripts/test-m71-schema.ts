/**
 * M7.1 Narration Plan V2 Schema 契约测试（零真实 API 成本，不触数据库）。
 *
 * 用法：npx tsx scripts/test-m71-schema.ts
 * 覆盖：discriminated union 排斥非法字段组合、superRefine 不变量、
 * needsReview fail-closed 资格判定。任一断言失败即非零退出。
 */

import {
  isPlanV2Eligible,
  narrationPlanV2Schema,
  type NarrationPlanV2,
} from '../src/lib/narration/schema-v2';

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

/** 最小合法 plan（2 units：1 speech + 1 silence，chapter 引用一致）。 */
function validPlan(): Record<string, unknown> {
  return {
    schemaVersion: 'narration-plan@2.0',
    compilerVersion: '2.0',
    inputMode: 'legacy',
    source: {
      scriptV2VersionId: 'version-row-id-1',
      scriptV2Version: 1,
      scriptV2PromptVersion: 'script-v2@1.0',
      scriptV2ContentHash: `sha256:${'a'.repeat(64)}`,
    },
    chapters: [{chapter: 1, title: '第 1 章', firstUnitId: 'N001', lastUnitId: 'N002'}],
    units: [
      {
        id: 'N001',
        kind: 'speech',
        chapter: 1,
        spokenText: '第一句。',
        subtitleText: '第一句。',
        delivery: 'normal',
        evidenceIds: [],
        sourceText: '第一句。',
      },
      {
        id: 'N002',
        kind: 'silence',
        chapter: 1,
        durationMs: 500,
        reason: 'pause',
        sourceText: '（停顿 0.5s）',
      },
    ],
    needsReview: [],
  };
}

function accepts(plan: unknown): boolean {
  return narrationPlanV2Schema.safeParse(plan).success;
}

function rejects(plan: unknown, label: string): void {
  const result = narrationPlanV2Schema.safeParse(plan);
  ok(!result.success, label, result.success ? '意外通过' : result.error.issues.map((i) => i.message));
}

function main(): void {
  // ============ 基线 ============
  const baseline = narrationPlanV2Schema.safeParse(validPlan());
  ok(baseline.success, '[S1] 最小合法 plan 通过校验', baseline.success ? undefined : baseline.error.issues);

  // ============ discriminated union：非法字段组合排斥 ============
  const silenceWithSpeech = validPlan();
  (silenceWithSpeech.units as Array<Record<string, unknown>>)[1]!.spokenText = '不应存在';
  rejects(silenceWithSpeech, '[S2] silence 携带 spokenText → strict 拒绝');

  const silenceWithDelivery = validPlan();
  (silenceWithDelivery.units as Array<Record<string, unknown>>)[1]!.delivery = 'slow';
  rejects(silenceWithDelivery, '[S3] silence 携带 delivery → strict 拒绝');

  const silenceWithSubtitle = validPlan();
  (silenceWithSubtitle.units as Array<Record<string, unknown>>)[1]!.subtitleText = null;
  rejects(silenceWithSubtitle, '[S4] silence 携带 subtitleText → strict 拒绝');

  const speechEmpty = validPlan();
  (speechEmpty.units as Array<Record<string, unknown>>)[0]!.spokenText = '';
  rejects(speechEmpty, '[S5] speech.spokenText 空串 → 拒绝');

  const speechNull = validPlan();
  (speechNull.units as Array<Record<string, unknown>>)[0]!.spokenText = null;
  rejects(speechNull, '[S6] speech.spokenText null → 拒绝');

  const speechWithDuration = validPlan();
  (speechWithDuration.units as Array<Record<string, unknown>>)[0]!.durationMs = 500;
  rejects(speechWithDuration, '[S7] speech 携带 durationMs → strict 拒绝（禁止双重表示）');

  const badKind = validPlan();
  (badKind.units as Array<Record<string, unknown>>)[1]!.kind = 'pause';
  rejects(badKind, '[S8] kind="pause"（旧模型）→ discriminated union 拒绝');

  // ============ silence 时长边界 ============
  for (const [value, label] of [
    [0, 'durationMs=0'],
    [-100, 'durationMs 负数'],
    [30_001, 'durationMs 超上限 30000'],
    [1.5, 'durationMs 非整数'],
    [Number.NaN, 'durationMs NaN'],
    [Number.POSITIVE_INFINITY, 'durationMs Infinity'],
  ] as Array<[number, string]>) {
    const plan = validPlan();
    (plan.units as Array<Record<string, unknown>>)[1]!.durationMs = value;
    rejects(plan, `[S9] silence ${label} → 拒绝`);
  }
  const durOk = validPlan();
  (durOk.units as Array<Record<string, unknown>>)[1]!.durationMs = 30_000;
  ok(accepts(durOk), '[S10] durationMs=30000（上限边界）→ 通过');

  // ============ superRefine 不变量 ============
  const dupId = validPlan();
  (dupId.units as Array<Record<string, unknown>>)[1]!.id = 'N001';
  (dupId.chapters as Array<Record<string, unknown>>)[0]!.lastUnitId = 'N001';
  rejects(dupId, '[S11] unit ID 不连续（重复 N001）→ 拒绝');

  const gapId = validPlan();
  (gapId.units as Array<Record<string, unknown>>)[1]!.id = 'N003';
  rejects(gapId, '[S12] unit ID 跳号（N001,N003）→ 拒绝');

  const badChapterRef = validPlan();
  (badChapterRef.units as Array<Record<string, unknown>>)[0]!.chapter = 99;
  rejects(badChapterRef, '[S13] unit 引用不存在的 chapter → 拒绝');

  const badFirstLast = validPlan();
  (badFirstLast.chapters as Array<Record<string, unknown>>)[0]!.firstUnitId = 'N002';
  rejects(badFirstLast, '[S14] chapter first/lastUnitId 与 units 不一致 → 拒绝');

  const badReviewId = validPlan();
  badReviewId.needsReview = [
    {id: 'R002', kind: 'unknown_directive', chapter: 1, raw: 'x', context: 'y', reason: 'z'},
  ];
  rejects(badReviewId, '[S15] needsReview ID 不从 R001 开始 → 拒绝');

  const badHash = validPlan();
  (badHash.source as Record<string, unknown>).scriptV2ContentHash = 'not-a-sha';
  rejects(badHash, '[S16] contentHash 非 sha256:hex64 → 拒绝');

  const badEvidence = validPlan();
  (badEvidence.units as Array<Record<string, unknown>>)[0]!.evidenceIds = ['EVIDENCE-1'];
  rejects(badEvidence, '[S17] evidenceIds 格式非法 → 拒绝');

  // ============ leakage superRefine（schema 层防线） ============
  const leakSpoken = validPlan();
  (leakSpoken.units as Array<Record<string, unknown>>)[0]!.spokenText = '（停顿 0.5s）第一句。';
  rejects(leakSpoken, '[S18] spokenText 含括号指令 → superRefine 拒绝');

  const leakSubtitle = validPlan();
  (leakSubtitle.units as Array<Record<string, unknown>>)[0]!.subtitleText = '旁白：第一句。';
  rejects(leakSubtitle, '[S19] subtitleText 含「旁白：」→ superRefine 拒绝');

  const leakHr = validPlan();
  (leakHr.units as Array<Record<string, unknown>>)[0]!.spokenText = '第一句。\n---\n第二句。';
  rejects(leakHr, '[S20] spokenText 含独立 --- → superRefine 拒绝');

  // sourceText 是 trace 字段，允许保留原始指令（不进 TTS/字幕）
  const sourceOk = validPlan();
  (sourceOk.units as Array<Record<string, unknown>>)[0]!.sourceText = '（停顿 0.5s，放缓）第一句。';
  ok(accepts(sourceOk), '[S21] sourceText 保留原始指令不触发拒绝（trace-only）');

  // ============ needsReview fail-closed 资格 ============
  const withReview = validPlan();
  withReview.needsReview = [
    {
      id: 'R001',
      kind: 'pause_without_duration',
      chapter: 1,
      raw: '（停顿）',
      context: '第 1 章段 1',
      reason: '停顿无明确时长',
    },
  ];
  const parsed = narrationPlanV2Schema.safeParse(withReview);
  ok(parsed.success, '[S22] needsReview 非空的 plan 结构合法（可保存 candidate）');
  ok(parsed.success && !isPlanV2Eligible(parsed.data), '[S23] needsReview 非空 → 不 eligible（不得 current/lock）');

  const eligible = narrationPlanV2Schema.parse(validPlan()) as NarrationPlanV2;
  ok(isPlanV2Eligible(eligible), '[S24] needsReview 空 → eligible');

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] M7.1 schema 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] M7.1 Schema V2 测试全部通过 ✅');
}

main();

/**
 * TTS-C.1C.1 — provider capability snapshot + pure compiler 测试。
 *
 * 覆盖（执行计划 §J 1C 核心测试 + 本轮任务最小矩阵）：
 *   1. 全 neutral → no-op
 *   2. 每个当前 control non-neutral + unsupported → 对应 flag
 *   3. 多个 unsupported → 固定顺序且无遗漏
 *   4. synthetic supported snapshot → 正确 providerParams
 *   5. 同输入重复编译 → 稳定一致（JSON 序列化逐字节一致）
 *   6. schema 外字段 → reject
 *   7. 输入原对象和 snapshot 不被修改（深冻结）
 *
 * 纯函数测试，零 DB / 零 IO / 零 provider / 零时钟。
 * 不测试未来 emotion vector / emotionAlpha / 情绪参考音频（v1 未引入）。
 *
 * 用法：npx tsx scripts/test-tts-c1c1-capability.ts
 */

import {ZodError} from 'zod';
import {
  INDEXTTS2_CAPABILITY_SNAPSHOT_V1,
  PROVIDER_CAPABILITY_SNAPSHOT_VERSION,
  providerCapabilitySnapshotV1Schema,
  type ProviderCapabilitySnapshotV1,
} from '../src/lib/tts-c/provider-capability';
import {
  capabilityCompileInputSchema,
  COMPILE_CONTROL_ORDER,
  compilePerformanceToProvider,
  type CapabilityCompileInput,
  type CompilePerformanceResult,
} from '../src/lib/tts-c/capability-compiler';

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

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function neutralInput(): CapabilityCompileInput {
  return {
    deliveryOverride: null,
    pace: 'normal',
    energy: 'normal',
    emotion: {mode: 'none'},
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** synthetic supported snapshot：部分 control 声明 supported（同一 v1 shape）。 */
function supportedSnapshot(
  controls: Partial<Record<keyof ProviderCapabilitySnapshotV1['controls'], boolean>>,
): ProviderCapabilitySnapshotV1 {
  return {
    ...INDEXTTS2_CAPABILITY_SNAPSHOT_V1,
    controls: {
      deliveryOverride: {supported: controls.deliveryOverride ?? false},
      pace: {supported: controls.pace ?? false},
      energy: {supported: controls.energy ?? false},
      emotionSemantic: {supported: controls.emotionSemantic ?? false},
    },
  };
}

function assertResultShape(
  r: CompilePerformanceResult,
  label: string,
  opts: {
    params?: Record<string, unknown>;
    flags?: {control: string; inputValue: unknown}[];
    flagsLength?: number;
  },
): void {
  ok(r.compilerVersion === '1.0', `${label}: compilerVersion=1.0`, r.compilerVersion);
  ok(r.snapshotVersion === PROVIDER_CAPABILITY_SNAPSHOT_VERSION, `${label}: snapshotVersion 回显`, r.snapshotVersion);
  if (opts.params !== undefined) {
    ok(sameJson(r.providerParams, opts.params), `${label}: providerParams`, r.providerParams);
  }
  if (opts.flagsLength !== undefined) {
    ok(r.unsupportedFlags.length === opts.flagsLength, `${label}: unsupportedFlags 长度=${opts.flagsLength}`, r.unsupportedFlags);
  }
  if (opts.flags !== undefined) {
    ok(
      opts.flags.every((f, i) => {
        const actual = r.unsupportedFlags[i];
        return (
          actual !== undefined &&
          actual.control === f.control &&
          sameJson(actual.inputValue, f.inputValue) &&
          actual.snapshotVersion === PROVIDER_CAPABILITY_SNAPSHOT_VERSION
        );
      }),
      `${label}: flags 顺序与内容`,
      r.unsupportedFlags,
    );
  }
}

function main(): void {
  const v1 = INDEXTTS2_CAPABILITY_SNAPSHOT_V1;

  // ---------- schema 边界 ----------
  ok(providerCapabilitySnapshotV1Schema.safeParse(v1).success, '[S1] v1 常量通过 snapshot schema');
  ok(
    !providerCapabilitySnapshotV1Schema.safeParse({
      ...v1,
      controls: {...v1.controls, useRandom: {supported: false}},
    }).success,
    '[S2] v1 schema 拒绝 useRandom 扩展 control（v1 仅 4 项）',
  );
  ok(
    !providerCapabilitySnapshotV1Schema.safeParse({...v1, snapshotVersion: 'indextts2-capability@2'}).success,
    '[S3] v1 schema 拒绝非 v1 snapshotVersion',
  );
  ok(providerCapabilitySnapshotV1Schema.safeParse(supportedSnapshot({pace: true})).success, '[S4] synthetic supported snapshot 通过同一 shape schema');
  ok(capabilityCompileInputSchema.safeParse(neutralInput()).success, '[S5] neutral 输入通过输入 schema');
  ok(
    !capabilityCompileInputSchema.safeParse({...neutralInput(), unitId: 'N001'}).success,
    '[S6] 输入 schema 拒绝 unitId（输入面仅 4 项表现力字段）',
  );

  // ---------- 1. 全 neutral → no-op ----------
  const neutralResult = compilePerformanceToProvider(neutralInput(), v1);
  ok(sameJson(neutralResult.providerParams, {}), '[T1] 全 neutral → providerParams 空', neutralResult.providerParams);
  ok(neutralResult.unsupportedFlags.length === 0, '[T2] 全 neutral → unsupportedFlags 空', neutralResult.unsupportedFlags);

  // ---------- 2. 每个 control non-neutral + unsupported → 对应 flag ----------
  const cases: [string, Partial<CapabilityCompileInput>, string, unknown][] = [
    ['deliveryOverride', {deliveryOverride: 'slow'}, 'deliveryOverride', 'slow'],
    ['pace', {pace: 'fast'}, 'pace', 'fast'],
    ['energy', {energy: 'high'}, 'energy', 'high'],
    [
      'emotionSemantic',
      {emotion: {mode: 'semantic', label: 'warm'}},
      'emotionSemantic',
      {mode: 'semantic', label: 'warm'},
    ],
  ];
  for (const [name, patch, control, inputValue] of cases) {
    const r = compilePerformanceToProvider({...neutralInput(), ...patch}, v1);
    assertResultShape(r, `[T3] ${name} unsupported`, {
      params: {},
      flagsLength: 1,
      flags: [{control, inputValue}],
    });
  }

  // ---------- 3. 多个 unsupported → 固定顺序且无遗漏 ----------
  const allNonNeutral: Pick<CapabilityCompileInput, 'deliveryOverride' | 'pace' | 'energy' | 'emotion'> = {
    deliveryOverride: 'emphasis',
    pace: 'slow',
    energy: 'low',
    emotion: {mode: 'semantic', label: 'urgent'},
  };
  const multiResult = compilePerformanceToProvider({...neutralInput(), ...allNonNeutral}, v1);
  assertResultShape(multiResult, '[T4] 四项全 unsupported', {
    params: {},
    flagsLength: 4,
    flags: [
      {control: 'deliveryOverride', inputValue: 'emphasis'},
      {control: 'pace', inputValue: 'slow'},
      {control: 'energy', inputValue: 'low'},
      {control: 'emotionSemantic', inputValue: {mode: 'semantic', label: 'urgent'}},
    ],
  });
  ok(
    sameJson(multiResult.unsupportedFlags.map((f) => f.control), [...COMPILE_CONTROL_ORDER]),
    '[T5] flags 顺序 == COMPILE_CONTROL_ORDER 固定顺序',
    multiResult.unsupportedFlags.map((f) => f.control),
  );

  // ---------- 4. synthetic supported snapshot → 正确 providerParams ----------
  const synthSupported = supportedSnapshot({pace: true, emotionSemantic: true});
  const mixedResult = compilePerformanceToProvider({...neutralInput(), ...allNonNeutral}, synthSupported);
  assertResultShape(mixedResult, '[T6] 部分 supported 混合输入', {
    params: {
      pace: 'slow',
      emotionSemantic: {mode: 'semantic', label: 'urgent'},
    },
    flagsLength: 2,
    flags: [
      {control: 'deliveryOverride', inputValue: 'emphasis'},
      {control: 'energy', inputValue: 'low'},
    ],
  });
  ok(
    !mixedResult.unsupportedFlags.some((f) => f.control === 'pace' || f.control === 'emotionSemantic'),
    '[T7] supported non-neutral 不进入 unsupportedFlags',
    mixedResult.unsupportedFlags,
  );

  const allSupported = supportedSnapshot({deliveryOverride: true, pace: true, energy: true, emotionSemantic: true});
  const allParams = compilePerformanceToProvider({...neutralInput(), ...allNonNeutral}, allSupported);
  assertResultShape(allParams, '[T8] 全 supported', {
    params: {
      deliveryOverride: 'emphasis',
      pace: 'slow',
      energy: 'low',
      emotionSemantic: {mode: 'semantic', label: 'urgent'},
    },
    flagsLength: 0,
  });

  // neutral 输入 + supported snapshot 仍是 no-op
  const neutralOnSupported = compilePerformanceToProvider(neutralInput(), allSupported);
  ok(sameJson(neutralOnSupported.providerParams, {}) && neutralOnSupported.unsupportedFlags.length === 0, '[T9] neutral 不因 supported 产生参数');

  // ---------- 5. 同输入重复编译 → 稳定一致 ----------
  const serialized = new Set<string>();
  for (let i = 0; i < 20; i++) {
    serialized.add(JSON.stringify(compilePerformanceToProvider({...neutralInput(), ...allNonNeutral}, v1)));
  }
  ok(serialized.size === 1, '[T10] 同输入同 snapshot 重复 20 次编译逐字节一致', [...serialized].length);

  // ---------- 6. schema 外字段 → reject ----------
  const rejectCases: [string, unknown][] = [
    ['unitId 字段', {...neutralInput(), unitId: 'N001'}],
    ['未知字段 foo', {...neutralInput(), foo: 1}],
    ['未知 emotion mode', {...neutralInput(), emotion: {mode: 'text'}}],
    ['非法 pace 枚举', {...neutralInput(), pace: 'extreme'}],
  ];
  for (const [name, badInput] of rejectCases) {
    let threw = false;
    try {
      compilePerformanceToProvider(badInput as CapabilityCompileInput, v1);
    } catch (err) {
      threw = err instanceof ZodError;
    }
    ok(threw, `[T11] 输入含${name} → ZodError 显式拒绝`);
  }
  let snapshotThrew = false;
  try {
    compilePerformanceToProvider(
      neutralInput(),
      {...v1, adapterCompatibilityKey: 'other@1'} as unknown as ProviderCapabilitySnapshotV1,
    );
  } catch (err) {
    snapshotThrew = err instanceof ZodError;
  }
  ok(snapshotThrew, '[T12] snapshot 结构非法 → ZodError 显式拒绝');

  // ---------- 7. 输入原对象和 snapshot 不被修改 ----------
  const frozenInput = deepFreeze({...neutralInput(), ...allNonNeutral});
  const frozenSnapshot = deepFreeze(JSON.parse(JSON.stringify(v1)) as ProviderCapabilitySnapshotV1);
  const beforeInput = JSON.stringify(frozenInput);
  const beforeSnapshot = JSON.stringify(frozenSnapshot);
  const frozenResult = compilePerformanceToProvider(frozenInput, frozenSnapshot);
  ok(
    JSON.stringify(frozenInput) === beforeInput && JSON.stringify(frozenSnapshot) === beforeSnapshot,
    '[T13] 深冻结输入与 snapshot 编译后原对象逐字节不变',
  );
  ok(
    sameJson(frozenResult, compilePerformanceToProvider({...neutralInput(), ...allNonNeutral}, v1)),
    '[T14] 冻结对象编译结果与普通对象一致',
  );

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-C.1C.1 capability snapshot/compiler 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-C.1C.1 provider capability snapshot/compiler 测试全部通过 ✅');
}

main();

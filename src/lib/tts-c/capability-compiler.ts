/**
 * TTS-C.1C.1 — provider capability 纯编译器。
 *
 * 编译 TTS-B frozen Performance Plan 的表现力输入（deliveryOverride / pace /
 * energy / emotion{none|semantic}）为 provider 参数，按 capability snapshot 声明
 * 的能力面产出 providerParams 与 unsupportedFlags。
 *
 * 零 DB / 零 IO / 零时钟 / 零环境变量 / 零随机数——纯函数，同输入同 snapshot
 * 逐字节同输出（固定 control 顺序 + 固定对象键插入顺序）。
 *
 * 规则：
 * 1. neutral（deliveryOverride=null、pace=normal、energy=normal、emotion.mode=none）
 *    → no-op，不因 supported:false 报 unsupported。
 * 2. non-neutral + snapshot 声明 supported → 直接映射进 providerParams（当前只实现
 *    四个 control 的直接映射，control 名即 providerParams 键；不构建通用规则引擎）。
 * 3. non-neutral + snapshot 声明 unsupported → unsupportedFlags 逐项记录
 *    {control, inputValue, snapshotVersion}，不静默丢弃。
 * 4. 输入与 snapshot 均经 strict schema 校验；schema 外字段显式拒绝（抛 ZodError）。
 *
 * 注意：deliveryOverride 的 neutral 形态严格为 null；枚举值 'normal' 按非 neutral
 * 处理（保守：宁可显式 flag 也不静默丢弃），与 frozen neutral matrix
 * （deliveryOverride:null）一致。
 */
import {z} from 'zod';
import {
  performanceItemV1Schema,
  type PerformanceItemV1,
} from '../tts-b/performance-schema';
import {
  PROVIDER_CAPABILITY_COMPILER_VERSION,
  providerCapabilitySnapshotV1Schema,
  type ProviderCapabilitySnapshotV1,
} from './provider-capability';

/** 编译器输入 = TTS-B frozen PerformanceItemV1 的四项表现力字段（不含 unitId）。 */
export type CapabilityCompileInput = Pick<
  PerformanceItemV1,
  'deliveryOverride' | 'pace' | 'energy' | 'emotion'
>;

/** 输入 strict schema：未知字段显式拒绝（沿用 Performance Plan `.strict()` 先例）。 */
export const capabilityCompileInputSchema = performanceItemV1Schema
  .pick({
    deliveryOverride: true,
    pace: true,
    energy: true,
    emotion: true,
  })
  .strict();

/** 固定 control 顺序：determinism 的权威迭代序。 */
export const COMPILE_CONTROL_ORDER = [
  'deliveryOverride',
  'pace',
  'energy',
  'emotionSemantic',
] as const;

export type CompileControlKey = (typeof COMPILE_CONTROL_ORDER)[number];

export type UnsupportedControl = {
  control: string;
  inputValue: unknown;
  snapshotVersion: string;
};

export type CompilePerformanceResult = {
  providerParams: Record<string, unknown>;
  unsupportedFlags: UnsupportedControl[];
  snapshotVersion: string;
  compilerVersion: '1.0';
};

function isNeutral(control: CompileControlKey, input: CapabilityCompileInput): boolean {
  switch (control) {
    case 'deliveryOverride':
      return input.deliveryOverride === null;
    case 'pace':
      return input.pace === 'normal';
    case 'energy':
      return input.energy === 'normal';
    case 'emotionSemantic':
      return input.emotion.mode === 'none';
  }
}

function inputValueOf(control: CompileControlKey, input: CapabilityCompileInput): unknown {
  switch (control) {
    case 'deliveryOverride':
      return input.deliveryOverride;
    case 'pace':
      return input.pace;
    case 'energy':
      return input.energy;
    case 'emotionSemantic':
      return input.emotion;
  }
}

export function compilePerformanceToProvider(
  input: CapabilityCompileInput,
  snapshot: ProviderCapabilitySnapshotV1,
): CompilePerformanceResult {
  // 入口校验：输入与 snapshot 都经 strict schema（未知字段/非法枚举显式拒绝）。
  const parsedInput = capabilityCompileInputSchema.parse(input);
  const parsedSnapshot = providerCapabilitySnapshotV1Schema.parse(snapshot);

  const providerParams: Record<string, unknown> = {};
  const unsupportedFlags: UnsupportedControl[] = [];

  for (const control of COMPILE_CONTROL_ORDER) {
    if (isNeutral(control, parsedInput)) {
      continue;
    }
    if (parsedSnapshot.controls[control].supported) {
      providerParams[control] = inputValueOf(control, parsedInput);
    } else {
      unsupportedFlags.push({
        control,
        inputValue: inputValueOf(control, parsedInput),
        snapshotVersion: parsedSnapshot.snapshotVersion,
      });
    }
  }

  return {
    providerParams,
    unsupportedFlags,
    snapshotVersion: parsedSnapshot.snapshotVersion,
    compilerVersion: PROVIDER_CAPABILITY_COMPILER_VERSION,
  };
}

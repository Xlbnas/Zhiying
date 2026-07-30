/**
 * M6.3.12：Final Master 响度归一化（两通 loudnorm）。
 *
 * 背景：外部实测最终 MP4 integrated loudness 仅 -22.04 LUFS，明显偏低。
 * 目标：integrated ≈ -16 LUFS（EBU R128 语音口径），true peak ≤ -1.5 dBTP。
 *
 * 实现：
 * - pass1：`loudnorm=...:print_format=json` 测量（输出 null），从 stderr
 *   末尾 JSON 解析 input_i/input_tp/input_lra/input_thresh/target_offset；
 * - pass2：带 measured_* + offset + linear=true 动态归一化，视频流 copy
 *   （不重编码，画质零损失），音频重编码 AAC 192k；
 * - 只处理 final audio master，不触碰 TTS/narration usage 记账。
 *
 * exec 可注入（测试用伪 ffmpeg；本机无 ffmpeg 也能跑单测）。
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/** 可注入的 ffmpeg 执行器（args 不含 'ffmpeg' 本身）。 */
export type FfmpegExec = (args: string[]) => Promise<{stdout: string; stderr: string}>;

export const LOUDNESS_TARGET = {
  integrated: -16,
  truePeak: -1.5,
  lra: 11,
} as const;

export interface LoudnormMeasured {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  targetOffset: number;
}

const defaultExec: FfmpegExec = async (args) => {
  const {stdout, stderr} = await execFileAsync('ffmpeg', args, {maxBuffer: 16 * 1024 * 1024});
  return {stdout, stderr};
};

export function buildLoudnormPass1Args(inputAbs: string): string[] {
  return [
    '-hide_banner', '-nostats', '-y',
    '-i', inputAbs,
    '-af', `loudnorm=I=${LOUDNESS_TARGET.integrated}:TP=${LOUDNESS_TARGET.truePeak}:LRA=${LOUDNESS_TARGET.lra}:print_format=json`,
    '-f', 'null', '-',
  ];
}

export function buildLoudnormPass2Args(
  inputAbs: string,
  outputAbs: string,
  measured: LoudnormMeasured,
): string[] {
  const af =
    `loudnorm=I=${LOUDNESS_TARGET.integrated}:TP=${LOUDNESS_TARGET.truePeak}:LRA=${LOUDNESS_TARGET.lra}` +
    `:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
    `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset}:linear=true:print_format=json`;
  return [
    '-hide_banner', '-nostats', '-y',
    '-i', inputAbs,
    '-af', af,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputAbs,
  ];
}

/** 从 ffmpeg stderr 解析 loudnorm print_format=json 的测量块（取最后一个含 input_i 的 JSON 对象）。 */
export function parseLoudnormMeasured(stderr: string): LoudnormMeasured {
  const blocks = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  const block = blocks?.[blocks.length - 1];
  if (!block) {
    throw new Error('loudnorm 输出中未找到测量 JSON（input_i 缺失）');
  }
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(block) as Record<string, string>;
  } catch {
    throw new Error('loudnorm 测量 JSON 解析失败');
  }
  const num = (key: string): number => {
    const v = Number(raw[key]);
    if (!Number.isFinite(v)) throw new Error(`loudnorm 测量字段非法: ${key}=${raw[key] ?? '(missing)'}`);
    return v;
  };
  return {
    inputI: num('input_i'),
    inputTp: num('input_tp'),
    inputLra: num('input_lra'),
    inputThresh: num('input_thresh'),
    targetOffset: num('target_offset'),
  };
}

/** 只测量（pass1）：用于归一化后成品的实测响度记录。 */
export async function measureLoudness(
  inputAbs: string,
  execFn: FfmpegExec = defaultExec,
): Promise<LoudnormMeasured> {
  const {stderr} = await execFn(buildLoudnormPass1Args(inputAbs));
  return parseLoudnormMeasured(stderr);
}

/**
 * 两通响度归一化：input → output（不同路径）。
 * 返回 pass1 测量值（输入响度，供报告对比）。
 */
export async function runTwoPassLoudnorm(
  inputAbs: string,
  outputAbs: string,
  execFn: FfmpegExec = defaultExec,
): Promise<{measured: LoudnormMeasured}> {
  const measured = await measureLoudness(inputAbs, execFn);
  await execFn(buildLoudnormPass2Args(inputAbs, outputAbs, measured));
  return {measured};
}

/**
 * TTS-A Voice Library — 音频校验（D）+ 幂等与并发（F）测试（真实 ffmpeg/ffprobe）。
 *
 * 覆盖（设计文档 docs/TTS_A_VOICE_LIBRARY_DESIGN.md §2/§4/§5）：
 *  D. audio validation：
 *     - 合法 WAV → created；canonical codec=pcm_s16le / 48k / mono；
 *       duration_ms 与 canonical 文件 ffprobe 实测一致；sha256 与实际文件一致；metadata.json 存在
 *     - 错误扩展名但真实音频（wav 内容命名 .mp3）→ 按内容识别成功；真实 mp3 → created
 *     - 假 WAV（随机字节）→ 415；带视频 mp4 → 415；空文件 → 415
 *     - truncated wav → 按观察到的实际行为断言（见 D7 注释，deterministic）
 *     - 超 MAX_REFERENCE_UPLOAD_BYTES → 413（size 预检）；300ms < MIN → 422；61s > MAX → 422
 *     - 立体声 44.1k 输入 → canonical 归一 mono/48k
 *     - ffprobe 注入 fail → 415 且 staging 无残留；ffmpeg 注入 fail → 错误且 staging 无残留、无 DB 行
 *     - subprocess timeout 常量存在且被传入 spawn 选项（源码断言）
 *  F. idempotency：
 *     - same requestId + same fingerprint → reused（同 revisionId，行数/文件数不变）
 *     - same requestId + 不同音频 → 409 request_id_conflict；transcript 改变 → 409
 *     - 并发 10× 同 requestId 同音频 → 恰好 1 行 revision，其余 reused，revision_number 无重复
 *     - 不同 requestId + 同音频同 Profile → 409 duplicate_audio
 *     - 跨 Profile 同音频 → 允许且文件独立（路径不同、各自存在、字节一致）
 *
 * 运行环境：需要真实 ffmpeg/ffprobe（仓库 .tools/static-ffmpeg，脚本自动 prepend PATH）。
 * 用法：npx tsx scripts/test-tts-a-voice-library-ingest.ts
 * 使用临时数据目录（data/test-tts-a-ingest），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

// 真实 ffmpeg/ffprobe：优先仓库内静态构建
const TOOLS_DIR = path.resolve(process.cwd(), '.tools', 'static-ffmpeg');
if (fs.existsSync(path.join(TOOLS_DIR, 'ffprobe'))) {
  process.env.PATH = `${TOOLS_DIR}:${process.env.PATH ?? ''}`;
}

const DATA_DIR = path.join('data', 'test-tts-a-ingest');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {
  ingestVoiceProfileRevision,
  type VoiceLibraryExecDeps,
} from '../src/lib/voice-library/revisions';
import {VoiceLibraryError} from '../src/lib/voice-library/types';
import {
  FFPROBE_TIMEOUT_MS,
  FFMPEG_TIMEOUT_MS,
  MAX_REFERENCE_UPLOAD_BYTES,
} from '../src/lib/voice-library/constants';

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

async function expectIngestError(
  label: string,
  fn: () => Promise<unknown>,
  code: string,
  httpStatus: number,
): Promise<void> {
  try {
    await fn();
    ok(false, label, '预期抛错但未抛');
  } catch (err) {
    ok(
      err instanceof VoiceLibraryError && err.code === code && err.httpStatus === httpStatus,
      label,
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}

// ---------- fixture：PCM WAV（16-bit，可参数化时长/声道/采样率） ----------

function makeWav(opts: {
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  freq?: number; // 0 = 静音
}): Buffer {
  const sampleRate = opts.sampleRate ?? 48000;
  const channels = opts.channels ?? 1;
  const freq = opts.freq ?? 440;
  const frames = Math.floor((sampleRate * opts.durationMs) / 1000);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = freq === 0 ? 0 : Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function ffprobeFormatDurationMs(absPath: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', absPath,
  ]).toString();
  return Math.round(Number(JSON.parse(out).format.duration) * 1000);
}

function sha256Buf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

function stagingResidue(): string[] {
  const staging = path.join(getDataDir(), 'voice-library', '.staging');
  return listFilesRecursive(staging);
}

function revisionCount(profileId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM voice_profile_revisions WHERE voice_profile_id = ?')
    .get(profileId) as {c: number}).c;
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const profile = createVoiceProfile({displayName: 'ingest 测试'});
  const pid = profile.id;
  const vlRoot = path.join(getDataDir(), 'voice-library');

  const wav2s = makeWav({durationMs: 2000});
  const ingest = (requestId: string, buf: Buffer, extra?: Partial<Parameters<typeof ingestVoiceProfileRevision>[0]>) =>
    ingestVoiceProfileRevision({voiceProfileId: pid, requestId, audioBuffer: buf, ...extra});

  // ---------- D. audio validation ----------

  // D1：合法 WAV → created，canonical 契约与文件一致
  const d1 = await ingest('req-d1', wav2s, {originalFilename: 'voice.wav'});
  const d1Abs = path.join(getDataDir(), d1.revision.canonical_audio_path);
  ok(
    d1.outcome === 'created' && d1.status === 201 &&
      d1.revision.codec === 'pcm_s16le' && d1.revision.sample_rate === 48000 && d1.revision.channels === 1,
    '[D1] 合法 WAV → created；canonical codec=pcm_s16le/48000Hz/mono',
  );
  ok(
    d1.revision.duration_ms === ffprobeFormatDurationMs(d1Abs),
    '[D2] duration_ms 与 canonical 文件 ffprobe 实测一致',
    {db: d1.revision.duration_ms, probe: ffprobeFormatDurationMs(d1Abs)},
  );
  ok(
    d1.revision.canonical_audio_sha256 === sha256Buf(fs.readFileSync(d1Abs)),
    '[D3] canonical_audio_sha256 与实际文件一致',
  );
  ok(
    fs.existsSync(path.join(vlRoot, pid, d1.revision.id, 'metadata.json')),
    '[D4] metadata.json 存在',
  );

  // D2：错误扩展名但真实音频（wav 内容命名 .mp3）→ 按内容识别成功
  const d2 = await ingest('req-d2', makeWav({durationMs: 2000, freq: 1000}), {originalFilename: 'not-really.mp3'});
  ok(
    d2.outcome === 'created' && d2.revision.original_filename_display === 'not-really.mp3',
    '[D5] wav 内容命名 .mp3 → 按内容识别成功（扩展名不参与判定）',
  );

  // 真实 mp3 fixture（ffmpeg 从 wav 转）→ created
  const tmpDir = path.join(getDataDir(), 'fixtures');
  fs.mkdirSync(tmpDir, {recursive: true});
  fs.writeFileSync(path.join(tmpDir, 'src.wav'), makeWav({durationMs: 2000, freq: 560}));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmpDir, 'src.wav'), path.join(tmpDir, 'real.mp3')]);
  const mp3Buf = fs.readFileSync(path.join(tmpDir, 'real.mp3'));
  const d3 = await ingest('req-d3', mp3Buf, {originalFilename: 'real.mp3'});
  ok(d3.outcome === 'created', '[D6] 真实 mp3 内容 → created（canonical 归一为 wav）');

  // 假 WAV（随机字节）→ 415
  await expectIngestError(
    '[D7] 假 WAV（随机字节）→ 415 unsupported_audio',
    () => ingest('req-d4', crypto.randomBytes(4096)),
    'unsupported_audio',
    415,
  );

  // 带视频 mp4（testsrc + 正弦）→ 415
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-shortest', path.join(tmpDir, 'with-video.mp4'),
  ]);
  await expectIngestError(
    '[D8] 带视频流 mp4 → 415 unsupported_audio',
    () => ingest('req-d5', fs.readFileSync(path.join(tmpDir, 'with-video.mp4'))),
    'unsupported_audio',
    415,
  );

  // 空文件 → 415（ffprobe 无法解析）
  await expectIngestError(
    '[D9] 空文件 → 415 unsupported_audio',
    () => ingest('req-d6', Buffer.alloc(0)),
    'unsupported_audio',
    415,
  );

  // truncated wav：观察到的实际行为（agentvm ffprobe N-125856）——
  // ffprobe 按实际数据长度读出 duration（不信 WAV header 声明），ffmpeg 对残缺数据
  // 正常转码退出 0；3s wav 截掉后半 → 实测 ~1.5s，落在 [MIN,MAX] 内 → deterministic created，
  // duration_ms 反映 canonical 实测（~1500ms）而非 header 声明的 3000ms。
  const wav3s = makeWav({durationMs: 3000, freq: 620});
  const trunc = wav3s.subarray(0, Math.floor(wav3s.length / 2));
  const d7 = await ingest('req-d7', Buffer.from(trunc));
  const d7Abs = path.join(getDataDir(), d7.revision.canonical_audio_path);
  ok(
    d7.outcome === 'created' && d7.revision.duration_ms >= 1000 && d7.revision.duration_ms <= 2000 &&
      d7.revision.duration_ms === ffprobeFormatDurationMs(d7Abs),
    '[D10] truncated wav（3s 截半）→ created，duration_ms 为 canonical 实测 ~1.5s（非 header 声明）',
    {durationMs: d7.revision.duration_ms},
  );

  // size 预检：> MAX_REFERENCE_UPLOAD_BYTES → 413
  await expectIngestError(
    '[D11] 超 MAX_REFERENCE_UPLOAD_BYTES → 413 file_too_large（size 预检）',
    () => ingest('req-d8', Buffer.alloc(MAX_REFERENCE_UPLOAD_BYTES + 1)),
    'file_too_large',
    413,
  );

  // 时长边界：300ms < MIN → 422；61s > MAX → 422（静音 wav，生成快）
  await expectIngestError(
    '[D12] 300ms < MIN_REFERENCE_AUDIO_MS → 422 invalid_audio_contract',
    () => ingest('req-d9', makeWav({durationMs: 300})),
    'invalid_audio_contract',
    422,
  );
  await expectIngestError(
    '[D13] 61s > MAX_REFERENCE_AUDIO_MS → 422 invalid_audio_contract',
    () => ingest('req-d10', makeWav({durationMs: 61000, freq: 0})),
    'invalid_audio_contract',
    422,
  );

  // 立体声 44.1k → canonical 归一 mono/48k
  const d11 = await ingest('req-d11', makeWav({durationMs: 2000, sampleRate: 44100, channels: 2, freq: 680}));
  ok(
    d11.outcome === 'created' && d11.revision.sample_rate === 48000 && d11.revision.channels === 1 &&
      d11.revision.codec === 'pcm_s16le',
    '[D14] 立体声 44.1kHz 输入 → canonical 归一为 mono/48kHz',
  );

  // ffprobe 注入 fail → 415 + staging 无残留 + 无 DB 行
  const beforeF = revisionCount(pid);
  const failFfprobe: VoiceLibraryExecDeps = {
    ffprobeImpl: async () => {
      throw new Error('injected ffprobe failure');
    },
  };
  await expectIngestError(
    '[D15] ffprobe 注入 fail → 415 unsupported_audio',
    () => ingestVoiceProfileRevision({voiceProfileId: pid, requestId: 'req-d12', audioBuffer: wav2s}, failFfprobe),
    'unsupported_audio',
    415,
  );
  ok(
    stagingResidue().length === 0 && revisionCount(pid) === beforeF,
    '[D16] ffprobe fail 后 staging 无残留、无 DB 行',
    stagingResidue(),
  );

  // ffmpeg 注入 fail → 415 + staging 无残留 + 无 DB 行
  const failFfmpeg: VoiceLibraryExecDeps = {
    ffmpegImpl: async () => {
      throw new Error('injected ffmpeg failure');
    },
  };
  await expectIngestError(
    '[D17] ffmpeg 注入 fail → 415 unsupported_audio',
    () => ingestVoiceProfileRevision({voiceProfileId: pid, requestId: 'req-d13', audioBuffer: wav2s}, failFfmpeg),
    'unsupported_audio',
    415,
  );
  ok(
    stagingResidue().length === 0 && revisionCount(pid) === beforeF,
    '[D18] ffmpeg fail 后 staging 无残留、无 DB 行',
    stagingResidue(),
  );

  // subprocess timeout 常量存在且被传入 spawn 选项（源码断言）
  const revisionsSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/lib/voice-library/revisions.ts'),
    'utf8',
  );
  ok(
    FFPROBE_TIMEOUT_MS === 15000 && FFMPEG_TIMEOUT_MS === 60000 &&
      revisionsSrc.includes('timeout: FFPROBE_TIMEOUT_MS') &&
      revisionsSrc.includes('timeout: FFMPEG_TIMEOUT_MS'),
    '[D19] subprocess timeout 常量（ffprobe 15s / ffmpeg 60s）存在且传入 execFile 选项',
  );

  // ---------- F. idempotency ----------

  const fAudio = makeWav({durationMs: 1500, freq: 550});
  const f1 = await ingest('req-f1', fAudio, {transcript: '你好 世界'});
  const countAfterF1 = revisionCount(pid);
  const filesAfterF1 = listFilesRecursive(vlRoot).length;
  const f1again = await ingest('req-f1', fAudio, {transcript: '你好 世界'});
  ok(
    f1again.outcome === 'reused' && f1again.status === 200 && f1again.revision.id === f1.revision.id &&
      revisionCount(pid) === countAfterF1 && listFilesRecursive(vlRoot).length === filesAfterF1,
    '[F1] same requestId + same fingerprint → 200 reused（revisionId 相同、行数/文件数不变）',
  );

  await expectIngestError(
    '[F2] same requestId + 不同音频 → 409 request_id_conflict',
    () => ingest('req-f1', makeWav({durationMs: 1500, freq: 660}), {transcript: '你好 世界'}),
    'request_id_conflict',
    409,
  );
  await expectIngestError(
    '[F3] same requestId + transcript 改变 → 409 request_id_conflict',
    () => ingest('req-f1', fAudio, {transcript: '另一段文本'}),
    'request_id_conflict',
    409,
  );

  // 并发 10× 同 requestId 同音频 → 恰好 1 行 revision
  const concAudio = makeWav({durationMs: 1500, freq: 770});
  const concResults = await Promise.all(
    Array.from({length: 10}, () => ingest('req-conc', concAudio)),
  );
  const concRows = getDb()
    .prepare('SELECT * FROM voice_profile_revisions WHERE voice_profile_id = ? AND request_id = ?')
    .all(pid, 'req-conc') as Array<{revision_number: number}>;
  const createdCount = concResults.filter((r) => r.outcome === 'created').length;
  const reusedCount = concResults.filter((r) => r.outcome === 'reused').length;
  const allSameId = new Set(concResults.map((r) => r.revision.id)).size === 1;
  const revNumbers = getDb()
    .prepare('SELECT revision_number FROM voice_profile_revisions WHERE voice_profile_id = ?')
    .all(pid) as Array<{revision_number: number}>;
  const noDupNumbers = new Set(revNumbers.map((r) => r.revision_number)).size === revNumbers.length;
  ok(
    concRows.length === 1 && createdCount === 1 && reusedCount === 9 && allSameId && noDupNumbers,
    '[F4] 并发 10× 同 requestId 同音频 → 恰好 1 行 revision（1 created + 9 reused），revision_number 无重复',
    {rows: concRows.length, createdCount, reusedCount},
  );

  // 不同 requestId + 同音频同 Profile → 409 duplicate_audio
  await expectIngestError(
    '[F5] 不同 requestId + 同音频同 Profile → 409 duplicate_audio',
    () => ingest('req-f2', concAudio),
    'duplicate_audio',
    409,
  );

  // 跨 Profile 同音频 → 允许且文件独立
  const profileB = createVoiceProfile({displayName: '第二个 Profile'});
  const cross = await ingestVoiceProfileRevision({
    voiceProfileId: profileB.id,
    requestId: 'req-cross',
    audioBuffer: concAudio,
  });
  const crossAbs = path.join(getDataDir(), cross.revision.canonical_audio_path);
  const ownAbs = path.join(
    getDataDir(),
    (getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE voice_profile_id = ? AND request_id = ?')
      .get(pid, 'req-conc') as {p: string}).p,
  );
  ok(
    cross.outcome === 'created' && cross.revision.canonical_audio_path !==
      (getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE voice_profile_id = ? AND request_id = ?')
        .get(pid, 'req-conc') as {p: string}).p &&
      fs.existsSync(crossAbs) && fs.existsSync(ownAbs) &&
      fs.readFileSync(crossAbs).equals(fs.readFileSync(ownAbs)),
    '[F6] 跨 Profile 同音频 → created，文件独立（路径不同、各自存在、字节一致）',
  );

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-A ingest 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A Voice Library ingest（音频校验+幂等并发）测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

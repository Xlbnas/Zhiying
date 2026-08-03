/**
 * TTS-A.R2 — staging ownership + I/O failure containment 权威测试（S1..S8）。
 *
 * 真实运行代码（route handler / parser / core），不做纯源码字符串匹配：
 *  S1 open failure：mkdir 成功、open 抛 ENOSPC → 500 ingest_failed、无 uncaught、
 *     DB row=0、staging 无残留、ffprobe calls=0（core 未进入）
 *  S2 mid-stream write failure：多 chunk body、第 2 个 write 抛 ENOSPC →
 *     route 返回 500 JSON、不抛到进程顶层、source 未全部消费、fd close exactly once、
 *     parser/source 停止、DB row=0、staging 无残留
 *  S3 fsync failure：500 ingest_failed、DB row=0、staging 无残留、core 未进入
 *  S4 close failure：同 S3 且证明 cleanup 仍执行（staging 无残留）、close 尝试一次
 *  S5 parser cleanup failure：注入 rm 抛错 + parser 错误 → 返回原始 parser 错误、
 *     cleanup 错误不覆盖原错误、无 uncaught
 *  S6 core early validation（Buffer wrapper 与 staged core 分别测）：
 *     invalid requestId / profile not found / transcript 过长 / language 非法 →
 *     原始稳定错误码不变；staging cleanup 被调用；cleanup failure 不覆盖原始错误
 *  S7 post-commit cleanup failure：正常 canonical + commit 成功 + rm 抛错 →
 *     outcome=created、status=201、DB row=1、exact usable=true、final WAV 存在且 hash 正确、
 *     无第二行；另测 same requestId reused → 仍 200 reused、revisionId 不变
 *  S8 route ownership：route 无 fs.rmSync / 无 stagingDir 局部 / 无第二套 finally
 *     （源码断言）+ 运行时：成功 POST 后 staging 无残留（core 清理）、parser 失败后无残留
 *
 * 用法：npx tsx scripts/test-tts-a-staging-failures.ts
 * 使用临时数据目录（data/test-tts-a-staging-failures），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOOLS_DIR = path.resolve(process.cwd(), '.tools', 'static-ffmpeg');
if (fs.existsSync(path.join(TOOLS_DIR, 'ffprobe'))) {
  process.env.PATH = `${TOOLS_DIR}:${process.env.PATH ?? ''}`;
}

const DATA_DIR = path.join('data', 'test-tts-a-staging-failures');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {createVoiceProfile} from '../src/lib/voice-library/profiles';
import {
  getVoiceProfileRevisionExact,
  ingestVoiceProfileRevision,
  ingestVoiceProfileRevisionFromStaged,
  type VoiceLibraryExecDeps,
} from '../src/lib/voice-library/revisions';
import {POST as revisionsPOST, type VoiceUploadRouteDeps} from '../src/app/api/voice-profiles/[profileId]/revisions/route';
import {VoiceLibraryError} from '../src/lib/voice-library/types';

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

function makeWav(durationMs: number, freq: number): Buffer {
  const sampleRate = 48000;
  const frames = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function revisionCount(profileId: string): number {
  return (getDb()
    .prepare('SELECT COUNT(*) AS c FROM voice_profile_revisions WHERE voice_profile_id = ?')
    .get(profileId) as {c: number}).c;
}

function stagingEntries(): string[] {
  const staging = path.join(getDataDir(), 'voice-library', '.staging');
  if (!fs.existsSync(staging)) return [];
  if (!fs.statSync(staging).isDirectory()) return [];
  return fs.readdirSync(staging);
}

/** 测试级清理：清空 .staging 下所有残留（注入 throwing-rm 留下的目录是预期残留）。 */
function sweepStaging(): void {
  const staging = path.join(getDataDir(), 'voice-library', '.staging');
  fs.rmSync(staging, {recursive: true, force: true});
  fs.mkdirSync(staging, {recursive: true});
}

const BASE = 'http://localhost';
const profileParams = (profileId: string) => ({params: Promise.resolve({profileId})});

function formReq(profileId: string, requestId: string, wav: Buffer): Request {
  const form = new FormData();
  form.set('requestId', requestId);
  form.set('audio', new File([new Uint8Array(wav)], 'voice.wav'));
  return new Request(`${BASE}/api/voice-profiles/${profileId}/revisions`, {method: 'POST', body: form});
}

/** 合法 multipart body，文件数据以 64KB 分块流式产出（S2 需要多个 data chunk）。 */
function streamMultipartBody(fileBytes: number, boundary = 's2-boundary'): {
  body: ReadableStream<Uint8Array>;
  totalBytes: number;
  generated: () => number;
} {
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\ns2-req\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="big.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const chunkSize = 64 * 1024;
  const totalBytes = prefix.length + fileBytes + suffix.length;
  let remaining = fileBytes;
  let generated = 0;
  let phase: 'prefix' | 'file' | 'suffix' = 'prefix';
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 'prefix') {
        phase = 'file';
        generated += prefix.length;
        controller.enqueue(prefix);
        return;
      }
      if (phase === 'file') {
        if (remaining > 0) {
          const n = Math.min(chunkSize, remaining);
          generated += n;
          remaining -= n;
          controller.enqueue(Buffer.alloc(n, 7));
          return;
        }
        phase = 'suffix';
      }
      generated += suffix.length;
      controller.enqueue(suffix);
      controller.close();
    },
  });
  return {body, totalBytes, generated: () => generated};
}

function streamRequest(
  url: string,
  headers: Record<string, string>,
  body: ReadableStream<Uint8Array>,
): Request {
  return new Request(url, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
}

const MOCK_EXEC: VoiceLibraryExecDeps = {
  ffprobeImpl: async () => ({
    durationMs: 2000,
    codec: 'pcm_s16le',
    sampleRate: 48000,
    channels: 1,
    hasVideo: false,
  }),
  ffmpegImpl: async (args: string[]) => {
    const inputPath = args[args.indexOf('-i') + 1];
    const outPath = args[args.length - 1];
    const h = crypto.createHash('sha256').update(fs.readFileSync(inputPath)).digest('hex');
    fs.writeFileSync(outPath, Buffer.from(`FAKE-CANONICAL:${h}`));
  },
};

/** 在 .staging/<uuid> 下创建合法 staging 目录（供 staged core 直接调用）。 */
function makeValidStagingDir(): {stagingDir: string; originalPath: string} {
  const rootAbs = path.join(getDataDir(), 'voice-library');
  fs.mkdirSync(path.join(rootAbs, '.staging'), {recursive: true});
  const stagingDir = path.join(rootAbs, '.staging', crypto.randomUUID());
  fs.mkdirSync(stagingDir, {mode: 0o700});
  return {stagingDir, originalPath: path.join(stagingDir, 'original.bin')};
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const pid = createVoiceProfile({displayName: 'staging failures'}).id;
  const wav = makeWav(1500, 440);

  // ---------- S1：open failure（mkdir 成功，open 抛错） ----------
  {
    let ffprobeCalls = 0;
    const deps: VoiceUploadRouteDeps = {
      multipartFileOps: {
        mkdir: (d, m) => fs.mkdirSync(d, {mode: m}),
        open: () => {
          throw Object.assign(new Error('ENOSPC: staging open failure'), {code: 'ENOSPC'});
        },
      },
      execDeps: {
        ffprobeImpl: async () => {
          ffprobeCalls++;
          return {durationMs: 2000, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, hasVideo: false};
        },
      },
    };
    const res = await revisionsPOST(formReq(pid, 's1', wav), profileParams(pid), deps);
    const body = (await res.json()) as {error: string};
    ok(
      res.status === 500 && body.error === 'ingest_failed',
      '[S1] open original.bin 失败 → 500 ingest_failed（稳定错误）',
      {status: res.status, error: body.error},
    );
    ok(revisionCount(pid) === 0 && stagingEntries().length === 0, '[S1b] open 失败 → DB row=0、staging 无残留');
    ok(ffprobeCalls === 0, '[S1c] open 失败 → ffprobe calls=0（core 未进入）', {ffprobeCalls});
  }

  // ---------- S2：mid-stream write failure（第 2 个 write 抛 ENOSPC） ----------
  {
    let writeCalls = 0;
    let closeCalls = 0;
    const deps: VoiceUploadRouteDeps = {
      multipartFileOps: {
        mkdir: (d, m) => fs.mkdirSync(d, {mode: m}),
        open: (p, f, m) => fs.openSync(p, f, m),
        write: (fd, chunk, off, len) => {
          writeCalls++;
          if (writeCalls === 2) {
            throw Object.assign(new Error('ENOSPC: staging write failure'), {code: 'ENOSPC'});
          }
          return fs.writeSync(fd, chunk, off, len);
        },
        fsync: (fd) => fs.fsyncSync(fd),
        close: (fd) => {
          closeCalls++;
          fs.closeSync(fd);
        },
      },
    };
    const {body, totalBytes, generated} = streamMultipartBody(3 * 1024 * 1024);
    const res = await revisionsPOST(
      streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
        'content-type': 'multipart/form-data; boundary=s2-boundary',
      }, body),
      profileParams(pid),
      deps,
    );
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 500 && bodyJson.error === 'ingest_failed',
      '[S2] 第 2 个 write 失败 → route 正常返回 500 ingest_failed JSON（未抛到进程顶层）',
      {status: res.status, error: bodyJson.error},
    );
    ok(
      generated() < totalBytes,
      '[S2b] write 失败后 source 未被全部消费（parser/source 停止）',
      {generated: generated(), totalBytes},
    );
    ok(closeCalls === 1, '[S2c] fd close exactly once', {closeCalls});
    ok(
      revisionCount(pid) === 0 && stagingEntries().length === 0,
      '[S2d] write 失败 → DB row=0、staging 无残留',
      {rows: revisionCount(pid)},
    );
  }

  // ---------- S3：fsync failure ----------
  {
    let ffprobeCalls = 0;
    const deps: VoiceUploadRouteDeps = {
      multipartFileOps: {
        mkdir: (d, m) => fs.mkdirSync(d, {mode: m}),
        open: (p, f, m) => fs.openSync(p, f, m),
        write: (fd, chunk, off, len) => fs.writeSync(fd, chunk, off, len),
        fsync: () => {
          throw new Error('injected fsync failure');
        },
        close: (fd) => fs.closeSync(fd),
      },
      execDeps: {
        ffprobeImpl: async () => {
          ffprobeCalls++;
          return {durationMs: 2000, codec: 'pcm_s16le', sampleRate: 48000, channels: 1, hasVideo: false};
        },
      },
    };
    const res = await revisionsPOST(formReq(pid, 's3', wav), profileParams(pid), deps);
    const body = (await res.json()) as {error: string};
    ok(
      res.status === 500 && body.error === 'ingest_failed',
      '[S3] staging fsync 失败 → 500 ingest_failed',
      {status: res.status, error: body.error},
    );
    ok(
      revisionCount(pid) === 0 && stagingEntries().length === 0 && ffprobeCalls === 0,
      '[S3b] fsync 失败 → DB row=0、staging 无残留、core 未进入',
      {ffprobeCalls},
    );
  }

  // ---------- S4：close failure ----------
  {
    let closeAttempts = 0;
    const deps: VoiceUploadRouteDeps = {
      multipartFileOps: {
        mkdir: (d, m) => fs.mkdirSync(d, {mode: m}),
        open: (p, f, m) => fs.openSync(p, f, m),
        write: (fd, chunk, off, len) => fs.writeSync(fd, chunk, off, len),
        fsync: (fd) => fs.fsyncSync(fd),
        close: () => {
          closeAttempts++;
          throw new Error('injected close failure');
        },
      },
    };
    const res = await revisionsPOST(formReq(pid, 's4', wav), profileParams(pid), deps);
    const body = (await res.json()) as {error: string};
    ok(
      res.status === 500 && body.error === 'ingest_failed',
      '[S4] staging close 失败 → 500 ingest_failed',
      {status: res.status, error: body.error},
    );
    ok(
      revisionCount(pid) === 0 && stagingEntries().length === 0,
      '[S4b] close 失败 → DB row=0、staging 无残留（cleanup 仍执行）',
    );
    ok(closeAttempts === 1, '[S4c] close 最多尝试一次（close 失败不重试）', {closeAttempts});
  }

  // ---------- S5：parser cleanup failure + parser 错误 → 原始错误不被覆盖 ----------
  {
    const deps: VoiceUploadRouteDeps = {
      multipartFileOps: {
        rm: () => {
          throw new Error('injected rm failure');
        },
      },
    };
    const garbage = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from('this is not a valid multipart body at all'));
        controller.close();
      },
    });
    const res = await revisionsPOST(
      streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
        'content-type': 'multipart/form-data; boundary=zzz',
      }, garbage),
      profileParams(pid),
      deps,
    );
    const body = (await res.json()) as {error: string};
    ok(
      (res.status === 400 && body.error === 'invalid_formdata') ||
        (res.status === 422 && body.error === 'invalid_request'),
      '[S5] cleanup（rm）失败 + parser 错误 → 返回原始 parser 错误（cleanup 错误不覆盖）',
      {status: res.status, error: body.error},
    );
    ok(revisionCount(pid) === 0, '[S5b] cleanup 失败路径无 DB 行');
  }

  // ---------- S6：core early validation（Buffer wrapper + staged core 双路径） ----------
  {
    const cases: Array<{
      label: string;
      input: Parameters<typeof ingestVoiceProfileRevisionFromStaged>[0];
      expectCode: string;
      expectStatus: number;
    }> = [
      {
        label: 'invalid requestId（空）',
        input: {voiceProfileId: pid, requestId: '', stagingDir: makeValidStagingDir().stagingDir, stagedOriginalPath: makeValidStagingDir().originalPath, originalSha256: 'a'.repeat(64), byteLength: 100},
        expectCode: 'invalid_request',
        expectStatus: 422,
      },
      {
        label: 'profile not found',
        input: {voiceProfileId: 'no-such-profile', requestId: 's6-pnf', stagingDir: makeValidStagingDir().stagingDir, stagedOriginalPath: makeValidStagingDir().originalPath, originalSha256: 'a'.repeat(64), byteLength: 100},
        expectCode: 'profile_not_found',
        expectStatus: 404,
      },
      {
        label: 'transcript 过长',
        input: {voiceProfileId: pid, requestId: 's6-t', transcript: 'x'.repeat(4001), stagingDir: makeValidStagingDir().stagingDir, stagedOriginalPath: makeValidStagingDir().originalPath, originalSha256: 'a'.repeat(64), byteLength: 100},
        expectCode: 'invalid_request',
        expectStatus: 422,
      },
      {
        label: 'language 非法（空串）',
        input: {voiceProfileId: pid, requestId: 's6-l', language: '', stagingDir: makeValidStagingDir().stagingDir, stagedOriginalPath: makeValidStagingDir().originalPath, originalSha256: 'a'.repeat(64), byteLength: 100},
        expectCode: 'invalid_request',
        expectStatus: 422,
      },
    ];
    for (const c of cases) {
      // staged core 路径：注入 rm 计数 + 抛错（同时证明 cleanup 被调用且不覆盖原错误）
      let rmCalls = 0;
      const deps: VoiceLibraryExecDeps = {
        fileOps: {
          rm: () => {
            rmCalls++;
            throw new Error('injected rm failure');
          },
        },
      };
      let stagedErr: unknown = null;
      try {
        await ingestVoiceProfileRevisionFromStaged(c.input, deps);
      } catch (err) {
        stagedErr = err;
      }
      ok(
        stagedErr instanceof VoiceLibraryError &&
          stagedErr.code === c.expectCode &&
          stagedErr.httpStatus === c.expectStatus,
        `[S6a-${c.label}] staged core 早验错误码稳定（${c.expectCode}/${c.expectStatus}）`,
        stagedErr instanceof Error ? `${(stagedErr as VoiceLibraryError).code}` : String(stagedErr),
      );
      ok(
        rmCalls >= 1,
        `[S6b-${c.label}] staged core 早验路径 cleanup 被调用（rm >= 1 次）`,
        {rmCalls},
      );
      // Buffer wrapper 路径：同输入（staging 由 wrapper 创建并传给 core）
      let wrapperErr: unknown = null;
      try {
        await ingestVoiceProfileRevision(
          {
            voiceProfileId: c.input.voiceProfileId,
            requestId: c.input.requestId,
            audioBuffer: makeWav(1500, 440),
            transcript: c.input.transcript,
            language: c.input.language,
          },
          {
            fileOps: {
              rm: () => {
                rmCalls++;
                throw new Error('injected rm failure');
              },
            },
          },
        );
      } catch (err) {
        wrapperErr = err;
      }
      ok(
        wrapperErr instanceof VoiceLibraryError &&
          wrapperErr.code === c.expectCode &&
          wrapperErr.httpStatus === c.expectStatus,
        `[S6c-${c.label}] Buffer wrapper 早验错误码稳定且 cleanup 失败不覆盖原错误`,
        wrapperErr instanceof Error ? `${(wrapperErr as VoiceLibraryError).code}` : String(wrapperErr),
      );
      ok(
        revisionCount(pid) === 0,
        `[S6d-${c.label}] 早验路径无 DB 行`,
        {rows: revisionCount(pid)},
      );
    }
    // 清理 S6 注入 throwing-rm 留下的 staging 残留（测试自建目录，真实 fs 清空），
    // 使 S6e 的残留断言不被污染
    sweepStaging();
    // S6e：cleanup 成功（真实 rm）时 staging 无残留——证明 cleanup 正常路径生效
    {
      const staged = makeValidStagingDir();
      const bad = {
        voiceProfileId: pid,
        requestId: '',
        stagingDir: staged.stagingDir,
        stagedOriginalPath: staged.originalPath,
        originalSha256: 'a'.repeat(64),
        byteLength: 100,
      };
      let err: unknown = null;
      try {
        await ingestVoiceProfileRevisionFromStaged(bad, {});
      } catch (e) {
        err = e;
      }
      ok(
        err instanceof VoiceLibraryError && err.code === 'invalid_request' && err.httpStatus === 422 &&
          stagingEntries().length === 0,
        '[S6e] 早验路径 + cleanup 成功（真实 rm）→ 原始错误不变且 staging 无残留',
        {staging: stagingEntries()},
      );
    }
    // 清理 S6 注入 throwing-rm 留下的 staging 残留（测试自建目录，真实 fs 清空）
    sweepStaging();
  }

  // ---------- S7：post-commit cleanup failure → 业务成功不可被推翻 ----------
  {
    let rmCalls = 0;
    const deps: VoiceLibraryExecDeps = {
      ...MOCK_EXEC,
      fileOps: {
        rm: () => {
          rmCalls++;
          throw new Error('injected rm failure');
        },
      },
    };
    const result = await ingestVoiceProfileRevision(
      {voiceProfileId: pid, requestId: 's7', audioBuffer: makeWav(1500, 550)},
      deps,
    );
    ok(
      result.outcome === 'created' && result.status === 201,
      '[S7] commit 成功后 cleanup（rm）失败 → 仍返回 created/201（不返回 500）',
      {outcome: result.outcome, status: result.status},
    );
    const rows = revisionCount(pid);
    ok(rows === 1, '[S7b] 只有 1 行（无第二行）', {rows});
    const exact = await getVoiceProfileRevisionExact(pid, result.revision.id);
    const finalAbs = path.join(getDataDir(), result.revision.canonical_audio_path);
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(finalAbs)).digest('hex');
    ok(
      exact !== null && exact.usable === true && fs.existsSync(finalAbs) &&
        fileHash === result.revision.canonical_audio_sha256,
      '[S7c] committed row 与 final 文件保持 usable（exact usable=true、hash 正确）',
    );
    ok(rmCalls >= 1, '[S7d] cleanup 确实被尝试（rm 被调用）', {rmCalls});
    // same requestId reused：cleanup 仍抛错 → 仍 200 reused、revisionId 不变
    const reuse = await ingestVoiceProfileRevision(
      {voiceProfileId: pid, requestId: 's7', audioBuffer: makeWav(1500, 550)},
      deps,
    );
    ok(
      reuse.outcome === 'reused' && reuse.status === 200 && reuse.revision.id === result.revision.id &&
        revisionCount(pid) === 1,
      '[S7e] same requestId reused + cleanup 失败 → 仍 200 reused、revisionId 不变、无新增行',
      {outcome: reuse.outcome, status: reuse.status},
    );
    // S7 注入 throwing-rm 留下的 staging 残留是预期行为；清理后 S8 残留断言不被污染
    sweepStaging();
  }

  // ---------- S8：route ownership（源码 + 运行时） ----------
  {
    const routeSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/api/voice-profiles/[profileId]/revisions/route.ts'),
      'utf8',
    );
    // 只看代码（去注释行）：注释中允许提及这些字样，代码中不允许出现。
    // stagingDir 作为 core 输入字段名（stagingDir: staged.stagingDir）是必要的；
    // 禁止的是 route 声明自己的局部 stagingDir 变量 / fs.rmSync / cleanup finally。
    const codeOnly = routeSrc
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*') && !l.trim().startsWith('//'))
      .join('\n');
    ok(
      !codeOnly.includes('fs.rmSync') &&
        !/\b(let|const|var)\s+stagingDir\b/.test(codeOnly) &&
        !codeOnly.includes('finally'),
      '[S8] 源码：route 无 fs.rmSync / stagingDir 局部变量声明 / 第二套 cleanup finally',
    );
    // 运行时：成功 POST 后 staging 由 core 清理（无残留）
    const okRes = await revisionsPOST(formReq(pid, 's8-ok', makeWav(1500, 660)), profileParams(pid));
    const okBody = (await okRes.json()) as {outcome: string};
    ok(okRes.status === 201 && okBody.outcome === 'created' && stagingEntries().length === 0, '[S8b] 成功 POST 201 + staging 无残留（core 清理）');
    // parser 失败路径（body 超限垃圾流）→ parser 清理
    const {body, generated} = (() => {
      let remaining = 31 * 1024 * 1024;
      let gen = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (remaining > 0) {
            const n = Math.min(64 * 1024, remaining);
            remaining -= n;
            gen += n;
            c.enqueue(Buffer.alloc(n, 7));
            return;
          }
          c.close();
        },
      });
      return {body: stream, generated: () => gen};
    })();
    const failRes = await revisionsPOST(
      streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
        'content-type': 'multipart/form-data; boundary=s8b',
      }, body),
      profileParams(pid),
    );
    const failBody = (await failRes.json()) as {error: string};
    ok(
      failRes.status === 413 && failBody.error === 'body_too_large' && stagingEntries().length === 0,
      '[S8c] parser 失败路径（413 body_too_large）→ staging 无残留（parser 清理）',
      {status: failRes.status, error: failBody.error, generated: generated()},
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-A.R2 staging failures 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A.R2 staging ownership + I/O failure containment 测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

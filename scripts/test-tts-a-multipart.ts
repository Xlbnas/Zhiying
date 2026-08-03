/**
 * TTS-A.R1 — bounded multipart streaming 测试（M1..M9）。
 *
 * 直接调用 POST /api/voice-profiles/[profileId]/revisions route handler
 * （构造 Request，不起 Next server）。覆盖（设计文档 §4/§6，TTS-A.R1 streaming contract）：
 *  M1 Content-Length 明确大于总限制 → 413 body_too_large（读取 body 前返回；parser 未消费 body；staging 无文件）
 *  M2 chunked / 无 Content-Length 超限 → 流式计数立即中止 → 413；不消费剩余 body；无 DB 行；无 staging 残留
 *  M3 Content-Length 伪造偏小但真实 body 超限 → 仍由流式计数返回 413
 *  M4 单文件 > 25MB（总 body 未超总限制）→ 413 file_too_large
 *  M5 两个 audio → 422 invalid_request
 *  M6 unknown field → 422 invalid_request
 *  M7 重复 requestId / transcript / language → 422 invalid_request
 *  M8 合法 multipart → 201 + 真实 canonical；API 未持有完整 file Buffer 的实现证据（源码断言）
 *  M9 parser 错误 / 客户端断连 → 无 DB 行；staging 安全清理
 *
 * 用法：npx tsx scripts/test-tts-a-multipart.ts
 * 使用临时数据目录（data/test-tts-a-multipart），结束后清理。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';

const TOOLS_DIR = path.resolve(process.cwd(), '.tools', 'static-ffmpeg');
if (fs.existsSync(path.join(TOOLS_DIR, 'ffprobe'))) {
  process.env.PATH = `${TOOLS_DIR}:${process.env.PATH ?? ''}`;
}

const DATA_DIR = path.join('data', 'test-tts-a-multipart');
process.env.ZHIYING_DATA_DIR = DATA_DIR;

import {closeDb, getDb, getDataDir} from '../src/lib/db';
import {POST as profilesPOST} from '../src/app/api/voice-profiles/route';
import {POST as revisionsPOST} from '../src/app/api/voice-profiles/[profileId]/revisions/route';
import {
  MAX_MULTIPART_FIELD_BYTES,
  MAX_REFERENCE_MULTIPART_BODY_BYTES,
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

/**
 * 构造按块流式产出 bytes 字节的无边界数据流（用于测总 body 上限：不依赖合法 multipart，
 * busboy 对首个 boundary 之前的 preamble 不设限，纯字节计数会在 30MB 处触发 413 body_too_large）。
 */
function garbageStream(bytes: number): {
  body: ReadableStream<Uint8Array>;
  totalBytes: number;
  generated: () => number;
} {
  // 64KB 分块：read-ahead 最多 1 块（~64KB），超限中止后 generated 明显 < totalBytes
  const chunkSize = 64 * 1024;
  let remaining = bytes;
  let generated = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining > 0) {
        const n = Math.min(chunkSize, remaining);
        remaining -= n;
        generated += n;
        controller.enqueue(Buffer.alloc(n, 7));
        return;
      }
      controller.close();
    },
  });
  return {body, totalBytes: bytes, generated: () => generated};
}

const BASE = 'http://localhost';
const profileParams = (profileId: string) => ({params: Promise.resolve({profileId})});

/** 流式 body 的 Request（undici 要求 duplex:'half'；TS lib.dom 无此字段 → 断言）。 */
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

function formReq(profileId: string, build: (f: FormData) => void): Request {
  const form = new FormData();
  build(form);
  return new Request(`${BASE}/api/voice-profiles/${profileId}/revisions`, {method: 'POST', body: form});
}

async function main(): Promise<void> {
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});
  getDb();
  const create = await profilesPOST(
    new Request(`${BASE}/api/voice-profiles`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({displayName: 'multipart 测试'}),
    }),
  );
  const pid = ((await create.json()) as {profile: {id: string}}).profile.id;

  // ---------- M1：Content-Length 明确大于总限制 → 413（读取 body 前返回） ----------
  {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(Buffer.alloc(4096));
      },
    });
    const req = streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
      'content-type': 'multipart/form-data; boundary=m1',
      'content-length': String(MAX_REFERENCE_MULTIPART_BODY_BYTES + 1),
    }, body);
    const res = await revisionsPOST(req, profileParams(pid));
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 413 && bodyJson.error === 'body_too_large',
      '[M1] Content-Length 明确超总限制 → 413 body_too_large（读取 body 前）',
      {status: res.status, error: bodyJson.error},
    );
    // undici 在 Request 构造/处理时会内部拉取首块；parser 在 content-length 预检即返回，
    // 从未创建读取流/pipe body。pulls ≤ 2 证明 body 未被 parser 消费。
    ok(
      pulls <= 2,
      '[M1b] parser 未消费 body（无 Readable.fromWeb/pipe；仅 undici Request 内部拉取 ≤2 块）',
      {pulls},
    );
    ok(stagingEntries().length === 0, '[M1c] staging 无文件', stagingEntries());
  }

  // ---------- M2：chunked / 无 Content-Length 超限 → 流式计数立即中止 413 ----------
  {
    const {body, totalBytes, generated} = garbageStream(31 * 1024 * 1024);
    const req = streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
      'content-type': 'multipart/form-data; boundary=ttsa-m-boundary',
    }, body);
    const res = await revisionsPOST(req, profileParams(pid));
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 413 && bodyJson.error === 'body_too_large',
      '[M2] 无 Content-Length（chunked）总 body 超限 → 流式计数 413 body_too_large',
      {status: res.status, error: bodyJson.error},
    );
    ok(
      generated() < totalBytes,
      '[M2b] 超限立即中止，不把剩余 body 全部消费',
      {generated: generated(), totalBytes},
    );
    ok(
      revisionCount(pid) === 0 && stagingEntries().length === 0,
      '[M2c] 无 DB 行、无 staging 残留',
      {rows: revisionCount(pid), staging: stagingEntries()},
    );
  }

  // ---------- M3：Content-Length 伪造偏小但真实 body 超限 → 仍 413 ----------
  {
    const {body, generated} = garbageStream(31 * 1024 * 1024);
    const req = streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
      'content-type': 'multipart/form-data; boundary=ttsa-m-boundary',
      'content-length': '1024',
    }, body);
    const res = await revisionsPOST(req, profileParams(pid));
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 413 && bodyJson.error === 'body_too_large',
      '[M3] Content-Length 伪造偏小 → 由流式实测计数返回 413 body_too_large',
      {status: res.status, error: bodyJson.error},
    );
    ok(
      generated() < 31 * 1024 * 1024,
      '[M3b] 流式计数在真实超限点中止',
      {generated: generated()},
    );
    ok(revisionCount(pid) === 0 && stagingEntries().length === 0, '[M3c] 无 DB 行、无 staging 残留');
  }

  // ---------- M4：单文件 > 25MB（总 body < 30MB）→ 413 file_too_large ----------
  {
    const bigFile = new File([new Uint8Array(MAX_REFERENCE_UPLOAD_BYTES + 1024)], 'big.wav');
    const res = await revisionsPOST(
      formReq(pid, (f) => {
        f.set('requestId', 'm4');
        f.set('audio', bigFile);
      }),
      profileParams(pid),
    );
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 413 && bodyJson.error === 'file_too_large',
      '[M4] 单文件 > 25MB（总 body 未超 30MB）→ 413 file_too_large',
      {status: res.status, error: bodyJson.error},
    );
    ok(revisionCount(pid) === 0 && stagingEntries().length === 0, '[M4b] 无 DB 行、无 staging 残留');
  }

  // ---------- M5：两个 audio → 422 invalid_request ----------
  {
    const res = await revisionsPOST(
      formReq(pid, (f) => {
        f.append('requestId', 'm5');
        f.append('audio', new File([new Uint8Array(makeWav(1200, 440))], 'a.wav'));
        f.append('audio', new File([new Uint8Array(makeWav(1200, 550))], 'b.wav'));
      }),
      profileParams(pid),
    );
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 422 && bodyJson.error === 'invalid_request',
      '[M5] 两个 audio → 422 invalid_request',
      {status: res.status, error: bodyJson.error},
    );
    ok(revisionCount(pid) === 0 && stagingEntries().length === 0, '[M5b] 无 DB 行、无 staging 残留');
  }

  // ---------- M6：unknown field → 422 invalid_request ----------
  {
    const res = await revisionsPOST(
      formReq(pid, (f) => {
        f.set('requestId', 'm6');
        f.set('audio', new File([new Uint8Array(makeWav(1200, 440))], 'a.wav'));
        f.set('bogus', 'x');
      }),
      profileParams(pid),
    );
    const bodyJson = (await res.json()) as {error: string};
    ok(
      res.status === 422 && bodyJson.error === 'invalid_request',
      '[M6] unknown field → 422 invalid_request',
      {status: res.status, error: bodyJson.error},
    );
    ok(revisionCount(pid) === 0 && stagingEntries().length === 0, '[M6b] 无 DB 行、无 staging 残留');
  }

  // ---------- M7：重复 requestId / transcript / language → 422 ----------
  {
    for (const [label, field] of [
      ['requestId', 'requestId'],
      ['transcript', 'transcript'],
      ['language', 'language'],
    ] as const) {
      const res = await revisionsPOST(
        formReq(pid, (f) => {
          f.append('requestId', 'm7-' + label);
          f.append('audio', new File([new Uint8Array(makeWav(1200, 440))], 'a.wav'));
          f.append(field, 'first');
          f.append(field, 'second');
        }),
        profileParams(pid),
      );
      const bodyJson = (await res.json()) as {error: string};
      ok(
        res.status === 422 && bodyJson.error === 'invalid_request',
        `[M7] 重复 ${label} → 422 invalid_request`,
        {status: res.status, error: bodyJson.error},
      );
      ok(revisionCount(pid) === 0 && stagingEntries().length === 0, `[M7b] 重复 ${label} 无 DB 行、无 staging 残留`);
    }
  }

  // ---------- M8：合法 multipart → 201 + 真实 canonical ----------
  {
    const wav = makeWav(1500, 440);
    const res = await revisionsPOST(
      formReq(pid, (f) => {
        f.set('requestId', 'm8');
        f.set('audio', new File([new Uint8Array(wav)], 'voice.wav'));
        f.set('transcript', '你好世界');
        f.set('language', 'zh-CN');
      }),
      profileParams(pid),
    );
    const bodyJson = (await res.json()) as {outcome: string; revision: {id: string}};
    const canonicalAbs = path.join(
      getDataDir(),
      (getDb().prepare('SELECT canonical_audio_path AS p FROM voice_profile_revisions WHERE id = ?')
        .get(bodyJson.revision.id) as {p: string}).p,
    );
    const probe = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', canonicalAbs])
      .toString();
    const streams = (JSON.parse(probe) as {streams: Array<{codec_name: string; sample_rate: string; channels: number}>})
      .streams;
    ok(
      res.status === 201 && bodyJson.outcome === 'created',
      '[M8] 合法 multipart（含 transcript/language）→ 201 created',
    );
    ok(
      fs.existsSync(canonicalAbs) &&
        streams.some((s) => s.codec_name === 'pcm_s16le' && s.sample_rate === '48000' && s.channels === 1),
      '[M8b] canonical 真实存在且为 pcm_s16le/48000/mono（ffprobe 实测）',
    );
    // 实现证据：route 与 parser 不持有完整 file Buffer（无 formData/arrayBuffer 上传主路径）
    const routeSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/api/voice-profiles/[profileId]/revisions/route.ts'),
      'utf8',
    );
    const multipartSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/voice-library/multipart.ts'),
      'utf8',
    );
    ok(
      !routeSrc.includes('req.formData(') && !routeSrc.includes('.arrayBuffer(') &&
        routeSrc.includes('parseVoiceUploadMultipart'),
      '[M8c] route 不再调用 req.formData()/arrayBuffer()（streaming parser 主路径）',
    );
    ok(
      multipartSrc.includes('@fastify/busboy') && !multipartSrc.includes('.arrayBuffer(') &&
        multipartSrc.includes('fs.writeSync'),
      '[M8d] parser 使用 @fastify/busboy 流式写入 staging（无完整 file Buffer）',
    );
    // 文本字段超限（> MAX_MULTIPART_FIELD_BYTES）→ 422
    const oversizedField = await revisionsPOST(
      formReq(pid, (f) => {
        f.set('requestId', 'm8-field');
        f.set('audio', new File([new Uint8Array(makeWav(1200, 440))], 'a.wav'));
        f.set('transcript', 'x'.repeat(MAX_MULTIPART_FIELD_BYTES + 1));
      }),
      profileParams(pid),
    );
    const oversizedJson = (await oversizedField.json()) as {error: string};
    ok(
      oversizedField.status === 422 && oversizedJson.error === 'invalid_request',
      '[M8e] 超限文本字段 → 422 invalid_request',
      {status: oversizedField.status, error: oversizedJson.error},
    );
    ok(revisionCount(pid) === 1, '[M8f] M8 之后恰好 1 行 revision（非法请求均未落库）', revisionCount(pid));
  }

  // ---------- M9：parser 错误 / 客户端断连 → 无 DB 行、staging 安全清理 ----------
  {
    // M9a：body 流中途 error（模拟客户端断连）
    let steps = 0;
    const aborted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (steps++ === 0) {
          controller.enqueue(Buffer.from('--x\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n\r\n'));
        } else {
          controller.error(new Error('client aborted'));
        }
      },
    });
    const resA = await revisionsPOST(
      streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
        'content-type': 'multipart/form-data; boundary=x',
      }, aborted),
      profileParams(pid),
    );
    ok(
      resA.status === 400,
      '[M9a] 客户端断连（body 流 error）→ 400 invalid_formdata',
      {status: resA.status},
    );
    ok(
      revisionCount(pid) === 1 && stagingEntries().length === 0,
      '[M9b] 断连后无 DB 行新增、staging 安全清理',
      {rows: revisionCount(pid), staging: stagingEntries()},
    );

    // M9b：畸形 multipart（body 无 boundary）→ 非 2xx
    const garbage = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from('this is not a valid multipart body at all'));
        controller.close();
      },
    });
    const resB = await revisionsPOST(
      streamRequest(`${BASE}/api/voice-profiles/${pid}/revisions`, {
        'content-type': 'multipart/form-data; boundary=zzz',
      }, garbage),
      profileParams(pid),
    );
    ok(
      resB.status === 400 || resB.status === 422,
      '[M9c] 畸形 multipart → 400/422（非 2xx）',
      {status: resB.status},
    );
    ok(
      revisionCount(pid) === 1 && stagingEntries().length === 0,
      '[M9d] 畸形 body 无 DB 行新增、staging 安全清理',
      {rows: revisionCount(pid), staging: stagingEntries()},
    );
  }

  closeDb();
  fs.rmSync(path.resolve(process.cwd(), DATA_DIR), {recursive: true, force: true});

  console.log(`\n[test] 汇总: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.error('[test] TTS-A multipart 测试存在失败项 ❌');
    process.exit(1);
  }
  console.log('[test] TTS-A multipart streaming（bounded + strict fields）测试全部通过 ✅');
}

main().catch((err) => {
  console.error('[test] 未捕获异常：', err);
  process.exit(1);
});

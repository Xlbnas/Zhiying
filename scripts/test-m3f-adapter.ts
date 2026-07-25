/**
 * M3-F Adapter contract tests（mock upstream 8002，零 GPU/零 Feiniu 依赖）。
 *
 * 用法：npx tsx scripts/test-m3f-adapter.ts
 * 启动：Node mock upstream（127.0.0.1:18002）+ adapter uvicorn 子进程（127.0.0.1:9880）。
 * 任一断言失败即非零退出。
 */

import {spawn, type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ADAPTER_DIR = path.resolve('services', 'indextts2-api-adapter');
const VENV_PY = path.join(ADAPTER_DIR, '.venv', 'bin', 'python');
const UPSTREAM_PORT = 18012;
const ADAPTER_PORT = 9880;
const ADAPTER = `http://127.0.0.1:${ADAPTER_PORT}`;
const TMP_DIR = path.join('data', 'test-m3f-adapter');

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成合法小 WAV（44 字节头 + 静音）。 */
function buildWav(samples = 480): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = samples * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize, 0)]);
}

const MOCK_WAV = buildWav();

/** mock upstream 8002 状态机（各测试用例可编程行为）。 */
interface MockState {
  speakers: Array<{speaker_id: string; speaker_name: string}>;
  uploadCount: number;
  uploadSucceeds: boolean;
  ttsMode: 'wav' | 'http500' | 'html' | 'slow' | 'unavailable';
  speakersEndpointFails: boolean;
  nextSpeakerId: number;
  ttsRequestBodies: string[];
}

const state: MockState = {
  speakers: [],
  uploadCount: 0,
  uploadSucceeds: true,
  ttsMode: 'wav',
  speakersEndpointFails: false,
  nextSpeakerId: 1,
  ttsRequestBodies: [],
};

function resetState(): void {
  state.speakers = [];
  state.uploadCount = 0;
  state.uploadSucceeds = true;
  state.ttsMode = 'wav';
  state.speakersEndpointFails = false;
  state.nextSpeakerId = 1;
  state.ttsRequestBodies = [];
}

function startMockUpstream(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/speakers') {
      if (state.speakersEndpointFails) {
        res.writeHead(500).end('boom');
        return;
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({count: state.speakers.length, speakers: state.speakers}));
      return;
    }
    if (req.method === 'POST' && url === '/upload_speaker') {
      state.uploadCount++;
      let body = Buffer.alloc(0);
      req.on('data', (c: Buffer) => { body = Buffer.concat([body, c]); });
      req.on('end', () => {
        if (!state.uploadSucceeds) {
          res.writeHead(500, {'content-type': 'application/json'});
          res.end(JSON.stringify({error: 'upload failed'}));
          return;
        }
        const id = `spk_mock${state.nextSpeakerId++}`;
        state.speakers.push({speaker_id: id, speaker_name: 'zhiying-m3f-test'});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({speaker_id: id, status: 'new'}));
      });
      return;
    }
    if (req.method === 'POST' && url === '/tts_cached') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        state.ttsRequestBodies.push(body);
        if (state.ttsMode === 'http500') {
          res.writeHead(500, {'content-type': 'application/json'});
          res.end(JSON.stringify({error: 'tts failed'}));
          return;
        }
        if (state.ttsMode === 'html') {
          res.writeHead(200, {'content-type': 'text/html'});
          res.end('<html>not a wav</html>');
          return;
        }
        if (state.ttsMode === 'slow') {
          setTimeout(() => {
            res.writeHead(200, {'content-type': 'audio/wav'});
            res.end(MOCK_WAV);
          }, 3000);
          return;
        }
        res.writeHead(200, {'content-type': 'audio/wav'});
        res.end(MOCK_WAV);
      });
      return;
    }
    res.writeHead(404).end('nf');
  });
  return new Promise((resolve) => {
    server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitAdapter(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${ADAPTER}/health`);
      if (res.status === 200) return true;
    } catch {
      // not ready
    }
    await sleep(500);
  }
  return false;
}

async function main(): Promise<void> {
  fs.rmSync(TMP_DIR, {recursive: true, force: true});
  fs.mkdirSync(TMP_DIR, {recursive: true});
  const refWav = path.resolve(TMP_DIR, 'ref.wav');
  fs.writeFileSync(refWav, MOCK_WAV);

  const upstream = await startMockUpstream();

  let adapter: ChildProcess | null = null;
  const adapterLog: string[] = [];
  const startAdapter = async (): Promise<void> => {
    adapter = spawn(
      VENV_PY,
      ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(ADAPTER_PORT)],
      {
        cwd: ADAPTER_DIR,
        env: {
          ...process.env,
          ADAPTER_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
          ADAPTER_UPSTREAM_TIMEOUT_SEC: '1', // 测试 timeout 用短超时
          ADAPTER_REFERENCE_VOICE_PATH: refWav,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    adapter.stdout!.on('data', (d) => adapterLog.push(String(d)));
    adapter.stderr!.on('data', (d) => adapterLog.push(String(d)));
    if (!(await waitAdapter())) throw new Error('adapter 启动超时');
  };
  const stopAdapter = async (): Promise<void> => {
    adapter?.kill('SIGTERM');
    adapter = null;
    await sleep(700);
  };
  /** 重启 adapter 以获得冷 speaker cache（adapter 内存 cache 属合法行为）。 */
  const restartAdapter = async (): Promise<void> => {
    await stopAdapter();
    await startAdapter();
  };

  const post = (body: unknown): Promise<Response> =>
    fetch(`${ADAPTER}/v1/synthesize`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
  const validBody = {
    text: '测试文本。',
    voiceProfile: 'default',
    voiceRevision: '1',
    useRandom: false,
    emotion: 'none',
  };

  try {
    await startAdapter();
    ok(true, 'S00 adapter 启动');

    // health：upstream 可用 → ready=true；无 repoCommit 伪造
    resetState();
    {
      const res = await fetch(`${ADAPTER}/health`);
      const json = (await res.json()) as {ready?: boolean; provider?: string; model?: string; repoCommit?: string};
      ok(res.status === 200 && json.ready === true && json.provider === 'indextts2', 'S01 health ready（upstream 可达）');
      ok(json.model === 'IndexTTS-2' && json.repoCommit === undefined, 'S02 health model 正确且 repoCommit 省略（不伪造）');
    }
    // health：upstream 挂 → ready=false 但自身 200
    {
      state.speakersEndpointFails = true;
      const res = await fetch(`${ADAPTER}/health`);
      const json = (await res.json()) as {ready?: boolean};
      ok(res.status === 200 && json.ready === false, 'S03 upstream 故障 → ready=false（自身仍 200）');
      state.speakersEndpointFails = false;
    }

    // speaker missing → upload 注册 → cache；第二次同 voice 不再 upload
    resetState();
    {
      const r1 = await post(validBody);
      const wav = Buffer.from(await r1.arrayBuffer());
      ok(r1.status === 200 && wav.length > 44 && wav.subarray(0, 4).toString() === 'RIFF', 'S04 speaker 缺失 → upload 后合成 WAV');
      ok(state.uploadCount === 1, 'S05 upload 恰好一次');
      const r2 = await post(validBody);
      ok(r2.status === 200 && state.uploadCount === 1, 'S06 同 voice 第二次 → 内存 cache，不重复 upload');
      // tts_cached 请求体只含 text+speaker_id（不传 emo 参数）
      const last = JSON.parse(state.ttsRequestBodies.at(-1)!) as Record<string, unknown>;
      ok(
        'text' in last && 'speaker_id' in last && !('emo_vector' in last) && !('emo_alpha' in last),
        'S07 upstream 请求不含 emo 参数',
        last,
      );
    }

    // 冷 cache + speaker 已在 upstream 注册 → 经 /speakers reuse，不 upload
    await restartAdapter();
    resetState();
    state.speakers.push({speaker_id: 'spk_existing', speaker_name: 'zhiying-m3f-test'});
    {
      const r = await post(validBody);
      const last = JSON.parse(state.ttsRequestBodies.at(-1)!) as {speaker_id?: string};
      ok(r.status === 200 && state.uploadCount === 0 && last.speaker_id === 'spk_existing', 'S08 speaker 已存在 → reuse，不 upload');
    }

    // 输入验证
    resetState();
    {
      const r = await post({...validBody, text: '   '});
      ok(r.status === 422, 'S09 空 text → 422');
    }
    {
      const r = await post({...validBody, voiceProfile: 'unknown'});
      ok(r.status === 404, 'S10 unknown voiceProfile → 404');
    }
    {
      const r = await post({...validBody, voiceRevision: 'wrong-rev'});
      ok(r.status === 404, 'S11 unknown voiceRevision → 404');
    }
    {
      const r = await post({...validBody, useRandom: true});
      const json = (await r.json()) as {error?: string};
      ok(r.status === 422 && json.error === 'UNSUPPORTED_USE_RANDOM', 'S12 useRandom=true → 422');
    }
    {
      const r = await post({...validBody, emotion: 'happy'});
      const json = (await r.json()) as {error?: string};
      ok(r.status === 422 && json.error === 'UNSUPPORTED_EMOTION', 'S13 emotion!=none → 422');
    }

    // upstream 错误映射（S14 需冷 cache：重启让 upload 真正发生）
    await restartAdapter();
    resetState();
    {
      state.uploadSucceeds = false;
      const r = await post(validBody);
      ok(r.status === 502, 'S14 upload 失败 → 502');
      state.uploadSucceeds = true;
    }
    {
      const r = await post(validBody); // 重新注册成功
      ok(r.status === 200, 'S15 upload 恢复后成功');
      state.ttsMode = 'http500';
      const r2 = await post(validBody);
      ok(r2.status === 502, 'S16 upstream tts 500 → 502');
      state.ttsMode = 'html';
      const r3 = await post(validBody);
      ok(r3.status === 502, 'S17 upstream 返回 HTML → 502（不当 WAV）');
      state.ttsMode = 'slow';
      const r4 = await post(validBody);
      const json = (await r4.json()) as {error?: string};
      ok(r4.status === 504 && json.error === 'UPSTREAM_TIMEOUT', 'S18 upstream 超时 → 504');
      state.ttsMode = 'wav';
    }

    // single-flight：冷 cache 并发同 voice → upload 仅一次
    await restartAdapter();
    resetState();
    {
      const results = await Promise.all([post(validBody), post(validBody), post(validBody), post(validBody)]);
      const okCount = results.filter((r) => r.status === 200).length;
      ok(okCount === 4 && state.uploadCount === 1, 'S19 冷 cache 并发 4 请求 → upload 恰好 1（single-flight）', state.uploadCount);
    }
  } finally {
    await stopAdapter();
    upstream.close();
    await sleep(300);
    fs.rmSync(TMP_DIR, {recursive: true, force: true});
  }

  console.log(`\nM3-F adapter: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) {
    console.log(adapterLog.join('').slice(-800));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('M3-F adapter 测试异常终止:', err);
  process.exitCode = 1;
});

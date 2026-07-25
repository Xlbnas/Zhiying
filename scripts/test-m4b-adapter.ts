/**
 * M4-B Adapter production registry 测试（mock upstream，零 GPU/零 Feiniu 依赖）。
 *
 * 用法：npx tsx scripts/test-m4b-adapter.ts
 * 覆盖：registry 加载/验证、voice root containment、SHA-256 fail-closed、
 * upstream MD5 identity（reuse/upload/conflict）。
 *
 * 可选真实 gate：RUN_REAL_INDEXTTS2_M4B=1
 *   前置（fail-closed）：reference 文件存在（ADAPTER_REAL_REFERENCE，
 *   默认 /tmp/m3f-test-reference.wav）+ 真实 upstream 可达
 *   （ADAPTER_REAL_UPSTREAM，默认 http://127.0.0.1:18002 SSH tunnel）。
 *   验证：production registry + SHA-256 + 真实 upstream MD5 reuse（同名不同亦按内容）。
 *   不能替代 M4-C Feiniu production topology E2E。
 */

import {spawn, type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ADAPTER_DIR = path.resolve('services', 'indextts2-api-adapter');
const VENV_PY = path.join(ADAPTER_DIR, '.venv', 'bin', 'python');
const UPSTREAM_PORT = 18013;
const ADAPTER_PORT = 9880;
const ADAPTER = `http://127.0.0.1:${ADAPTER_PORT}`;
const TMP_DIR = path.resolve('data', 'test-m4b-adapter');

const REAL_GATE = process.env.RUN_REAL_INDEXTTS2_M4B === '1';
const REAL_UPSTREAM = (process.env.ADAPTER_REAL_UPSTREAM ?? 'http://127.0.0.1:18002').replace(/\/+$/, '');
const REAL_REFERENCE = process.env.ADAPTER_REAL_REFERENCE ?? '/tmp/m3f-test-reference.wav';

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

function realGateFail(reason: string): never {
  console.error(`[m4b-real] FAIL: RUN_REAL_INDEXTTS2_M4B=1 但前置不满足（${reason}）`);
  process.exit(1);
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
const MOCK_SHA256 = crypto.createHash('sha256').update(MOCK_WAV).digest('hex');
const MOCK_MD5 = crypto.createHash('md5').update(MOCK_WAV).digest('hex');
const OTHER_MD5 = 'f'.repeat(32);

interface MockState {
  speakers: Array<{speaker_id: string; speaker_name: string; md5: string}>;
  uploadCount: number;
  uploadResponseMd5: string;
  ttsSpeakerIds: string[];
}

const state: MockState = {speakers: [], uploadCount: 0, uploadResponseMd5: MOCK_MD5, ttsSpeakerIds: []};

function resetState(): void {
  state.speakers = [];
  state.uploadCount = 0;
  state.uploadResponseMd5 = MOCK_MD5;
  state.ttsSpeakerIds = [];
}

function startMockUpstream(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === '/speakers') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({count: state.speakers.length, speakers: state.speakers}));
      return;
    }
    if (req.method === 'POST' && url === '/upload_speaker') {
      state.uploadCount++;
      let body = Buffer.alloc(0);
      req.on('data', (c: Buffer) => { body = Buffer.concat([body, c]); });
      req.on('end', () => {
        const id = `spk_up${state.uploadCount}`;
        state.speakers.push({speaker_id: id, speaker_name: 'uploaded', md5: state.uploadResponseMd5});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({speaker_id: id, md5: state.uploadResponseMd5, status: 'new'}));
      });
      return;
    }
    if (req.method === 'POST' && url === '/tts_cached') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try {
          state.ttsSpeakerIds.push(String((JSON.parse(body) as {speaker_id?: string}).speaker_id));
        } catch {
          // ignore
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

interface AdapterEnv {
  registryPath?: string; // undefined = 不设置 ADAPTER_VOICE_REGISTRY_PATH
  voiceRoot?: string;
  upstreamUrl?: string;
  upstreamTimeoutSec?: string;
}

let adapter: ChildProcess | null = null;
const adapterLog: string[] = [];

async function startAdapter(env: AdapterEnv): Promise<void> {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    ADAPTER_UPSTREAM_BASE_URL: env.upstreamUrl ?? `http://127.0.0.1:${UPSTREAM_PORT}`,
    ADAPTER_UPSTREAM_TIMEOUT_SEC: env.upstreamTimeoutSec ?? '3',
    ADAPTER_VOICE_ROOT: env.voiceRoot ?? TMP_DIR,
  };
  delete e.ADAPTER_VOICE_REGISTRY_PATH;
  if (env.registryPath !== undefined) e.ADAPTER_VOICE_REGISTRY_PATH = env.registryPath;
  const proc = spawn(VENV_PY, ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(ADAPTER_PORT)], {
    cwd: ADAPTER_DIR,
    env: e,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  adapter = proc;
  proc.stdout!.on('data', (d) => adapterLog.push(String(d)));
  proc.stderr!.on('data', (d) => adapterLog.push(String(d)));
  if (!(await waitAdapter())) throw new Error('adapter 启动超时\n' + adapterLog.join('').slice(-800));
}

async function stopAdapter(): Promise<void> {
  adapter?.kill('SIGTERM');
  adapter = null;
  await sleep(700);
}

function writeRegistry(name: string, content: unknown): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function validRegistry(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: '1.0',
    voices: [{
      voiceProfile: 'default',
      voiceRevision: '1',
      speakerName: 'zhiying-m4b-test',
      referenceAssetPath: path.join(TMP_DIR, 'ref.wav'),
      referenceSha256: MOCK_SHA256,
      ...overrides,
    }],
  };
}

async function healthJson(): Promise<{ready?: boolean; detail?: string}> {
  const res = await fetch(`${ADAPTER}/health`);
  return (await res.json()) as {ready?: boolean; detail?: string};
}

const VALID_BODY = {
  text: '测试文本。',
  voiceProfile: 'default',
  voiceRevision: '1',
  useRandom: false,
  emotion: 'none',
};

const post = (body: unknown): Promise<Response> =>
  fetch(`${ADAPTER}/v1/synthesize`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });

async function main(): Promise<void> {
  fs.rmSync(TMP_DIR, {recursive: true, force: true});
  fs.mkdirSync(TMP_DIR, {recursive: true});
  fs.writeFileSync(path.join(TMP_DIR, 'ref.wav'), MOCK_WAV);

  const upstream = await startMockUpstream();

  try {
    // ---- T01 合法 registry → ready=true 且无 detail ----
    resetState();
    await startAdapter({registryPath: writeRegistry('reg.json', validRegistry())});
    {
      const h = await healthJson();
      ok(h.ready === true && !('detail' in h), 'T01 合法 registry → ready=true 且无 detail', h);
    }

    // ---- T02 registry 文件不存在 → UNREADABLE ----
    await stopAdapter();
    await startAdapter({registryPath: path.join(TMP_DIR, 'nonexistent.json')});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_UNREADABLE', 'T02 registry 缺失 → ready=false/UNREADABLE', h);
    }

    // ---- T03 registry 未配置 → NOT_CONFIGURED；synthesize → 503 VOICE_REGISTRY_INVALID ----
    await stopAdapter();
    await startAdapter({});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_NOT_CONFIGURED', 'T03 registry 未配置 → ready=false/NOT_CONFIGURED', h);
      const r = await post(VALID_BODY);
      const j = (await r.json()) as {error?: string};
      ok(r.status === 503 && j.error === 'VOICE_REGISTRY_INVALID', 'T03 未配置时 synthesize → 503 VOICE_REGISTRY_INVALID', j);
    }

    // ---- T04 非法 JSON ----
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('bad.json', '{not json')});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T04 非法 JSON → ready=false/INVALID', h);
    }

    // ---- T05 不支持的 schemaVersion ----
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('schema.json', {schemaVersion: '2.0', voices: []})});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_UNSUPPORTED_SCHEMA', 'T05 未知 schema → UNSUPPORTED_SCHEMA', h);
    }

    // ---- T06 voices 空数组 ----
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('empty.json', {schemaVersion: '1.0', voices: []})});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T06 voices 空 → INVALID', h);
    }

    // ---- T07 profile@revision 重复 ----
    await stopAdapter();
    {
      const v = validRegistry() as {voices: unknown[]};
      v.voices = [v.voices[0], v.voices[0]];
      await startAdapter({registryPath: writeRegistry('dup.json', v)});
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T07 profile@revision 重复 → INVALID', h);
    }

    // ---- T08 非法 SHA-256 格式 ----
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('badsha.json', validRegistry({referenceSha256: 'abc'}))});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T08 非法 SHA 格式 → INVALID', h);
    }

    // ---- T09 reference 文件缺失 → ready=false + synthesize 503 REFERENCE_VOICE_MISSING ----
    await stopAdapter();
    await startAdapter({
      registryPath: writeRegistry('missing.json', validRegistry({referenceAssetPath: path.join(TMP_DIR, 'missing.wav')})),
    });
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'REFERENCE_VOICE_MISSING', 'T09 reference 缺失 → ready=false/REFERENCE_VOICE_MISSING', h);
      const r = await post(VALID_BODY);
      const j = (await r.json()) as {error?: string};
      ok(r.status === 503 && j.error === 'REFERENCE_VOICE_MISSING', 'T09 synthesize → 503 REFERENCE_VOICE_MISSING', j);
    }

    // ---- T10 SHA-256 不匹配 → fail closed ----
    await stopAdapter();
    await startAdapter({
      registryPath: writeRegistry('shabad.json', validRegistry({referenceSha256: '0'.repeat(64)})),
    });
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'REFERENCE_SHA256_MISMATCH', 'T10 SHA 不匹配 → ready=false/SHA256_MISMATCH', h);
      const r = await post(VALID_BODY);
      const j = (await r.json()) as {error?: string};
      ok(r.status === 503 && j.error === 'REFERENCE_SHA256_MISMATCH', 'T10 synthesize → 503 REFERENCE_SHA256_MISMATCH', j);
    }

    // ---- T11 相对 referenceAssetPath → 拒绝 ----
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('rel.json', validRegistry({referenceAssetPath: 'ref.wav'}))});
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T11 相对路径 → INVALID', h);
    }

    // ---- T12 ../ 路径逃逸 → 拒绝 ----
    fs.mkdirSync(path.join(TMP_DIR, 'voices'), {recursive: true});
    fs.writeFileSync(path.join(TMP_DIR, 'secret.wav'), MOCK_WAV);
    await stopAdapter();
    await startAdapter({
      registryPath: writeRegistry('escape.json', validRegistry({
        referenceAssetPath: path.join(TMP_DIR, 'voices', '..', 'secret.wav'),
        referenceSha256: MOCK_SHA256,
      })),
      voiceRoot: path.join(TMP_DIR, 'voices'),
    });
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T12 ../ 逃逸 → INVALID', h);
    }

    // ---- T13 symlink 逃逸 → 拒绝 ----
    fs.symlinkSync(path.join(TMP_DIR, 'secret.wav'), path.join(TMP_DIR, 'voices', 'link.wav'));
    await stopAdapter();
    await startAdapter({
      registryPath: writeRegistry('symlink.json', validRegistry({
        referenceAssetPath: path.join(TMP_DIR, 'voices', 'link.wav'),
        referenceSha256: MOCK_SHA256,
      })),
      voiceRoot: path.join(TMP_DIR, 'voices'),
    });
    {
      const h = await healthJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID', 'T13 symlink 逃逸 → INVALID', h);
    }

    // ---- T14 Case A：同 MD5 不同 speaker_name → 按内容 reuse，不 upload ----
    resetState();
    state.speakers.push({speaker_id: 'spk_other', speaker_name: 'someone-else', md5: MOCK_MD5});
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('reg.json', validRegistry())});
    {
      const r = await post(VALID_BODY);
      ok(r.status === 200 && state.uploadCount === 0, 'T14 同内容不同名 → MD5 reuse，不 upload', {status: r.status, uploadCount: state.uploadCount});
    }

    // ---- T15 Case B：同名不同 MD5 → 不按名字 reuse → upload ----
    resetState();
    state.speakers.push({speaker_id: 'spk_name', speaker_name: 'zhiying-m4b-test', md5: OTHER_MD5});
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('reg.json', validRegistry())});
    {
      const r = await post(VALID_BODY);
      ok(r.status === 200 && state.uploadCount === 1, 'T15 同名不同 MD5 → 不 name-reuse，upload 注册', {status: r.status, uploadCount: state.uploadCount});
    }

    // ---- T16 upload 响应 MD5 不匹配 → 502 UPSTREAM_CACHE_CONFLICT ----
    resetState();
    state.uploadResponseMd5 = OTHER_MD5;
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('reg.json', validRegistry())});
    {
      const r = await post(VALID_BODY);
      const j = (await r.json()) as {error?: string};
      ok(r.status === 502 && j.error === 'UPSTREAM_CACHE_CONFLICT', 'T16 upload MD5 不匹配 → 502 UPSTREAM_CACHE_CONFLICT', j);
    }

    // ---- T17 stale speaker_id：adapter 不重启，upstream cache 变更后禁止发旧 ID ----
    resetState();
    await stopAdapter();
    await startAdapter({registryPath: writeRegistry('reg.json', validRegistry())});
    {
      const r1 = await post(VALID_BODY);
      ok(
        r1.status === 200 && state.uploadCount === 1 && state.ttsSpeakerIds.at(-1) === 'spk_up1',
        'T17a 首次 synthesize → upload → speaker_id A（spk_up1）',
        {uploadCount: state.uploadCount, used: state.ttsSpeakerIds.at(-1)},
      );
      // upstream cache 重建：同内容 MD5 映射为新 speaker_id B
      state.speakers = [{speaker_id: 'spk_B', speaker_name: 'rebuilt-cache', md5: MOCK_MD5}];
      const r2 = await post(VALID_BODY);
      ok(
        r2.status === 200 && state.ttsSpeakerIds.at(-1) === 'spk_B' && state.uploadCount === 1,
        'T17b cache 重建后 → 重新解析用 B，禁止发送 stale A',
        {used: state.ttsSpeakerIds.at(-1), uploadCount: state.uploadCount},
      );
      // upstream cache 清空 → 必须重新 upload
      state.speakers = [];
      const r3 = await post(VALID_BODY);
      ok(
        r3.status === 200 && state.uploadCount === 2 && state.ttsSpeakerIds.at(-1) === 'spk_up2',
        'T17c cache 清空 → 重新 upload（spk_up2），禁止发送 stale ID',
        {uploadCount: state.uploadCount, used: state.ttsSpeakerIds.at(-1)},
      );
    }

    // ---- 可选真实 gate：真实 IndexTTS2 upstream MD5 identity ----
    if (REAL_GATE) {
      console.log('\n[m4b-real] 进入真实 IndexTTS2 gate');
      if (!fs.existsSync(REAL_REFERENCE)) realGateFail(`reference 不存在: ${REAL_REFERENCE}`);
      const refBytes = fs.readFileSync(REAL_REFERENCE);
      const refSha = crypto.createHash('sha256').update(refBytes).digest('hex');
      {
        let res: globalThis.Response;
        try {
          res = await fetch(`${REAL_UPSTREAM}/speakers`, {signal: AbortSignal.timeout(10_000)});
        } catch (err) {
          realGateFail(`upstream 不可达: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!res.ok) realGateFail(`/speakers HTTP ${res.status}`);
      }
      const realReg = writeRegistry('real-reg.json', {
        schemaVersion: '1.0',
        voices: [{
          voiceProfile: 'default',
          voiceRevision: '1',
          speakerName: `zhiying-default-1-${refSha.slice(0, 12)}`,
          referenceAssetPath: REAL_REFERENCE,
          referenceSha256: refSha,
        }],
      });
      await stopAdapter();
      await startAdapter({registryPath: realReg, voiceRoot: path.dirname(REAL_REFERENCE), upstreamUrl: REAL_UPSTREAM, upstreamTimeoutSec: '120'});
      const h = await healthJson();
      ok(h.ready === true, '[real] production registry + SHA-256 + upstream → ready=true', h);
      const before = (await (await fetch(`${REAL_UPSTREAM}/speakers`)).json()) as {count: number};
      const r = await post(VALID_BODY);
      const wav = Buffer.from(await r.arrayBuffer());
      ok(r.status === 200 && wav.length > 44 && wav.subarray(0, 4).toString() === 'RIFF', '[real] synthesize → 真实 WAV（RIFF）', {status: r.status, bytes: wav.length});
      const after = (await (await fetch(`${REAL_UPSTREAM}/speakers`)).json()) as {count: number; speakers: Array<{speaker_name: string; md5: string}>};
      ok(
        after.count === before.count,
        '[real] 既有同内容 speaker（不同名）→ MD5 reuse，零新增 upload',
        {before: before.count, after: after.count, names: after.speakers.map((s) => s.speaker_name)},
      );
    }

    await stopAdapter();
  } finally {
    await stopAdapter();
    upstream.close();
    await sleep(300);
    fs.rmSync(TMP_DIR, {recursive: true, force: true});
  }

  console.log(`\nM4-B adapter: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) {
    console.log(adapterLog.join('').slice(-800));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('M4-B adapter 测试异常终止:', err);
  process.exitCode = 1;
});

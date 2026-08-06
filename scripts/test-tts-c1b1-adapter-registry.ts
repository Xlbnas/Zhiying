/**
 * TTS-C.1B.1 Adapter registry reload contract 测试（mock upstream，零 GPU/零 Feiniu 依赖）。
 *
 * 用法：npx tsx scripts/test-tts-c1b1-adapter-registry.ts
 *
 * 覆盖（对应任务书六个最小场景 + TTS-C.1B.1.R1 reference 验证前置）：
 *   场景1 legacy 1.0 启动完全兼容（T01-T03）
 *   场景2 /registry-status 对 1.0 返回 generation=null（T02）
 *   场景3 reload 合法 1.1 → sha/generation/schema/speakerCount 更新 + 新 voice 可用（T04-T07）
 *   场景4 reload 非法 → 非 2xx + LKG 不变 + 旧 voice 可用（T08-T14）
 *   场景5 首次加载失败无 LKG → ready=false + synthesize 503（T17-T19）
 *   场景6 重复 reload 同一文件幂等无副作用（T15-T16、T20 冷启动失败后 reload 恢复）
 *   R1   reload 前 reference 文件完整验证（TTS-C.1B.1.R1）：
 *        R01 已有 LKG + reference 缺失 → reload 非 2xx + LKG 不变 + degraded + 旧 voice 200
 *        R02 已有 LKG + referenceSha256 不符 → reload 非 2xx + LKG 不变 + lastReloadError 精确
 *        R03 冷启动 reference 缺失 → ready=false + synthesize 503 REFERENCE_VOICE_MISSING
 *        R04 冷启动 reference SHA 错误 → ready=false + synthesize 503 REFERENCE_SHA256_MISMATCH
 *        R05 修复文件与 SHA 后 reload → 200 ready=true degraded=false
 */

import {spawn, type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ADAPTER_DIR = path.resolve('services', 'indextts2-api-adapter');
const VENV_PY = path.join(ADAPTER_DIR, '.venv', 'bin', 'python');
const UPSTREAM_PORT = 18014;
const ADAPTER_PORT = 9881;
const ADAPTER = `http://127.0.0.1:${ADAPTER_PORT}`;
const TMP_DIR = path.resolve('data', 'test-tts-c1b1-adapter-registry');
const REGISTRY_PATH = path.join(TMP_DIR, 'reg.json');
const PUBLISHER_VERSION = 'tts-c-registry-publisher@1';

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

const WAV_A = buildWav(480);
const WAV_B = buildWav(960);
const SHA_A = crypto.createHash('sha256').update(WAV_A).digest('hex');
const SHA_B = crypto.createHash('sha256').update(WAV_B).digest('hex');
const MD5_A = crypto.createHash('md5').update(WAV_A).digest('hex');
const MD5_B = crypto.createHash('md5').update(WAV_B).digest('hex');

function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface MockState {
  speakers: Array<{speaker_id: string; speaker_name: string; md5: string}>;
  uploadCount: number;
  uploadMd5s: string[];
}

const state: MockState = {speakers: [], uploadCount: 0, uploadMd5s: []};

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
        // multipart body 内含完整 WAV bytes——按已知 fixture 识别内容 MD5
        const found = [[WAV_A, MD5_A], [WAV_B, MD5_B]].find(([w]) => body.includes(w as Buffer));
        const md5 = found ? (found[1] as string) : '0'.repeat(32);
        state.uploadMd5s.push(md5);
        const id = `spk_up${state.uploadCount}`;
        state.speakers.push({speaker_id: id, speaker_name: 'uploaded', md5});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({speaker_id: id, md5, status: 'new'}));
      });
      return;
    }
    if (req.method === 'POST' && url === '/tts_cached') {
      res.writeHead(200, {'content-type': 'audio/wav'});
      res.end(WAV_A);
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

let adapter: ChildProcess | null = null;
const adapterLog: string[] = [];

async function startAdapter(registryPath?: string): Promise<void> {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    ADAPTER_UPSTREAM_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    ADAPTER_UPSTREAM_TIMEOUT_SEC: '3',
    ADAPTER_VOICE_ROOT: TMP_DIR,
  };
  delete e.ADAPTER_VOICE_REGISTRY_PATH;
  if (registryPath !== undefined) e.ADAPTER_VOICE_REGISTRY_PATH = registryPath;
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

function writeRegistry(content: unknown): void {
  fs.writeFileSync(REGISTRY_PATH, typeof content === 'string' ? content : JSON.stringify(content));
}

interface VoiceSpec {
  voiceProfile: string;
  voiceRevision: string;
  speakerName: string;
  referenceAssetPath: string;
  referenceSha256: string;
}

const VOICE_DEFAULT: VoiceSpec = {
  voiceProfile: 'default',
  voiceRevision: '1',
  speakerName: 'zhiying-c1b1-default',
  referenceAssetPath: path.join(TMP_DIR, 'ref-a.wav'),
  referenceSha256: SHA_A,
};

const VOICE_ALT: VoiceSpec = {
  voiceProfile: 'alt',
  voiceRevision: '1',
  speakerName: 'zhiying-c1b1-alt',
  referenceAssetPath: path.join(TMP_DIR, 'ref-b.wav'),
  referenceSha256: SHA_B,
};

const legacy10 = (): unknown => ({schemaVersion: '1.0', voices: [VOICE_DEFAULT]});
const publisher11 = (generation: number): unknown => ({
  schemaVersion: '1.1',
  registryGeneration: generation,
  publisherSchemaVersion: PUBLISHER_VERSION,
  voices: [VOICE_DEFAULT, VOICE_ALT],
});

interface RegistryStatus {
  ready?: boolean;
  degraded?: boolean;
  schemaVersion?: string | null;
  loadedRegistrySha256?: string | null;
  loadedRegistryGeneration?: number | null;
  publisherSchemaVersion?: string | null;
  speakerCount?: number;
  detail?: string | null;
  lastReloadError?: string | null;
}

async function statusJson(): Promise<RegistryStatus> {
  const res = await fetch(`${ADAPTER}/registry-status`);
  return (await res.json()) as RegistryStatus;
}

async function healthJson(): Promise<{ready?: boolean; detail?: string; degraded?: boolean}> {
  const res = await fetch(`${ADAPTER}/health`);
  return (await res.json()) as {ready?: boolean; detail?: string; degraded?: boolean};
}

async function reload(): Promise<{status: number; body: RegistryStatus & {error?: string}}> {
  const res = await fetch(`${ADAPTER}/reload`, {method: 'POST'});
  return {status: res.status, body: (await res.json()) as RegistryStatus & {error?: string}};
}

const post = (voiceProfile: string, voiceRevision: string): Promise<Response> =>
  fetch(`${ADAPTER}/v1/synthesize`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({text: '测试文本。', voiceProfile, voiceRevision, useRandom: false, emotion: 'none'}),
  });

async function main(): Promise<void> {
  fs.rmSync(TMP_DIR, {recursive: true, force: true});
  fs.mkdirSync(TMP_DIR, {recursive: true});
  fs.writeFileSync(path.join(TMP_DIR, 'ref-a.wav'), WAV_A);
  fs.writeFileSync(path.join(TMP_DIR, 'ref-b.wav'), WAV_B);

  const upstream = await startMockUpstream();

  try {
    // ============ 进程 A：legacy 1.0 启动 ============
    writeRegistry(legacy10());
    const shaLegacyFile = sha256File(REGISTRY_PATH);
    await startAdapter(REGISTRY_PATH);

    // ---- 场景1：legacy 1.0 启动成功，现有字段完全兼容 ----
    {
      const h = await healthJson();
      ok(h.ready === true && !('detail' in h) && h.degraded === false,
        'T01 场景1 legacy 1.0 → /health ready=true 无 detail degraded=false', h);
    }

    // ---- 场景2：/registry-status 对 1.0 返回 generation=null ----
    {
      const s = await statusJson();
      ok(
        s.ready === true && s.degraded === false &&
        s.schemaVersion === '1.0' &&
        s.loadedRegistrySha256 === shaLegacyFile &&
        s.loadedRegistryGeneration === null &&
        s.publisherSchemaVersion === null &&
        s.speakerCount === 1 &&
        s.lastReloadError === null,
        'T02 场景2 /registry-status：1.0 → sha 匹配 generation=null publisher=null speakerCount=1', s);
    }

    {
      const r = await post('default', '1');
      ok(r.status === 200 && state.uploadCount === 1 && state.uploadMd5s.at(-1) === MD5_A,
        'T03 场景1 legacy 1.0 voice synthesize → 200（upload 注册 md5A）',
        {status: r.status, uploadCount: state.uploadCount, md5: state.uploadMd5s.at(-1)});
    }

    // ---- 场景3：reload 合法 1.1 → identity 全更新 + 新 voice 可用 ----
    writeRegistry(publisher11(7));
    const sha11File = sha256File(REGISTRY_PATH);
    {
      const r = await reload();
      ok(
        r.status === 200 &&
        r.body.schemaVersion === '1.1' &&
        r.body.loadedRegistryGeneration === 7 &&
        r.body.publisherSchemaVersion === PUBLISHER_VERSION &&
        r.body.loadedRegistrySha256 === sha11File &&
        r.body.speakerCount === 2 &&
        r.body.degraded === false,
        'T04 场景3 reload 合法 1.1 → 200 + sha/generation/schema/speakerCount 更新', r.body);
      const s = await statusJson();
      ok(s.loadedRegistryGeneration === 7 && s.loadedRegistrySha256 === sha11File && s.speakerCount === 2,
        'T05 场景3 /registry-status 与 reload 一致（generation=7 sha=1.1 文件 count=2）', s);
    }

    {
      const before = state.uploadCount;
      const r = await post('alt', '1');
      ok(r.status === 200 && state.uploadCount === before + 1 && state.uploadMd5s.at(-1) === MD5_B,
        'T06 场景3 1.1 新 voice alt@1 synthesize → 200（upload 注册 md5B）',
        {status: r.status, uploadCount: state.uploadCount, md5: state.uploadMd5s.at(-1)});
      const r2 = await post('default', '1');
      ok(r2.status === 200 && state.uploadCount === before + 1,
        'T07 场景3 旧 voice default@1 在 1.1 下仍可用（md5 reuse 零新 upload）',
        {status: r2.status, uploadCount: state.uploadCount});
    }

    // ---- 场景4：reload 非法 registry → 非 2xx + LKG 不变 + 旧 voice 可用 ----
    writeRegistry('{not json');
    {
      const r = await reload();
      ok(r.status === 500 && r.body.error === 'VOICE_REGISTRY_RELOAD_FAILED',
        'T08 场景4 reload 非法 JSON → 非 2xx VOICE_REGISTRY_RELOAD_FAILED', r.body);
      const s = await statusJson();
      ok(
        s.loadedRegistrySha256 === sha11File &&
        s.loadedRegistryGeneration === 7 &&
        s.speakerCount === 2 &&
        s.degraded === true &&
        s.lastReloadError === 'VOICE_REGISTRY_INVALID',
        'T09 场景4 LKG 不变（sha/generation/count 保持）degraded=true lastReloadError=INVALID', s);
      const r2 = await post('default', '1');
      ok(r2.status === 200, 'T10 场景4 旧 voice 在 degraded LKG 下仍 synthesize 200', {status: r2.status});
      const h = await healthJson();
      ok(h.ready === true && h.degraded === true && h.detail === 'VOICE_REGISTRY_INVALID',
        'T11 场景4 /health ready=true degraded=true detail=最近 reload 失败码', h);
    }

    writeRegistry({schemaVersion: '1.1', publisherSchemaVersion: PUBLISHER_VERSION, voices: [VOICE_DEFAULT]});
    {
      const r = await reload();
      const s = await statusJson();
      ok(r.status === 500 && s.loadedRegistrySha256 === sha11File && s.lastReloadError === 'VOICE_REGISTRY_INVALID',
        'T12 场景4 1.1 缺 registryGeneration → 拒绝且 LKG 不变', {reload: r.status, lastReloadError: s.lastReloadError});
    }

    writeRegistry({schemaVersion: '1.1', registryGeneration: 8, publisherSchemaVersion: 'wrong@9', voices: [VOICE_DEFAULT]});
    {
      const r = await reload();
      const s = await statusJson();
      ok(r.status === 500 && s.loadedRegistrySha256 === sha11File && s.lastReloadError === 'VOICE_REGISTRY_INVALID',
        'T13 场景4 1.1 错误 publisherSchemaVersion → 拒绝且 LKG 不变', {reload: r.status, lastReloadError: s.lastReloadError});
    }

    writeRegistry({schemaVersion: '2.0', voices: [VOICE_DEFAULT]});
    {
      const r = await reload();
      const s = await statusJson();
      ok(r.status === 500 && s.lastReloadError === 'VOICE_REGISTRY_UNSUPPORTED_SCHEMA' && s.loadedRegistrySha256 === sha11File,
        'T14 场景4 未知 schemaVersion → 拒绝（UNSUPPORTED_SCHEMA）且 LKG 不变', {reload: r.status, lastReloadError: s.lastReloadError});
    }

    // ---- 场景6：恢复后重复 reload 同一文件幂等、零额外副作用 ----
    writeRegistry(publisher11(7));
    fs.writeFileSync(REGISTRY_PATH, fs.readFileSync(REGISTRY_PATH)); // 同 bytes（显式表达「同一文件」）
    const sha11FileAgain = sha256File(REGISTRY_PATH);
    {
      const uploadsBefore = state.uploadCount;
      const r = await reload();
      ok(r.status === 200 && r.body.degraded === false && r.body.lastReloadError === null &&
        r.body.loadedRegistrySha256 === sha11FileAgain,
        'T15 场景6 恢复合法 1.1 → 200 degraded=false lastReloadError=null', r.body);
      const r2 = await reload();
      const s = await statusJson();
      ok(
        r2.status === 200 &&
        s.loadedRegistrySha256 === sha11FileAgain &&
        s.loadedRegistryGeneration === 7 &&
        s.speakerCount === 2 &&
        state.uploadCount === uploadsBefore,
        'T16 场景6 重复 reload 同一文件 → 幂等（identity 不变、零 upstream 副作用）',
        {reload: r2.status, speakerCount: s.speakerCount, uploadCount: state.uploadCount});
    }

    // ---- R1：reload 前 reference 文件完整验证（TTS-C.1B.1.R1）----
    // R01：已有 LKG，registry 引用不存在文件 → reload 非 2xx + LKG 不变 + 旧 voice 200
    writeRegistry({
      schemaVersion: '1.1',
      registryGeneration: 9,
      publisherSchemaVersion: PUBLISHER_VERSION,
      voices: [{...VOICE_DEFAULT, referenceAssetPath: path.join(TMP_DIR, 'missing.wav')}],
    });
    {
      const r = await reload();
      ok(r.status === 500 && r.body.error === 'VOICE_REGISTRY_RELOAD_FAILED',
        'R01a LKG + reference 缺失 → reload 非 2xx VOICE_REGISTRY_RELOAD_FAILED', r.body);
      const s = await statusJson();
      ok(
        s.ready === true && s.degraded === true &&
        s.loadedRegistrySha256 === sha11FileAgain &&
        s.loadedRegistryGeneration === 7 &&
        s.speakerCount === 2 &&
        s.lastReloadError === 'REFERENCE_VOICE_MISSING',
        'R01b LKG 不变（sha/generation/count 全旧值）degraded=true lastReloadError=REFERENCE_VOICE_MISSING', s);
      const r2 = await post('default', '1');
      const r3 = await post('alt', '1');
      ok(r2.status === 200 && r3.status === 200, 'R01c 旧 voice 在 degraded LKG 下仍 synthesize 200',
        {default: r2.status, alt: r3.status});
    }

    // R02：已有 LKG，referenceSha256 与真实文件不符 → reload 非 2xx + LKG 不变 + 错误精确
    writeRegistry({
      schemaVersion: '1.1',
      registryGeneration: 10,
      publisherSchemaVersion: PUBLISHER_VERSION,
      voices: [{...VOICE_DEFAULT, referenceSha256: SHA_B}], // ref-a.wav 实际内容 SHA_A
    });
    {
      const r = await reload();
      ok(r.status === 500 && r.body.error === 'VOICE_REGISTRY_RELOAD_FAILED',
        'R02a LKG + referenceSha256 不符 → reload 非 2xx VOICE_REGISTRY_RELOAD_FAILED', r.body);
      const s = await statusJson();
      ok(
        s.ready === true && s.degraded === true &&
        s.loadedRegistrySha256 === sha11FileAgain &&
        s.loadedRegistryGeneration === 7 &&
        s.speakerCount === 2 &&
        s.lastReloadError === 'REFERENCE_SHA256_MISMATCH',
        'R02b LKG 不变 degraded=true lastReloadError=REFERENCE_SHA256_MISMATCH', s);
    }

    // R05：恢复正确文件与正确 SHA 后 reload → 200 ready=true degraded=false
    fs.writeFileSync(path.join(TMP_DIR, 'ref-c.wav'), WAV_B); // 修复 R01 的缺失文件
    writeRegistry({
      schemaVersion: '1.1',
      registryGeneration: 11,
      publisherSchemaVersion: PUBLISHER_VERSION,
      voices: [
        {
          ...VOICE_DEFAULT,
          referenceAssetPath: path.join(TMP_DIR, 'ref-c.wav'),
          referenceSha256: SHA_B,
        },
      ],
    });
    {
      const r = await reload();
      const s = await statusJson();
      ok(r.status === 200 && r.body.ready === true && r.body.degraded === false &&
        r.body.lastReloadError === null &&
        s.loadedRegistryGeneration === 11 && s.speakerCount === 1,
        'R05a 修复 reference 文件与 SHA 后 reload → 200 ready=true degraded=false', r.body);
      const r2 = await post('default', '1');
      ok(r2.status === 200, 'R05b 修复后新 voice default@1（ref-c）synthesize → 200', {status: r2.status});
    }

    await stopAdapter();

    // ============ 进程 B：首次加载失败、无 LKG ============
    writeRegistry('{still not json');
    await startAdapter(REGISTRY_PATH);

    // ---- 场景5：首次加载失败且无 LKG → ready=false + synthesize 503 ----
    {
      const h = await healthJson();
      const s = await statusJson();
      ok(h.ready === false && h.detail === 'VOICE_REGISTRY_INVALID' &&
        s.ready === false && s.schemaVersion === null && s.loadedRegistrySha256 === null &&
        s.loadedRegistryGeneration === null && s.speakerCount === 0 && s.degraded === false,
        'T17 场景5 启动加载失败 → ready=false，status 全空', {health: h, status: s});
      const r = await post('default', '1');
      const j = (await r.json()) as {error?: string};
      ok(r.status === 503 && j.error === 'VOICE_REGISTRY_INVALID',
        'T18 场景5 无 LKG synthesize → 503 VOICE_REGISTRY_INVALID', j);
      const rr = await reload();
      const s2 = await statusJson();
      ok(rr.status === 500 && s2.ready === false && s2.degraded === false &&
        s2.lastReloadError === 'VOICE_REGISTRY_INVALID',
        'T19 场景5 无 LKG reload 仍失败 → 非 2xx，维持 unready 非 degraded', {reload: rr.status, status: s2});
    }

    // ---- 场景5 补充：冷启动失败后修复文件，reload 无需重启即可恢复 ----
    writeRegistry(legacy10());
    const shaLegacyAgain = sha256File(REGISTRY_PATH);
    {
      const r = await reload();
      ok(r.status === 200 && r.body.ready === true && r.body.loadedRegistrySha256 === shaLegacyAgain,
        'T20a 场景5 修复后 reload → 200 ready=true（无重启恢复）', r.body);
      const r2 = await post('default', '1');
      ok(r2.status === 200, 'T20b 场景5 恢复后 synthesize → 200', {status: r2.status});
    }

    await stopAdapter();

    // ============ 进程 C：冷启动 reference 文件缺失 / SHA 错误（TTS-C.1B.1.R1）============
    // R03：冷启动 registry reference 文件缺失 → ready=false + synthesize 503
    writeRegistry({
      schemaVersion: '1.1',
      registryGeneration: 20,
      publisherSchemaVersion: PUBLISHER_VERSION,
      voices: [{...VOICE_DEFAULT, referenceAssetPath: path.join(TMP_DIR, 'missing.wav')}],
    });
    await startAdapter(REGISTRY_PATH);
    {
      const s = await statusJson();
      const h = await healthJson();
      ok(s.ready === false && s.detail === 'REFERENCE_VOICE_MISSING' && s.speakerCount === 0,
        'R03a 冷启动 reference 缺失 → registry-status ready=false detail=REFERENCE_VOICE_MISSING', s);
      ok(h.ready === false && h.detail === 'REFERENCE_VOICE_MISSING',
        'R03b 冷启动 reference 缺失 → /health ready=false', h);
      const r = await post('default', '1');
      const j = (await r.json()) as {error?: string};
      ok(r.status === 503 && j.error === 'REFERENCE_VOICE_MISSING',
        'R03c 冷启动 reference 缺失 → synthesize 503 REFERENCE_VOICE_MISSING', j);
    }
    await stopAdapter();

    // R04：冷启动 registry referenceSha256 与真实文件不符 → ready=false + synthesize 503
    writeRegistry({
      schemaVersion: '1.1',
      registryGeneration: 21,
      publisherSchemaVersion: PUBLISHER_VERSION,
      voices: [{...VOICE_DEFAULT, referenceSha256: SHA_B}], // ref-a.wav 实际内容 SHA_A
    });
    await startAdapter(REGISTRY_PATH);
    {
      const s = await statusJson();
      const h = await healthJson();
      ok(s.ready === false && s.detail === 'REFERENCE_SHA256_MISMATCH' && s.speakerCount === 0,
        'R04a 冷启动 reference SHA 错误 → registry-status ready=false detail=REFERENCE_SHA256_MISMATCH', s);
      ok(h.ready === false && h.detail === 'REFERENCE_SHA256_MISMATCH',
        'R04b 冷启动 reference SHA 错误 → /health ready=false', h);
      const r = await post('default', '1');
      const j = (await r.json()) as {error?: string};
      ok(r.status === 503 && j.error === 'REFERENCE_SHA256_MISMATCH',
        'R04c 冷启动 reference SHA 错误 → synthesize 503 REFERENCE_SHA256_MISMATCH', j);
    }
    await stopAdapter();
  } finally {
    await stopAdapter();
    upstream.close();
    await sleep(300);
    fs.rmSync(TMP_DIR, {recursive: true, force: true});
  }

  console.log(`\nTTS-C.1B.1 adapter registry: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) {
    console.log(adapterLog.join('').slice(-800));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('TTS-C.1B.1 adapter registry 测试异常终止:', err);
  process.exitCode = 1;
});

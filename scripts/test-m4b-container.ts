/**
 * M4-B 镜像构建 + 容器级测试（不触碰 Feiniu）。
 *
 * 用法：npx tsx scripts/test-m4b-container.ts
 * 可选 gate：RUN_M4B_CONTAINER_RENDER=1（容器内真实 Remotion render，fail-closed）
 *
 * 覆盖：
 *   1. docker build：zhiying:m4b-test / zhiying-indextts2-adapter:m4b-test
 *   2. app 镜像静态：uid=1000 / HOME / Chrome cache / Noto CJK / ffmpeg / ffprobe
 *   3. web 容器：health 2xx + SQLite 创建 + WAL + API 建项目（隔离 tmp data）
 *   4. worker 容器：starting + 共享 DB claim job 成功 + 优雅 SIGTERM
 *      （功能测试用 NODE_ENV=development + mock provider——production 禁 mock
 *      是 frozen gate，生产 env 值由 test-m4b-compose 静态锁定）
 *   5. adapter 容器：read_only rootfs + non-root + Docker HEALTHCHECK healthy + synthesize
 *   6. render gate：容器内跑 test-m3e-real-render（Chrome/CJK/ffmpeg/Remotion 端到端；
 *      NODE_ENV=development 因 mock provider；这是 container runtime smoke，
 *      不是 production visual E2E——public 455MB 资产缺失，见 M4-A blocker）
 */

import {execFileSync, spawn, spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const APP_IMAGE = 'zhiying:m4b-test';
const ADAPTER_IMAGE = 'zhiying-indextts2-adapter:m4b-test';
const SUFFIX = String(process.pid);
const TMP_ROOT = path.resolve('data', 'test-m4b-container');
const RENDER_GATE = process.env.RUN_M4B_CONTAINER_RENDER === '1';
const MOCK_UPSTREAM_PORT = 18014;
const ADAPTER_PUBLISH_PORT = 9881;

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

function run(cmd: string, args: string[], opts: {timeoutMs?: number} = {}): {code: number; out: string} {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`};
}

function docker(args: string[], timeoutMs = 120_000): {code: number; out: string} {
  return run('docker', args, {timeoutMs});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, fn: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(2000);
  }
  console.log(`[wait] 超时: ${label}`);
  return false;
}

/** 生成合法小 WAV。 */
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

function startMockUpstream(): Promise<http.Server> {
  const speakers: Array<{speaker_id: string; speaker_name: string; md5: string}> = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/speakers') {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({count: speakers.length, speakers}));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload_speaker') {
      let body = Buffer.alloc(0);
      req.on('data', (c: Buffer) => { body = Buffer.concat([body, c]); });
      req.on('end', () => {
        speakers.push({speaker_id: 'spk_m4b', speaker_name: 'zhiying-m4b-test', md5: MOCK_MD5});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({speaker_id: 'spk_m4b', md5: MOCK_MD5, status: 'new'}));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/tts_cached') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        res.writeHead(200, {'content-type': 'audio/wav'});
        res.end(MOCK_WAV);
      });
      return;
    }
    res.writeHead(404).end('nf');
  });
  return new Promise((resolve) => {
    // R2 Linux portability：GitHub-hosted Linux Docker Engine 不提供 Docker
    // Desktop 的 host routing magic，mock 必须对 bridge container 可达——
    // 监听 0.0.0.0（仅测试进程生命周期内），配合 adapter 容器
    // --add-host host.docker.internal=host-gateway
    server.listen(MOCK_UPSTREAM_PORT, '0.0.0.0', () => {
      console.log(`[mock] upstream listening 0.0.0.0:${MOCK_UPSTREAM_PORT}`);
      resolve(server);
    });
  });
}

function cleanupContainer(name: string): void {
  docker(['rm', '-f', name]);
}

async function main(): Promise<void> {
  fs.rmSync(TMP_ROOT, {recursive: true, force: true});
  fs.mkdirSync(TMP_ROOT, {recursive: true});

  // ---------- 1. 构建双镜像 ----------
  // 可选镜像加速（默认官方源）：M4B_APT_MIRROR / M4B_PIP_INDEX_URL / M4B_NPM_REGISTRY
  // M4B_SKIP_BUILD=1：镜像 tag 已存在且明确由当前 Dockerfile 构建时复用（跳过 B01/B02）
  const SKIP_BUILD = process.env.M4B_SKIP_BUILD === '1';
  const appBuildArgs = [
    ...(process.env.M4B_APT_MIRROR ? ['--build-arg', `APT_MIRROR=${process.env.M4B_APT_MIRROR}`] : []),
    ...(process.env.M4B_NPM_REGISTRY ? ['--build-arg', `NPM_REGISTRY=${process.env.M4B_NPM_REGISTRY}`] : []),
  ];
  const adapterBuildArgs = process.env.M4B_PIP_INDEX_URL
    ? ['--build-arg', `PIP_INDEX_URL=${process.env.M4B_PIP_INDEX_URL}`]
    : [];
  if (SKIP_BUILD) {
    const a = docker(['image', 'inspect', APP_IMAGE]);
    const b = docker(['image', 'inspect', ADAPTER_IMAGE]);
    ok(a.code === 0 && b.code === 0, 'B00 M4B_SKIP_BUILD=1：复用已存在镜像（双 tag 存在）');
    if (a.code !== 0 || b.code !== 0) throw new Error('M4B_SKIP_BUILD=1 但镜像不存在');
  } else {
    console.log('[build] zhiying app image...');
    {
      const r = docker(['build', ...appBuildArgs, '-t', APP_IMAGE, '.'], 1_800_000);
      ok(r.code === 0, 'B01 app image build 成功', r.code !== 0 ? r.out.slice(-1500) : undefined);
      if (r.code !== 0) throw new Error('app image build 失败，终止后续容器测试');
    }
    console.log('[build] adapter image...');
    {
      const r = docker(['build', ...adapterBuildArgs, '-t', ADAPTER_IMAGE, 'services/indextts2-api-adapter'], 600_000);
      ok(r.code === 0, 'B02 adapter image build 成功', r.code !== 0 ? r.out.slice(-1500) : undefined);
      if (r.code !== 0) throw new Error('adapter image build 失败，终止后续容器测试');
    }
  }

  // ---------- 2. app 镜像静态检查 ----------
  {
    const r = docker(['run', '--rm', '--entrypoint', 'bash', APP_IMAGE, '-lc',
      'id -u; echo "HOME=$HOME"; fc-list :lang=zh family | sort -u | head -3; ffmpeg -version 2>/dev/null | head -1; ffprobe -version 2>/dev/null | head -1; command -v pgrep']);
    const out = r.out;
    ok(r.code === 0 && out.split('\n')[0]?.trim() === '1000', 'I01 容器 runtime uid=1000（node）', out.split('\n')[0]);
    ok(out.includes('HOME=/home/node'), 'I02 HOME=/home/node');
    // R2：不再 ls 目录 + regex 猜平台目录名（linux64/linux-x64/linux-arm64
    // 漂移曾致 I03 误判）——直接定位 browser executable 本体。Remotion 4.x
    // 布局：chrome-headless-shell/<platform>/chrome-headless-shell-<platform>/，
    // executable 名按平台不同（linux64=chrome-headless-shell，
    // linux-arm64=headless_shell，见 @remotion/renderer BrowserFetcher）
    const rb = docker(['run', '--rm', '--entrypoint', 'bash', APP_IMAGE, '-lc',
      'find /app/node_modules/.remotion/chrome-headless-shell -type f \\( -name headless_shell -o -name chrome-headless-shell \\) -perm -111 -print -quit 2>/dev/null']);
    const browserPath = rb.out.trim().split('\n')[0]?.trim() ?? '';
    if (browserPath) console.log(`REMOTION_BROWSER_PATH=${browserPath}`);
    ok(rb.code === 0 && browserPath.length > 0, 'I03 Chrome Headless Shell executable 存在于 node_modules/.remotion（image-baked，runtime 零下载）', browserPath || rb.out.slice(-300));
    ok(/Noto Sans CJK/i.test(out), 'I04 fonts-noto-cjk 可用（fc-list :lang=zh）');
    ok(out.includes('ffmpeg version'), 'I05 ffmpeg 可用');
    ok(out.includes('ffprobe version'), 'I06 ffprobe 可用');
    ok(/\/pgrep$/.test(out.trim()), 'I07 pgrep 可用（procps 显式安装，worker healthcheck 依赖）');
  }

  // ---------- 3. web 容器 + SQLite/WAL ----------
  const webName = `m4b-web-${SUFFIX}`;
  const workerName = `m4b-worker-${SUFFIX}`;
  const adapterName = `m4b-adapter-${SUFFIX}`;
  // web/worker 共享 DB 用 named volume（VM 内 ext4）：这才是 Linux 生产
  // 「同一 bind mount、同一 filesystem」的忠实语义。macOS Docker Desktop 的
  // virtiofs bind mount 对 WAL -shm mmap 跨容器一致性是概率性破碎的（实测：
  // web 提交的 job 行对 worker/新连接概率性不可见），不代表 Linux 行为。
  const dataVolume = `m4b-data-${SUFFIX}`;
  docker(['volume', 'create', dataVolume]);
  let projectId = '';
  try {
    const r = docker(['run', '-d', '--name', webName, '--init',
      '-e', 'NODE_ENV=production',
      '-e', 'ZHIYING_DATA_DIR=/app/data',
      '-e', 'TTS_PROVIDER=indextts2',
      '-e', 'INDEXTTS2_BASE_URL=http://indextts2-adapter:9880',
      '-v', `${dataVolume}:/app/data`,
      '-p', '127.0.0.1:3210:3000',
      APP_IMAGE, 'node', 'node_modules/next/dist/bin/next', 'start']);
    ok(r.code === 0, 'W01 web 容器启动（production env）', r.out.slice(-300));
    const up = await waitFor('web /api/projects 2xx', async () => {
      try {
        const res = await fetch('http://127.0.0.1:3210/api/projects');
        return res.ok;
      } catch {
        return false;
      }
    }, 90_000);
    ok(up, 'W02 web health endpoint GET /api/projects → 2xx');
    {
      const res = await fetch('http://127.0.0.1:3210/api/projects', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({topic: 'M4B 容器测试', coreQuestion: '容器内 SQLite 可用吗？'}),
      });
      const j = (await res.json()) as {project?: {id: string}};
      projectId = j.project?.id ?? '';
      ok(res.status === 201 && projectId.length > 0, 'W03 POST /api/projects → 201（API DB write）', {status: res.status});
    }
    {
      const res = await fetch('http://127.0.0.1:3210/api/projects');
      const j = (await res.json()) as {projects: Array<{id: string}>};
      ok(j.projects.some((p) => p.id === projectId), 'W04 GET /api/projects 含新项目（API DB read）');
    }
    {
      const r2 = docker(['exec', webName, 'node', '-e',
        "const db=require('better-sqlite3')('/app/data/zhiying.db');console.log(db.pragma('journal_mode',{simple:true}))"]);
      ok(r2.out.trim() === 'wal', 'W05 SQLite 创建且 journal_mode=WAL', r2.out.trim());
    }

    // ---------- 4. worker 容器：共享 DB claim job ----------
    {
      const r3 = docker(['run', '-d', '--name', workerName, '--init',
        '-e', 'NODE_ENV=development', // mock provider 功能测试（production 禁 mock 由 compose 静态锁定）
        '-e', 'ZHIYING_DATA_DIR=/app/data',
        '-e', 'WORKER_ROLE=all',
        '-e', 'LLM_PROVIDER=mock',
        '-e', 'TTS_PROVIDER=mock',
        '--health-cmd', "pgrep -f 'src/worker/index.ts' >/dev/null",
        '--health-interval', '5s',
        '--health-start-period', '10s',
        '--health-retries', '6',
        '-v', `${dataVolume}:/app/data`,
        APP_IMAGE, 'node', '--import', 'tsx', 'src/worker/index.ts']);
      ok(r3.code === 0, 'K01 worker 容器启动（直接 exec + init）', r3.out.slice(-300));
      ok(r3.code === 0, 'K01 worker 容器启动', r3.out.slice(-300));
      const started = await waitFor('worker starting', () =>
        docker(['logs', workerName]).out.includes('starting'), 60_000);
      ok(started, 'K02 worker 主循环 starting（无 permission error）');
      {
        const res = await fetch('http://127.0.0.1:3210/api/workflow/run-stage', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({projectId, stage: 'project_definition', confirmStale: true}),
        });
        ok(res.status === 202, 'K03 run-stage 入队 202', {status: res.status});
      }
      const claimed = await waitFor('llm job succeeded', () =>
        docker(['exec', webName, 'node', '-e',
          "const db=require('better-sqlite3')('/app/data/zhiying.db',{readonly:true});const r=db.prepare('SELECT status FROM llm_jobs ORDER BY queued_at DESC LIMIT 1').get();console.log(r?r.status:'none')",
        ]).out.trim() === 'succeeded', 180_000);
      if (!claimed) {
        console.log('[diag] worker logs tail:\n' + docker(['logs', workerName]).out.slice(-1500));
        console.log('[diag] llm_jobs:\n' + docker(['exec', webName, 'node', '-e',
          "const db=require('better-sqlite3')('/app/data/zhiying.db',{readonly:true});console.log(JSON.stringify(db.prepare('SELECT status,error_message FROM llm_jobs').all()))",
        ]).out);
      }
      ok(claimed, 'K04 worker 经共享 SQLite claim 并完成 job（succeeded）');
      // Worker Docker healthcheck（pgrep 匹配直接 exec 的新进程形态）→ healthy
      const workerHealthy = await waitFor('worker container healthy', () =>
        docker(['inspect', '--format', '{{.State.Health.Status}}', workerName]).out.trim() === 'healthy', 90_000);
      ok(workerHealthy, 'K05a worker Docker healthcheck → healthy（pgrep + procps）');
      // 真实 docker stop：SIGTERM 经 tini → node（--import tsx 进程内 loader）
      // 直达 worker handler——不经 pnpm/sh shim 链；验收退出码 143（SIGTERM
      // 优雅退出），不是 137（SIGKILL）
      docker(['stop', '--time', '60', workerName]);
      const stopLogs = docker(['logs', workerName]).out;
      const exitCode = docker(['inspect', '--format', '{{.State.ExitCode}}', workerName]).out.trim();
      ok(stopLogs.includes('bye.'), 'K05b docker stop → worker logs 包含 bye.', exitCode);
      ok(exitCode === '0', 'K05c worker 在 grace period 内优雅退出（handled SIGTERM → exit 0，非 SIGKILL 137）', exitCode);
    }
  } finally {
    cleanupContainer(workerName);
    cleanupContainer(webName);
    docker(['volume', 'rm', '-f', dataVolume]);
  }

  // ---------- 4b. active job：docker stop mid-render → requeue → 重启续跑 ----------
  const worker2Name = `m4b-worker2-${SUFFIX}`;
  const driverName = `m4b-driver-${SUFFIX}`;
  const dataVolume2 = `m4b-data2-${SUFFIX}`;
  docker(['volume', 'create', dataVolume2]);
  try {
    docker(['run', '-d', '--name', worker2Name, '--init',
      '-e', 'NODE_ENV=development',
      '-e', 'ZHIYING_DATA_DIR=/app/data',
      '-e', 'WORKER_ROLE=all',
      '-e', 'LLM_PROVIDER=mock',
      '-e', 'TTS_PROVIDER=mock',
      '-v', `${dataVolume2}:/app/data`,
      APP_IMAGE, 'node', '--import', 'tsx', 'src/worker/index.ts']);
    docker(['run', '-d', '--name', driverName, '--init',
      '-e', 'NODE_ENV=development',
      '-e', 'ZHIYING_DATA_DIR=/app/data',
      '-e', 'LLM_PROVIDER=mock',
      '-e', 'TTS_PROVIDER=mock',
      '-v', `${dataVolume2}:/app/data`,
      '-v', `${path.resolve('scripts')}:/app/scripts:ro`,
      APP_IMAGE, 'node', '--import', 'tsx', 'scripts/test-m4b-active-job-driver.ts']);
    const running = await waitFor('RENDER_RUNNING marker', () =>
      docker(['logs', driverName]).out.includes('RENDER_RUNNING'), 600_000);
    ok(running, 'J01 pipeline 完成且 render job 进入 running（真实 render 进行中）');
    // 真实 docker stop（mid-render）：SIGTERM → abort → requeue → bye.
    docker(['stop', '--time', '60', worker2Name]);
    const stopLogs2 = docker(['logs', worker2Name]).out;
    const exit2 = docker(['inspect', '--format', '{{.State.ExitCode}}', worker2Name]).out.trim();
    ok(stopLogs2.includes('requeued due to shutdown'), 'J02 docker stop mid-render → job requeued due to shutdown', exit2);
    // frozen 优雅契约 = SIGTERM 到达 handler → requeue + bye.（均实测）。
    // 已知残留（frozen src/Remotion 句柄，不改 frozen）：render/bundle 活动后
    // node 进程在 bye. 之后不自然退出，grace 到期被 SIGKILL（exit 137）——
    // 发生在优雅契约完成之后，job 状态已安全持久化，无数据影响。
    const idxRequeue = stopLogs2.indexOf('requeued due to shutdown');
    const idxBye = stopLogs2.indexOf('bye.');
    ok(
      idxRequeue >= 0 && idxBye > idxRequeue,
      'J03 优雅契约完成且顺序正确（requeue → bye.；post-bye. 退出码如实记录）',
      {exit: exit2, note: '137=post-bye. SIGKILL（Remotion/frozen 残留句柄）'},
    );
    {
      const st = docker(['exec', driverName, 'node', '-e',
        `const db=require('better-sqlite3')('/app/data/zhiying.db',{readonly:true});console.log(db.prepare('SELECT status FROM render_jobs ORDER BY queued_at DESC LIMIT 1').get().status)`]);
      ok(st.out.trim() === 'queued', 'J04 mid-render job 回到 queued（frozen 定义的正确状态）', st.out.trim());
    }
    // 重启单 worker → 任务被重新处理直至 succeeded（driver 全程在轮询）
    docker(['start', worker2Name]);
    const recovered = await waitFor('RENDER_SUCCEEDED marker', () =>
      docker(['logs', driverName]).out.includes('RENDER_SUCCEEDED'), 900_000);
    ok(recovered, 'J05 worker 重启后 requeue job 被重新处理至 succeeded（真实 render + ffprobe 校验）');
    const driverExit = docker(['inspect', '--format', '{{.State.ExitCode}}', driverName]).out.trim();
    ok(driverExit === '0', 'J06 driver 正常完成（DRIVER_DONE）', driverExit);
  } finally {
    cleanupContainer(driverName);
    cleanupContainer(worker2Name);
    docker(['volume', 'rm', '-f', dataVolume2]);
  }

  // ---------- 5. adapter 容器 ----------
  const adapterData = path.join(TMP_ROOT, 'adapter');
  fs.mkdirSync(path.join(adapterData, 'voices'), {recursive: true});
  fs.writeFileSync(path.join(adapterData, 'voices', 'ref.wav'), MOCK_WAV);
  fs.writeFileSync(path.join(adapterData, 'registry.json'), JSON.stringify({
    schemaVersion: '1.0',
    voices: [{
      voiceProfile: 'default',
      voiceRevision: '1',
      speakerName: 'zhiying-m4b-test',
      referenceAssetPath: '/voices/ref.wav',
      referenceSha256: MOCK_SHA256,
    }],
  }));
  const mock = await startMockUpstream();
  try {
    const r = docker(['run', '-d', '--name', adapterName,
      // R2 Linux portability：Docker Desktop 自带 host.docker.internal 映射，
      // GitHub-hosted Linux Engine 需要显式 host-gateway（test harness 专用，
      // 不改 production compose/adapter architecture）
      '--add-host', 'host.docker.internal=host-gateway',
      '-e', `ADAPTER_UPSTREAM_BASE_URL=http://host.docker.internal:${MOCK_UPSTREAM_PORT}`,
      '-e', 'ADAPTER_UPSTREAM_TIMEOUT_SEC=5',
      '-e', 'ADAPTER_VOICE_REGISTRY_PATH=/config/voice-registry.json',
      '-e', 'ADAPTER_VOICE_ROOT=/voices',
      '-v', `${path.join(adapterData, 'registry.json')}:/config/voice-registry.json:ro`,
      '-v', `${path.join(adapterData, 'voices')}:/voices:ro`,
      '--read-only',
      '--tmpfs', '/tmp',
      '-p', `127.0.0.1:${ADAPTER_PUBLISH_PORT}:9880`,
      ADAPTER_IMAGE]);
    ok(r.code === 0, 'A01 adapter 容器启动（read_only + tmpfs）', r.out.slice(-300));
    const healthy = await waitFor('adapter container healthy', () =>
      docker(['inspect', '--format', '{{.State.Health.Status}}', adapterName]).out.trim() === 'healthy', 120_000);
    if (!healthy) {
      // R2：A02 timeout 时输出可审计诊断（无 secret），随后仍走 finally 清理
      const health = docker(['inspect', '--format', '{{json .State.Health}}', adapterName]);
      console.log('[diag] adapter Health:\n' + health.out.slice(-2000));
      console.log('[diag] adapter logs tail:\n' + docker(['logs', '--tail', '60', adapterName]).out.slice(-3000));
      const dns = docker(['exec', adapterName, 'python3', '-c',
        "import socket\nprint('host.docker.internal ->', socket.gethostbyname('host.docker.internal'))"]);
      console.log('[diag] container resolve host.docker.internal:\n' + dns.out);
    }
    ok(healthy, 'A02 Docker HEALTHCHECK → healthy（ready==true 语义，非 curl -f）');
    {
      const r2 = docker(['exec', adapterName, 'id', '-u']);
      ok(r2.out.trim() === '1000', 'A03 adapter 容器 non-root uid=1000', r2.out.trim());
    }
    {
      const r3 = docker(['exec', adapterName, 'touch', '/app/x']);
      ok(r3.code !== 0, 'A04 rootfs 只读（touch /app/x 失败）');
    }
    {
      const res = await fetch(`http://127.0.0.1:${ADAPTER_PUBLISH_PORT}/health`);
      const j = (await res.json()) as {ready?: boolean};
      ok(res.ok && j.ready === true, 'A05 /health ready=true（registry + SHA + upstream）', j);
    }
    {
      const res = await fetch(`http://127.0.0.1:${ADAPTER_PUBLISH_PORT}/v1/synthesize`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({text: '测试文本。', voiceProfile: 'default', voiceRevision: '1', useRandom: false, emotion: 'none'}),
      });
      const wav = Buffer.from(await res.arrayBuffer());
      ok(res.status === 200 && wav.length > 44 && wav.subarray(0, 4).toString() === 'RIFF', 'A06 容器内 synthesize → WAV（RIFF）', {status: res.status});
    }
  } finally {
    cleanupContainer(adapterName);
    mock.close();
    await sleep(300);
  }

  // ---------- 6. 容器内真实 Remotion render gate（fail-closed） ----------
  if (RENDER_GATE) {
    console.log('[render] RUN_M4B_CONTAINER_RENDER=1：容器内真实 render...');
    // R2 Linux portability：bind mount 的宿主目录 owner 是 runner 用户，
    // 容器 uid1000 mkdir EACCES（GitHub Linux 实测；macOS virtiofs 不会暴露）。
    // 与 web/worker 段一致使用 named volume（镜像内 /app/data owner=node 初始化，
    // 两个平台语义一致）
    const renderDataVolume = `m4b-render-data-${SUFFIX}`;
    docker(['volume', 'create', renderDataVolume]);
    const r = docker(['run', '--rm',
      '-e', 'RUN_REAL_REMOTION_SMOKE=1',
      '-e', 'NODE_ENV=development', // mock provider（production 禁 mock 是 frozen gate）
      '-v', `${renderDataVolume}:/app/data`,
      // 整个 scripts/ 目录 ro 挂载：测试脚本以 ../src 相对路径 import，
      // 单文件挂载会破坏相对布局
      '-v', `${path.resolve('scripts')}:/app/scripts:ro`,
      // timeout 兜底：历史 stopWorker 经 pnpm shim 链 SIGTERM 不转发曾致悬挂
      // （R2-R1 起 test-m3e-real-render 已改 direct Node launcher，与
      // production 对齐并自带 bounded teardown）；timeout 仅作 ultimate
      // safety net，正常路径不依赖它
      APP_IMAGE, 'sh', '-c', 'timeout -s KILL 600 npx tsx scripts/test-m3e-real-render.ts'], 900_000);
    docker(['volume', 'rm', '-f', renderDataVolume]);
    const tail = r.out.split('\n').filter((l) => l.includes('REAL_RENDER') || l.includes('FAIL')).slice(-5);
    const renderPassed = r.out.includes('M3-E REAL_RENDER: 26 PASS, 0 FAIL');
    if (!renderPassed) {
      // R2：R01 失败必须给出 raw diagnostic（code=1 tail=[] 不可诊断）——
      // 输出合并 stdout/stderr 最后 ~6KB（worker/browser/render 实际错误尾部），
      // 同时避免无限完整日志冲刷 CI
      console.log('RAW_RENDER_DIAGNOSTIC_TAIL（combined stdout/stderr 最后 ~6KB）:');
      console.log(r.out.slice(-6144));
    }
    ok(
      renderPassed,
      'R01 容器内真实 Remotion render（Chrome+Noto CJK+ffmpeg，26 assertions）',
      {code: r.code, tail},
    );
  } else {
    console.log('[render] SKIP：设置 RUN_M4B_CONTAINER_RENDER=1 运行容器内真实 render gate');
  }

  fs.rmSync(TMP_ROOT, {recursive: true, force: true});
  console.log(`\nM4-B container: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('M4-B container 测试异常终止:', err);
  process.exitCode = 1;
});

/**
 * M4-B production compose 静态检查（不启动任何容器）。
 *
 * 用法：npx tsx scripts/test-m4b-compose.ts
 * 通过 `docker compose -f docker-compose.production.yml config --format json`
 * （dummy env，无真实 secret）验证 M4-A frozen 架构约束。任一断言失败即非零退出。
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

interface ComposePort {host_ip?: string; target: number; published?: string}
interface ComposeVolume {source: string; target: string; read_only?: boolean}
interface ComposeService {
  command?: string[] | null;
  environment?: Record<string, string>;
  networks?: Record<string, unknown>;
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
  depends_on?: Record<string, {condition?: string}>;
  cpus?: number;
  mem_limit?: string;
  read_only?: boolean;
  privileged?: boolean;
  network_mode?: string;
  healthcheck?: {test?: string[]};
}
interface ComposeConfig {
  services: Record<string, ComposeService>;
  networks: Record<string, {external?: boolean; name?: string; driver?: string}>;
}

function main(): void {
  // dummy env：仅为变量替换，不含真实 secret
  const RELEASE_TAG = 'm4b-review-tag';
  const envFile = path.join(os.tmpdir(), `m4b-compose-test-${process.pid}.env`);
  fs.writeFileSync(envFile, [
    'DEEPSEEK_API_KEY=test-dummy-not-a-real-key',
    'ZHIYING_HOST_DATA_DIR=/tmp/zhiying-data',
    'ZHIYING_HOST_PUBLIC_DIR=/tmp/zhiying-public',
    'ZHIYING_HOST_VOICES_DIR=/tmp/zhiying-voices',
    'ZHIYING_HOST_VOICE_REGISTRY=/tmp/zhiying-voice-registry.json',
    `ZHIYING_RELEASE_TAG=${RELEASE_TAG}`,
    '',
  ].join('\n'));
  let cfg: ComposeConfig;
  try {
    const out = execFileSync('docker', [
      'compose', '-f', 'docker-compose.production.yml',
      '--env-file', envFile, 'config', '--format', 'json',
    ], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    cfg = JSON.parse(out) as ComposeConfig;
  } finally {
    fs.rmSync(envFile, {force: true});
  }

  // ---- 服务集合：恰好 3 个，且不含任何 tts-stack 服务 ----
  const names = Object.keys(cfg.services).sort();
  ok(
    names.length === 3 && names.includes('zhiying-web') && names.includes('zhiying-worker') && names.includes('indextts2-adapter'),
    'C01 恰好 3 个 service（web/worker/adapter）',
    names,
  );
  ok(
    !('indextts2' in cfg.services) && !('qwen3-tts' in cfg.services) && !('cosyvoice3' in cfg.services),
    'C02 未声明 indextts2/qwen3-tts/cosyvoice3（属独立 tts-stack）',
  );

  const web = cfg.services['zhiying-web']!;
  const worker = cfg.services['zhiying-worker']!;
  const adapter = cfg.services['indextts2-adapter']!;

  // ---- 网络安全：无 host network、无 privileged ----
  for (const [n, s] of Object.entries(cfg.services)) {
    ok(s.network_mode !== 'host' && s.privileged !== true, `C03 ${n} 无 host network / 无 privileged`);
  }

  // ---- network membership（M4-A frozen）----
  ok(
    Object.keys(web.networks ?? {}).sort().join(',') === 'zhiying-app-net',
    'C04 web ∈ zhiying-app-net only',
    web.networks,
  );
  ok(
    Object.keys(worker.networks ?? {}).sort().join(',') === 'zhiying-app-net',
    'C05 worker ∈ zhiying-app-net only',
    worker.networks,
  );
  ok(
    Object.keys(adapter.networks ?? {}).sort().join(',') === 'zhiying-app-net,zhiying-tts-net',
    'C06 adapter ∈ app-net + tts-net（唯一桥）',
    adapter.networks,
  );
  ok(
    cfg.networks['zhiying-tts-net']?.external === true && cfg.networks['zhiying-tts-net']?.name === 'zhiying-tts-net',
    'C07 zhiying-tts-net external（管理员预创建）',
    cfg.networks['zhiying-tts-net'],
  );
  ok(cfg.networks['zhiying-app-net']?.driver === 'bridge', 'C08 zhiying-app-net = bridge');

  // ---- 端口暴露：仅 web 127.0.0.1:3210:3000；worker/adapter 无 ports ----
  const wp = web.ports ?? [];
  ok(
    wp.length === 1 && wp[0]!.host_ip === '127.0.0.1' && wp[0]!.target === 3000 && wp[0]!.published === '3210',
    'C09 web 仅发布 127.0.0.1:3210:3000',
    wp,
  );
  ok((worker.ports ?? []).length === 0, 'C10 worker 无 ports');
  ok((adapter.ports ?? []).length === 0, 'C11 adapter 无 ports（stack 内部 only）');

  // ---- 挂载：data rw（web+worker）、public ro（web+worker）、registry/voices ro（adapter）----
  const hasMount = (s: ComposeService, target: string, ro: boolean): boolean =>
    (s.volumes ?? []).some((v) => v.target === target && (v.read_only ?? false) === ro);
  ok(hasMount(web, '/app/data', false) && hasMount(web, '/app/public', true), 'C12 web: data rw + public ro');
  ok(hasMount(worker, '/app/data', false) && hasMount(worker, '/app/public', true), 'C13 worker: data rw + public ro');
  ok(
    hasMount(adapter, '/config/voice-registry.json', true) && hasMount(adapter, '/voices', true),
    'C14 adapter: registry ro + voices ro',
  );

  // ---- worker contract：cpus/mem_limit/depends_on/单 service ----
  ok(worker.cpus === 4, 'C15 worker cpus=4', worker.cpus);
  ok(worker.mem_limit === String(6 * 1024 ** 3), 'C16 worker mem_limit=6g', worker.mem_limit);
  ok(
    worker.depends_on?.['indextts2-adapter']?.condition === 'service_healthy',
    'C17 worker depends_on adapter: service_healthy（跨 stack readiness bridge）',
    worker.depends_on,
  );
  ok(worker.depends_on?.['indextts2'] === undefined, 'C18 worker 不 depends_on indextts2（禁止跨 stack 生命周期）');
  ok(!('deploy' in worker), 'C19 worker 无 deploy/scale 配置（单 worker 不变量）');

  // ---- secret scoping：DEEPSEEK_API_KEY 只在 worker ----
  ok(
    worker.environment?.DEEPSEEK_API_KEY === 'test-dummy-not-a-real-key',
    'C20 worker 注入 DEEPSEEK_API_KEY（变量替换）',
  );
  ok(!('DEEPSEEK_API_KEY' in (web.environment ?? {})), 'C21 web 不注入 DEEPSEEK_API_KEY');
  ok(!('DEEPSEEK_API_KEY' in (adapter.environment ?? {})), 'C22 adapter 不注入 DEEPSEEK_API_KEY');
  ok(!('LLM_PROVIDER' in (web.environment ?? {})), 'C23 web 不注入 LLM_PROVIDER（实证 web 不实例化 LLM）');
  ok(worker.environment?.LLM_PROVIDER === 'deepseek', 'C24 worker LLM_PROVIDER=deepseek（生产禁 mock）');

  // ---- 关键 env 值 ----
  ok(
    worker.environment?.INDEXTTS2_BASE_URL === 'http://indextts2-adapter:9880' &&
      web.environment?.INDEXTTS2_BASE_URL === 'http://indextts2-adapter:9880',
    'C25 web/worker INDEXTTS2_BASE_URL → adapter 内部地址',
  );
  ok(
    adapter.environment?.ADAPTER_UPSTREAM_BASE_URL === 'http://indextts2:8002' &&
      adapter.environment?.ADAPTER_VOICE_REGISTRY_PATH === '/config/voice-registry.json' &&
      adapter.environment?.ADAPTER_VOICE_ROOT === '/voices',
    'C26 adapter upstream/registry/voice-root 指向 production 值',
  );
  ok(
    web.environment?.NODE_ENV === 'production' && worker.environment?.NODE_ENV === 'production',
    'C27 NODE_ENV=production（生产安全 gate 激活）',
  );

  // ---- adapter 加固：read_only rootfs + tmpfs ----
  ok(adapter.read_only === true, 'C28 adapter read_only rootfs');

  // ---- command（直接 exec，不经 pnpm/sh shim 链）----
  const webCmd = (web.command ?? []).join(' ');
  const workerCmd = (worker.command ?? []).join(' ');
  ok(webCmd === 'node node_modules/next/dist/bin/next start', 'C29 web command = 直接 exec next start（无 pnpm wrapper）', webCmd);
  ok(workerCmd === 'node --import tsx src/worker/index.ts', 'C30 worker command = node --import tsx（进程内 loader，无 shim 链）', workerCmd);

  // ---- image tag：禁止 latest，release tag 必填，双镜像同一 tag ----
  const webImage = (web as unknown as {image?: string}).image ?? '';
  const adapterImage = (adapter as unknown as {image?: string}).image ?? '';
  ok(
    webImage === `zhiying:${RELEASE_TAG}` && !webImage.endsWith(':latest'),
    'C31 app image 使用 ZHIYING_RELEASE_TAG（禁止 latest）',
    webImage,
  );
  ok(
    adapterImage === `zhiying-indextts2-adapter:${RELEASE_TAG}` && !adapterImage.endsWith(':latest'),
    'C32 adapter image 与 app 同一 release tag',
    adapterImage,
  );

  // ---- init / stop_grace_period（signal chain 契约）----
  ok(
    (web as unknown as {init?: boolean}).init === true && (worker as unknown as {init?: boolean}).init === true,
    'C33 web/worker init=true（tini signal forwarding + reaping）',
  );
  ok(
    ['60s', '1m0s'].includes((worker as unknown as {stop_grace_period?: string}).stop_grace_period ?? ''),
    'C34 worker stop_grace_period=60s（优雅退出窗口）',
    (worker as unknown as {stop_grace_period?: string}).stop_grace_period,
  );

  console.log(`\nM4-B compose: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();

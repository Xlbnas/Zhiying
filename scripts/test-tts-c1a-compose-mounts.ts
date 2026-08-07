/**
 * TTS-C.1A.R1 + TTS-C.1B.3 compose mount 契约：
 * - Web：materialization 专用 mount :ro（可只读校验 existing projection，不能创建/temp/rename）；
 * - Worker：materialization 同一 mount :rw（唯一 rw writer）；
 * - env 缺失 fail-closed（`:?` 强制语法）；
 * - TTS-A voice-library Web 写入不回退（/app/data 主挂载仍 rw 在 Web/Worker）；
 * - TTS-C.1B.3 topology（TOP-01…TOP-09）：
 *   TOP-01 adapter registry directory :ro（/config）+ 固定 ADAPTER_VOICE_REGISTRY_PATH
 *   TOP-02 worker registry directory :rw（/app/data/registry）+ ZHIYING_ACTIVE_REGISTRY_* 一致
 *   TOP-03 host source identity（worker registry source == adapter registry source）
 *   TOP-04 worker legacy voices :ro（/voices）+ ZHIYING_LEGACY_VOICE_ROOT_DIR 一致
 *   TOP-05 adapter materialization visibility（/voices/tts-a :ro + ZHIYING_EMIT_VOICE_ROOT_PATH 一致）
 *   TOP-06 permissions 矩阵（registry rw/ro、voices ro、materializations ro；无 privileged/socket）
 *   TOP-07 无 single-file registry bind（/config/voice-registry.json 不再是 volume target）
 *   TOP-08 recovery env completeness（4 个 required env 与 mounts 一致）
 *   TOP-09 docker compose config 真实渲染（dummy env）成功且 resolved volumes/env 一致
 *
 * 文本级断言 + `docker compose config` 渲染级断言（不启动任何容器）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ok, summary} from './lib/tts-c1a-test-utils';

const COMPOSE_PATH = 'docker-compose.production.yml';

interface ComposeVolume {source: string; target: string; read_only?: boolean}
interface ComposeService {environment?: Record<string, string>; volumes?: ComposeVolume[]; privileged?: boolean}
interface ComposeConfig {services: Record<string, ComposeService>}

function renderComposeConfig(): ComposeConfig {
  // dummy env：仅为变量替换，不含真实 secret
  const envFile = path.join(os.tmpdir(), `tts-c1a-compose-topology-${process.pid}.env`);
  fs.writeFileSync(envFile, [
    'DEEPSEEK_API_KEY=test-dummy-not-a-real-key',
    'ZHIYING_HOST_DATA_DIR=/tmp/zhiying-data',
    'ZHIYING_HOST_PUBLIC_DIR=/tmp/zhiying-public',
    'ZHIYING_HOST_VOICES_DIR=/tmp/zhiying-voices',
    'ZHIYING_HOST_REGISTRY_DIR=/tmp/zhiying-registry',
    'ZHIYING_HOST_MATERIALIZATIONS_DIR=/tmp/zhiying-data/voice-materializations',
    'ZHIYING_HOST_ASSETS_DIR=/tmp/zhiying-assets',
    'ZHIYING_RELEASE_TAG=topology-review-tag',
    '',
  ].join('\n'));
  try {
    const out = execFileSync('docker', [
      'compose', '-f', COMPOSE_PATH,
      '--env-file', envFile, 'config', '--format', 'json',
    ], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    return JSON.parse(out) as ComposeConfig;
  } finally {
    fs.rmSync(envFile, {force: true});
  }
}

(async () => {
  const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');

  // ── 1) 1A 保留：env fail-closed + Web/Worker materialization 分离 ──
  ok(compose.includes('${ZHIYING_HOST_MATERIALIZATIONS_DIR:?ZHIYING_HOST_MATERIALIZATIONS_DIR required}'), 'CM-01 env 缺失 fail-closed（:? 强制）');

  const webBlock = compose.split('zhiying-worker:')[0].split('zhiying-web:')[1];
  ok(
    webBlock.includes('/app/data/voice-materializations:ro'),
    'CM-02 Web materialization mount :ro',
  );
  ok(!webBlock.includes('/app/data/voice-materializations:rw'), 'CM-02b Web 无 rw materialization mount');

  const workerBlock = compose.split('zhiying-web:')[1].split('\n  indextts2-adapter:')[0];
  ok(
    workerBlock.includes('/app/data/voice-materializations:rw'),
    'CM-03 Worker materialization mount :rw',
  );

  // 4) adapter 无独立 materialization 平铺 mount（1B.3 拓扑为 /voices/tts-a 子命名空间）
  const adapterBlock = compose.split('\n  indextts2-adapter:')[1] ?? '';
  ok(adapterBlock.includes('/voices/tts-a:ro'), 'CM-04 adapter materialization mount /voices/tts-a :ro');
  ok(!adapterBlock.includes('/app/data/voice-materializations'), 'CM-04b adapter 无 /app/data 暴露');

  // 5) Web/Worker 主 data 挂载仍 rw（TTS-A voice-library Web 写入不回退）
  ok(compose.split('zhiying-web:')[1].split('zhiying-worker:')[0].includes('${ZHIYING_HOST_DATA_DIR:?ZHIYING_HOST_DATA_DIR required}:/app/data\n'), 'CM-05 Web /app/data 主挂载保留 rw');
  ok(workerBlock.includes('${ZHIYING_HOST_DATA_DIR:?ZHIYING_HOST_DATA_DIR required}:/app/data'), 'CM-05b Worker /app/data 主挂载保留 rw');

  // 6) 子路径挂载覆盖顺序：materialization mount 出现在 data 挂载之后（子路径覆盖生效）
  const webDataIdx = webBlock.indexOf(':/app/data\n');
  const webMatIdx = webBlock.indexOf(':/app/data/voice-materializations');
  ok(webDataIdx !== -1 && webMatIdx > webDataIdx, 'CM-06 子路径挂载在 data 之后（覆盖生效）', {dataIdx: webDataIdx, matIdx: webMatIdx});

  // ── 2) TTS-C.1B.3 topology ──

  // TOP-01 adapter registry directory RO（/config），不再有 single-file bind
  ok(
    adapterBlock.includes('${ZHIYING_HOST_REGISTRY_DIR:?ZHIYING_HOST_REGISTRY_DIR required}:/config:ro'),
    'TOP-01 adapter registry directory mount :ro（/config）',
  );
  ok(
    adapterBlock.includes('ADAPTER_VOICE_REGISTRY_PATH: /config/voice-registry.json'),
    'TOP-01b adapter 固定 registry 路径保持 /config/voice-registry.json',
  );

  // TOP-02 worker registry directory RW + ZHIYING_ACTIVE_REGISTRY_* 与 mount 一致
  ok(
    workerBlock.includes('${ZHIYING_HOST_REGISTRY_DIR:?ZHIYING_HOST_REGISTRY_DIR required}:/app/data/registry:rw'),
    'TOP-02 worker registry directory mount :rw（/app/data/registry）',
  );
  ok(
    workerBlock.includes('ZHIYING_ACTIVE_REGISTRY_ROOT: /app/data/registry') &&
      workerBlock.includes('ZHIYING_ACTIVE_REGISTRY_PATH: /app/data/registry/voice-registry.json'),
    'TOP-02b ZHIYING_ACTIVE_REGISTRY_ROOT/PATH 与 worker mount 一致',
  );

  // TOP-03 host source identity：worker 与 adapter 使用同一 env 变量（文本同源）
  const registryVarUsage = (compose.match(/\$\{ZHIYING_HOST_REGISTRY_DIR:\?ZHIYING_HOST_REGISTRY_DIR required\}/g) ?? []).length;
  ok(registryVarUsage >= 2, 'TOP-03 worker 与 adapter 的 registry source 同一 env（出现 ≥2 处）', registryVarUsage);
  ok(!compose.includes('ZHIYING_HOST_VOICE_REGISTRY'), 'TOP-03b 旧 single-file env（ZHIYING_HOST_VOICE_REGISTRY）已移除');

  // TOP-04 worker legacy voices :ro + ZHIYING_LEGACY_VOICE_ROOT_DIR 一致
  ok(
    workerBlock.includes('${ZHIYING_HOST_VOICES_DIR:?ZHIYING_HOST_VOICES_DIR required}:/voices:ro'),
    'TOP-04 worker legacy voices mount :ro（/voices）',
  );
  ok(
    workerBlock.includes('ZHIYING_LEGACY_VOICE_ROOT_DIR: /voices'),
    'TOP-04b ZHIYING_LEGACY_VOICE_ROOT_DIR 与 mount target 一致（/voices）',
  );

  // TOP-05 adapter materialization visibility：/voices/tts-a :ro + emit 前缀一致
  ok(
    adapterBlock.includes('${ZHIYING_HOST_MATERIALIZATIONS_DIR:?ZHIYING_HOST_MATERIALIZATIONS_DIR required}:/voices/tts-a:ro'),
    'TOP-05 adapter materialization mount :ro（/voices/tts-a 非重叠子命名空间）',
  );
  ok(
    workerBlock.includes('ZHIYING_EMIT_VOICE_ROOT_PATH: /voices/tts-a'),
    'TOP-05b ZHIYING_EMIT_VOICE_ROOT_PATH=/voices/tts-a 与 adapter mount 一致',
  );

  // TOP-06 permissions 矩阵（文本 + 渲染双层）
  ok(
    workerBlock.includes('/app/data/registry:rw') && workerBlock.includes('/voices:ro') &&
      !workerBlock.includes('/app/data/registry:ro'),
    'TOP-06a worker registry rw / legacy voices ro',
  );
  ok(
    adapterBlock.includes('/config:ro') && adapterBlock.includes('/voices:ro') && adapterBlock.includes('/voices/tts-a:ro') &&
      !adapterBlock.includes('/config:rw') && !adapterBlock.includes('/voices/tts-a:rw'),
    'TOP-06b adapter registry/voices/materializations 全 ro',
  );

  // TOP-07 无 single-file bind：/config/voice-registry.json 不得是 volume target
  ok(
    !compose.includes('/config/voice-registry.json:ro') && !compose.includes('/config/voice-registry.json:rw'),
    'TOP-07 无 single-file registry bind（/config/voice-registry.json 不是 volume target）',
  );

  // TOP-08 recovery env completeness（4 个 required env 全部存在）
  for (const key of ['ZHIYING_ACTIVE_REGISTRY_PATH', 'ZHIYING_ACTIVE_REGISTRY_ROOT', 'ZHIYING_LEGACY_VOICE_ROOT_DIR', 'ZHIYING_EMIT_VOICE_ROOT_PATH']) {
    ok(workerBlock.includes(`${key}: `), `TOP-08 ${key} 已显式配置`);
  }
  ok(
    workerBlock.includes('INDEXTTS2_BASE_URL: http://127.0.0.1:9880') ||
      workerBlock.includes('ADAPTER_BASE_URL: http://127.0.0.1:9880'),
    'TOP-08b adapter URL 走本机既有 INDEXTTS2_BASE_URL / ADAPTER_BASE_URL（无公网路径）',
  );

  // TOP-09 docker compose config 真实渲染（dummy env）：resolved volumes/env 一致
  const cfg = renderComposeConfig();
  const worker = cfg.services['zhiying-worker']!;
  const adapter = cfg.services['indextts2-adapter']!;
  const hasMount = (s: ComposeService, target: string, ro: boolean): boolean =>
    (s.volumes ?? []).some((v) => v.target === target && (v.read_only ?? false) === ro);
  ok(
    hasMount(adapter, '/config', true) && hasMount(adapter, '/voices', true) && hasMount(adapter, '/voices/tts-a', true),
    'TOP-09 compose render：adapter /config:ro + /voices:ro + /voices/tts-a:ro',
    (adapter.volumes ?? []).map((v) => `${v.source}->${v.target}${v.read_only ? ':ro' : ':rw'}`),
  );
  ok(
    hasMount(worker, '/app/data/registry', false) && hasMount(worker, '/voices', true),
    'TOP-09b compose render：worker /app/data/registry:rw + /voices:ro',
    (worker.volumes ?? []).map((v) => `${v.source}->${v.target}${v.read_only ? ':ro' : ':rw'}`),
  );
  // host source identity（渲染后）：worker registry source == adapter registry source
  const workerRegSrc = (worker.volumes ?? []).find((v) => v.target === '/app/data/registry')?.source;
  const adapterRegSrc = (adapter.volumes ?? []).find((v) => v.target === '/config')?.source;
  ok(workerRegSrc !== undefined && workerRegSrc === adapterRegSrc, 'TOP-09c 渲染后 registry source worker == adapter', {workerRegSrc, adapterRegSrc});
  const adapterMatSrc = (adapter.volumes ?? []).find((v) => v.target === '/voices/tts-a')?.source;
  const workerMatSrc = (worker.volumes ?? []).find((v) => v.target === '/app/data/voice-materializations')?.source;
  ok(adapterMatSrc !== undefined && adapterMatSrc === workerMatSrc, 'TOP-09d 渲染后 materializations source adapter == worker（同一 bytes 可见）', {adapterMatSrc, workerMatSrc});
  ok(
    worker.environment?.ZHIYING_ACTIVE_REGISTRY_ROOT === '/app/data/registry' &&
      worker.environment?.ZHIYING_ACTIVE_REGISTRY_PATH === '/app/data/registry/voice-registry.json' &&
      worker.environment?.ZHIYING_LEGACY_VOICE_ROOT_DIR === '/voices' &&
      worker.environment?.ZHIYING_EMIT_VOICE_ROOT_PATH === '/voices/tts-a' &&
      (worker.environment?.ADAPTER_BASE_URL ?? worker.environment?.INDEXTTS2_BASE_URL) === 'http://127.0.0.1:9880',
    'TOP-09e 渲染后 recovery env 完整且与 mounts 一致',
    worker.environment,
  );
  ok(
    adapter.environment?.ADAPTER_VOICE_REGISTRY_PATH === '/config/voice-registry.json' &&
      adapter.environment?.ADAPTER_VOICE_ROOT === '/voices',
    'TOP-09f 渲染后 adapter 固定 registry/voice-root 保持',
  );
  ok(
    !(adapter.volumes ?? []).some((v) => v.target === '/config/voice-registry.json'),
    'TOP-09g 渲染后无 single-file registry volume target',
  );
  // TOP-06c 无 docker.sock / 无 privileged / 无 rootfs 放宽（resolved config 为准）
  ok(
    adapter.privileged !== true && worker.privileged !== true && cfg.services['zhiying-web']!.privileged !== true,
    'TOP-06c 渲染后三个 service 均无 privileged',
  );
  ok(
    !(adapter.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock')) &&
      !(worker.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock')) &&
      !(cfg.services['zhiying-web']!.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock')),
    'TOP-06d 渲染后无 docker.sock volume',
  );

  summary('TTS-C.1A compose-mounts');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

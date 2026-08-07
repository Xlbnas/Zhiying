/**
 * TTS-C.1A.R1 + TTS-C.1B.3.R1 compose mount 契约。
 *
 * R1 修复（Topology-Specific Review FAIL 关闭项）：
 *   P1-1 adapter /voices + /voices/tts-a nested bind 导致 path shadowing /
 *        cross-container source identity 漂移 → single unified host voice root：
 *        ${ZHIYING_HOST_VOICES_DIR}/ 含 legacy 平铺文件 + tts-a/（materialization root）；
 *        adapter 只有一个 /voices:ro mount，无任何 /voices child bind；
 *        materialization host source 派生自同一 voice root（/tts-a），无独立可漂移 source。
 *   P1-2 worker registry target /app/data/registry 与 /app/data 重叠 → 独立 /registry。
 *   P1-3 empty-publication no-op proof 见 scripts/test-tts-c1b3-activation-recovery.ts G0。
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
interface ComposeService {environment?: Record<string, string>; volumes?: ComposeVolume[]; privileged?: boolean; read_only?: boolean}
interface ComposeConfig {services: Record<string, ComposeService>}

function renderComposeConfig(): ComposeConfig {
  const envFile = path.join(os.tmpdir(), `tts-c1a-compose-topology-r1-${process.pid}.env`);
  fs.writeFileSync(envFile, [
    'DEEPSEEK_API_KEY=test-dummy-not-a-real-key',
    'ZHIYING_HOST_DATA_DIR=/tmp/zhiying-data',
    'ZHIYING_HOST_PUBLIC_DIR=/tmp/zhiying-public',
    'ZHIYING_HOST_VOICES_DIR=/tmp/zhiying-voices',
    'ZHIYING_HOST_REGISTRY_DIR=/tmp/zhiying-registry',
    'ZHIYING_HOST_ASSETS_DIR=/tmp/zhiying-assets',
    'ZHIYING_RELEASE_TAG=topology-r1-review-tag',
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

  // ── 1A 保留：env fail-closed + Web/Worker materialization 分离 ──
  ok(compose.includes('${ZHIYING_HOST_VOICES_DIR:?ZHIYING_HOST_VOICES_DIR required}/tts-a'), 'CM-01 materialization source 派生自 voice root/tts-a（:? 强制）');
  ok(!compose.includes('ZHIYING_HOST_MATERIALIZATIONS_DIR'), 'CM-01b 独立 materializations env 已移除（单一 source of truth）');

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

  const adapterBlock = compose.split('\n  indextts2-adapter:')[1] ?? '';
  ok(!adapterBlock.includes('/app/data/voice-materializations'), 'CM-04 adapter 无 /app/data 暴露');

  ok(compose.split('zhiying-web:')[1].split('zhiying-worker:')[0].includes('${ZHIYING_HOST_DATA_DIR:?ZHIYING_HOST_DATA_DIR required}:/app/data\n'), 'CM-05 Web /app/data 主挂载保留 rw');
  ok(workerBlock.includes('${ZHIYING_HOST_DATA_DIR:?ZHIYING_HOST_DATA_DIR required}:/app/data'), 'CM-05b Worker /app/data 主挂载保留 rw');

  const webDataIdx = webBlock.indexOf(':/app/data\n');
  const webMatIdx = webBlock.indexOf(':/app/data/voice-materializations');
  ok(webDataIdx !== -1 && webMatIdx > webDataIdx, 'CM-06 子路径挂载在 data 之后（覆盖生效）', {dataIdx: webDataIdx, matIdx: webMatIdx});

  // ── P1-1：single unified host voice root；无 /voices child bind ──

  // TOP-R1-01 adapter 只有一个 /voices mount（渲染级；文本辅助）
  ok(
    adapterBlock.includes('${ZHIYING_HOST_VOICES_DIR:?ZHIYING_HOST_VOICES_DIR required}:/voices:ro'),
    'TOP-R1-01 adapter 唯一 voice mount ${ZHIYING_HOST_VOICES_DIR}:/voices:ro',
  );
  ok(!adapterBlock.includes('/voices/tts-a'), 'TOP-R1-01b adapter 不再有 /voices/tts-a child mount');

  // TOP-R1-02 adapter 无任何 target=/voices/* child volume（渲染级）
  const cfg = renderComposeConfig();
  const worker = cfg.services['zhiying-worker']!;
  const web = cfg.services['zhiying-web']!;
  const adapter = cfg.services['indextts2-adapter']!;
  const adapterVoiceMounts = (adapter.volumes ?? []).filter((v) => v.target === '/voices' || v.target.startsWith('/voices/'));
  ok(
    adapterVoiceMounts.length === 1 && adapterVoiceMounts[0]!.target === '/voices' && adapterVoiceMounts[0]!.read_only === true,
    'TOP-R1-02 渲染后 adapter 恰好一个 /voices mount（无 child）',
    adapterVoiceMounts.map((v) => `${v.source}->${v.target}${v.read_only ? ':ro' : ':rw'}`),
  );

  // TOP-R1-03 worker /voices source == adapter /voices source
  const workerVoicesSrc = (worker.volumes ?? []).find((v) => v.target === '/voices')?.source;
  const adapterVoicesSrc = adapterVoiceMounts[0]?.source;
  ok(
    workerVoicesSrc !== undefined && workerVoicesSrc === adapterVoicesSrc,
    'TOP-R1-03 worker /voices source == adapter /voices source',
    {workerVoicesSrc, adapterVoicesSrc},
  );

  // TOP-R1-04 materialization host source == voice-root/tts-a（worker + web）
  const workerMatSrc = (worker.volumes ?? []).find((v) => v.target === '/app/data/voice-materializations')?.source;
  const webMatSrc = (web.volumes ?? []).find((v) => v.target === '/app/data/voice-materializations')?.source;
  const expectedMatSrc = adapterVoicesSrc !== undefined ? `${adapterVoicesSrc}/tts-a` : undefined;
  ok(
    workerMatSrc !== undefined && workerMatSrc === expectedMatSrc && webMatSrc === expectedMatSrc,
    'TOP-R1-04 materialization host source == voice-root/tts-a（worker rw + web ro 同一 source）',
    {workerMatSrc, webMatSrc, expectedMatSrc},
  );

  // TOP-R1-05 emitted /voices/tts-a/<rel> 映射到同一 host tree
  ok(
    workerBlock.includes('ZHIYING_EMIT_VOICE_ROOT_PATH: /voices/tts-a'),
    'TOP-R1-05 ZHIYING_EMIT_VOICE_ROOT_PATH=/voices/tts-a（registry 文档前缀）',
  );
  ok(
    worker.environment?.ZHIYING_EMIT_VOICE_ROOT_PATH === '/voices/tts-a' && adapterVoicesSrc !== undefined,
    'TOP-R1-05b 渲染后 emit 前缀与 adapter voice mount source 一致（/voices/tts-a/<rel> == voice-root/tts-a/<rel>）',
  );

  // ── P1-2：registry target 独立于 /app/data ──

  // TOP-R1-06 worker registry target=/registry（独立路径）
  ok(
    workerBlock.includes('${ZHIYING_HOST_REGISTRY_DIR:?ZHIYING_HOST_REGISTRY_DIR required}:/registry:rw'),
    'TOP-R1-06 worker registry mount :rw（/registry 独立 target）',
  );

  // TOP-R1-07 registry target 不是 /app/data 的 descendant，且不与任何 worker volume target 重叠
  const registryMount = (worker.volumes ?? []).find((v) => v.target === '/registry');
  const allWorkerTargets = (worker.volumes ?? []).map((v) => v.target);
  const overlaps = allWorkerTargets.filter((t) => t !== '/registry' && (t.startsWith('/registry/') || '/registry'.startsWith(`${t}/`) || t === '/registry'));
  ok(
    registryMount !== undefined && (registryMount.read_only ?? false) === false &&
      !registryMount.target.startsWith('/app/data/') && !allWorkerTargets.some((t) => t !== '/registry' && (t.startsWith('/registry/') || '/registry'.startsWith(`${t}/`))),
    'TOP-R1-07 worker registry target=/registry 独立（非 /app/data descendant，无重叠）',
    {registryTarget: registryMount?.target, allWorkerTargets, overlaps},
  );
  ok(
    worker.environment?.ZHIYING_ACTIVE_REGISTRY_ROOT === '/registry' &&
      worker.environment?.ZHIYING_ACTIVE_REGISTRY_PATH === '/registry/voice-registry.json',
    'TOP-R1-09 recovery env 与新 registry target 精确一致（/registry）',
  );

  // ── 保持已通过部分 ──
  // registry worker/adapter source identity（同一 env）
  ok(
    (compose.match(/\$\{ZHIYING_HOST_REGISTRY_DIR:\?ZHIYING_HOST_REGISTRY_DIR required\}/g) ?? []).length >= 2,
    'TOP-03 worker 与 adapter 的 registry source 同一 env（出现 ≥2 处）',
  );
  ok(
    !compose.includes('ZHIYING_HOST_VOICE_REGISTRY'),
    'TOP-03b 旧 single-file env（ZHIYING_HOST_VOICE_REGISTRY）已移除',
  );
  ok(
    workerBlock.includes('${ZHIYING_HOST_VOICES_DIR:?ZHIYING_HOST_VOICES_DIR required}:/voices:ro') &&
      workerBlock.includes('ZHIYING_LEGACY_VOICE_ROOT_DIR: /voices'),
    'TOP-04 worker legacy voices :ro + ZHIYING_LEGACY_VOICE_ROOT_DIR 一致',
  );
  ok(
    workerBlock.includes('/app/data/voice-materializations:rw') && workerBlock.includes('/registry:rw') &&
      !workerBlock.includes('/registry:ro'),
    'TOP-06a worker registry rw / materializations rw',
  );
  ok(
    adapterBlock.includes('/config:ro') && adapterBlock.includes('/voices:ro') &&
      !adapterBlock.includes('/config:rw'),
    'TOP-06b adapter registry/voices 全 ro',
  );
  ok(
    adapter.privileged !== true && worker.privileged !== true && web.privileged !== true,
    'TOP-06c 渲染后三个 service 均无 privileged',
  );
  ok(
    !(adapter.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock')) &&
      !(worker.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock')) &&
      !(web.volumes ?? []).some((v) => (v.source ?? '').includes('docker.sock')),
    'TOP-06d 渲染后无 docker.sock volume',
  );
  ok(adapter.read_only === true, 'TOP-06e adapter rootfs read_only');
  ok(
    !compose.includes('/config/voice-registry.json:ro') && !compose.includes('/config/voice-registry.json:rw'),
    'TOP-07 无 single-file registry bind（/config/voice-registry.json 不是 volume target）',
  );
  ok(
    !(adapter.volumes ?? []).some((v) => v.target === '/config/voice-registry.json'),
    'TOP-08 渲染后无 single-file registry volume target',
  );
  for (const key of ['ZHIYING_ACTIVE_REGISTRY_PATH', 'ZHIYING_ACTIVE_REGISTRY_ROOT', 'ZHIYING_LEGACY_VOICE_ROOT_DIR', 'ZHIYING_EMIT_VOICE_ROOT_PATH']) {
    ok(workerBlock.includes(`${key}: `), `TOP-08b ${key} 已显式配置`);
  }
  ok(
    worker.environment?.INDEXTTS2_BASE_URL === 'http://127.0.0.1:9880' ||
      worker.environment?.ADAPTER_BASE_URL === 'http://127.0.0.1:9880',
    'TOP-08c adapter URL 走本机既有 INDEXTTS2_BASE_URL / ADAPTER_BASE_URL',
  );

  // ── TOP-R1-10 compose config resolved proof（渲染成功 + resolved volumes/env）──
  const hasMount = (s: ComposeService, target: string, ro: boolean): boolean =>
    (s.volumes ?? []).some((v) => v.target === target && (v.read_only ?? false) === ro);
  ok(
    hasMount(adapter, '/config', true) && hasMount(adapter, '/voices', true),
    'TOP-R1-10 compose render：adapter /config:ro + /voices:ro',
    (adapter.volumes ?? []).map((v) => `${v.source}->${v.target}${v.read_only ? ':ro' : ':rw'}`),
  );
  ok(
    hasMount(worker, '/registry', false) && hasMount(worker, '/voices', true) &&
      hasMount(worker, '/app/data/voice-materializations', false),
    'TOP-R1-10b compose render：worker /registry:rw + /voices:ro + materializations:rw',
    (worker.volumes ?? []).map((v) => `${v.source}->${v.target}${v.read_only ? ':ro' : ':rw'}`),
  );
  const workerRegSrc = (worker.volumes ?? []).find((v) => v.target === '/registry')?.source;
  const adapterRegSrc = (adapter.volumes ?? []).find((v) => v.target === '/config')?.source;
  ok(workerRegSrc !== undefined && workerRegSrc === adapterRegSrc, 'TOP-R1-10c 渲染后 registry source worker == adapter', {workerRegSrc, adapterRegSrc});
  ok(
    worker.environment?.ZHIYING_ACTIVE_REGISTRY_ROOT === '/registry' &&
      worker.environment?.ZHIYING_ACTIVE_REGISTRY_PATH === '/registry/voice-registry.json' &&
      worker.environment?.ZHIYING_LEGACY_VOICE_ROOT_DIR === '/voices' &&
      worker.environment?.ZHIYING_EMIT_VOICE_ROOT_PATH === '/voices/tts-a',
    'TOP-R1-10d 渲染后 recovery env 完整且与 mounts 一致',
    worker.environment,
  );
  ok(
    adapter.environment?.ADAPTER_VOICE_REGISTRY_PATH === '/config/voice-registry.json' &&
      adapter.environment?.ADAPTER_VOICE_ROOT === '/voices',
    'TOP-R1-10e 渲染后 adapter 固定 registry/voice-root 保持',
  );

  summary('TTS-C.1A compose-mounts');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

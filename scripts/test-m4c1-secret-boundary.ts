/**
 * M4-C1A-S secret boundary 回归测试。
 *
 * 用法：npx tsx scripts/test-m4c1-secret-boundary.ts
 *
 * 验证 Git + Docker build-context 双边界（不读取任何真实 secret）：
 *   A. git check-ignore：所有 env variant / registry / voices / _m4c1 必须
 *      ignored；.env.example / adapter example / 构建必需文件必须 NOT ignored。
 *   B. canary Docker context：临时目录 + repo .dockerignore + dummy canary
 *      secret（非真实值），FROM scratch build + docker cp 抽取，实证 canary
 *      不进入 build context。
 * 测试结束清理全部临时文件/容器/镜像。
 */

import {execFileSync, spawnSync} from 'node:child_process';
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

function gitIgnored(relPath: string): boolean {
  const r = spawnSync('git', ['check-ignore', '-q', '--no-index', relPath], {encoding: 'utf8'});
  return r.status === 0;
}

const SUFFIX = String(process.pid);
const CANARY_IMAGE = `m4c1-canary-${SUFFIX}`;
const CANARY_CONTAINER = `m4c1-canary-${SUFFIX}`;

function docker(args: string[]): {code: number; out: string} {
  const r = spawnSync('docker', args, {encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024});
  return {code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`};
}

function main(): void {
  // ---------- A. Git ignore 边界 ----------
  const mustIgnore = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
    '.env.development',
    '.env.test.local',
    'API-KEY.env',
    'voice-registry.json',
    'voices/default-v1.wav',
    '_m4c1/tts-stack.docker-compose.proposed.yml',
  ];
  for (const p of mustIgnore) {
    ok(gitIgnored(p), `G01 git ignored: ${p}`);
  }
  const mustNotIgnore = [
    '.env.example',
    'services/indextts2-api-adapter/voice-registry.example.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'src/lib/db.ts',
  ];
  for (const p of mustNotIgnore) {
    ok(!gitIgnored(p), `G02 git NOT ignored: ${p}`);
  }

  // ---------- B. Canary Docker build-context 边界 ----------
  const info = docker(['info', '--format', '{{.ServerVersion}}']);
  if (info.code !== 0) {
    ok(false, 'D00 docker daemon 可用', info.out.slice(-200));
    console.log(`\nM4-C1 secret-boundary: ${pass} PASS, ${fail} FAIL`);
    process.exitCode = 1;
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `m4c1-boundary-${SUFFIX}-`));
  const ctx = path.join(tmp, 'ctx');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(ctx, {recursive: true});
  fs.mkdirSync(outDir, {recursive: true});
  try {
    // canary 文件（dummy 值，绝非真实 secret）
    const canaryFiles: Record<string, string> = {
      '.env': 'DUMMY_CANARY=canary\n',
      '.env.local': 'DUMMY_CANARY=canary\n',
      '.env.production': 'DUMMY_CANARY_SECRET=canary-value-not-real\n',
      '.env.production.local': 'DUMMY_CANARY=canary\n',
      '.env.development': 'DUMMY_CANARY=canary\n',
      '.env.test.local': 'DUMMY_CANARY=canary\n',
      'API-KEY.env': 'DUMMY_CANARY=canary\n',
      '.env.example': 'TEMPLATE_OK=1\n',
      'voice-registry.json': '{"canary":true}\n',
      'voices/default-v1.wav': 'CANARYAUDIO',
      '_m4c1/proposed.yml': 'canary: true\n',
      'keep.txt': 'keep\n',
    };
    for (const [rel, content] of Object.entries(canaryFiles)) {
      const abs = path.join(ctx, rel);
      fs.mkdirSync(path.dirname(abs), {recursive: true});
      fs.writeFileSync(abs, content);
    }
    // 使用 repo 当前 .dockerignore
    fs.copyFileSync(path.resolve('.dockerignore'), path.join(ctx, '.dockerignore'));
    fs.writeFileSync(path.join(ctx, 'Dockerfile.canary'), 'FROM scratch\nCOPY . /ctx\nCMD ["/bin/false"]\n');

    const build = docker(['build', '-f', path.join(ctx, 'Dockerfile.canary'), '-t', CANARY_IMAGE, ctx]);
    ok(build.code === 0, 'D01 canary context build 成功（FROM scratch，无网络）', build.code !== 0 ? build.out.slice(-300) : undefined);
    if (build.code === 0) {
      const create = docker(['create', '--name', CANARY_CONTAINER, CANARY_IMAGE]);
      ok(create.code === 0, 'D02a canary container create 成功', create.code !== 0 ? create.out.slice(-200) : undefined);
      const cp = docker(['cp', `${CANARY_CONTAINER}:/ctx`, outDir]);
      ok(cp.code === 0, 'D02 docker cp 抽取 context 成功', cp.code !== 0 ? cp.out.slice(-200) : undefined);
      const extracted = path.join(outDir, 'ctx');
      const seen = new Set<string>();
      const walk = (dir: string, prefix: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          seen.add(rel);
          if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
        }
      };
      walk(extracted, '');
      const canaryMustAbsent = [
        '.env', '.env.local', '.env.production', '.env.production.local',
        '.env.development', '.env.test.local', 'API-KEY.env',
        'voice-registry.json', 'voices', 'voices/default-v1.wav', '_m4c1', '_m4c1/proposed.yml',
      ];
      for (const p of canaryMustAbsent) {
        ok(!seen.has(p), `D03 build context 不含: ${p}`);
      }
      ok(seen.has('.env.example'), 'D04 build context 保留 .env.example');
      ok(seen.has('keep.txt'), 'D05 build context 保留普通文件 keep.txt');
      // canary secret 值绝不出现
      const leaked = [...seen].some((p) => p.includes('canary-value'));
      ok(!leaked, 'D06 canary secret 未出现在 context 文件路径');
      const exampleContent = fs.existsSync(path.join(extracted, '.env.example'))
        ? fs.readFileSync(path.join(extracted, '.env.example'), 'utf8')
        : '';
      ok(exampleContent.includes('TEMPLATE_OK'), 'D07 .env.example 内容完整（模板可用）');
    }
  } finally {
    docker(['rm', '-f', CANARY_CONTAINER]);
    docker(['rmi', '-f', CANARY_IMAGE]);
    fs.rmSync(tmp, {recursive: true, force: true});
  }

  console.log(`\nM4-C1 secret-boundary: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();

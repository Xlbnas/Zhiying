/**
 * M4-C1B0-R admin deploy scripts 静态安全测试。
 *
 * 用法：npx tsx scripts/test-m4c1-admin-scripts.ts
 * 只读检查 scripts/deploy/m4c1/ 三个脚本与 proposed compose，
 * 不执行任何脚本、不触 Docker。任一断言失败即非零退出。
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('scripts', 'deploy', 'm4c1');
const DIAG = path.join(DIR, 'diagnose-indextts2-network.sh');
const APPLY = path.join(DIR, 'apply-indextts2-bridge.sh');
const ROLLBACK = path.join(DIR, 'rollback-indextts2-bridge.sh');
const PROPOSED = path.join(DIR, 'tts-stack.docker-compose.proposed.yml');

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

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function main(): void {
  for (const p of [DIAG, APPLY, ROLLBACK, PROPOSED]) {
    ok(fs.existsSync(p), `S01 tracked 存在: ${path.basename(p)}`);
  }

  const diag = read(DIAG);
  const apply = read(APPLY);
  const rollback = read(ROLLBACK);
  const proposed = read(PROPOSED);
  const all = [diag, apply, rollback];

  // ---- 基本纪律 ----
  for (const [name, content] of [['diagnose', diag], ['apply', apply], ['rollback', rollback]] as const) {
    ok(content.includes('set -euo pipefail'), `S02 ${name}: set -euo pipefail`);
  }
  // ---- 无 secret 字面量 ----
  for (const [name, content] of [['diagnose', diag], ['apply', apply], ['rollback', rollback], ['proposed', proposed]] as const) {
    ok(
      !/sk-[A-Za-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY|password\s*=|token\s*=|DEEPSEEK_API_KEY=.+/.test(content),
      `S03 ${name}: 无 secret 字面量`,
    );
  }
  // ---- 危险操作缺席 ----
  for (const [name, content] of [['diagnose', diag], ['apply', apply], ['rollback', rollback]] as const) {
    ok(!/rm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r/.test(content), `S04 ${name}: 无 rm -rf`);
    ok(!content.includes('docker system prune'), `S05 ${name}: 无 docker system prune`);
    ok(!/\biptables\b|\bnft\b|firewall-cmd/.test(content), `S06 ${name}: 无 firewall 修改`);
    ok(!/privileged/.test(content), `S07 ${name}: 无 privileged`);
    ok(!content.includes('cat .env.production') && !content.includes('cat /vol1/1000/docker/zhiying/.env.production'), `S08 ${name}: 不读 .env.production`);
    ok(!/docker compose (up|down)(?!.*--no-deps)/.test(content.replace(/docker compose up -d --no-deps indextts2/g, '')), `S09 ${name}: compose 操作仅限 --no-deps indextts2`);
  }

  // ---- diagnose 只读性 ----
  ok(!/docker (stop|restart|kill|rm|compose up|compose down|network create|network rm)\b/.test(diag.replace(/docker run --rm/g, '')), 'S10 diagnose: 无 stop/restart/recreate/network 修改');
  ok((diag.match(/docker run --rm/g) ?? []).length >= 4, 'S11 diagnose: ephemeral 测试容器 >= 4（B/C/D/E）');
  ok(diag.includes('--network none'), 'S12 diagnose: Test E 使用 --network none');
  ok(diag.includes('UV_NO_SYNC=1') && diag.includes('UV_OFFLINE=1'), 'S13 diagnose: Test E 注入 UV_NO_SYNC + UV_OFFLINE');
  ok(diag.includes('OFFLINE_IMPORT_OK'), 'S14 diagnose: Test E 断言 OFFLINE_IMPORT_OK');
  ok(diag.includes('127.0.0.1:7890'), 'S15 diagnose: Test D 复现 localhost proxy 根因');

  // ---- proposed compose 内容 ----
  ok(proposed.includes('UV_NO_SYNC: "1"'), 'S20 proposed: UV_NO_SYNC=1');
  ok(proposed.includes('UV_OFFLINE: "1"'), 'S21 proposed: UV_OFFLINE=1');
  ok(!proposed.includes('network_mode: host') || (proposed.match(/network_mode: host/g) ?? []).length === 2, 'S22 proposed: indextts2 不再 network_mode: host（仅 qwen/cosyvoice 保留）');
  ok(proposed.includes('zhiying-tts-net'), 'S23 proposed: 挂 zhiying-tts-net');
  ok(proposed.includes('"127.0.0.1:8002:8002"'), 'S24 proposed: 8002 仅 loopback 发布');
  ok(proposed.includes('"7870:7870"'), 'S25 proposed: 7870 维持现状');
  ok(proposed.includes('start_period: 600s'), 'S26 proposed: health start_period=600s');
  ok(proposed.includes('./outputs/index:/app/outputs'), 'S27 proposed: outputs/speaker cache volume 保持');
  ok(proposed.includes('gpus: all'), 'S28 proposed: GPU 配置保持');
  ok(proposed.includes('qwen3-tts') && proposed.includes('cosyvoice3'), 'S29 proposed: qwen/cosyvoice 未删改');

  // ---- apply 纪律 ----
  ok(apply.includes('id -u') && apply.includes('exit 1'), 'S30 apply: root precheck');
  ok(apply.includes('EXPECTED_FORMAL_SHA') && apply.includes('EXPECTED_PROPOSED_SHA'), 'S31 apply: 双 SHA precheck');
  ok(apply.includes('.last-indextts2-backup'), 'S32 apply: backup path state file');
  ok(apply.includes('docker compose up -d --no-deps indextts2'), 'S33 apply: 仅 recreate indextts2');
  ok(apply.includes('READINESS_DEADLINE=900'), 'S34 apply: readiness deadline=900s');
  ok(apply.includes('HOST_SIDE_PASS') && apply.includes('LAN_ACCEPTANCE_PENDING'), 'S35 apply: 结束语诚实（不自宣最终 PASS）');
  ok(!/qwen3-tts|cosyvoice3/.test(apply.replace(/不动 qwen\/cosyvoice/g, '')), 'S36 apply: 不触碰 qwen/cosyvoice');

  // ---- rollback 纪律 ----
  ok(rollback.includes('.last-indextts2-backup'), 'S40 rollback: 读精确 backup state file');
  ok(!/\.bak-[a-z0-9-]*\*/.test(rollback), 'S41 rollback: 无 wildcard backup glob');
  ok(rollback.includes('docker compose up -d --no-deps indextts2'), 'S42 rollback: 仅 recreate indextts2');
  ok(rollback.includes('READINESS_DEADLINE=900'), 'S43 rollback: readiness deadline=900s');
  ok(rollback.includes('0.0.0.0:8002') && rollback.includes('0.0.0.0:7870'), 'S44 rollback: 验证 host-network 端口形态恢复');

  console.log(`\nM4-C1 admin-scripts: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();

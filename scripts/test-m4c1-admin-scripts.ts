/**
 * M4-C1B2-R5A admin deploy scripts 静态安全测试。
 *
 * 用法：npx tsx scripts/test-m4c1-admin-scripts.ts
 * 只读检查 scripts/deploy/m4c1/ 四个脚本 + proposed compose + semantic gate，
 * 不执行任何脚本、不触 Docker。任一断言失败即非零退出（fail-closed）。
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('scripts', 'deploy', 'm4c1');
const DIAG = path.join(DIR, 'diagnose-indextts2-network.sh');
const APPLY = path.join(DIR, 'apply-indextts2-bridge.sh');
const ROLLBACK = path.join(DIR, 'rollback-indextts2-bridge.sh');
const PREFLIGHT = path.join(DIR, 'preflight-indextts2-hf-cache.sh');
const PROPOSED = path.join(DIR, 'tts-stack.docker-compose.proposed.yml');
const GATE = path.join(DIR, 'semantic-compose-gate.py');

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
  for (const p of [DIAG, APPLY, ROLLBACK, PREFLIGHT, PROPOSED, GATE]) {
    ok(fs.existsSync(p), `S01 tracked 存在: ${path.basename(p)}`);
  }

  const diag = read(DIAG);
  const apply = read(APPLY);
  const rollback = read(ROLLBACK);
  const preflight = read(PREFLIGHT);
  const proposed = read(PROPOSED);
  const gate = read(GATE);

  // ---- 基本纪律 ----
  for (const [name, content] of [['diagnose', diag], ['apply', apply], ['rollback', rollback]] as const) {
    ok(content.includes('set -euo pipefail'), `S02 ${name}: set -euo pipefail`);
  }
  // ---- 无 secret 字面量 ----
  for (const [name, content] of [['diagnose', diag], ['apply', apply], ['rollback', rollback], ['preflight', preflight], ['proposed', proposed], ['gate', gate]] as const) {
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
  ok((diag.match(/docker run --rm/g) ?? []).length >= 4, 'S11 diagnose: ephemeral 测试容器 >= 4（C/D/E）');
  ok(diag.includes('--network none'), 'S12 diagnose: Test E 使用 --network none');
  ok(diag.includes('127.0.0.1:7890'), 'S13 diagnose: Test D 复现 localhost proxy 根因');
  ok(!diag.includes('docker pull'), 'S14 diagnose: 禁止 pull image');

  // ---- R2 diagnose：image 来源 / pull 策略 / proxy 证据来源 ----
  ok(diag.includes("{{.Config.Image}}") && diag.includes('docker inspect'), 'R2-D01 diagnose: IMG 来自 docker inspect indextts2');
  ok(!/IMG="neosun/.test(diag), 'R2-D02 diagnose: 无硬编码 image tag');
  const runCount = (diag.match(/docker run /g) ?? []).length;
  const pullNeverCount = (diag.match(/docker run --rm --pull=never/g) ?? []).length;
  ok(runCount > 0 && runCount === pullNeverCount, 'R2-D03 diagnose: 所有 docker run 均 --pull=never', { runCount, pullNeverCount });
  ok(diag.includes('--entrypoint bash'), 'R2-D04 diagnose: ephemeral 使用 --entrypoint bash');
  ok(diag.includes('{{range .Config.Env}}'), 'R2-D05 diagnose: proxy 证据来自 indextts2 容器 env');
  ok(diag.includes('REDACTED'), 'R2-D06 diagnose: credential REDACT 逻辑存在');
  ok(diag.includes('NetworkMode') && diag.includes('"host"'), 'R2-D07 diagnose: Test A 校验 NetworkMode=host');
  ok(diag.includes('spk_73d01a47_emb.pkl') && diag.includes('spk_73d01a47.wav') && diag.includes('index.json'), 'R2-D08 diagnose: Test A 校验 speaker cache 三文件');
  ok(diag.includes('nvidia-smi'), 'R2-D09 diagnose: Test A 校验 GPU');
  ok(diag.includes('docker network inspect') && !diag.includes('docker network create'), 'R2-D10 diagnose: network 只 inspect 不 create');

  // ---- R2 diagnose：Test D exit-code 语义 ----
  ok(!diag.includes('|| echo REFUSED'), 'R2-D11 diagnose: Test D 无字符串拼接判断（|| echo REFUSED）');
  ok(diag.includes('EXPECTED_FAILURE_CONFIRMED'), 'R2-D12 diagnose: Test D exit-code 预期失败语义');

  // ---- R2 diagnose：Test E fail-closed（真实 exit code + marker 双条件） ----
  const eBlock = diag.slice(diag.indexOf('# Test E begin'), diag.indexOf('# Test E end'));
  ok(eBlock.length > 0, 'R2-D13 diagnose: Test E block 标记存在');
  ok(!eBlock.includes('|| true'), 'R2-D14 diagnose: Test E 不得 || true 吞 exit code');
  ok(eBlock.includes('e_rc=$?'), 'R2-D15 diagnose: Test E 捕获真实 exit code');
  ok(eBlock.includes('UV_NO_SYNC=1') && eBlock.includes('UV_OFFLINE=1'), 'R2-D16 diagnose: Test E 注入 UV_NO_SYNC + UV_OFFLINE');
  ok(eBlock.includes('OFFLINE_IMPORT_OK') && eBlock.includes('[ "$e_rc" -eq 0 ]'), 'R2-D17 diagnose: Test E rc==0 且 marker 双条件');

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
  ok(!proposed.includes('runtime 完全 offline'), 'R2-P01 proposed: 无「runtime 完全 offline」不准确表述');
  ok(proposed.includes('uv runtime dependency resolution offline'), 'R2-P02 proposed: 准确表述 uv runtime dependency resolution offline');
  ok(!/^[ \t]+command:/m.test(proposed), 'R3-P01 proposed: indextts2 无 command override（正式 compose 亦未声明，image-default CMD）');

  // ---- apply 纪律 ----
  ok(apply.includes('id -u') && apply.includes('fail 1 "需要 root 执行"'), 'S30 apply: root precheck（fail-closed）');
  ok(apply.includes('EXPECTED_FORMAL_SHA') && apply.includes('EXPECTED_PROPOSED_SHA'), 'S31 apply: 双 SHA precheck');
  ok(apply.includes('.last-indextts2-backup'), 'S32 apply: backup path state file');
  ok(apply.includes('docker compose up -d --no-deps indextts2'), 'S33 apply: 仅 recreate indextts2');
  ok(apply.includes('READINESS_DEADLINE=900'), 'S34 apply: readiness deadline=900s');
  ok(apply.includes('HOST_SIDE_PASS') && apply.includes('LAN_ACCEPTANCE_PENDING'), 'S35 apply: 结束语诚实（不自宣最终 PASS）');
  ok(!/qwen3-tts|cosyvoice3/.test(apply.replace(/不动 qwen\/cosyvoice/g, '')), 'S36 apply: 不触碰 qwen/cosyvoice');

  // ---- R2 apply：semantic diff gate ----
  ok(apply.includes('config --format json'), 'R2-A01 apply: 使用 config --format json normalize');
  ok(apply.includes('semantic-compose-gate.py') && apply.includes('python3 "$GATE_PY"'), 'R2-A02 apply: 调用 python3 semantic gate');
  ok(apply.includes('SEMANTIC_DIFF_GATE'), 'R2-A03 apply: SEMANTIC_DIFF_GATE 输出语义');
  ok(apply.includes('mktemp') && apply.includes('rm -f "$CUR_JSON"'), 'R2-A04 apply: normalized JSON 用 mktemp 且退出 cleanup');
  const iGate = apply.indexOf('STAGE="semantic-diff-gate"');
  const iBackup = apply.indexOf('STAGE="backup-formal-compose"');
  const iReplace = apply.indexOf('STAGE="replace-formal-compose"');
  const iRecreate = apply.indexOf('STAGE="recreate-indextts2"');
  ok(iGate > -1 && iGate < iBackup && iBackup < iReplace && iReplace < iRecreate, 'R2-A05 apply 顺序: gate < backup < replace < recreate');
  ok(apply.includes('trap on_err ERR') && apply.includes('FAILED_STAGE=$STAGE'), 'R2-A06 apply: ERR trap + FAILED_STAGE');
  ok(apply.includes('BACKUP=${BACKUP:-NOT_CREATED}') && apply.includes('ROLLBACK_SCRIPT=$ROLLBACK_SCRIPT'), 'R2-A07 apply: 失败报告 BACKUP/ROLLBACK_SCRIPT');
  ok(apply.includes('docker logs --tail 60 indextts2') && apply.includes('RECREATE_STARTED'), 'R2-A08 apply: recreate 后失败输出 logs tail 60');
  ok(apply.includes('exit "$rc"'), 'R2-A09 apply: trap 不隐藏原 exit code');
  ok(!apply.includes('rollback-indextts2-bridge.sh &&') && !/bash .*rollback/.test(apply), 'R2-A10 apply: 不自动执行 rollback');
  ok(apply.indexOf('config --format json') < apply.indexOf('cp -a "$FORMAL" "$BACKUP"'), 'R2-A11 apply: normalize/gate 早于首个 production file mutation');

  // ---- R2 semantic gate 脚本内容 ----
  ok(gate.includes('qwen3-tts') && gate.includes('cosyvoice3'), 'R2-G01 gate: qwen/cosyvoice deep equality 校验');
  ok(gate.includes('check_untouched') && gate.includes('deep equality'), 'R2-G02 gate: untouched service 零 delta');
  for (const f of ['image', 'container_name', 'command', 'entrypoint', 'restart', 'volumes', 'shm_size', 'working_dir', 'user', 'build']) {
    ok(gate.includes(`"${f}"`), `R2-G03 gate: indextts2 immutable 字段 ${f}`);
  }
  ok(gate.includes('UV_NO_SYNC') && gate.includes('UV_OFFLINE'), 'R2-G04 gate: environment delta whitelist');
  ok(gate.includes('zhiying-tts-net') && gate.includes('network_mode'), 'R2-G05 gate: network delta whitelist');
  ok(gate.includes('127.0.0.1') && gate.includes('0.0.0.0'), 'R2-G06 gate: 8002 loopback 发布约束');
  ok(gate.includes('127.0.0.1:8002/health') && gate.includes('start_period'), 'R2-G07 gate: healthcheck 约束');
  ok(gate.includes('SEMANTIC_DIFF_GATE=PASS') && gate.includes('SEMANTIC_DIFF_GATE=FAIL'), 'R2-G08 gate: PASS/FAIL 输出');
  ok(gate.includes('external') && gate.includes('"name"'), 'R2-G09 gate: top-level external network 约束');

  // ---- R3 apply：fail() expected-failure handler ----
  ok(/fail\(\) \{/.test(apply), 'R3-A01 apply: fail() helper 存在');
  ok(apply.includes('report_failure') && apply.includes('FAILED_STAGE=$STAGE') && apply.includes('BACKUP=${BACKUP:-NOT_CREATED}'), 'R3-A02 apply: fail 路径统一输出 FAILED_STAGE/BACKUP/ROLLBACK_SCRIPT');
  const failCalls = (apply.match(/fail 1 "/g) ?? []).length;
  ok(failCalls >= 12, 'R3-A03 apply: expected 检查失败均走 fail()', { failCalls });
  const readinessBlock = apply.slice(apply.indexOf('STAGE="readiness-wait"'), apply.indexOf('STAGE="post-verify"'));
  ok(readinessBlock.includes('fail 1 "超过 ${READINESS_DEADLINE}s 未 healthy"'), 'R3-A04 apply: readiness timeout 调 fail()');
  ok(!/[^"]exit 1/.test(readinessBlock), 'R3-A05 apply: readiness block 无直接 exit 1');
  const postBlock = apply.slice(apply.indexOf('STAGE="post-verify"'));
  ok(postBlock.includes('fail 1 "迁移后 7870 不可用'), 'R3-A06 apply: post-recreate 7870 验证走 fail()');
  ok(apply.includes('trap on_err ERR') && apply.includes('UNEXPECTED_ERROR'), 'R3-A07 apply: ERR trap 保留（unexpected fallback）');
  ok(apply.includes('不得声明 command override'), 'R3-A08 apply: precheck 禁止 proposed command override');
  ok(!/^[ \t]+command:/m.test(apply), 'R3-A09 apply: 自身不含 command override 字面量');

  // ---- R3 gate：volumes 零 delta / networks 精确 / health 三参数 ----
  ok(gate.includes('top-level volumes 必须零 delta'), 'R3-G01 gate: top-level volumes deep equality（禁新增/删除/修改）');
  ok(gate.includes('必须精确为') && gate.includes('!= {NET_NAME}'), 'R3-G02 gate: service networks 精确等于 {zhiying-tts-net}');
  ok(gate.includes('approved=15s') && gate.includes('approved=10s') && gate.includes('approved=10）'), 'R3-G03 gate: health interval=15s/timeout=10s/retries=10 锁定');

  // ---- R3 fixture 测试接入 ----
  const FIXTURE = path.resolve('scripts', 'test-m4c1-semantic-gate.py');
  ok(fs.existsSync(FIXTURE), 'R3-T01 semantic gate fixture 测试存在');
  const ci = fs.readFileSync(path.resolve('.github', 'workflows', 'ci.yml'), 'utf8');
  ok(ci.includes('test-m4c1-semantic-gate.py'), 'R3-T02 CI 接入 semantic gate fixtures');

  // ---- R5A preflight 脚本静态安全 ----
  ok(preflight.includes('set -euo pipefail'), 'R5A-F01 preflight: set -euo pipefail');
  ok(preflight.includes('--pull=never'), 'R5A-F02 preflight: --pull=never');
  ok(preflight.includes('--network none'), 'R5A-F03 preflight: --network none');
  ok(preflight.includes('docker run --rm -i'), 'R5A-F04 preflight: --rm disposable container');
  ok(!/--gpus|gpus: all/.test(preflight), 'R5A-F05 preflight: 不使用 GPU');
  ok(preflight.includes('HF_HUB_CACHE=/app/checkpoints/hf_cache'), 'R5A-F06 preflight: HF_HUB_CACHE 指向 image-baked cache');
  ok(preflight.includes('HF_HUB_OFFLINE=1'), 'R5A-F07 preflight: HF_HUB_OFFLINE=1');
  ok(!preflight.includes('docker pull') && !preflight.includes('docker build'), 'R5A-F08 preflight: 禁止 pull/build');
  ok(!/docker compose (up|down)|docker (stop|restart|kill)\b/.test(preflight), 'R5A-F09 preflight: 不触 production container/compose');
  ok(!/(\s|^)(-v|--volume)[\s=]/.test(preflight), 'R5A-F10 preflight: 无 host HF cache mount（零 volume flag）');
  ok(preflight.includes('HF_RUNTIME_ARTIFACT_PREFLIGHT=PASS'), 'R5A-F11 preflight: 成功唯一标记');
  ok(preflight.includes('image ref 参数为空'), 'R5A-F12 preflight: image 参数 fail-closed');
  ok(!preflight.includes('HF_HUB_OFFLINE=0') && !preflight.includes('--network host'), 'R5A-F13 preflight: 无 online/host-network fallback');
  for (const item of ['amphion/MaskGCT', 'facebook/w2v-bert-2.0', 'funasr/campplus', 'nvidia/bigvgan_v2_22khz_80band_256x']) {
    ok(preflight.includes(item), `R5A-F14 preflight: 覆盖启动依赖 ${item}`);
  }
  ok(!preflight.includes('/root/.cache/huggingface"'), 'R5A-F15 preflight: 不 fallback /root/.cache/huggingface');

  // ---- R5A proposed compose HF env delta ----
  ok(proposed.includes('HF_HUB_CACHE: /app/checkpoints/hf_cache'), 'R5A-P01 proposed: HF_HUB_CACHE 指向 image-baked cache');
  ok(proposed.includes('HF_HUB_OFFLINE: "1"'), 'R5A-P02 proposed: HF_HUB_OFFLINE=1');
  const itBlock = proposed.slice(proposed.indexOf('  indextts2:'), proposed.indexOf('  cosyvoice3:'));
  ok(!/HF_HOME|HUGGINGFACE_HUB_CACHE|TRANSFORMERS_OFFLINE/.test(itBlock), 'R5A-P03 proposed: indextts2 无额外 HF env（qwen 既有 env 不受影响）');
  ok(!/- .*hf_cache/.test(itBlock), 'R5A-P04 proposed: indextts2 无 HF cache volume（零 volume delta）');

  // ---- R5A semantic gate allowlist ----
  ok(gate.includes('"HF_HUB_CACHE": "/app/checkpoints/hf_cache"') && gate.includes('"HF_HUB_OFFLINE": "1"'), 'R5A-G01 gate: R5A env allowlist 精确值锁定');

  // ---- R5A apply 集成 ----
  ok(apply.includes('PREFLIGHT="$REPO_M4C1/preflight-indextts2-hf-cache.sh"'), 'R5A-A01 apply: PREFLIGHT 脚本路径');
  ok(apply.includes('bash "$PREFLIGHT" "$PREFLIGHT_IMAGE"'), 'R5A-A02 apply: 调用 preflight 并传 image');
  ok(apply.includes('PREFLIGHT_IMAGE') && apply.includes('PROP_JSON') && apply.includes('services') && apply.includes('indextts2'), 'R5A-A03 apply: preflight image 唯一来源 PROP_JSON');
  const iPreflight = apply.indexOf('STAGE="hf-artifact-preflight"');
  const iNetwork = apply.indexOf('STAGE="network-ensure"');
  ok(
    iGate > -1 && iGate < iPreflight && iPreflight < iNetwork && iNetwork < iBackup && iBackup < iReplace && iReplace < iRecreate,
    'R5A-A04 apply 顺序: gate < preflight < network < backup < replace < recreate',
  );
  ok(apply.indexOf('STAGE="hf-artifact-preflight"') < apply.indexOf('cp -a "$FORMAL" "$BACKUP"'), 'R5A-A05 apply: preflight 早于首个 production file mutation');
  for (const e of ['UV_NO_SYNC=1', 'UV_OFFLINE=1', 'HF_HUB_CACHE=/app/checkpoints/hf_cache', 'HF_HUB_OFFLINE=1']) {
    ok(apply.includes(`"${e}"`), `R5A-A06 apply: postcheck 精确 env ${e}`);
  }
  ok(apply.includes('grep -qxF'), 'R5A-A07 apply: postcheck 精确行匹配（非模糊 grep）');
  ok(apply.includes(`grep -q 'HF_HUB_CACHE: /app/checkpoints/hf_cache' "$PROPOSED"`), 'R5A-A08 apply: precheck 校验 proposed HF_HUB_CACHE');
  ok(apply.includes(`grep -q 'HF_HUB_OFFLINE: "1"' "$PROPOSED"`), 'R5A-A09 apply: precheck 校验 proposed HF_HUB_OFFLINE');
  ok(apply.includes('[11/11]'), 'R5A-A10 apply: 阶段编号更新（HF preflight 插入）');

  // ---- rollback 纪律 ----
  ok(rollback.includes('.last-indextts2-backup'), 'S40 rollback: 读精确 backup state file');
  ok(!/\.bak-[a-z0-9-]*\*/.test(rollback), 'S41 rollback: 无 wildcard backup glob');
  ok(rollback.includes('docker compose up -d --no-deps indextts2'), 'S42 rollback: 仅 recreate indextts2');
  ok(rollback.includes('READINESS_DEADLINE=900'), 'S43 rollback: readiness deadline=900s');
  ok(rollback.includes('0.0.0.0:8002') && rollback.includes('0.0.0.0:7870'), 'S44 rollback: 验证 host-network 端口形态恢复');
  ok(rollback.indexOf('config --quiet') < rollback.indexOf('docker compose up -d --no-deps indextts2'), 'R2-R01 rollback: restore 后 recreate 前 config --quiet');

  console.log(`\nM4-C1 admin-scripts: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}

main();

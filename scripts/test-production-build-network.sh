#!/usr/bin/env bash
# test-production-build-network.sh — production-build-network.sh 逻辑测试。
# 只做脚本逻辑/本地检查验证（bash -n、dry-run、mock 容器状态、端口占用拒绝、
# 退出码），不启动真实 docker 容器、不访问任何付费服务/外网。
# 用法：bash scripts/test-production-build-network.sh
set -euo pipefail

SCRIPT="scripts/production-build-network.sh"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1"; }

# 1) 语法检查
if bash -n "$SCRIPT"; then ok "bash -n 语法检查"; else bad "bash -n 语法检查"; fi

# 2) dry-run start（本地只读检查通过路径）：自起临时 listener 模拟代理
python3 -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',65533)); s.listen(4); time.sleep(20)" &
PROXY_PID=$!
sleep 1
if ZHIYING_BUILD_PROXY=127.0.0.1:65533 ZHIYING_BUILD_TUNNEL_PORT=65532 \
   ZHIYING_BUILD_NETWORK_DRY_RUN=1 bash "$SCRIPT" start >/dev/null 2>&1; then
  ok "dry-run start（端口空闲 + 代理可达时通过）"
else
  bad "dry-run start 应通过（模拟代理可达 + 端口空闲）"
fi
kill "$PROXY_PID" 2>/dev/null || true
wait "$PROXY_PID" 2>/dev/null || true

# 3) 端口占用拒绝：起一个 65534 监听，start 必须拒绝（无自有容器时）
python3 -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',65534)); s.listen(1); time.sleep(20)" &
PID=$!
sleep 1
if ZHIYING_BUILD_TUNNEL_PORT=65534 ZHIYING_BUILD_NETWORK_DRY_RUN=1 bash "$SCRIPT" start >/dev/null 2>&1; then
  bad "端口占用时 start 应非零退出"
else
  ok "端口占用时 start 拒绝（fail-closed）"
fi
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

# 4) 自有容器 running 时第二次 start 返回 0（幂等；mock 容器 + dry-run 跳过 TLS 验证）
if ZHIYING_BUILD_NETWORK_MOCK=running ZHIYING_BUILD_TUNNEL_PORT=65532 \
   ZHIYING_BUILD_PROXY=127.0.0.1:65533 ZHIYING_BUILD_NETWORK_DRY_RUN=1 \
   bash "$SCRIPT" start >/dev/null 2>&1; then
  ok "自有容器 running 时二次 start 幂等返回 0"
else
  bad "自有容器 running 时二次 start 应返回 0"
fi

# 5) check：无容器 → 非零退出 + STOPPED
out=$(ZHIYING_BUILD_NETWORK_MOCK=absent ZHIYING_BUILD_NETWORK_DRY_RUN=1 bash "$SCRIPT" check 2>/dev/null || true)
if [ "$out" = "STOPPED" ]; then ok "check 无容器输出 STOPPED"; else bad "check 输出=$out"; fi
if ZHIYING_BUILD_NETWORK_MOCK=absent ZHIYING_BUILD_NETWORK_DRY_RUN=1 bash "$SCRIPT" check >/dev/null 2>&1; then
  bad "check 无容器应非零退出"
else
  ok "check 无容器非零退出"
fi

# 6) check：mock running + dry-run → RUNNING（DRY_RUN 下 tls_ok 短路）
out=$(ZHIYING_BUILD_NETWORK_MOCK=running ZHIYING_BUILD_NETWORK_DRY_RUN=1 bash "$SCRIPT" check 2>/dev/null || true)
if [ "$out" = "RUNNING" ]; then ok "check running 容器输出 RUNNING"; else bad "check running 输出=$out"; fi

# 7) listener 仅 loopback：检查 socat 命令包含 bind=127.0.0.1（脚本内容断言）
if grep -q "TCP-LISTEN:\${LISTEN_PORT},bind=127.0.0.1,fork,reuseaddr" "$SCRIPT"; then
  ok "socat 仅监听 loopback（bind=127.0.0.1）"
else
  bad "socat 未绑定 loopback"
fi

# 8) 代理 host 环境变量生效：脚本从 ZHIYING_BUILD_PROXY 解析 host/port（内容断言）
if grep -q 'PROXY_HOST="${PROXY_ADDR%:\*}"' "$SCRIPT" && grep -q 'PROXY:${PROXY_HOST}:${TARGET_HOST}:443,proxyport=${PROXY_PORT}' "$SCRIPT"; then
  ok "代理 host/port 从环境变量解析（不硬编码）"
else
  bad "代理 host/port 解析缺失"
fi

# 9) 用法错误 → exit 2
if bash "$SCRIPT" >/dev/null 2>&1; then
  bad "无参数应 exit 2"
else
  rc=$?
  if [ "$rc" -eq 2 ]; then ok "无参数 exit 2"; else bad "无参数 exit=$rc（期望 2）"; fi
fi

# 10) dry-run stop 幂等通过
if ZHIYING_BUILD_NETWORK_DRY_RUN=1 bash "$SCRIPT" stop >/dev/null 2>&1; then
  ok "dry-run stop 通过"
else
  bad "dry-run stop 失败"
fi

echo ""
echo "${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1

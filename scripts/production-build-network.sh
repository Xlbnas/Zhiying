#!/usr/bin/env bash
# production-build-network.sh — 知影生产构建网络加速（M7.3A.3 / M7.3A.3.1）
#
# 背景：Docker build 期间 Remotion 的 `npx remotion browser ensure` 用 node:https
# 直连 remotion.media（Cloudflare），国内链路极慢（~10KB/s）；node:https 不读取
# HTTP_PROXY 环境变量。本脚本在宿主起一个 nginx:alpine + socat CONNECT 隧道
# （--network=host，socat 仅绑定 loopback），把 remotion.media:443 的流量经宿主
# 代理转发，实测下载速率 ~2MB/s（约 200 倍）。
#
# 用法：
#   scripts/production-build-network.sh start   # 启动隧道（幂等）
#   scripts/production-build-network.sh check   # 容器+listener+TLS 均 OK → 0；否则 1
#   scripts/production-build-network.sh stop    # 清理隧道容器（幂等）
#
# M7.3A.3.1 硬化：
#   - start 真正幂等：自有容器已 running 时先验证 listener+TLS，通过直接返回 0，
#     不因 443 被占用而失败；只有不存在自有容器时才执行 port_free。
#   - socat 仅监听 127.0.0.1（禁止 0.0.0.0）。
#   - 代理 host/port 由 ZHIYING_BUILD_PROXY 解析，不硬编码。
#   - check 验证：容器 running + loopback listener + TLS handshake（SNI=remotion.media）。
#   - 不打印任何 secret；失败非零退出；start 失败 trap 清理。
#
# 环境变量（测试/定制）：
#   ZHIYING_BUILD_PROXY           代理地址 host:port（默认 127.0.0.1:7890）
#   ZHIYING_BUILD_TUNNEL_PORT     隧道监听端口（默认 443）
#   ZHIYING_BUILD_NETWORK_DRY_RUN 1=只做本地只读检查（不操作 docker/网络）
#   ZHIYING_BUILD_NETWORK_MOCK    测试钩子：container_running/port_free 的模拟结果
#                                 （absent|running|external443；仅测试用）
set -euo pipefail

CONTAINER_NAME="tunnel-remotion-build"
IMAGE="nginx:alpine"
PROXY_ADDR="${ZHIYING_BUILD_PROXY:-127.0.0.1:7890}"
TARGET_HOST="remotion.media"
LISTEN_PORT="${ZHIYING_BUILD_TUNNEL_PORT:-443}"
DRY_RUN="${ZHIYING_BUILD_NETWORK_DRY_RUN:-0}"
MOCK="${ZHIYING_BUILD_NETWORK_MOCK:-}"

PROXY_HOST="${PROXY_ADDR%:*}"
PROXY_PORT="${PROXY_ADDR##*:}"

log() { echo "[build-network] $*"; }
die() { echo "[build-network] ERROR: $*" >&2; exit 1; }

port_free() {
  [ "$MOCK" = "external443" ] && return 1
  if command -v ss >/dev/null 2>&1; then
    # Avoid `ss | grep -q` under pipefail: grep may close the pipe after the
    # first match, making ss exit with SIGPIPE and turning a match into false.
    local sockets
    sockets="$(ss -lnt 2>/dev/null || true)"
    if grep -qE "[:.]${LISTEN_PORT}[[:space:]]" <<<"$sockets"; then
      return 1
    fi
  else
    if grep -qE ":$(printf '%04X' "$LISTEN_PORT") " /proc/net/tcp 2>/dev/null; then
      return 1
    fi
  fi
  return 0
}

proxy_reachable() {
  timeout 5 bash -c "cat < /dev/null > /dev/tcp/${PROXY_HOST}/${PROXY_PORT}" 2>/dev/null
}

container_running() {
  [ "$MOCK" = "running" ] && return 0
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"
}

container_exists() {
  [ -n "$MOCK" ] && return 0
  docker inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

listener_up() {
  # 测试钩子：mock 容器状态视为 listener 就绪（脚本逻辑测试用）
  [ -n "$MOCK" ] && return 0
  if command -v ss >/dev/null 2>&1; then
    local sockets
    sockets="$(ss -lnt 2>/dev/null || true)"
    grep -qE "127\.0\.0\.1:${LISTEN_PORT}[[:space:]]" <<<"$sockets"
  else
    grep -qE ":$(printf '%04X' "$LISTEN_PORT") " /proc/net/tcp 2>/dev/null
  fi
}

# TLS handshake 验证：SNI=remotion.media 且证书链有效（openssl 可用时）。
tls_ok() {
  [ "$DRY_RUN" = "1" ] && return 0
  command -v openssl >/dev/null 2>&1 || return 0
  local out
  out=$(timeout 10 openssl s_client -connect "127.0.0.1:${LISTEN_PORT}" \
    -servername "$TARGET_HOST" -verify_hostname "$TARGET_HOST" </dev/null 2>/dev/null) || return 1
  # -verify_hostname 已校验 SNI 主机名（SAN/CN）；Verification: OK 即证书链有效
  printf '%s' "$out" | grep -q "Verification: OK"
}

cmd_start() {
  # 幂等：自有容器已 running → 验证 listener + TLS，通过直接返回 0
  if container_running; then
    if listener_up && tls_ok; then
      log "隧道容器已运行且健康（${CONTAINER_NAME}），幂等返回"
      exit 0
    fi
    die "自有容器 ${CONTAINER_NAME} 存在但 listener/TLS 检查失败；请 stop 后重试"
  fi

  # 只有不存在自有容器时才检查端口占用（避免误伤自己的 listener）
  if ! container_exists; then
    port_free || die "端口 ${LISTEN_PORT} 已被未知服务占用；请先排查（ss -lnt | grep ${LISTEN_PORT}）"
  fi
  proxy_reachable || die "宿主代理 ${PROXY_ADDR} 不可达"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run：检查通过（端口空闲、代理可达），未创建容器"
    exit 0
  fi

  if container_exists; then
    log "隧道容器已存在（${CONTAINER_NAME}），幂等启动"
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
    container_running || die "容器 ${CONTAINER_NAME} 无法启动"
    log "tunnel ready（已有容器）"
    exit 0
  fi

  trap 'docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true' EXIT
  # socat 仅监听 loopback；PROXY host/port 从 ZHIYING_BUILD_PROXY 解析
  docker run -d --name "$CONTAINER_NAME" --network=host \
    -e "HTTPS_PROXY=http://${PROXY_ADDR}" -e "HTTP_PROXY=http://${PROXY_ADDR}" \
    "$IMAGE" sh -c "apk add --no-cache socat >/dev/null 2>&1 && exec socat TCP-LISTEN:${LISTEN_PORT},bind=127.0.0.1,fork,reuseaddr PROXY:${PROXY_HOST}:${TARGET_HOST}:443,proxyport=${PROXY_PORT}"

  for _ in $(seq 1 90); do
    if container_running && listener_up && tls_ok; then
      trap - EXIT
      log "tunnel ready：${TARGET_HOST}:443 → 127.0.0.1:${LISTEN_PORT}（经 ${PROXY_ADDR}，仅 loopback）"
      exit 0
    fi
    sleep 1
  done
  die "隧道容器启动超时（诊断：docker logs ${CONTAINER_NAME}）"
}

cmd_check() {
  if ! container_running; then
    echo "STOPPED"
    exit 1
  fi
  if ! listener_up; then
    echo "NO_LISTENER"
    exit 1
  fi
  if ! tls_ok; then
    echo "TLS_FAIL"
    exit 1
  fi
  echo "RUNNING"
  exit 0
}

cmd_stop() {
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run：未执行 docker 清理"
    exit 0
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  log "隧道容器已清理（${CONTAINER_NAME}）"
}

case "${1:-}" in
  start) cmd_start ;;
  check) cmd_check ;;
  stop) cmd_stop ;;
  *)
    echo "用法: $0 {start|check|stop}" >&2
    exit 2
    ;;
esac

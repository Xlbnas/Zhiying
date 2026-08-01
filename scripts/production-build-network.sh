#!/usr/bin/env bash
# production-build-network.sh — 知影生产构建网络加速（M7.3A.3）
#
# 背景：Docker build 期间 Remotion 的 `npx remotion browser ensure` 用 node:https
# 直连 remotion.media（Cloudflare），国内链路极慢（~10KB/s）；node:https 不读取
# HTTP_PROXY 环境变量，apt/npm 镜像源无法覆盖该下载。本脚本在宿主起一个
# nginx:alpine + socat CONNECT 隧道（--network=host），把 remotion.media:443
# 的流量经宿主代理（127.0.0.1:7890）转发，实测下载速率 ~2MB/s（约 200 倍）。
#
# 用法：
#   scripts/production-build-network.sh start   # 启动隧道（幂等；占用 443 时拒绝）
#   scripts/production-build-network.sh check   # 隧道运行中 → 0；未运行 → 1
#   scripts/production-build-network.sh stop    # 清理隧道容器
#
# 约束：
#   - 不需要 sudo（docker 容器内 root 绑定 443，宿主侧 docker 权限即可）
#   - 固定容器名 tunnel-remotion-build，幂等
#   - 不打印任何 secret；代理地址仅 loopback（127.0.0.1:7890）
#   - 失败时非零退出；start 失败自动清理已创建的容器（trap）
#   - 镜像源/隧道不可用时必须停止构建，不得默默退回极慢直连
#
# 环境变量（测试/定制用）：
#   ZHIYING_BUILD_PROXY        代理地址（默认 127.0.0.1:7890）
#   ZHIYING_BUILD_TUNNEL_PORT  隧道监听端口（默认 443）
#   ZHIYING_BUILD_NETWORK_DRY_RUN  1=只做本地只读检查（不操作 docker），供测试
set -euo pipefail

CONTAINER_NAME="tunnel-remotion-build"
IMAGE="nginx:alpine"
PROXY_ADDR="${ZHIYING_BUILD_PROXY:-127.0.0.1:7890}"
TARGET_HOST="remotion.media"
LISTEN_PORT="${ZHIYING_BUILD_TUNNEL_PORT:-443}"
DRY_RUN="${ZHIYING_BUILD_NETWORK_DRY_RUN:-0}"

log() { echo "[build-network] $*"; }
die() { echo "[build-network] ERROR: $*" >&2; exit 1; }

port_free() {
  # 监听端口未被占用（ss 优先；无 ss 时回退 /proc/net/tcp）
  if command -v ss >/dev/null 2>&1; then
    if ss -lnt 2>/dev/null | grep -qE "[:.]${LISTEN_PORT}[[:space:]]"; then
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
  local host="${PROXY_ADDR%:*}"
  local port="${PROXY_ADDR##*:}"
  timeout 5 bash -c "cat < /dev/null > /dev/tcp/${host}/${port}" 2>/dev/null
}

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"
}

cmd_start() {
  # 本地只读检查（DRY_RUN 也执行）：不占用已有未知 443 服务 + 代理可达
  port_free || die "端口 ${LISTEN_PORT} 已被占用（可能有未知服务）；拒绝启动隧道，请先排查（ss -lnt | grep ${LISTEN_PORT}）"
  proxy_reachable || die "宿主代理 ${PROXY_ADDR} 不可达；请确认代理服务运行中"
  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run：检查通过（端口空闲、代理可达），未创建容器"
    exit 0
  fi

  if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    log "隧道容器已存在（${CONTAINER_NAME}），幂等启动"
    docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
    container_running || die "容器 ${CONTAINER_NAME} 无法启动"
    log "tunnel ready（已有容器）"
    exit 0
  fi

  # 启动失败时清理已创建的容器（trap；成功就绪后解除）
  trap 'docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true' EXIT
  docker run -d --name "$CONTAINER_NAME" --network=host \
    -e "HTTPS_PROXY=http://${PROXY_ADDR}" -e "HTTP_PROXY=http://${PROXY_ADDR}" \
    "$IMAGE" sh -c "apk add --no-cache socat >/dev/null 2>&1 && exec socat TCP-LISTEN:${LISTEN_PORT},fork,reuseaddr PROXY:127.0.0.1:${TARGET_HOST}:443,proxyport=${PROXY_ADDR##*:}"

  # 等待就绪（apk 装 socat + socat 监听；最多 90s）
  for _ in $(seq 1 90); do
    if container_running && ss -lnt 2>/dev/null | grep -qE "[:.]${LISTEN_PORT}[[:space:]]"; then
      trap - EXIT
      log "tunnel ready：${TARGET_HOST}:443 → 127.0.0.1:${LISTEN_PORT}（经 ${PROXY_ADDR}）"
      exit 0
    fi
    sleep 1
  done
  die "隧道容器启动超时（诊断：docker logs ${CONTAINER_NAME}）"
}

cmd_check() {
  if container_running; then
    echo "RUNNING"
    exit 0
  fi
  echo "STOPPED"
  exit 1
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

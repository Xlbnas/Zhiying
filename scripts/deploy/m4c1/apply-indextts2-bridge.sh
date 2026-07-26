#!/usr/bin/env bash
# M4-C1B0-R — IndexTTS2 bridge migration apply（Git 受审版，offline runtime）
# 修复根因：UV_NO_SYNC=1 + UV_OFFLINE=1 使 uv runtime dependency resolution
# 完全 offline（uv run 不再经 loopback proxy 拉 hatchling）。
# 用法（管理员）：sudo bash scripts/deploy/m4c1/apply-indextts2-bridge.sh
# 注意：脚本只能给出 HOST_SIDE_PASS；LAN 8002 关闭/7870 保留需同网段设备复验
# （LAN_ACCEPTANCE_PENDING），服务器自身无法可靠证明。
set -euo pipefail

TTS_DIR="/vol1/1000/tts-stack"
FORMAL="$TTS_DIR/docker-compose.yml"
PROPOSED="/vol1/1000/docker/zhiying/scripts/deploy/m4c1/tts-stack.docker-compose.proposed.yml"
STATE_DIR="/vol1/1000/docker/zhiying/_m4c1"
EXPECTED_FORMAL_SHA="a404b1a0889556dd5b687b685569d990e25f42f3c395bac13ac646c33bcb3f88"
EXPECTED_PROPOSED_SHA="1597f4394496834232bdb40bb1784030b34134d2d39661b449b0bf3d96558ab6"
READINESS_DEADLINE=900

echo "=== [0/8] prechecks ==="
[ "$(id -u)" -eq 0 ] || { echo "FAIL: 需要 root 执行" >&2; exit 1; }
docker info >/dev/null
sha=$(sha256sum "$FORMAL" | awk '{print $1}')
[ "$sha" = "$EXPECTED_FORMAL_SHA" ] || { echo "FAIL: formal compose SHA 漂移：$sha" >&2; exit 1; }
mkdir -p "$STATE_DIR"
psha=$(sha256sum "$PROPOSED" | awk '{print $1}')
[ "$psha" = "$EXPECTED_PROPOSED_SHA" ] || { echo "FAIL: proposed SHA 不符：$psha" >&2; exit 1; }
grep -q 'UV_NO_SYNC: "1"' "$PROPOSED" || { echo "FAIL: proposed 缺 UV_NO_SYNC" >&2; exit 1; }
grep -q 'UV_OFFLINE: "1"' "$PROPOSED" || { echo "FAIL: proposed 缺 UV_OFFLINE" >&2; exit 1; }

echo "=== [1/8] 精确时间戳 backup（写入 state file） ==="
BACKUP="$FORMAL.bak-m4c1-$(date +%Y%m%d-%H%M%S)"
cp -a "$FORMAL" "$BACKUP"
echo "$BACKUP" > "$STATE_DIR/.last-indextts2-backup"
echo "BACKUP=$BACKUP"

echo "=== [2/8] network inspect/create（先查后建） ==="
docker network inspect zhiying-tts-net >/dev/null 2>&1 \
  || docker network create zhiying-tts-net

echo "=== [3/8] proposed compose config 验证 ==="
docker compose -f "$PROPOSED" --project-directory "$TTS_DIR" config --quiet

echo "=== [4/8] 应用（仅 recreate indextts2，--no-deps，不动 qwen/cosyvoice） ==="
cp "$PROPOSED" "$FORMAL"
cd "$TTS_DIR"
docker compose up -d --no-deps indextts2

echo "=== [5/8] readiness（deadline ${READINESS_DEADLINE}s，每 10s 反馈；health=starting 不提前失败） ==="
start_ts=$(date +%s)
st="unknown"
while :; do
  elapsed=$(( $(date +%s) - start_ts ))
  st=$(docker inspect --format '{{.State.Health.Status}}' indextts2 2>/dev/null || echo missing)
  l8002=$(ss -lnt | grep -q '127.0.0.1:8002' && echo yes || echo no)
  l7870=$(ss -lnt | grep -q ':7870' && echo yes || echo no)
  gpu=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo n/a)
  echo "elapsed=${elapsed}s health=$st 8002=$l8002 7870=$l7870 gpu=$gpu"
  [ "$st" = "healthy" ] && break
  if [ "$elapsed" -ge "$READINESS_DEADLINE" ]; then
    echo "FAIL: 超过 ${READINESS_DEADLINE}s 未 healthy，最近日志：" >&2
    docker logs --tail 40 indextts2 >&2 || true
    echo "请执行 scripts/deploy/m4c1/rollback-indextts2-bridge.sh" >&2
    exit 1
  fi
  sleep 10
done

echo "=== [6/8] localhost 服务验证 ==="
curl -fsS -m 10 http://127.0.0.1:8002/health; echo
c7870=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:7870/)
echo "7870_http=$c7870"
[ "$c7870" = "200" ]
echo "--- offline 语义抽查：容器内 uv 不再联网（UV_NO_SYNC/UV_OFFLINE 已注入 environment） ---"
docker inspect indextts2 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^UV_(NO_SYNC|OFFLINE)=1$'

echo "=== [7/8] speaker cache + GPU 验证 ==="
ls /vol1/1000/tts-stack/outputs/index/speaker_cache/
curl -fsS -m 10 http://127.0.0.1:8002/speakers | head -c 200; echo
nvidia-smi --query-gpu=memory.used --format=csv,noheader

echo "=== [8/8] 记录 ==="
echo "applied_at=$(date -Is) backup=$BACKUP" >> "$STATE_DIR/.bridge-applied.log"
echo "HOST_SIDE_PASS"
echo "LAN_ACCEPTANCE_PENDING（需同网段设备复验：LAN_IP:8002 必须 unreachable；LAN_IP:7870 必须 200）"

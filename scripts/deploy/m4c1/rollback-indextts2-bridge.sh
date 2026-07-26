#!/usr/bin/env bash
# M4-C1B0-R — IndexTTS2 bridge migration rollback（Git 受审版）
# 读取精确 backup state file，禁止 wildcard 猜测。
# 用法（管理员）：sudo bash scripts/deploy/m4c1/rollback-indextts2-bridge.sh
set -euo pipefail

TTS_DIR="/vol1/1000/tts-stack"
FORMAL="$TTS_DIR/docker-compose.yml"
STATE_FILE="/vol1/1000/docker/zhiying/_m4c1/.last-indextts2-backup"
READINESS_DEADLINE=900

echo "=== [0/6] prechecks ==="
[ "$(id -u)" -eq 0 ] || { echo "FAIL: 需要 root 执行" >&2; exit 1; }
docker info >/dev/null
[ -f "$STATE_FILE" ] || { echo "FAIL: backup state file 不存在：$STATE_FILE" >&2; exit 1; }
BACKUP=$(cat "$STATE_FILE")
[ -f "$BACKUP" ] || { echo "FAIL: state file 指向的 backup 不存在：$BACKUP" >&2; exit 1; }
echo "BACKUP=$BACKUP"

echo "=== [1/6] 恢复 formal compose ==="
cp -a "$BACKUP" "$FORMAL"

echo "=== [2/6] compose config 验证 ==="
docker compose -f "$FORMAL" --project-directory "$TTS_DIR" config --quiet

echo "=== [3/6] 仅 recreate indextts2（--no-deps，不动 qwen/cosyvoice） ==="
cd "$TTS_DIR"
docker compose up -d --no-deps indextts2

echo "=== [4/6] readiness（deadline ${READINESS_DEADLINE}s，含 uv sync + 双进程模型加载） ==="
start_ts=$(date +%s)
ok=0
while :; do
  elapsed=$(( $(date +%s) - start_ts ))
  l8002=$(ss -lnt | grep -q ':8002' && echo yes || echo no)
  l7870=$(ss -lnt | grep -q ':7870' && echo yes || echo no)
  gpu=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo n/a)
  echo "elapsed=${elapsed}s 8002=$l8002 7870=$l7870 gpu=$gpu"
  if curl -fsS -m 8 http://127.0.0.1:8002/health >/dev/null 2>&1; then ok=1; break; fi
  if [ "$elapsed" -ge "$READINESS_DEADLINE" ]; then
    echo "FAIL: 8002 未在 ${READINESS_DEADLINE}s 内恢复，最近日志：" >&2
    docker logs --tail 40 indextts2 >&2 || true
    exit 1
  fi
  sleep 10
done
curl -fsS -m 10 http://127.0.0.1:8002/health; echo

echo "=== [5/6] host-network 端口形态验证（8002/7870 应恢复 0.0.0.0） ==="
ss -lnt | grep -q '0.0.0.0:8002' || { echo "FAIL: 8002 未恢复 0.0.0.0" >&2; exit 1; }
ss -lnt | grep -q '0.0.0.0:7870' || { echo "FAIL: 7870 未恢复 0.0.0.0" >&2; exit 1; }
ss -lnt | grep -E ':(7870|8002)\b'

echo "=== [6/6] speaker cache + GPU 验证 ==="
ls /vol1/1000/tts-stack/outputs/index/speaker_cache/
curl -fsS -m 10 http://127.0.0.1:8002/speakers | head -c 200; echo
nvidia-smi --query-gpu=memory.used --format=csv,noheader

echo "ROLLBACK_DONE"

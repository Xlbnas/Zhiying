#!/usr/bin/env bash
# M4-C1B0-R2 — IndexTTS2 bridge migration apply（Git 受审版，offline runtime）
# 修复根因：UV_NO_SYNC=1 + UV_OFFLINE=1 使 uv runtime dependency resolution
# 完全 offline（uv run 不再经 loopback proxy 拉 hatchling）。
# 用法（管理员）：sudo bash scripts/deploy/m4c1/apply-indextts2-bridge.sh
# 注意：脚本只能给出 HOST_SIDE_PASS；LAN 8002 关闭/7870 保留需同网段设备复验
# （LAN_ACCEPTANCE_PENDING），服务器自身无法可靠证明。
set -euo pipefail

TTS_DIR="/vol1/1000/tts-stack"
FORMAL="$TTS_DIR/docker-compose.yml"
REPO_M4C1="/vol1/1000/docker/zhiying/scripts/deploy/m4c1"
PROPOSED="$REPO_M4C1/tts-stack.docker-compose.proposed.yml"
GATE_PY="$REPO_M4C1/semantic-compose-gate.py"
STATE_DIR="/vol1/1000/docker/zhiying/_m4c1"
ROLLBACK_SCRIPT="$REPO_M4C1/rollback-indextts2-bridge.sh"
EXPECTED_FORMAL_SHA="a404b1a0889556dd5b687b685569d990e25f42f3c395bac13ac646c33bcb3f88"
EXPECTED_PROPOSED_SHA="63df2960c75df644612ad302b0e54f440a6bf2b914ec4057ea5cb5b1b8fa23c9"
READINESS_DEADLINE=900

STAGE="init"
BACKUP=""
RECREATE_STARTED=0
CUR_JSON=""
PROP_JSON=""

cleanup() { [ -n "$CUR_JSON" ] && rm -f "$CUR_JSON" "$PROP_JSON" 2>/dev/null || true; }
on_err() {
  rc=$?
  echo "FAILED_STAGE=$STAGE" >&2
  echo "BACKUP=${BACKUP:-NOT_CREATED}" >&2
  echo "ROLLBACK_SCRIPT=$ROLLBACK_SCRIPT" >&2
  if [ "$RECREATE_STARTED" = "1" ]; then
    echo "--- docker logs --tail 60 indextts2 ---" >&2
    docker logs --tail 60 indextts2 >&2 || true
  fi
  cleanup
  exit "$rc"
}
trap on_err ERR
trap cleanup EXIT

echo "=== [0/10] prechecks（root / docker / python3 / SHA / UV policy） ==="
STAGE="precheck-root"
[ "$(id -u)" = "0" ] || { echo "FAIL: 需要 root 执行" >&2; exit 1; }
STAGE="precheck-docker"
docker info >/dev/null
STAGE="precheck-python3"
command -v python3 >/dev/null || { echo "FAIL: python3 不存在（semantic gate 需要 stdlib json）" >&2; exit 1; }
[ -f "$GATE_PY" ] || { echo "FAIL: semantic gate 脚本缺失：$GATE_PY" >&2; exit 1; }
STAGE="precheck-formal-sha"
sha=$(sha256sum "$FORMAL" | awk '{print $1}')
[ "$sha" = "$EXPECTED_FORMAL_SHA" ] || { echo "FAIL: formal compose SHA 漂移：$sha" >&2; exit 1; }
STAGE="precheck-proposed-sha"
psha=$(sha256sum "$PROPOSED" | awk '{print $1}')
[ "$psha" = "$EXPECTED_PROPOSED_SHA" ] || { echo "FAIL: proposed SHA 不符：$psha" >&2; exit 1; }
grep -q 'UV_NO_SYNC: "1"' "$PROPOSED" || { echo "FAIL: proposed 缺 UV_NO_SYNC" >&2; exit 1; }
grep -q 'UV_OFFLINE: "1"' "$PROPOSED" || { echo "FAIL: proposed 缺 UV_OFFLINE" >&2; exit 1; }

echo "=== [1/10] 当前 indextts2 healthy ==="
STAGE="precheck-current-healthy"
h=$(docker inspect --format '{{.State.Health.Status}}' indextts2 2>/dev/null || echo missing)
[ "$h" = "healthy" ] || { echo "FAIL: 当前 indextts2 非 healthy：$h（不应对异常状态做迁移）" >&2; exit 1; }
curl -fsS -m 8 http://127.0.0.1:8002/health >/dev/null

echo "=== [2/10] normalized compose JSON（config --format json，不支持则 FAIL PRECHECK，零 mutation） ==="
STAGE="normalize-compose-json"
CUR_JSON="$(mktemp)"; PROP_JSON="$(mktemp)"
docker compose -f "$FORMAL" --project-directory "$TTS_DIR" config --format json >"$CUR_JSON" \
  || { echo "FAIL PRECHECK: 当前 Docker Compose 不支持 config --format json，禁止 mutation" >&2; exit 1; }
docker compose -f "$PROPOSED" --project-directory "$TTS_DIR" config --format json >"$PROP_JSON" \
  || { echo "FAIL PRECHECK: proposed compose 无法 normalize" >&2; exit 1; }
[ -s "$CUR_JSON" ] && [ -s "$PROP_JSON" ] || { echo "FAIL PRECHECK: normalized JSON 为空" >&2; exit 1; }

echo "=== [3/10] SEMANTIC DIFF GATE（先于任何 backup/apply mutation） ==="
STAGE="semantic-diff-gate"
python3 "$GATE_PY" "$CUR_JSON" "$PROP_JSON"
# gate fail-closed：非零退出即经 trap 终止，此处到达即 SEMANTIC_DIFF_GATE=PASS

echo "=== [4/10] speaker cache precheck ==="
STAGE="precheck-speaker-cache"
CACHE="$TTS_DIR/outputs/index/speaker_cache"
for f in index.json spk_73d01a47_emb.pkl spk_73d01a47.wav; do
  [ -f "$CACHE/$f" ] || { echo "FAIL: speaker cache 缺失：$CACHE/$f" >&2; exit 1; }
done

echo "=== [5/10] network inspect/create（先查后建） ==="
STAGE="network-ensure"
docker network inspect zhiying-tts-net >/dev/null 2>&1 \
  || docker network create zhiying-tts-net

echo "=== [6/10] 精确时间戳 backup（写入 state file） ==="
STAGE="backup-formal-compose"
mkdir -p "$STATE_DIR"
BACKUP="$FORMAL.bak-m4c1-$(date +%Y%m%d-%H%M%S)"
cp -a "$FORMAL" "$BACKUP"
echo "$BACKUP" > "$STATE_DIR/.last-indextts2-backup"
echo "BACKUP=$BACKUP"

echo "=== [7/10] 替换 formal compose 并复核 config ==="
STAGE="replace-formal-compose"
cp "$PROPOSED" "$FORMAL"
docker compose -f "$FORMAL" --project-directory "$TTS_DIR" config --quiet

echo "=== [8/10] 应用（仅 recreate indextts2，--no-deps，不动 qwen/cosyvoice） ==="
STAGE="recreate-indextts2"
RECREATE_STARTED=1
cd "$TTS_DIR"
docker compose up -d --no-deps indextts2

echo "=== [9/10] readiness（deadline ${READINESS_DEADLINE}s，每 10s 反馈；health=starting 不提前失败） ==="
STAGE="readiness-wait"
start_ts=$(date +%s)
while :; do
  elapsed=$(( $(date +%s) - start_ts ))
  st=$(docker inspect --format '{{.State.Health.Status}}' indextts2 2>/dev/null || echo missing)
  l8002=$(ss -lnt | grep -q '127.0.0.1:8002' && echo yes || echo no)
  l7870=$(ss -lnt | grep -q ':7870' && echo yes || echo no)
  gpu=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null || echo n/a)
  echo "elapsed=${elapsed}s health=$st 8002=$l8002 7870=$l7870 gpu=$gpu"
  [ "$st" = "healthy" ] && break
  if [ "$elapsed" -ge "$READINESS_DEADLINE" ]; then
    echo "FAIL: 超过 ${READINESS_DEADLINE}s 未 healthy" >&2
    exit 1
  fi
  sleep 10
done

echo "=== [10/10] localhost 服务 + offline 语义 + speaker cache + GPU 验证 ==="
STAGE="post-verify"
curl -fsS -m 10 http://127.0.0.1:8002/health; echo
c7870=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:7870/)
echo "7870_http=$c7870"
[ "$c7870" = "200" ]
docker inspect indextts2 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^UV_(NO_SYNC|OFFLINE)=1$'
ls "$CACHE/"
curl -fsS -m 10 http://127.0.0.1:8002/speakers | head -c 200; echo
nvidia-smi --query-gpu=memory.used --format=csv,noheader

echo "applied_at=$(date -Is) backup=$BACKUP" >> "$STATE_DIR/.bridge-applied.log"
echo "HOST_SIDE_PASS"
echo "LAN_ACCEPTANCE_PENDING（需同网段设备复验：LAN_IP:8002 必须 unreachable；LAN_IP:7870 必须 200）"

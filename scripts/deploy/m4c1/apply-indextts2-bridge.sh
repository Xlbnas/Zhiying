#!/usr/bin/env bash
# M4-C1B2-R5A-R1 — IndexTTS2 bridge migration apply（Git 受审版，offline runtime）
# 修复根因一：UV_NO_SYNC=1 + UV_OFFLINE=1 使 uv runtime dependency resolution
# 完全 offline（uv run 不再经 loopback proxy 拉 hatchling）。
# 修复根因二：HF_HUB_CACHE=/app/checkpoints/hf_cache + HF_HUB_OFFLINE=1 使
# HuggingFace runtime artifact closure（IndexTTS2.__init__ 不再经 loopback
# proxy 访问 HF Hub）。formal compose 替换前强制执行
# preflight-indextts2-hf-cache.sh（--network none disposable 验证四依赖）。
# R1 image identity hardening：tag 不是 immutable identity——三层 Docker
# image ID pin（running container / local tag / pre-recreate 二次复核）+
# recreate 强制 --pull never，封闭 tag 漂移与 implicit pull 两类风险。
# 用法（管理员）：sudo bash scripts/deploy/m4c1/apply-indextts2-bridge.sh
# 注意：脚本只能给出 HOST_SIDE_PASS；LAN 8002 关闭/7870 保留需同网段设备复验
# （LAN_ACCEPTANCE_PENDING），服务器自身无法可靠证明。
#
# 失败语义：
#   fail()   = expected fail-closed gate handler（人为检查失败，统一诊断输出）
#   on_err() = unexpected error handler（ERR trap 兜底，未预期命令失败）
# 两者输出格式一致；均不自动 rollback、不输出 secret。
set -euo pipefail

TTS_DIR="/vol1/1000/tts-stack"
FORMAL="$TTS_DIR/docker-compose.yml"
REPO_M4C1="/vol1/1000/docker/zhiying/scripts/deploy/m4c1"
PROPOSED="$REPO_M4C1/tts-stack.docker-compose.proposed.yml"
GATE_PY="$REPO_M4C1/semantic-compose-gate.py"
PREFLIGHT="$REPO_M4C1/preflight-indextts2-hf-cache.sh"
STATE_DIR="/vol1/1000/docker/zhiying/_m4c1"
ROLLBACK_SCRIPT="$REPO_M4C1/rollback-indextts2-bridge.sh"
EXPECTED_FORMAL_SHA="a404b1a0889556dd5b687b685569d990e25f42f3c395bac13ac646c33bcb3f88"
EXPECTED_PROPOSED_SHA="7b6bd3c2faa5427c77f1229ce21f8cd796f65ce32d1fa0bc9934d208dd312b1a"
# R1：经 R5A 飞牛 disposable probe 实证、与当前 production container 一致的
# image identity（Docker image ID，非 tag、非 RepoDigest）
EXPECTED_INDEXTTS2_IMAGE_ID="sha256:fa8627665733f1d0a134c928012f4ad2eb9a7cc6f19615af46018c3b1126dd0d"
READINESS_DEADLINE=900

STAGE="init"
BACKUP=""
RECREATE_STARTED=0
CUR_JSON=""
PROP_JSON=""

cleanup() {
  if [ -n "$CUR_JSON" ]; then rm -f "$CUR_JSON" "$PROP_JSON" 2>/dev/null || true; fi
}

report_failure() {
  echo "FAILED_STAGE=$STAGE" >&2
  echo "BACKUP=${BACKUP:-NOT_CREATED}" >&2
  echo "ROLLBACK_SCRIPT=$ROLLBACK_SCRIPT" >&2
  if [ "$RECREATE_STARTED" = "1" ]; then
    echo "--- docker logs --tail 60 indextts2 ---" >&2
    docker logs --tail 60 indextts2 >&2 || true
  fi
}

# expected fail-closed gate handler：fail <exit-code> <message...>
fail() {
  local rc=$1; shift
  echo "FAIL: $*" >&2
  report_failure
  cleanup
  exit "$rc"
}

# unexpected error handler（ERR trap 兜底）
on_err() {
  local rc=$?
  echo "UNEXPECTED_ERROR(rc=$rc)" >&2
  report_failure
  cleanup
  exit "$rc"
}
trap on_err ERR
trap cleanup EXIT

echo "=== [0/12] prechecks（root / docker / python3 / SHA / offline contract） ==="
STAGE="precheck-root"
if [ "$(id -u)" != "0" ]; then fail 1 "需要 root 执行"; fi
STAGE="precheck-docker"
if ! docker info >/dev/null 2>&1; then fail 1 "Docker daemon 不可用"; fi
STAGE="precheck-python3"
if ! command -v python3 >/dev/null; then fail 1 "python3 不存在（semantic gate 需要 stdlib json）"; fi
if [ ! -f "$GATE_PY" ]; then fail 1 "semantic gate 脚本缺失：$GATE_PY"; fi
if [ ! -f "$PREFLIGHT" ]; then fail 1 "HF preflight 脚本缺失：$PREFLIGHT"; fi
STAGE="precheck-formal-sha"
sha=$(sha256sum "$FORMAL" | awk '{print $1}')
if [ "$sha" != "$EXPECTED_FORMAL_SHA" ]; then fail 1 "formal compose SHA 漂移：$sha"; fi
STAGE="precheck-proposed-sha"
psha=$(sha256sum "$PROPOSED" | awk '{print $1}')
if [ "$psha" != "$EXPECTED_PROPOSED_SHA" ]; then fail 1 "proposed SHA 不符：$psha"; fi
if ! grep -q 'UV_NO_SYNC: "1"' "$PROPOSED"; then fail 1 "proposed 缺 UV_NO_SYNC"; fi
if ! grep -q 'UV_OFFLINE: "1"' "$PROPOSED"; then fail 1 "proposed 缺 UV_OFFLINE"; fi
if ! grep -q 'HF_HUB_CACHE: /app/checkpoints/hf_cache' "$PROPOSED"; then fail 1 "proposed 缺 HF_HUB_CACHE=/app/checkpoints/hf_cache"; fi
if ! grep -q 'HF_HUB_OFFLINE: "1"' "$PROPOSED"; then fail 1 "proposed 缺 HF_HUB_OFFLINE"; fi
if grep -qE '^[[:space:]]+command:' "$PROPOSED"; then fail 1 "proposed 不得声明 command override（正式 compose 未声明，使用 image-default CMD）"; fi

echo "=== [1/12] 当前 indextts2 healthy ==="
STAGE="precheck-current-healthy"
h=$(docker inspect --format '{{.State.Health.Status}}' indextts2 2>/dev/null || echo missing)
if [ "$h" != "healthy" ]; then fail 1 "当前 indextts2 非 healthy：$h（不应对异常状态做迁移）"; fi
if ! curl -fsS -m 8 http://127.0.0.1:8002/health >/dev/null; then fail 1 "当前 8002 /health 不可用"; fi

echo "=== [2/12] 当前 production image identity（running container == pinned image ID） ==="
STAGE="precheck-current-image-identity"
CURRENT_CONTAINER_IMAGE_ID="$(docker inspect --format '{{.Image}}' indextts2)"
if [ "$CURRENT_CONTAINER_IMAGE_ID" != "$EXPECTED_INDEXTTS2_IMAGE_ID" ]; then
  fail 1 "当前 production indextts2 image ID 漂移：$CURRENT_CONTAINER_IMAGE_ID（预期 $EXPECTED_INDEXTTS2_IMAGE_ID），禁止迁移"
fi

echo "=== [3/12] normalized compose JSON（config --format json，不支持则 FAIL PRECHECK，零 mutation） ==="
STAGE="normalize-compose-json"
CUR_JSON="$(mktemp)"; PROP_JSON="$(mktemp)"
if ! docker compose -f "$FORMAL" --project-directory "$TTS_DIR" config --format json >"$CUR_JSON" 2>/dev/null; then
  fail 1 "当前 Docker Compose 不支持 config --format json，禁止 mutation"
fi
if ! docker compose -f "$PROPOSED" --project-directory "$TTS_DIR" config --format json >"$PROP_JSON" 2>/dev/null; then
  fail 1 "proposed compose 无法 normalize"
fi
if [ ! -s "$CUR_JSON" ] || [ ! -s "$PROP_JSON" ]; then fail 1 "normalized JSON 为空"; fi

echo "=== [4/12] SEMANTIC DIFF GATE（先于任何 backup/apply mutation） ==="
STAGE="semantic-diff-gate"
if ! python3 "$GATE_PY" "$CUR_JSON" "$PROP_JSON"; then
  fail 1 "SEMANTIC_DIFF_GATE=FAIL（详见上方 GATE_VIOLATION）"
fi
# gate fail-closed：此处到达即 SEMANTIC_DIFF_GATE=PASS

echo "=== [5/12] speaker cache precheck ==="
STAGE="precheck-speaker-cache"
CACHE="$TTS_DIR/outputs/index/speaker_cache"
for f in index.json spk_73d01a47_emb.pkl spk_73d01a47.wav; do
  if [ ! -f "$CACHE/$f" ]; then fail 1 "speaker cache 缺失：$CACHE/$f"; fi
done

echo "=== [6/12] HF RUNTIME ARTIFACT PREFLIGHT（--network none disposable，先于 network/backup/formal 一切 mutation） ==="
STAGE="hf-artifact-preflight"
# image 唯一来源：已 normalize 的 PROP_JSON（semantic gate 已保证 current ==
# proposed image），避免 apply 与 preflight 双处维护漂移
PREFLIGHT_IMAGE=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print((d.get("services") or {}).get("indextts2", {}).get("image") or "")' "$PROP_JSON")
if [ -z "$PREFLIGHT_IMAGE" ]; then fail 1 "PROP_JSON 无法解析 services.indextts2.image（fail-closed）"; fi
# R1：proposed tag -> local image identity，必须同时等于 pinned ID 与当前
# production container image ID（tag 漂移即 fail-closed，不启动 preflight）
LOCAL_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$PREFLIGHT_IMAGE" 2>/dev/null || echo missing)"
if [ "$LOCAL_IMAGE_ID" != "$EXPECTED_INDEXTTS2_IMAGE_ID" ]; then
  fail 1 "proposed image tag 本地 identity 漂移：$PREFLIGHT_IMAGE actual=$LOCAL_IMAGE_ID（预期 $EXPECTED_INDEXTTS2_IMAGE_ID）"
fi
if [ "$LOCAL_IMAGE_ID" != "$CURRENT_CONTAINER_IMAGE_ID" ]; then
  fail 1 "proposed image identity 与当前 production container 不一致：$LOCAL_IMAGE_ID != $CURRENT_CONTAINER_IMAGE_ID"
fi
if ! bash "$PREFLIGHT" "$PREFLIGHT_IMAGE" "$EXPECTED_INDEXTTS2_IMAGE_ID"; then
  fail 1 "HF_RUNTIME_ARTIFACT_PREFLIGHT=FAIL：formal compose 未动、backup 未建、production container 未触、network 零 mutation"
fi

echo "=== [7/12] network inspect/create（先查后建） ==="
STAGE="network-ensure"
docker network inspect zhiying-tts-net >/dev/null 2>&1 \
  || docker network create zhiying-tts-net

echo "=== [8/12] 精确时间戳 backup（写入 state file） ==="
STAGE="backup-formal-compose"
mkdir -p "$STATE_DIR"
BACKUP="$FORMAL.bak-m4c1-$(date +%Y%m%d-%H%M%S)"
cp -a "$FORMAL" "$BACKUP"
echo "$BACKUP" > "$STATE_DIR/.last-indextts2-backup"
echo "BACKUP=$BACKUP"

echo "=== [9/12] 替换 formal compose 并复核 config ==="
STAGE="replace-formal-compose"
cp "$PROPOSED" "$FORMAL"
if ! docker compose -f "$FORMAL" --project-directory "$TTS_DIR" config --quiet; then
  fail 1 "替换后 formal compose config 校验失败"
fi

echo "=== [10/12] pre-recreate image identity 复核 + 应用（仅 recreate indextts2，--no-deps --pull never，不动 qwen/cosyvoice） ==="
STAGE="pre-recreate-image-identity"
# R1 第二层：HF preflight 之后、recreate 紧邻之前重新校验（防御外部 tag
# mutation）。此处 formal compose 可能已替换——fail 时不 recreate、不自动
# rollback，failure report 给出 BACKUP 与 canonical rollback 路径
RECREATE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$PREFLIGHT_IMAGE" 2>/dev/null || echo missing)"
if [ "$RECREATE_IMAGE_ID" != "$EXPECTED_INDEXTTS2_IMAGE_ID" ]; then
  fail 1 "recreate 前 image identity 漂移：$PREFLIGHT_IMAGE actual=$RECREATE_IMAGE_ID（预期 $EXPECTED_INDEXTTS2_IMAGE_ID），禁止 recreate"
fi
STAGE="recreate-indextts2"
RECREATE_STARTED=1
cd "$TTS_DIR"
docker compose up -d --no-deps --pull never indextts2

echo "=== [11/12] readiness（deadline ${READINESS_DEADLINE}s，每 10s 反馈；health=starting 不提前失败） ==="
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
    fail 1 "超过 ${READINESS_DEADLINE}s 未 healthy"
  fi
  sleep 10
done

echo "=== [12/12] localhost 服务 + offline 语义 + speaker cache + GPU 验证 ==="
STAGE="post-verify"
if ! curl -fsS -m 10 http://127.0.0.1:8002/health; then fail 1 "迁移后 8002 /health 不可用"; fi
echo
c7870=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:7870/)
echo "7870_http=$c7870"
if [ "$c7870" != "200" ]; then fail 1 "迁移后 7870 不可用（http=$c7870）"; fi
# R5A runtime offline contract：四项 env 逐项精确匹配（非模糊 grep）
container_envs=$(docker inspect indextts2 --format '{{range .Config.Env}}{{println .}}{{end}}')
for want in "UV_NO_SYNC=1" "UV_OFFLINE=1" "HF_HUB_CACHE=/app/checkpoints/hf_cache" "HF_HUB_OFFLINE=1"; do
  if ! printf '%s\n' "$container_envs" | grep -qxF "$want"; then
    fail 1 "容器内 offline contract env 缺失或不精确：$want"
  fi
done
ls "$CACHE/"
if ! curl -fsS -m 10 http://127.0.0.1:8002/speakers | head -c 200; then fail 1 "迁移后 /speakers 不可用"; fi
echo
nvidia-smi --query-gpu=memory.used --format=csv,noheader

echo "applied_at=$(date -Is) backup=$BACKUP" >> "$STATE_DIR/.bridge-applied.log"
echo "HOST_SIDE_PASS"
echo "LAN_ACCEPTANCE_PENDING（需同网段设备复验：LAN_IP:8002 必须 unreachable；LAN_IP:7870 必须 200）"
